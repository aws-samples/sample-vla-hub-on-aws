#!/bin/bash
# ECS 컨테이너 헬스 체크 커맨드 (pi/gr00t 패턴 동일)
# HTTP /health on localhost:8080 → 200 after model loads + JIT warmup
# (LAP-3B JAX 첫 컴파일이 느려 startPeriod 300s 동안은 실패 허용)
curl -sf http://localhost:8080/health > /dev/null && exit 0 || exit 1
