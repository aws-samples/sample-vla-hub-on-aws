#!/bin/bash
# ECS 컨테이너 헬스 체크 커맨드 (gr00t 패턴 동일)
# HTTP /health on localhost:8080 → 200 after model loads + JIT warmup (~3 min)
curl -sf http://localhost:8080/health > /dev/null && exit 0 || exit 1
