# syntax=docker/dockerfile:1
# Base: PyTorch 2.4.0 + CUDA 12.4 + cuDNN 9
# g5.2xlarge (A10G): driver 550.x → CUDA 12.4 지원 (CUDA 12.1은 Error 803 발생)
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV DEBIAN_FRONTEND=noninteractive

# HuggingFace cache — EFS 마운트 없음 (openvla-7b는 public, 빌드 시 bake-in)
# 모델 가중치: Docker 이미지에 포함 (ECR 레이어 ~14GB)
# HF_HUB_OFFLINE=1은 serve.py 시작 시 설정
ENV HF_MODEL_ID=openvla/openvla-7b
ENV HF_HOME=/opt/hf-cache

RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools

# gRPC serving
RUN pip install grpcio==1.80.0 grpcio-tools==1.80.0

# OpenVLA dependencies — pinned versions:
#   transformers: 4.46.3 (AutoModelForVision2Seq 지원)
#   timm: 0.9.10 ~ <1.0.0 (modeling_prismatic.py 요구사항: >=0.9.10, <1.0.0)
RUN pip install --upgrade \
    "transformers==4.46.3" \
    "timm>=0.9.10,<1.0.0" \
    "pillow>=10.0.0" \
    "numpy>=1.24.0" \
    "accelerate>=0.28.0" \
    "pandas>=2.0.0" \
    "pyarrow>=14.0.0"

# 설치된 transformers 버전 확인 (빌드 로그에서 확인 가능)
RUN python3 -c "import transformers; print('transformers version:', transformers.__version__); from transformers import AutoModelForVision2Seq; print('AutoModelForVision2Seq import OK')"

# OpenVLA 모델 가중치 bake-in (HuggingFace public repo — 토큰 불필요)
# HF_HOME=/opt/hf-cache 에 다운로드 → serve.py가 offline으로 로드
RUN python3 -c "\
from transformers import AutoModelForVision2Seq, AutoProcessor; \
import torch; \
print('Downloading OpenVLA-7B weights...'); \
AutoProcessor.from_pretrained('openvla/openvla-7b', trust_remote_code=True); \
AutoModelForVision2Seq.from_pretrained('openvla/openvla-7b', torch_dtype=torch.bfloat16, trust_remote_code=True); \
print('Download complete.') \
"

# HF 네트워크 접근 차단 (가중치는 이미지에 포함)
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# Proto 스텁 생성
COPY openvla.proto /opt/ml/code/openvla.proto
RUN cd /opt/ml/code && python -m grpc_tools.protoc \
    -I. --python_out=. --grpc_python_out=. openvla.proto

COPY serve.py      /opt/ml/code/serve.py
COPY entrypoint.sh /opt/ml/code/entrypoint.sh
COPY check_health.sh /opt/ml/code/check_health.sh
RUN chmod +x /opt/ml/code/entrypoint.sh /opt/ml/code/check_health.sh

# 50053: gRPC (OpenVLAService)
#  8080: HTTP /health
EXPOSE 50053 8080

ENTRYPOINT ["/opt/ml/code/entrypoint.sh"]
