#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "${repository_root}"

readonly compose_file="tests/web-e2e/admin-moderation.compose.yaml"
export COMPOSE_PROJECT_NAME="${E2E_COMPOSE_PROJECT_NAME:-alphanet-admin-moderation-e2e}"
export E2E_POSTGRES_PORT="${E2E_POSTGRES_PORT:-55432}"
export E2E_REDIS_PORT="${E2E_REDIS_PORT:-56379}"
export E2E_DYNAMODB_PORT="${E2E_DYNAMODB_PORT:-58000}"
export E2E_API_PORT="${E2E_API_PORT:-4400}"
export E2E_WEB_PORT="${E2E_WEB_PORT:-3300}"
export E2E_ADMIN_OIDC_PORT="${E2E_ADMIN_OIDC_PORT:-55560}"
export E2E_POSTGRES_DB="${E2E_POSTGRES_DB:-alphanet_admin_e2e}"
export E2E_POSTGRES_USER="${E2E_POSTGRES_USER:-alphanet}"
export E2E_POSTGRES_PASSWORD="${E2E_POSTGRES_PASSWORD:-alphanet_admin_e2e_local_only}"
export E2E_REDIS_PASSWORD="${E2E_REDIS_PASSWORD:-alphanet_admin_e2e_local_only}"

export DATABASE_URL="postgresql://${E2E_POSTGRES_USER}:${E2E_POSTGRES_PASSWORD}@127.0.0.1:${E2E_POSTGRES_PORT}/${E2E_POSTGRES_DB}"
export REDIS_URL="redis://:${E2E_REDIS_PASSWORD}@127.0.0.1:${E2E_REDIS_PORT}/0"
export E2E_ADMIN_OIDC_ISSUER="http://127.0.0.1:${E2E_ADMIN_OIDC_PORT}/workforce"
export E2E_ADMIN_OIDC_AUDIENCE="${E2E_ADMIN_OIDC_AUDIENCE:-urn:alphanet:admin-api:e2e}"
export E2E_ADMIN_OIDC_CLIENT_ID="${E2E_ADMIN_OIDC_CLIENT_ID:-alphanet-admin-web-e2e}"
export E2E_ADMIN_OIDC_CLIENT_SECRET="${E2E_ADMIN_OIDC_CLIENT_SECRET:-admin-web-e2e-client-secret-32-bytes-minimum}"
export E2E_ADMIN_OIDC_SUBJECT="${E2E_ADMIN_OIDC_SUBJECT:-alphanet-e2e-content-moderator}"
export E2E_ADMIN_OIDC_REDIRECT_URI="http://127.0.0.1:${E2E_WEB_PORT}/admin/auth/callback"
export E2E_AUTHOR_PASSWORD="${E2E_AUTHOR_PASSWORD:-Author-owner-e2e-password-2026}"
export E2E_REPORTER_PASSWORD="${E2E_REPORTER_PASSWORD:-Reporter-owner-e2e-password-2026}"
export ALPHANET_ALLOW_ADMIN_E2E_SEED=1
export ALPHANET_ALLOW_UI_DEMO_SEED=1
export NODE_ENV=development

export ADMIN_WEB_DYNAMODB_ENDPOINT="http://127.0.0.1:${E2E_DYNAMODB_PORT}"
export ADMIN_WEB_SESSION_TABLE="alphanet-admin-web-e2e-sessions"
export AWS_ACCESS_KEY_ID="DUMMYIDEXAMPLE"
export AWS_SECRET_ACCESS_KEY="DUMMYEXAMPLEKEYDUMMYEXAMPLEKEY1234567890"
export AWS_REGION="${AWS_REGION:-us-west-2}"
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN

compose=(docker compose --project-name "${COMPOSE_PROJECT_NAME}" --file "${compose_file}")
readonly e2e_web_runtime_prefix="${TMPDIR:-/tmp}/alphanet-admin-web-e2e."
E2E_WEB_RUNTIME_ROOT=""
export E2E_WEB_RUNTIME_ROOT

cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    echo "Admin moderation E2E failed; dependency logs follow." >&2
    "${compose[@]}" logs --no-color --tail 200 >&2 || true
  fi
  if [[ "${E2E_KEEP_SERVICES:-0}" != "1" ]]; then
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  else
    echo "Keeping ${COMPOSE_PROJECT_NAME} services for inspection." >&2
  fi
  if [[ -n "${E2E_WEB_RUNTIME_ROOT}" ]]; then
    case "${E2E_WEB_RUNTIME_ROOT}" in
      "${e2e_web_runtime_prefix}"*) rm -rf -- "${E2E_WEB_RUNTIME_ROOT}" ;;
      *)
        echo "Refusing to remove unexpected Admin E2E runtime path." >&2
        status=1
        ;;
    esac
  fi
  exit "${status}"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the Admin moderation E2E suite." >&2
  exit 127
}
command -v pnpm >/dev/null 2>&1 || {
  echo "pnpm is required for the Admin moderation E2E suite." >&2
  exit 127
}
command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required to isolate the Admin E2E Web build." >&2
  exit 127
}

# A developer may already have `next dev` serving the local preview. Two Next
# processes cannot safely share apps/web/.next, so the browser suite gets an
# ephemeral source mirror and its own build output.
E2E_WEB_RUNTIME_ROOT="$(
  mktemp -d "${e2e_web_runtime_prefix}XXXXXX"
)"
mkdir -p "${E2E_WEB_RUNTIME_ROOT}/apps" "${E2E_WEB_RUNTIME_ROOT}/packages"
rsync -a --exclude ".next/" --exclude ".env*" \
  apps/web/ "${E2E_WEB_RUNTIME_ROOT}/apps/web/"
rsync -a --exclude "node_modules/" --exclude ".env*" \
  packages/contracts/ "${E2E_WEB_RUNTIME_ROOT}/packages/contracts/"
rsync -a package.json pnpm-workspace.yaml tsconfig.base.json \
  "${E2E_WEB_RUNTIME_ROOT}/"
ln -s "${repository_root}/node_modules" "${E2E_WEB_RUNTIME_ROOT}/node_modules"

"${compose[@]}" config --quiet
"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up --detach --wait --wait-timeout 180 postgres redis dynamodb

node apps/web/scripts/create-admin-e2e-table.mjs
node packages/auth/scripts/seed-admin-moderation-e2e.mjs

pnpm exec playwright test --config playwright.admin-moderation.config.ts
