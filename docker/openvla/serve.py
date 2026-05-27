# serve.py — OpenVLA-7B gRPC server
#
# Ports:
#   50053 — gRPC (OpenVLAService, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target, HEALTH_PORT env override 가능)
#
# Phase 1 probing용 GetAttention RPC:
#   request:  frames (T×JPEG), instruction, layer_indices, head_indices
#   response: attention_maps {"L{l}_H{h}": float32 bytes shape (T,N)}, shape_info
#
# gRPC 스텁은 Dockerfile 빌드 시 protoc로 생성:
#   python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. openvla.proto

import io
import json
import os
import threading
from concurrent import futures
from http.server import BaseHTTPRequestHandler, HTTPServer

import grpc
import numpy as np
import openvla_pb2
import openvla_pb2_grpc
from PIL import Image

model = None
processor = None


def load_model():
    global model, processor
    from transformers import AutoModelForVision2Seq, AutoProcessor
    import torch

    model_id = os.environ.get("HF_MODEL_ID", "openvla/openvla-7b")
    device = os.environ.get("DEVICE", "cuda:0" if __import__("torch").cuda.is_available() else "cpu")
    dtype = __import__("torch").bfloat16 if "cuda" in device else __import__("torch").float32

    print(f"Loading OpenVLA model: {model_id} on {device} ({dtype})")
    processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForVision2Seq.from_pretrained(
        model_id,
        torch_dtype=dtype,
        trust_remote_code=True,
    ).to(device)
    model.eval()
    params_b = sum(p.numel() for p in model.parameters()) / 1e9
    print(f"Model loaded: {params_b:.1f}B parameters")


# ── gRPC Servicer ─────────────────────────────────────────────────────────────

