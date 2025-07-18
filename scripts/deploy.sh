#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <owner> <image-name> [tag]" >&2
  exit 1
fi

GH_OWNER="${1,,}"
IMAGE_NAME=${2:?“Missing image name (arg2)”}
TAG=${3:-latest}

FULL_IMAGE="ghcr.io/${GH_OWNER}/${IMAGE_NAME}:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/.."
cd "${ROOT_DIR}"

echo "→ Building Docker image ${FULL_IMAGE}"
docker build -t "${FULL_IMAGE}" .

echo "→ Logging in to GitHub Container Registry (ghcr.io)"
# In CI: ensure GITHUB_TOKEN or a PAT is exported as GHCR_TOKEN
echo "${GHCR_TOKEN:?“Please set GHCR_TOKEN”}" \
  | docker login ghcr.io --username "${GH_OWNER}" --password-stdin

echo "→ Pushing ${FULL_IMAGE} to GHCR"
docker push "${FULL_IMAGE}"

echo "✅ Done! Image available at https://ghcr.io/${GH_OWNER}/${IMAGE_NAME}"
