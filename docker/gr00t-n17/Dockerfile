# syntax=docker/dockerfile:1
# pytorch:25.03-py3 — CUDA 12.8, PyTorch 2.7
# N1.7: Cosmos-Reason2-2B (qwen3_backbone) 백본 — flash-attn 불필요
FROM public.ecr.aws/nvidia/pytorch:25.03-py3

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV DEBIAN_FRONTEND=noninteractive
# N1.7 LIBERO fine-tuned checkpoint (LIBERO_PANDA embodiment tag 지원)
ENV HF_MODEL_REVISION=2ea293aa20ba7cf5bbf3ba17a5fbcb1a01cbfe21
ENV HF_MODEL_ID=nvidia/GR00T-N1.7-LIBERO
# HF cache → EFS mount point (ECS task def에서 /models 마운트)
# 모델 가중치는 Docker 이미지에 포함하지 않음 — EFS에서 로드
ENV HF_HOME=/models

RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools

# constraint 파일 비우기 (있을 경우에만)
RUN [ -f /etc/pip/constraint.txt ] && echo "" > /etc/pip/constraint.txt || true

# Isaac-GR00T N1.7 commit SHA 고정 — 2026-04-26
# SHA: git ls-remote https://github.com/NVIDIA/Isaac-GR00T.git refs/heads/main
ENV ISAAC_GROOT_COMMIT=4b1dca9d88d2a0b9ea5a65aa61c82ff89f5c4f0e
RUN git clone https://github.com/NVIDIA/Isaac-GR00T.git /opt/gr00t \
    && git -C /opt/gr00t checkout ${ISAAC_GROOT_COMMIT}

# N1.7 requires transformers >= 4.57.0 for Qwen3VLForConditionalGeneration
RUN pip install "transformers>=4.57.0"

RUN cd /opt/gr00t && pip install --ignore-requires-python -e .

# opencv 완전 교체 — gr00t 설치 이후에 덮어쓰기
RUN pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python 2>/dev/null || true && \
    find /usr/local/lib/python3.12/dist-packages -maxdepth 1 -name "cv2*" -exec rm -rf {} + 2>/dev/null || true && \
    pip install "opencv-python-headless==4.8.1.78"

# gRPC serving dependencies — pinned 2026-04-26
RUN pip install grpcio==1.80.0 grpcio-tools==1.80.0 typeguard==4.5.1

COPY patch_policy.py /opt/ml/code/patch_policy.py
RUN python3 /opt/ml/code/patch_policy.py

# 런타임 HF 네트워크 접근 차단 — EFS(/models)에서 로드, HF 다운로드 없음
# 모델 가중치는 Docker 이미지에 포함하지 않음 (ECR 50GB 레이어 한도 회피)
# ECS task def가 EFS를 /models에 마운트 → serve.py가 HF_HOME=/models에서 로드
ENV HF_HUB_OFFLINE=1

# Proto 스텁 생성 — 빌드 시점에 gr00t_pb2.py / gr00t_pb2_grpc.py 생성
COPY gr00t.proto      /opt/ml/code/gr00t.proto
RUN cd /opt/ml/code && python -m grpc_tools.protoc \
    -I. --python_out=. --grpc_python_out=. gr00t.proto

COPY serve.py         /opt/ml/code/serve.py
COPY entrypoint.sh    /opt/ml/code/entrypoint.sh
COPY check_health.sh  /opt/ml/code/check_health.sh
RUN chmod +x /opt/ml/code/entrypoint.sh /opt/ml/code/check_health.sh

# 50051: gRPC (GR00TInference service)
#  8080: HTTP /health (NLB TCP health check target)
EXPOSE 50051 8080

ENTRYPOINT ["/opt/ml/code/entrypoint.sh"]
