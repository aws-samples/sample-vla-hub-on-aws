#!/bin/bash
# Mode-aware health check (used as ECS container health check command)
# Both modes check /health on localhost:8080.
#
# HTTP mode: FastAPI /health → 200 after model loads (~5 min).
#   ECS startPeriod (300s) covers this window.
#
# ZMQ mode: background HTTP server /health → always 200.
#   The container stays "healthy" from ECS's perspective throughout ZMQ startup.
#   ZMQ readiness is tracked separately: NLB health check targets /health/zmq,
#   which returns 503 until the nc-polling loop in entrypoint.sh detects port 8000.
curl -sf http://localhost:8080/health > /dev/null && exit 0 || exit 1
