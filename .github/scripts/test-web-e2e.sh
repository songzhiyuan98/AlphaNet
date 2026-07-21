#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

# The public Web E2E suite always runs the current production output. Cleaning here
# prevents a local invocation from silently exercising an older standalone bundle.
pnpm --filter @alphanet/web... clean
pnpm --filter @alphanet/web... build
exec pnpm exec playwright test --config playwright.config.ts
