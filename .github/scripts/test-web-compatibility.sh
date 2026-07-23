#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

public_api_port="${E2E_PUBLIC_API_PORT:-50999}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:${public_api_port}}"

pnpm --filter @alphanet/web... clean
pnpm --filter @alphanet/web... build
exec pnpm exec playwright test --config playwright.compatibility.config.ts
