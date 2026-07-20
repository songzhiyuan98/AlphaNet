#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(git rev-parse --show-toplevel)"
readonly web_root="${repository_root}/apps/web"
readonly standalone_app="${web_root}/.next/standalone/apps/web"

if [[ ! -f "${standalone_app}/server.js" ]]; then
  echo "Build @alphanet/web before starting its standalone E2E server." >&2
  exit 2
fi

mkdir -p "${standalone_app}/.next/static"
cp -R "${web_root}/.next/static/." "${standalone_app}/.next/static/"
if [[ -d "${web_root}/public" ]]; then
  mkdir -p "${standalone_app}/public"
  cp -R "${web_root}/public/." "${standalone_app}/public/"
fi

cd "${standalone_app}"
export HOSTNAME="${E2E_HOSTNAME:-127.0.0.1}"
export PORT="${PORT:-3000}"
exec node server.js
