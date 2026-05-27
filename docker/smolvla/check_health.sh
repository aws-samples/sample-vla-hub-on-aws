#!/bin/bash
curl -sf http://localhost:8080/health > /dev/null && exit 0 || exit 1
