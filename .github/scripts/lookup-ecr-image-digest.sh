#!/usr/bin/env bash
set -Eeuo pipefail

repository_name="${1:-}"
image_tag="${2:-}"

if [[ ! "$repository_name" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*$ ]]; then
  echo "ECR repository name is invalid." >&2
  exit 2
fi
if [[ ! "$image_tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
  echo "ECR release tag must be sha- followed by a full lowercase commit SHA." >&2
  exit 2
fi

error_path="$(mktemp)"
trap 'rm -f "$error_path"' EXIT
if digest="$(aws ecr describe-images \
  --repository-name "$repository_name" \
  --image-ids "imageTag=${image_tag}" \
  --query 'imageDetails[0].imageDigest' \
  --output text 2> "$error_path")"; then
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ECR returned an invalid image digest." >&2
    exit 1
  fi
  printf '%s\n' "$digest"
  exit 0
fi

if grep -q 'ImageNotFoundException' "$error_path"; then
  exit 3
fi

cat "$error_path" >&2
exit 1
