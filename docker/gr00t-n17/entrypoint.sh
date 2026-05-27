#!/bin/bash
# CUDA Forward Compatibility 활성화
# ECS EC2 GPU AMI (드라이버 버전에 따라 compat 필요할 수 있음)
if [ -f /usr/local/cuda/compat/libcuda.so.1 ]; then
    CUDA_COMPAT_MAX_DRIVER_VERSION=$(readlink /usr/local/cuda/compat/libcuda.so.1 | cut -d'.' -f 3-)
    NVIDIA_DRIVER_VERSION=$(sed -n 's/^NVRM.*Kernel Module *\([0-9.]*\).*$/\1/p' /proc/driver/nvidia/version 2>/dev/null || true)
    echo "Host NVIDIA driver: ${NVIDIA_DRIVER_VERSION}, CUDA compat max: ${CUDA_COMPAT_MAX_DRIVER_VERSION}"
    if [ -n "$NVIDIA_DRIVER_VERSION" ]; then
        export LD_LIBRARY_PATH=/usr/local/cuda/compat:${LD_LIBRARY_PATH}
        echo "CUDA compat enabled: LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
    fi
else
    echo "No CUDA compat package found"
fi

# 2026-04-12: ZMQ / FastAPI 방식 → gRPC 재설계
# gRPC 서버 (포트 50051) + HTTP health 서버 (포트 8080) 동시 기동
# serve.py 내부에서 양쪽 포트를 모두 띄움
GRPC_PORT="${GRPC_PORT:-50051}"
HEALTH_PORT="${HEALTH_PORT:-8080}"

echo "Starting GR00T gRPC server on port ${GRPC_PORT} (HTTP health on :${HEALTH_PORT})"
exec python3 /opt/ml/code/serve.py
