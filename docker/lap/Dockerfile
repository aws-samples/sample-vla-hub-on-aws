# syntax=docker/dockerfile:1
# LAP-3B (Language-Action Pre-Training) realtime gRPC 컨테이너.
# Backbone: PaliGemma-3B + Flow Matching action expert (JAX, built on openpi).
# Repo: github.com/lihzha/lap (Apache-2.0). Checkpoint: lihzha/LAP-3B-Libero.
#
# 스택은 pi(π0.5) 컨테이너와 동일 계열 (JAX + CUDA 12 base + uv):
#   - Base: nvcr.io/nvidia/cuda:12.3.2-cudnn9-devel-ubuntu22.04 (NGC; JAX cuda12 호환)
#     (pi와 동일 base. public.ecr.aws/nvidia/cuda 는 존재하지 않음(NAME_UNKNOWN) — NVIDIA는
#      CUDA/pytorch 이미지를 public ECR에 게시 안 함. NGC nvcr.io는 anonymous pull 가능.)
#   - 프레임워크: lap (+ openpi submodule, editable) — Python 3.11, jax[cuda12]==0.5.3
#   - 가중치: HF public repo bake-in (~12.4 GB) — openvla 패턴, 토큰 불필요
#   - 토크나이저: PaliGemma SentencePiece(gs://big_vision/...)도 빌드 시 캐시 bake-in
FROM nvcr.io/nvidia/cuda:12.3.2-cudnn9-devel-ubuntu22.04

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV DEBIAN_FRONTEND=noninteractive

# ── 모델 설정 — 런타임 환경변수 (ECS 태스크 정의에서 override 가능) ───────────────
ENV MODEL_CONFIG=lap_libero
ENV MODEL_CHECKPOINT_DIR=/opt/lap-cache/checkpoints/lap_libero
# openpi maybe_download 캐시 위치 — 빌드/런타임 동일 경로여야 토크나이저 캐시 히트
ENV OPENPI_DATA_HOME=/opt/openpi-cache

# LAP commit SHA — 재현성을 위해 고정 (vla-simulator models/lap.yaml과 동일)
# 업데이트: git ls-remote https://github.com/lihzha/lap.git HEAD
ENV LAP_COMMIT=3958d1466d5b92445b67de7d4202c19608ad4d56
# HF 체크포인트 pin (LIBERO fine-tuned variant)
ENV LAP_HF_REPO=lihzha/LAP-3B-Libero
ENV LAP_HF_REVISION=11ba16b80b024fd6ee5ef47385a9e8f240212dfb

# ── 1. 시스템 패키지 (Python 3.11 — LAP requires-python >=3.11,<3.12) ───────────
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

# ── 2. uv 설치 (LAP/openpi 권장 패키지 매니저) ────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# ── 3. LAP clone (openpi + libero submodule 포함) + commit 고정 ────────────────
RUN git clone --recurse-submodules https://github.com/lihzha/lap.git /opt/lap \
    && git -C /opt/lap checkout ${LAP_COMMIT} \
    && git -C /opt/lap submodule update --init --recursive

# ── 4. LAP + openpi editable 설치 (system python 3.11) ────────────────────────
# pi 컨테이너와 동일하게 --system 설치 (컨테이너는 단일 python 환경).
# LAP pyproject [tool.uv.sources]가 openpi를 third_party/openpi editable로 지정하므로
# lap 설치 시 openpi가 함께 들어오나, 명시적으로 한 번 더 설치해 누락을 방지한다.
RUN cd /opt/lap \
    && GIT_LFS_SKIP_SMUDGE=1 uv pip install --python python3.11 --system -e third_party/openpi \
    && GIT_LFS_SKIP_SMUDGE=1 uv pip install --python python3.11 --system -e .

# ── 5. JAX CUDA 12 — LAP가 고정한 0.5.3에 CUDA 플러그인만 추가 ──────────────────
# 설치 후 정해진 JAX 버전(0.5.3)에 CUDA wheels만 추가. 버전 고정으로 업그레이드 방지.
RUN JAX_VER=$(python3.11 -c "import jax; print(jax.__version__)") && \
    echo "Pinned JAX version: ${JAX_VER}" && \
    uv pip install --python python3.11 --system "jax[cuda12]==${JAX_VER}"

# ── 6. gRPC serving + HF 다운로드 라이브러리 ──────────────────────────────────
# pytest: openpi `models_pytorch/gemma_pytorch.py`가 모듈 top-level에서 `import pytest`를
#   한다(upstream 결함 — test 의존성을 비-test 모듈에서 import). LAP은 JAX flow 정책만
#   쓰지만 `openpi.models.model`이 pi0_pytorch→gemma_pytorch를 무조건 import하므로,
#   런타임 import 체인이 pytest를 요구한다. editable 설치(-e .)는 dev 의존성을 안 깔므로 명시 추가.
RUN python3.11 -m pip install \
    grpcio==1.80.0 \
    grpcio-tools==1.80.0 \
    "huggingface_hub>=0.24.0" \
    "pillow>=10.0.0" \
    pytest

# ── 7. 에셋 bake-in (HF 체크포인트 ~12.4 GB + PaliGemma 토크나이저) ────────────
# public repo — 인증 불필요. 런타임 네트워크 접근 제거 (콜드 스타트 단축 + 격리).
COPY download_assets.py /opt/ml/code/download_assets.py
RUN python3 /opt/ml/code/download_assets.py

# 런타임 HF/네트워크 접근 차단 (가중치·토크나이저 이미지 내장)
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# ── 8. Proto 스텁 생성 ────────────────────────────────────────────────────────
COPY lap.proto /opt/ml/code/lap.proto
RUN cd /opt/ml/code && python3 -m grpc_tools.protoc \
    -I. --python_out=. --grpc_python_out=. lap.proto

# ── 9. 서빙 코드 복사 ─────────────────────────────────────────────────────────
COPY serve.py        /opt/ml/code/serve.py
COPY entrypoint.sh   /opt/ml/code/entrypoint.sh
COPY check_health.sh /opt/ml/code/check_health.sh
RUN chmod +x /opt/ml/code/entrypoint.sh /opt/ml/code/check_health.sh

# 50055: gRPC (LAPInference service)
#  8080: HTTP /health (NLB TCP health check target)
EXPOSE 50055 8080

ENTRYPOINT ["/opt/ml/code/entrypoint.sh"]
