# serve.py — π0.5 (openpi) gRPC inference server
# 2026-04-17: vla-pi-realtime Phase 2
#
# Ports:
#   50051 — gRPC (PIInference service, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target, HEALTH_PORT env override 가능)
#
# gRPC 스텁은 Dockerfile 빌드 시 protoc 로 생성됨:
#   python3 -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. pi.proto

import os
import io
import json
import threading
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent import futures

from PIL import Image
import grpc
import pi_pb2
import pi_pb2_grpc

policy = None


def load_model():
    global policy
    from openpi.training import config as _config
    from openpi.policies import policy_config

    config_name     = os.environ.get("MODEL_CONFIG", "pi05_droid")
    checkpoint_dir  = os.environ.get("MODEL_CHECKPOINT_DIR", "/opt/pi-cache/checkpoints/pi05_droid")

    print(f"Loading π0.5 model: config={config_name}, checkpoint={checkpoint_dir}")
    cfg    = _config.get_config(config_name)
    policy = policy_config.create_trained_policy(cfg, checkpoint_dir)
    print("Model loaded. Running JIT warmup...")
    _warmup()
    print("Warmup complete. Ready for inference.")


def _warmup():
    """JAX JIT 첫 컴파일 — 실제 추론 전 워밍업 (모델 로드 후 1회 실행)"""
    dummy_img = np.zeros((224, 224, 3), dtype=np.uint8)
    obs = _build_obs(
        exterior=dummy_img,
        wrist=dummy_img,
        instruction="warmup",
        state=np.zeros(8, dtype=np.float32),  # eef_pos(3)+axis_angle(3)+gripper(2)
    )
    try:
        policy.infer(obs)
    except Exception as e:
        print(f"Warmup warning (non-fatal): {e}")


# ── gRPC Servicer ──────────────────────────────────────────────────────────────

class PIServicer(pi_pb2_grpc.PIInferenceServicer):

    def Health(self, request, context):
        return pi_pb2.HealthResponse(
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
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _decode_image(data: bytes) -> np.ndarray:
    """JPEG/PNG bytes → (224, 224, 3) uint8 numpy array"""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img = img.resize((224, 224), Image.BILINEAR)
    return np.array(img, dtype=np.uint8)


def _build_obs(
    exterior: np.ndarray,
    wrist: np.ndarray,
    instruction: str,
    state: np.ndarray,
) -> dict:
    """openpi pi05_libero config obs 딕셔너리 구성

    LIBERO DataSpec (libero_policy.py) 기준:
      - "observation/image"       : (224, 224, 3) uint8 — agentview (exterior)
      - "observation/wrist_image" : (224, 224, 3) uint8 — robot eye-in-hand
      - "observation/state"       : (8,) float32 — eef_pos(3)+axis_angle(3)+gripper(2)
    LiberoOutputs가 actions[:, :7] 슬라이싱 적용 (7D 반환).
    """
    return {
        "observation/image":       exterior,    # (224, 224, 3) uint8
        "observation/wrist_image": wrist,       # (224, 224, 3) uint8
        "prompt":                  instruction,
        "observation/state":       state,       # (8,) float32
    }


def _run_inference(req: pi_pb2.InferRequest) -> pi_pb2.InferResponse:
    exterior = _decode_image(req.exterior_image)
    wrist    = _decode_image(req.wrist_image)

    # state: proto repeated float → (8,) float32, zero-pad if not provided
    if len(req.state) > 0:
        arr = np.array(req.state[:8], dtype=np.float32)
        if len(arr) < 8:
            arr = np.pad(arr, (0, 8 - len(arr)))
    else:
        arr = np.zeros(8, dtype=np.float32)

    obs    = _build_obs(exterior, wrist, req.instruction, arr)
    result = policy.infer(obs)

    # actions: (chunk_length=10, action_dim=7) → float32 bytes row-major (pi05_libero, LiberoOutputs applied)
    actions = np.array(result["actions"], dtype=np.float32)
    return pi_pb2.InferResponse(actions=actions.tobytes())


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


# ── gRPC server factory (smoke_test 에서도 재사용) ────────────────────────────

def create_server(grpc_port: int = 50051) -> grpc.Server:
    # max_workers=1: JAX/GPU 추론은 단일 스레드 처리 (CUDA context thread-safety)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    pi_pb2_grpc.add_PIInferenceServicer_to_server(PIServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port   = int(os.environ.get("GRPC_PORT",   "50051"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    # 모델 로드 + JIT 워밍업 (블로킹 — 완료 후 서버 시작)
    load_model()

    # gRPC 서버 시작
    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}")

    # HTTP health 서버 시작 (daemon thread)
    _start_health_server(health_port)

    server.wait_for_termination()
