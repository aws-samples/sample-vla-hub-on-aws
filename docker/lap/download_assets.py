#!/usr/bin/env python3
"""LAP-3B 빌드 시 에셋 pre-bake — Dockerfile RUN 단계에서 실행.

두 가지를 컨테이너 이미지에 내장(런타임 네트워크 접근 제거):
  1. HF 체크포인트 lihzha/LAP-3B-Libero  → ${MODEL_CHECKPOINT_DIR}
  2. PaliGemma 토크나이저 gs://big_vision/paligemma_tokenizer.model
     → openpi download.maybe_download 캐시 (${OPENPI_DATA_HOME})

토크나이저는 경로를 추측하지 않고 openpi 자체 함수를 호출해 캐시를 채운다.
런타임 maybe_download는 캐시 히트 시 재다운로드하지 않으므로 GCS egress가 불필요해진다.
"""

import os
import sys

HF_REPO     = os.environ.get("LAP_HF_REPO", "lihzha/LAP-3B-Libero")
HF_REVISION = os.environ.get("LAP_HF_REVISION", "")
CKPT_DIR    = os.environ.get("MODEL_CHECKPOINT_DIR", "/opt/lap-cache/checkpoints/lap_libero")
TOKENIZER_GS = "gs://big_vision/paligemma_tokenizer.model"


def download_checkpoint() -> None:
    from huggingface_hub import snapshot_download

    kwargs = {"repo_id": HF_REPO, "local_dir": CKPT_DIR}
    if HF_REVISION:
        kwargs["revision"] = HF_REVISION
    print(f"[download_assets] HF checkpoint {HF_REPO}"
          f"{('@' + HF_REVISION[:8]) if HF_REVISION else ''} → {CKPT_DIR}", flush=True)
    path = snapshot_download(**kwargs)
    print(f"[download_assets] checkpoint at: {path}", flush=True)


def prebake_tokenizer() -> None:
    """openpi 자체 download 함수로 토크나이저 캐시를 채운다 (경로 매핑 추측 회피)."""
    from openpi.shared import download

    print(f"[download_assets] PaliGemma tokenizer {TOKENIZER_GS} "
          f"→ OPENPI_DATA_HOME={os.environ.get('OPENPI_DATA_HOME', '~/.cache/openpi')}", flush=True)
    local = download.maybe_download(TOKENIZER_GS, gs={"token": "anon"})
    if not os.path.exists(local):
        print(f"[download_assets] ERROR: tokenizer not present after download: {local}",
              file=sys.stderr)
        sys.exit(1)
    print(f"[download_assets] tokenizer cached at: {local}", flush=True)


if __name__ == "__main__":
    download_checkpoint()
    prebake_tokenizer()
    print("[download_assets] done.", flush=True)
