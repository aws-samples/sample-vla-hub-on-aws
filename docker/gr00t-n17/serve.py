# serve.py — GR00T gRPC inference server
# 2026-04-12: FastAPI/REST → gRPC 재설계 (NLB + mTLS-ready)
#
# Ports:
#   50051 — gRPC (GR00TInference service, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target, HEALTH_PORT env override 가능)
#
# gRPC 스텁은 Dockerfile 빌드 시 protoc 로 생성됨:
#   python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. gr00t.proto

import os
import io
import json
import threading
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent import futures

from PIL import Image
import grpc
import gr00t_pb2
import gr00t_pb2_grpc

policy = None


def load_model():
    global policy
    from gr00t.policy.gr00t_policy import Gr00tPolicy
    from gr00t.data.embodiment_tags import EmbodimentTag
    from huggingface_hub import snapshot_download
    import torch

    model_id = os.environ.get("HF_MODEL_ID", "nvidia/GR00T-N1.7-LIBERO")
    revision = os.environ.get("HF_MODEL_REVISION", "2ea293aa20ba7cf5bbf3ba17a5fbcb1a01cbfe21")
    embodiment_tag = os.environ.get("EMBODIMENT_TAG", "LIBERO_PANDA")
    device = "cuda:0" if torch.cuda.is_available() else "cpu"

    # HF_HUB_OFFLINE=1 (Dockerfile 설정) → snapshot_download가 캐시에서 즉시 반환
    print(f"Loading model from cache: {model_id} @ {revision}")
    model_path = snapshot_download(model_id, revision=revision)
    os.environ["HF_HUB_OFFLINE"] = "1"  # safety net

    # GR00T-N1.7-LIBERO snapshot root contains per-suite subdirs (libero_10, libero_goal, etc.)
    # rather than flat model files. Select the appropriate subdir via LIBERO_SUBDIR env var.
    libero_subdir = os.environ.get("LIBERO_SUBDIR", "libero_10")
    candidate = os.path.join(model_path, libero_subdir)
    if os.path.isdir(candidate) and os.path.exists(os.path.join(candidate, "config.json")):
        print(f"Using per-suite subdir: {libero_subdir}")
        model_path = candidate

    # Workaround: transformers 4.57.x _patch_mistral_regex() → model_info(backbone_repo_id)
    # → OfflineModeIsEnabled when HF_HUB_OFFLINE=1.
    # Monkey-patch build_processor to resolve HF repo ID → local path before from_pretrained().
    try:
        import gr00t.model.gr00t_n1d7.processing_gr00t_n1d7 as _proc
        _orig_build = _proc.build_processor

        def _patched_build_processor(name, kwargs):
            import pathlib
            if not pathlib.Path(name).exists():
                try:
                    name = snapshot_download(name)
                except Exception:
                    pass
            return _orig_build(name, kwargs)

        _proc.build_processor = _patched_build_processor
        print("Monkey-patched build_processor to resolve local snapshot path")
    except Exception as _e:
        print(f"Monkey-patch skipped: {_e}")

    print(f"Loading model from {model_path}, embodiment_tag: {embodiment_tag}, device: {device}")
    policy = Gr00tPolicy(
        model_path=model_path,
        embodiment_tag=EmbodimentTag.resolve(embodiment_tag),
        device=device,
        strict=True,
    )
    print("Model loaded successfully.")


# ── gRPC Servicer ─────────────────────────────────────────────────────────────

class GR00TServicer(gr00t_pb2_grpc.GR00TInferenceServicer):

    def Health(self, request, context):
        return gr00t_pb2.HealthResponse(
            healthy=True,
            model_loaded=policy is not None,
        )

    def Infer(self, request, context):
        if policy is None:
            context.abort(grpc.StatusCode.UNAVAILABLE, "Model not loaded yet")
            return
        try:
            return _run_inference(request)
        except Exception as e:
            import traceback
            print(f"[serve] INTERNAL ERROR: {e}\n{traceback.format_exc()}", flush=True)
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _run_inference(req: gr00t_pb2.InferRequest) -> gr00t_pb2.InferResponse:
    image = np.array(Image.open(io.BytesIO(req.image_data)).convert("RGB"), dtype=np.uint8)

    def _img(data: bytes):
        if data:
            return np.array(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.uint8)[np.newaxis, np.newaxis]
        return image[np.newaxis, np.newaxis]

    def _state(val, dof: int):
        arr = list(val)
        if len(arr) == 0:
            arr = [0.0] * dof
        elif len(arr) < dof:
            arr = arr + [0.0] * (dof - len(arr))
        return np.array(arr[:dof], dtype=np.float32).reshape((1, 1, dof))

    # N1.7 LIBERO_PANDA modality keys (libero_sim embodiment_config)
    # video: image, wrist_image
    # state: x(1), y(1), z(1), roll(1), pitch(1), yaw(1), gripper(2) — robot0_gripper_qpos
    # left_arm proto field = [x, y, z, roll, pitch, yaw] (6-DOF EEF)
    # left_gripper proto field = [finger0_qpos, finger1_qpos] (2-DOF)
    obs = {
        "video": {
            "image":       _img(req.image_data),
            "wrist_image": _img(bytes(req.wrist_image_data) if req.wrist_image_data else b""),
        },
        "state": {
            "x":       _state(req.left_arm[:1],  1),
            "y":       _state(req.left_arm[1:2],  1),
            "z":       _state(req.left_arm[2:3],  1),
            "roll":    _state(req.left_arm[3:4],  1),
            "pitch":   _state(req.left_arm[4:5],  1),
            "yaw":     _state(req.left_arm[5:6],  1),
            "gripper": _state(req.left_gripper[:2], 2),
        },
        "language": {
            "annotation.human.action.task_description": [[req.instruction]],
        },
    }

    action, _ = policy.get_action(obs)
    # float32 bytes per key (클라이언트에서 np.frombuffer(v, dtype=np.float32) 로 복원)
    action_chunks = {k: v.astype(np.float32).tobytes() for k, v in action.items()}
    return gr00t_pb2.InferResponse(action_chunks=action_chunks)


# ── HTTP health server (port 8080) — NLB TCP health check target ──────────────

class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "status": "healthy",
            "model_loaded": policy is not None,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # suppress access logs


def _start_health_server(port: int = 8080) -> HTTPServer:
    srv = HTTPServer(("0.0.0.0", port), _HealthHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f"HTTP health server listening on :{port}")
    return srv


# ── gRPC server factory (분리: smoke_test 에서도 재사용) ──────────────────────

def create_server(grpc_port: int = 50051) -> grpc.Server:
    # max_workers=1: GPU 추론은 단일 스레드 처리 (CUDA context thread-safety)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    gr00t_pb2_grpc.add_GR00TInferenceServicer_to_server(GR00TServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port = int(os.environ.get("GRPC_PORT", "50051"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    # 모델 로드 (블로킹 — 완료 후 서버 시작)
    load_model()

    # gRPC 서버 시작
    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}")

    # HTTP health 서버 시작 (daemon thread)
    _start_health_server(health_port)

    server.wait_for_termination()
