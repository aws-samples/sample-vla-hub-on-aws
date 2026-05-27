# serve.py — GR00T N1.6 gRPC inference server
# Ports:
#   50051 — gRPC (GR00TInference service, GRPC_PORT env override 가능)
#    8080 — HTTP /health (NLB TCP health check target)

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

    model_id = os.environ.get("HF_MODEL_ID", "nvidia/GR00T-N1.6-3B")
    revision = os.environ.get("HF_MODEL_REVISION", None)
    embodiment_tag = os.environ.get("EMBODIMENT_TAG", "GR1")
    device = "cuda:0" if torch.cuda.is_available() else "cpu"

    print(f"Loading model from cache: {model_id}" + (f" @ {revision}" if revision else ""))
    kwargs = {"revision": revision} if revision else {}
    model_path = snapshot_download(model_id, **kwargs)
    os.environ["HF_HUB_OFFLINE"] = "1"  # safety net

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
            context.abort(grpc.StatusCode.INTERNAL, str(e))
            return


def _run_inference(req: gr00t_pb2.InferRequest) -> gr00t_pb2.InferResponse:
    image = np.array(Image.open(io.BytesIO(req.image_data)).convert("RGB"), dtype=np.uint8)

    def _img(data: bytes):
        if data:
            return np.array(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.uint8)[np.newaxis, np.newaxis]
        return image[np.newaxis, np.newaxis]

    def _state1(val):
        if len(val) > 0:
            return np.array(val, dtype=np.float32).reshape((1, 1, len(val)))
        return np.zeros((1, 1, 1), dtype=np.float32)

    # N1.6 GR1 modality keys (gr1 embodiment_config)
    # video: ego_view_bg_crop_pad_res256_freq20  |  state: joint angles
    obs = {
        "video": {
            "ego_view_bg_crop_pad_res256_freq20": _img(req.image_data),
        },
        "state": {
            "left_arm":   _state1(req.left_arm),
            "right_arm":  _state1(req.right_arm),
            "left_hand":  _state1(req.left_hand),
            "right_hand": _state1(req.right_hand),
            "waist":      _state1(req.waist),
        },
        "language": {
            "annotation.human.action.task_description": [[req.instruction]],
        },
    }

    action, _ = policy.get_action(obs)
    action_chunks = {k: v.astype(np.float32).tobytes() for k, v in action.items()}
    return gr00t_pb2.InferResponse(action_chunks=action_chunks)


# ── HTTP health server ────────────────────────────────────────────────────────

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
        pass


def _start_health_server(port: int = 8080) -> HTTPServer:
    srv = HTTPServer(("0.0.0.0", port), _HealthHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f"HTTP health server listening on :{port}")
    return srv


def create_server(grpc_port: int = 50051) -> grpc.Server:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    gr00t_pb2_grpc.add_GR00TInferenceServicer_to_server(GR00TServicer(), server)
    server.add_insecure_port(f"[::]:{grpc_port}")
    return server


if __name__ == "__main__":
    grpc_port = int(os.environ.get("GRPC_PORT", "50051"))
    health_port = int(os.environ.get("HEALTH_PORT", "8080"))

    load_model()

    server = create_server(grpc_port)
    server.start()
    print(f"gRPC server listening on :{grpc_port}")

    _start_health_server(health_port)

    server.wait_for_termination()
