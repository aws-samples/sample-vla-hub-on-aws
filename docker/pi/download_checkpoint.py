#!/usr/bin/env python3
"""GCS 체크포인트 다운로드 헬퍼 — Dockerfile 빌드 시 실행

Public bucket: gs://openpi-assets/checkpoints/pi05_libero
인증 불필요 (anonymous client 사용)
"""

import os
import sys
from pathlib import Path

from google.cloud import storage

GCS_BUCKET   = "openpi-assets"
GCS_PREFIX   = "checkpoints/pi05_libero/"
LOCAL_BASE   = Path("/opt/pi-cache")
LOCAL_DEST   = LOCAL_BASE / "checkpoints" / "pi05_libero"


def main() -> None:
    print(f"Downloading gs://{GCS_BUCKET}/{GCS_PREFIX}")
    print(f"  → {LOCAL_DEST}")

    client = storage.Client.create_anonymous_client()
    bucket = client.bucket(GCS_BUCKET)
    blobs  = list(bucket.list_blobs(prefix=GCS_PREFIX))

    if not blobs:
        print(
            f"ERROR: No blobs found at gs://{GCS_BUCKET}/{GCS_PREFIX}",
            file=sys.stderr,
        )
        sys.exit(1)

    total_bytes = 0
    for blob in blobs:
        # blob.name = "checkpoints/pi05_droid/params/..."
        # → local: /opt/pi-cache/checkpoints/pi05_droid/params/...
        rel  = blob.name[len("checkpoints/"):]   # "pi05_libero/params/..."
        dest = LOCAL_BASE / "checkpoints" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(str(dest))
        total_bytes += blob.size or 0
        print(f"  {blob.name}  ({blob.size:,} bytes)")

    print(f"\nDone. {len(blobs)} files, {total_bytes / 1e9:.2f} GB → {LOCAL_DEST}")


if __name__ == "__main__":
    main()
