#!/usr/bin/env bash
set -Eeuo pipefail

raw_manifest_path="${1:-}"
top_level_digest="${2:-}"

if [[ -z "$raw_manifest_path" || -z "$top_level_digest" ]]; then
  echo "usage: resolve-runtime-digest.sh RAW_MANIFEST TOP_LEVEL_DIGEST" >&2
  exit 2
fi
if [[ ! -f "$raw_manifest_path" ]]; then
  echo "Raw image manifest does not exist: ${raw_manifest_path}" >&2
  exit 2
fi
if [[ ! "$top_level_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Top-level image digest is invalid." >&2
  exit 2
fi

runtime_digest="$(jq -er --arg top_digest "$top_level_digest" '
  if (.manifests? | type) == "array" then
    [
      .manifests[] |
      select(
        .platform.os == "linux" and
        .platform.architecture == "amd64"
      ) |
      .digest
    ] |
    if length == 1 then
      .[0]
    else
      error("expected exactly one linux/amd64 image manifest")
    end
  else
    $top_digest
  end
' "$raw_manifest_path")"

if [[ ! "$runtime_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Resolved runtime image digest is invalid." >&2
  exit 1
fi

printf '%s\n' "$runtime_digest"
