# serve.py — SmolVLA-450M (HuggingFace LeRobot) gRPC inference server
#
# Ports:
#   50054 — gRPC (SmolVLAService, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target, HEALTH_PORT env override 가능)
#
# HF model: lerobot/smolvla_base (SmolVLM2-500M + Flow Matching action expert)
# 입력: two camera views (exterior, wrist) + 8D state + language instruction
# 출력: action chunk (shape = chunk_length × action_dim, float32)
#
# gRPC 스텁은 Dockerfile 빌드 시 protoc로 생성됨.

import io
import json
import os
import threading
from concurrent import futures
from http.server import BaseHTTPRequestHandler, HTTPServer

import grpc
import numpy as np
import smolvla_pb2
import smolvla_pb2_grpc
from PIL import Image

model = None
preprocess_fn = None
postprocess_fn = None


def load_model():
    global model, preprocess_fn, postprocess_fn
    import torch
    from lerobot.policies import make_pre_post_processors
    from lerobot.policies.smolvla import SmolVLAPolicy

    model_id = os.environ.get("HF_MODEL_ID", "lerobot/smolvla_base")
    device_str = os.environ.get("DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")

    print(f"Loading SmolVLA: {model_id} on {device_str}")
    model = SmolVLAPolicy.from_pretrained(model_id)
    model.to(device_str)
    model.eval()

    preprocess_fn, postprocess_fn = make_pre_post_processors(
        model.config,
        model_id,
        preprocessor_overrides={"device_processor": {"device": device_str}},
    )

    params_m = sum(p.numel() for p in model.parameters()) / 1e6
    print(f"Model loaded: {params_m:.0f}M parameters")


# ── gRPC Servicer ─────────────────────────────────────────────────────────────

class SmolVLAServicer(smolvla_pb2_grpc.SmolVLAServiceServicer):

    def Health(self, request, context):
        return smolvla_pb2.HealthResponse(
            healthy=True,
            model_loaded=(model is not None),
        )

    def Infer(self, request, context):
        if model is None:
            context.abort(grpc.StatusCode.UNAVAILABLE, "Model not loaded yet")
            return
        try:
            return _run_inference(request)
        except Exception as e:
            import traceback
            print(f"[serve] Infer ERROR: {e}\n{traceback.format_exc()}", flush=True)
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _decode_image(data: bytes, size: int = 224) -> np.ndarray:
    """JPEG/PNG bytes → (H, W, 3) uint8 numpy array (RGB, resized)"""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img = img.resize((size, size), Image.BILINEAR)
    return np.array(img, dtype=np.uint8)


def _hwc_uint8_to_chw_float_tensor(arr: np.ndarray):
    """(H, W, 3) uint8 → (1, 3, H, W) float tensor [0, 1]"""
    import torch
    t = torch.from_numpy(arr).float() / 255.0  # (H, W, 3) in [0, 1]
    t = t.permute(2, 0, 1).unsqueeze(0)        # (1, 3, H, W)
    return t


def _run_inference(req: smolvla_pb2.InferRequest) -> smolvla_pb2.InferResponse:
    import torch

    device = next(model.parameters()).device

    # ── 관측 dict 구성 — LeRobot 표준 키 ───────────────────────────────────
    # observation.images.image       : third-person view (exterior)
    # observation.images.wrist_image : eye-in-hand
    # observation.state              : (B, state_dim) float32
    # task                           : 자연어 지시 문자열 (batched 리스트)
    exterior = _decode_image(req.exterior_image)
    wrist    = _decode_image(req.wrist_image)

    # state: proto repeated float → (1, state_dim) float32, zero-pad to 8
    if len(req.state) > 0:
        state_np = np.array(req.state[:8], dtype=np.float32)
        if len(state_np) < 8:
            state_np = np.pad(state_np, (0, 8 - len(state_np)))
    else:
        state_np = np.zeros(8, dtype=np.float32)

    obs = {
        "observation.images.image":       _hwc_uint8_to_chw_float_tensor(exterior).to(device),
        "observation.images.wrist_image": _hwc_uint8_to_chw_float_tensor(wrist).to(device),
        "observation.state":               torch.from_numpy(state_np).unsqueeze(0).to(device),
        "task":                            [req.instruction],
    }

    with torch.no_grad():
        obs_in = preprocess_fn(obs)
        action = model.select_action(obs_in)
        action = postprocess_fn(action)

    # action tensor → numpy. SmolVLA action chunk shape 은
    # (B=1, chunk_length, action_dim) 또는 (B=1, action_dim) 중 하나.
    # 2D 이상이면 batch dim 제거 후 float32 flatten.
    arr = action.detach().cpu().numpy().astype(np.float32)
    if arr.ndim == 3 and arr.shape[0] == 1:
        arr = arr[0]  # (chunk_length, action_dim)
    elif arr.ndim == 2 and arr.shape[0] == 1:
        arr = arr  # (1, action_dim) — single-step
    # else: leave as-is

    if arr.ndim == 1:
        chunk_length, action_dim = 1, int(arr.shape[0])
    else:
        chunk_length, action_dim = int(arr.shape[0]), int(arr.shape[1])

    return smolvla_pb2.InferResponse(
        actions=arr.tobytes(),
        shape_info={"chunk_length": chunk_length, "action_dim": action_dim},
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

def create_server(grpc_port: int = 50054) -> grpc.Server:
    # max_workers=1: CUDA context thread-safety (단일 GPU 추론)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    smolvla_pb2_grpc.add_SmolVLAServiceServicer_to_server(SmolVLAServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port   = int(os.environ.get("GRPC_PORT",   "50054"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    load_model()

    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}")

    _start_health_server(health_port)

    server.wait_for_termination()