class OpenVLAServicer(openvla_pb2_grpc.OpenVLAServiceServicer):

    def Health(self, request, context):
        return openvla_pb2.HealthResponse(
            healthy=True,
            model_loaded=(model is not None),
        )

    def GetAttention(self, request, context):
        if model is None:
            context.abort(grpc.StatusCode.UNAVAILABLE, "Model not loaded yet")
            return
        try:
            return _run_attention(request)
        except Exception as e:
            import traceback
            print(f"[serve] GetAttention ERROR: {e}\n{traceback.format_exc()}", flush=True)
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _run_attention(req: openvla_pb2.AttentionRequest) -> openvla_pb2.AttentionResponse:
    import torch

    device = next(model.parameters()).device

    # ── 입력 준비 ─────────────────────────────────────────────────────────────
    # T frames 디코딩
    pil_frames = [Image.open(io.BytesIO(f)).convert("RGB") for f in req.frames]
    T = len(pil_frames)

    # tokenize instruction
    inputs = processor(
        text=req.instruction,
        images=pil_frames[0],  # representative frame for processor init
        return_tensors="pt",
    )
    input_ids = inputs["input_ids"].to(device)

    # ── layer/head 필터 ──────────────────────────────────────────────────────
    # OpenVLA (Prismatic) config에는 num_hidden_layers가 없음.
    # text_config 또는 llm_backbone sub-config에서 찾거나, forward 결과로 추론.
    cfg = model.config
    n_layers = (
        getattr(cfg, "num_hidden_layers", None)
        or getattr(getattr(cfg, "text_config", None), "num_hidden_layers", None)
        or getattr(getattr(cfg, "llm_config", None), "num_hidden_layers", None)
    )
    n_heads = (
        getattr(cfg, "num_attention_heads", None)
        or getattr(getattr(cfg, "text_config", None), "num_attention_heads", None)
        or getattr(getattr(cfg, "llm_config", None), "num_attention_heads", None)
    )
    # fallback: LLaMA-7B 기본값 (32 layers, 32 heads)
    if n_layers is None:
        n_layers = 32
    if n_heads is None:
        n_heads = 32
    all_layers = list(range(n_layers))
    all_heads  = list(range(n_heads))
    sel_layers = list(req.layer_indices) if len(req.layer_indices) > 0 else all_layers
    sel_heads  = list(req.head_indices)  if len(req.head_indices)  > 0 else all_heads

    # ── 각 frame에 대해 forward (output_attentions=True) ──────────────────────
    # attention_maps_by_frame: list[dict[layer_idx → (heads, seq, seq)]]
    model_dtype = next(model.parameters()).dtype
    attention_per_frame = []
    with torch.no_grad():
        for pil_frame in pil_frames:
            frame_inputs = processor(
                text=req.instruction,
                images=pil_frame,
                return_tensors="pt",
            )
            out = model(
                input_ids=frame_inputs["input_ids"].to(device),
                pixel_values=frame_inputs["pixel_values"].to(device, dtype=model_dtype),
                output_attentions=True,
            )
            # out.attentions: tuple of (batch=1, heads, seq, seq) per layer
            layer_attn = {}
            for l_idx in sel_layers:
                if l_idx < len(out.attentions):
                    # (heads, seq, seq) — remove batch dim, detach to CPU
                    layer_attn[l_idx] = out.attentions[l_idx][0].detach().cpu()
            attention_per_frame.append(layer_attn)

    # ── instruction token 범위 추론 ───────────────────────────────────────────
    # OpenVLA: [image_patches | instruction_tokens | action_tokens] concat
    # Causal attention: image(앞) → instruction(뒤) 방향은 항상 0 (미래 attend 불가)
    # 올바른 방향: instruction_tokens → image_patches (cross-modal attention)
    seq_len = attention_per_frame[0][sel_layers[0]].shape[-1]
    img_token_count = getattr(processor, "image_seq_length", seq_len // 2)
    img_idx = list(range(img_token_count))
    ins_idx = list(range(img_token_count, seq_len))
    # N = image token 수 (instruction→image attention axis)
    N = len(img_idx)

    # ── attention_maps 직렬화: key="L{l}_H{h}", value=float32 bytes (T,N) ──
    # shape (T_frames, N_img): 각 frame에서 instruction→image attention mean
    attention_maps = {}
    for l_idx in sel_layers:
        for h_idx in sel_heads:
            if h_idx >= all_heads[-1] + 1:
                continue
            frames_attn = []
            for frame_attn in attention_per_frame:
                if l_idx not in frame_attn:
                    frames_attn.append(np.zeros(N, dtype=np.float32))
                    continue
                attn = frame_attn[l_idx]  # (heads, seq, seq)
                # instruction_tokens → image_patches slice
                # attn[h, ins_row, img_col]: shape (N_ins, N_img)
                slice_ = attn[h_idx, :, :][ins_idx, :][:, img_idx]  # (N_ins, N_img)
                # mean over instruction tokens → (N_img,): "image attention map from instruction"
                mean_over_ins = slice_.float().mean(axis=0).numpy().astype(np.float32)
                frames_attn.append(mean_over_ins)

            arr = np.stack(frames_attn, axis=0)  # (T, N)
            key = f"L{l_idx}_H{h_idx}"
            attention_maps[key] = arr.tobytes()

    shape_info = {
        "T":          T,
        "N":          N,
        "num_layers": len(sel_layers),
        "num_heads":  len(sel_heads),
    }

    return openvla_pb2.AttentionResponse(
        attention_maps=attention_maps,
        shape_info=shape_info,
    )


# ── HTTP health server (port 8080) ────────────────────────────────────────────

class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "status": "healthy",
            "model_loaded": model is not None,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def _start_health_server(port: int = 8080) -> HTTPServer:
    srv = HTTPServer(("0.0.0.0", port), _HealthHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f"HTTP health server listening on :{port}")
    return srv


# ── gRPC server factory ───────────────────────────────────────────────────────

def create_server(grpc_port: int = 50053) -> grpc.Server:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    openvla_pb2_grpc.add_OpenVLAServiceServicer_to_server(OpenVLAServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port   = int(os.environ.get("GRPC_PORT",   "50053"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    load_model()

    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}")

    _start_health_server(health_port)

    server.wait_for_termination()
