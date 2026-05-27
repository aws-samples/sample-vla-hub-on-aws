#!/bin/bash
# efs-upload-models.sh — GR00T 모델 가중치를 EFS에 업로드
#
# 사전 요건:
#   1. EC2 인스턴스에서 실행 (VLA Hub VPC와 동일한 VPC에 위치)
#   2. EFS mount target이 EC2 AZ에 존재
#   3. EC2 인스턴스에 EFS SG(gr00t-models EFS)로부터 NFS 인바운드 허용 또는
#      인스턴스 SG가 EFS SG의 ingressRule에 등록되어 있어야 함
#   4. Secrets Manager에서 gr00t/hf-token 읽기 권한 (EC2 Instance Profile)
#   5. pip install huggingface-hub
#
# ⚠️ SSM 실행 시 주의사항 (2026-04-27 교훈):
#   - SSM RunShellScript에서 `aws` CLI 명령 사용 불가 (PATH에 없음)
#   - boto3도 기본 미설치 → `pip3 install boto3`로 먼저 설치 필요
#   - SSM 실행 역할이 Secrets Manager 권한 없으면 boto3도 AccessDenied
#   - 대안: HF_TOKEN을 로컬에서 가져와 환경변수로 주입하거나, EC2에서 직접 실행
#
# 사용법 (EC2에서 직접 실행):
#   export EFS_DNS=<efs-file-system-id>.efs.us-east-1.amazonaws.com  # CDK output 확인
#   export AWS_REGION=us-east-1
#   bash efs-upload-models.sh
#
# 사용법 (SSM에서 HF_TOKEN 직접 주입):
#   # 로컬에서 token 획득 후 스크립트에 embed해서 SSM 전달
#   HF_TOKEN=$(aws secretsmanager get-secret-value --secret-id gr00t/hf-token --query SecretString --output text)
#   python3 vla-hub/scripts/send_ssm_with_token.py $INSTANCE_ID $EFS_DNS $HF_TOKEN

set -euo pipefail

EFS_DNS="${EFS_DNS:?EFS_DNS env var required (e.g. fs-XXXXXX.efs.ap-northeast-2.amazonaws.com)}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
MOUNT_POINT="/mnt/gr00t-models"
HF_CACHE_DIR="${MOUNT_POINT}"

echo "=== GR00T N1.7 EFS Model Upload ==="
echo "EFS: ${EFS_DNS}"
echo "Mount: ${MOUNT_POINT}"

# ── EFS 마운트 ─────────────────────────────────────────────────────────────────
sudo apt-get install -y nfs-common 2>/dev/null || sudo yum install -y nfs-utils 2>/dev/null || true
sudo mkdir -p "${MOUNT_POINT}"
if ! mountpoint -q "${MOUNT_POINT}"; then
  sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport \
    "${EFS_DNS}:/" "${MOUNT_POINT}"
  echo "EFS mounted at ${MOUNT_POINT}"
else
  echo "EFS already mounted at ${MOUNT_POINT}"
fi
sudo chmod 777 "${MOUNT_POINT}"

# ── HF token 가져오기 ──────────────────────────────────────────────────────────
HF_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id gr00t/hf-token \
  --region "${AWS_REGION}" \
  --query SecretString \
  --output text)
echo "HF token retrieved from Secrets Manager"

# ── pip install ────────────────────────────────────────────────────────────────
pip install -q huggingface-hub 2>/dev/null || pip3 install -q huggingface-hub

# ── 모델 다운로드 ───────────────────────────────────────────────────────────────
# HF_HOME=/mnt/gr00t-models → 다운로드 경로:
#   /mnt/gr00t-models/hub/models--nvidia--GR00T-N1.7-LIBERO/snapshots/2ea293aa.../
#   /mnt/gr00t-models/hub/models--nvidia--Cosmos-Reason2-2B/snapshots/.../
export HF_HOME="${HF_CACHE_DIR}"

echo ""
echo "--- Downloading GR00T-N1.6-3B (base model, GR1 embodiment) ---"
python3 - <<PYEOF
import os
from huggingface_hub import snapshot_download
path = snapshot_download(
    "nvidia/GR00T-N1.6-3B",
    token=os.environ["HF_TOKEN"],
)
print(f"GR00T-N1.6-3B downloaded to: {path}")
PYEOF

echo ""
echo "--- Downloading GR00T-N1.7-LIBERO (revision: 2ea293aa20ba7cf5bbf3ba17a5fbcb1a01cbfe21) ---"
python3 - <<PYEOF
import os
from huggingface_hub import snapshot_download
path = snapshot_download(
    "nvidia/GR00T-N1.7-LIBERO",
    revision="2ea293aa20ba7cf5bbf3ba17a5fbcb1a01cbfe21",
    token=os.environ["HF_TOKEN"],
)
print(f"GR00T-N1.7-LIBERO downloaded to: {path}")
PYEOF

echo ""
echo "--- Downloading Cosmos-Reason2-2B (backbone, gated — andrewc76 동의 완료) ---"
python3 - <<PYEOF
import os
from huggingface_hub import snapshot_download
path = snapshot_download(
    "nvidia/Cosmos-Reason2-2B",
    token=os.environ["HF_TOKEN"],
)
print(f"Cosmos-Reason2-2B downloaded to: {path}")
PYEOF

echo ""
echo "=== Download complete. EFS model directory size ==="
du -sh "${MOUNT_POINT}/hub" 2>/dev/null || echo "(hub dir not found)"

echo ""
echo "=== Models on EFS ==="
ls "${MOUNT_POINT}/hub/" 2>/dev/null || echo "(empty)"

echo ""
echo "Done. EFS can now be safely unmounted."
echo "  sudo umount ${MOUNT_POINT}"
