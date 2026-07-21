#!/usr/bin/env bash
set -Eeuo pipefail

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is required to run the pinned Terraform toolchain." >&2
  exit 127
fi

docker_args=(run --rm \
  --user "$(id -u):$(id -g)" \
  -e AWS_ACCESS_KEY_ID \
  -e AWS_DEFAULT_REGION \
  -e AWS_PROFILE \
  -e AWS_REGION \
  -e AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN \
  -e HOME=/home/terraform)

if [[ -d "${HOME}/.aws" ]]; then
  docker_args+=(-v "${HOME}/.aws:/home/terraform/.aws:ro")
fi

docker_args+=( \
  -v "${PWD}:/workspace" \
  -w /workspace \
  hashicorp/terraform:1.15.8)

exec docker "${docker_args[@]}" "$@"
