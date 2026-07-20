#!/usr/bin/env bash
set -Eeuo pipefail

readonly GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the pinned Gitleaks scanner." >&2
  exit 127
fi

repository_root="$(git rev-parse --show-toplevel)"

gitleaks() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "${repository_root}:/repo:ro" \
    --workdir /repo \
    "${GITLEAKS_IMAGE}" \
    "$@" \
    --config /repo/.gitleaks.toml \
    --no-banner \
    --redact
}

# The history scan catches a secret that was added and later removed. The
# directory scan also protects local, not-yet-committed source changes.
gitleaks git .
gitleaks dir .
