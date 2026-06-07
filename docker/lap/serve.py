# serve.py — LAP-3B (Language-Action Pre-Training) gRPC inference server
#
# Ports:
#   50055 — gRPC (LAPInference service, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target, HEALTH_PORT env override 가능)
#
# LAP-3B: PaliGemma-3B backbone + Flow Matching action expert (JAX, built on openpi).
# Repo: github.com/lihzha/lap. Checkpoint: lihzha/LAP-3B-Libero (LIBERO fine-tune).
#
# pi/serve.py(π0.5, JAX)와 동일한 패턴 — in-process 정책 로드 + JIT 워밍업 + gRPC servicer.
# LAP 고유 차이점 (vla-simulator scripts/libero/main.py obs_to_request 기준):
#   - obs dict가 NESTED ("observation" 하위) — π0.5의 slash-flat 키와 다름
#   - state 10-dim (eef_pos 3 + eef_rot6d 6 + gripper 1) — π0.5의 8-dim과 다름
#   - 정책 생성자: lap.policies.policy_config_adapter.create_trained_policy (policy_config 아님)
#   - 출력 actions shape = (action_horizon=10, action_dim=7)
#
# gRPC 스텁은 Dockerfile 빌드 시 protoc로 생성됨:
#   python3 -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. lap.proto

import os
import io
import json
import threading
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent import futures

from PIL import Image
import grpc
import lap_pb2
import lap_pb2_grpc

policy = None

# LAP lap_libero config 고정값 (src/lap/training/config.py): action_dim=7, action_horizon=10.
STATE_DIM = 10  # eef_pos(3) + eef_rot6d(6) + gripper(1)


def load_model():
    global policy
    # LAP는 openpi Policy를 직접 반환 (flow 정책). 생성자는 policy_config_adapter에 있음.
    from lap.training import config as _config
    import lap.policies.policy_config_adapter as _policy_config

    config_name    = os.environ.get("MODEL_CONFIG", "lap_libero")
    checkpoint_dir = os.environ.get("MODEL_CHECKPOINT_DIR", "/opt/lap-cache/checkpoints/lap_libero")
    default_prompt = os.environ.get("DEFAULT_PROMPT", "") or None

    print(f"Loading LAP-3B: config={config_name}, checkpoint={checkpoint_dir}", flush=True)
    cfg = _config.get_config(config_name)
    policy = _policy_config.create_trained_policy(cfg, checkpoint_dir, default_prompt=default_prompt)
    print("Model loaded. Running JIT warmup...", flush=True)
    _warmup()
    print("Warmup complete. Ready for inference.", flush=True)


def _warmup():
    """JAX JIT 첫 컴파일 — 실제 추론 전 워밍업 (모델 로드 후 1회 실행)."""
    dummy_img = np.zeros((224, 224, 3), dtype=np.uint8)
    obs = _build_obs(
        base=dummy_img,
        wrist=dummy_img,
        instruction="warmup",
        state=np.zeros(STATE_DIM, dtype=np.float32),
        frame_description="",
    )
    try:
        policy.infer(obs)
    except Exception as e:
        print(f"Warmup warning (non-fatal): {e}", flush=True)


# ── gRPC Servicer ──────────────────────────────────────────────────────────────

class LAPServicer(lap_pb2_grpc.LAPInferenceServicer):

    def Health(self, request, context):
        return lap_pb2.HealthResponse(
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
            print(f"[serve] Infer ERROR: {e}\n{traceback.format_exc()}", flush=True)
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _decode_image(data: bytes) -> np.ndarray:
    """JPEG/PNG bytes → (224, 224, 3) uint8 numpy array (RGB)."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img = img.resize((224, 224), Image.BILINEAR)
    return np.array(img, dtype=np.uint8)


def _build_obs(
    base: np.ndarray,
    wrist: np.ndarray,
    instruction: str,
    state: np.ndarray,
    frame_description: str,
) -> dict:
    """LAP lap_libero obs 딕셔너리 구성 (NESTED).

    LAP scripts/libero/main.py obs_to_request() + model_adapter.py IMAGE_KEYS 기준:
      observation.base_0_rgb        : (224, 224, 3) uint8 — agentview (third-person)
      observation.left_wrist_0_rgb  : (224, 224, 3) uint8 — eye-in-hand
      observation.state             : (10,) float32 — eef_pos(3)+eef_rot6d(6)+gripper(1)
    prompt: 자연어 지시. frame_description: CoT 힌트 (flow 정책은 빈 문자열 무시).
    """
    return {
        "observation": {
            "base_0_rgb":       base,    # (224, 224, 3) uint8
            "left_wrist_0_rgb": wrist,   # (224, 224, 3) uint8
            "state":            state,   # (10,) float32
        },
        "prompt":            instruction,
        "frame_description": frame_description,
    }


def _run_inference(req: lap_pb2.InferRequest) -> lap_pb2.InferResponse:
    base  = _decode_image(req.base_image)
    wrist = _decode_image(req.wrist_image)

    # state: proto repeated float → (10,) float32, zero-pad if not provided
    if len(req.state) > 0:
        arr = np.array(req.state[:STATE_DIM], dtype=np.float32)
        if len(arr) < STATE_DIM:
            arr = np.pad(arr, (0, STATE_DIM - len(arr)))
    else:
        arr = np.zeros(STATE_DIM, dtype=np.float32)

    obs    = _build_obs(base, wrist, req.instruction, arr, req.frame_description or "")
    result = policy.infer(obs)

    # actions: (action_horizon=10, action_dim=7) → float32 bytes row-major
    actions = np.asarray(result["actions"], dtype=np.float32)
    if actions.ndim == 1:
        chunk_length, action_dim = 1, int(actions.shape[0])
    else:
        chunk_length, action_dim = int(actions.shape[0]), int(actions.shape[1])

    return lap_pb2.InferResponse(
        actions=actions.tobytes(),
        shape_info={"chunk_length": chunk_length, "action_dim": action_dim},
    )


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
    print(f"HTTP health server listening on :{port}", flush=True)
    return srv


# ── gRPC server factory (smoke_test 에서도 재사용) ────────────────────────────

def create_server(grpc_port: int = 50055) -> grpc.Server:
    # max_workers=1: JAX/GPU 추론은 단일 스레드 처리 (CUDA context thread-safety)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    lap_pb2_grpc.add_LAPInferenceServicer_to_server(LAPServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port   = int(os.environ.get("GRPC_PORT",   "50055"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    # 모델 로드 + JIT 워밍업 (블로킹 — 완료 후 서버 시작)
    load_model()

    # gRPC 서버 시작
    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}", flush=True)

    # HTTP health 서버 시작 (daemon thread)
    _start_health_server(health_port)

    server.wait_for_termination()
