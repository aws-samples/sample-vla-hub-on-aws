#!/bin/bash
# entrypoint.sh — π0.5 gRPC 서버 기동
# 2026-04-17: vla-pi-realtime Phase 2

# ── CUDA Forward Compatibility ─────────────────────────────────────────────────
# Only prepend compat libs when host driver < compat driver version.
# If host driver is newer, using compat libs causes CUDA_ERROR_SYSTEM_DRIVER_MISMATCH.
if [ -f /usr/local/cuda/compat/libcuda.so.1 ]; then
    COMPAT_LINK=$(readlink /usr/local/cuda/compat/libcuda.so.1 || true)
    COMPAT_VER=$(echo "$COMPAT_LINK" | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "0")
    HOST_VER=$(sed -n 's/^NVRM.*Kernel Module *\([0-9.]*\).*$/\1/p' /proc/driver/nvidia/version 2>/dev/null || echo "0")
    echo "Host NVIDIA driver: ${HOST_VER}, CUDA compat version: ${COMPAT_VER}"
    # Compare major versions (e.g. 545 vs 550)
    HOST_MAJOR=$(echo "$HOST_VER" | cut -d'.' -f1)
    COMPAT_MAJOR=$(echo "$COMPAT_VER" | cut -d'.' -f1)
    if [ -n "$HOST_VER" ] && [ "$HOST_MAJOR" -lt "$COMPAT_MAJOR" ] 2>/dev/null; then
        export LD_LIBRARY_PATH=/usr/local/cuda/compat:${LD_LIBRARY_PATH}
        echo "CUDA compat enabled (host ${HOST_VER} < compat ${COMPAT_VER}): LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
    else
        echo "CUDA compat skipped (host ${HOST_VER} >= compat ${COMPAT_VER}): using host driver directly"
    fi
else
    echo "No CUDA compat package found"
fi

# ── JAX 메모리 설정 ────────────────────────────────────────────────────────────
# GPU 메모리를 필요한 만큼만 사용 (사전 할당 방지)
# g5.xlarge: A10G 24GB — pi0.5 모델 전체 로드 가능
export XLA_PYTHON_CLIENT_PREALLOCATE=false
export XLA_PYTHON_CLIENT_MEM_FRACTION=0.90

# ── 서버 기동 ─────────────────────────────────────────────────────────────────
GRPC_PORT="${GRPC_PORT:-50051}"
HEALTH_PORT="${HEALTH_PORT:-8080}"

echo "Starting π0.5 gRPC server on port ${GRPC_PORT} (HTTP health on :${HEALTH_PORT})"
exec python3 /opt/ml/code/serve.py
