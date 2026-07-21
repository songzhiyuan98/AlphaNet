#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

# NEXT_PUBLIC_* values are compiled into the browser bundle. Point the E2E
# build at its isolated public API stub so client-side Search exercises the
# real cross-origin POST/CORS boundary instead of a same-origin 404.
public_api_port="${E2E_PUBLIC_API_PORT:-49999}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:${public_api_port}}"

# The public Web E2E suite always runs the current production output. Cleaning here
# prevents a local invocation from silently exercising an older standalone bundle.
pnpm --filter @alphanet/web... clean
pnpm --filter @alphanet/web... build
exec pnpm exec playwright test --config playwright.config.ts
