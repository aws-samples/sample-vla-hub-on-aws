# syntax=docker/dockerfile:1
# Base: PyTorch 2.4.0 + CUDA 12.4 + cuDNN 9 (openvla 컨테이너와 동일 스택)
# g5/g6.xlarge (A10G/L4): driver 550.x → CUDA 12.4 지원
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV DEBIAN_FRONTEND=noninteractive

# 런타임 모델 설정 (ECS task def가 override 가능)
ENV HF_MODEL_ID=lerobot/smolvla_base
ENV HF_HOME=/opt/hf-cache

RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools

# gRPC serving
RUN pip install grpcio==1.80.0 grpcio-tools==1.80.0

# LeRobot + SmolVLA 의존성
# - lerobot: SmolVLAPolicy, make_pre_post_processors 제공
# - transformers: SmolVLM2 backbone
# - 나머지: 이미지 디코드 / 텐서 조작
RUN pip install --upgrade \
    "lerobot[smolvla]>=0.3.0" \
    "pillow>=10.0.0" \
    "numpy>=1.24.0" \
    "accelerate>=0.28.0"

# 설치 검증 (빌드 로그에서 확인)
RUN python3 -c "\
import lerobot, transformers; \
from lerobot.policies.smolvla import SmolVLAPolicy; \
print('lerobot:', lerobot.__version__); \
print('transformers:', transformers.__version__); \
print('SmolVLAPolicy import OK') \
"

# SmolVLA 가중치 bake-in — public HF repo (토큰 불필요, ~1 GB)
# HF_HOME=/opt/hf-cache 에 다운로드 → serve.py가 offline으로 로드
RUN python3 -c "\
from lerobot.policies.smolvla import SmolVLAPolicy; \
print('Downloading SmolVLA 450M weights...'); \
SmolVLAPolicy.from_pretrained('lerobot/smolvla_base'); \
print('Download complete.') \
"

# 런타임 HF 네트워크 접근 차단 (가중치 이미지 내장)
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# Proto 스텁 생성
COPY smolvla.proto /opt/ml/code/smolvla.proto
RUN cd /opt/ml/code && python -m grpc_tools.protoc \
    -I. --python_out=. --grpc_python_out=. smolvla.proto

COPY serve.py        /opt/ml/code/serve.py
COPY entrypoint.sh   /opt/ml/code/entrypoint.sh
COPY check_health.sh /opt/ml/code/check_health.sh
RUN chmod +x /opt/ml/code/entrypoint.sh /opt/ml/code/check_health.sh

# 50054: gRPC (SmolVLAService)
#  8080: HTTP /health
EXPOSE 50054 8080

ENTRYPOINT ["/opt/ml/code/entrypoint.sh"]
