# syntax=docker/dockerfile:1
# CUDA 12.3.2 + cuDNN 9 base — JAX GPU (CUDA 12) 지원
# gr00t-realtime 대비 차이점:
#   - Base: pytorch:25.03-py3 → cuda:12.3.2-cudnn9-devel-ubuntu22.04 (JAX 호환)
#   - 모델: HuggingFace (PyTorch) → GCS public bucket (JAX/orbax)
#   - 프레임워크: Isaac-GR00T → openpi (JAX + flax)
#   - HF 토큰: 필요 없음 (GCS public bucket)
FROM public.ecr.aws/nvidia/cuda:12.3.2-cudnn9-devel-ubuntu22.04

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV DEBIAN_FRONTEND=noninteractive

# 모델 설정 — 런타임 환경변수 (ECS 태스크 정의에서 override 가능)
ENV MODEL_CONFIG=pi05_libero
ENV MODEL_CHECKPOINT_DIR=/opt/pi-cache/checkpoints/pi05_libero

# openpi commit SHA — 재현성을 위해 main HEAD SHA로 고정
# 업데이트: git ls-remote https://github.com/Physical-Intelligence/openpi.git refs/heads/main
# 2026-04-17 고정: 650c5b0283a49c42784fb5055a0507da2c6d347d
ENV OPENPI_COMMIT=650c5b0283a49c42784fb5055a0507da2c6d347d

# ── 1. 시스템 패키지 (Python 3.11 — openpi >= 3.11 요구) ───────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-distutils \
        git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# python3 / pip3 → python3.11 로 대체
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11 \
    && pip3 install --upgrade pip setuptools wheel

# ── 2. uv 설치 (openpi 권장 패키지 매니저) ───────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# ── 3. openpi clone + install ─────────────────────────────────────────────────
RUN git clone https://github.com/Physical-Intelligence/openpi.git /opt/openpi \
    && git -C /opt/openpi checkout ${OPENPI_COMMIT}

# CPU JAX 포함 openpi 설치 — pyproject.toml이 호환 JAX 버전을 결정
RUN cd /opt/openpi && uv pip install --python python3.11 --system -e .

# ── 4. JAX CUDA 12 — openpi가 고정한 버전에 CUDA 플러그인만 추가 ───────────────
# openpi 설치 후 정해진 JAX 버전에 CUDA wheels만 추가. 버전 고정으로 업그레이드 방지.
RUN JAX_VER=$(python3.11 -c "import jax; print(jax.__version__)") && \
    uv pip install --python python3.11 --system "jax[cuda12]==${JAX_VER}"

# ── 5. gRPC serving + GCS 다운로드 라이브러리 ────────────────────────────────
RUN python3.11 -m pip install \
    grpcio==1.80.0 \
    grpcio-tools==1.80.0 \
    google-cloud-storage==3.10.1

# ── 6. GCS 체크포인트 pre-bake ───────────────────────────────────────────────
# public bucket — 인증 불필요
# 빌드 시 /opt/pi-cache/checkpoints/pi05_libero/ 에 다운로드
# 런타임: MODEL_CHECKPOINT_DIR 경로에서 즉시 로드 (콜드 스타트 단축)
COPY download_checkpoint.py /opt/ml/code/download_checkpoint.py
RUN python3 /opt/ml/code/download_checkpoint.py

# ── 7. Proto 스텁 생성 ────────────────────────────────────────────────────────
# 빌드 시점에 pi_pb2.py / pi_pb2_grpc.py 생성
COPY pi.proto /opt/ml/code/pi.proto
RUN cd /opt/ml/code && python3 -m grpc_tools.protoc \
    -I. --python_out=. --grpc_python_out=. pi.proto

# ── 8. 서빙 코드 복사 ─────────────────────────────────────────────────────────
COPY serve.py         /opt/ml/code/serve.py
COPY entrypoint.sh    /opt/ml/code/entrypoint.sh
COPY check_health.sh  /opt/ml/code/check_health.sh
RUN chmod +x /opt/ml/code/entrypoint.sh /opt/ml/code/check_health.sh

# 50051: gRPC (PIInference service)
#  8080: HTTP /health (NLB TCP health check target)
EXPOSE 50051 8080

ENTRYPOINT ["/opt/ml/code/entrypoint.sh"]
