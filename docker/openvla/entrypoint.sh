#!/bin/bash
# CUDA Forward Compatibility — only enable if host driver < CUDA runtime requirement.
# Driver 525+ natively supports CUDA 12.x; adding compat stubs on top causes Error 803.
if [ -f /usr/local/cuda/compat/libcuda.so.1 ]; then
    NVIDIA_DRIVER_VERSION=$(sed -n 's/^NVRM.*Kernel Module *\([0-9.]*\).*$/\1/p' /proc/driver/nvidia/version 2>/dev/null || true)
    DRIVER_MAJOR=$(echo "${NVIDIA_DRIVER_VERSION}" | cut -d. -f1)
    if [ -n "$DRIVER_MAJOR" ] && [ "$DRIVER_MAJOR" -lt 525 ]; then
        export LD_LIBRARY_PATH=/usr/local/cuda/compat:${LD_LIBRARY_PATH}
        echo "CUDA compat enabled (driver ${NVIDIA_DRIVER_VERSION} < 525): LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
    else
        echo "CUDA compat skipped (driver ${NVIDIA_DRIVER_VERSION} >= 525, native CUDA 12.x support)"
    fi
fi

GRPC_PORT="${GRPC_PORT:-50053}"
HEALTH_PORT="${HEALTH_PORT:-8080}"

echo "Starting OpenVLA-7B gRPC server on port ${GRPC_PORT} (HTTP health on :${HEALTH_PORT})"
exec python3 /opt/ml/code/serve.py
