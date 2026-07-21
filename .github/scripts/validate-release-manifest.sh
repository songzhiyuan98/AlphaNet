#!/usr/bin/env bash
set -Eeuo pipefail

manifest_path="${1:-}"
expected_sha="${2:-}"
expected_repository="${3:-}"
expected_image_prefix="${4:-}"

if [[ -z "$manifest_path" || -z "$expected_sha" || -z "$expected_repository" ||
      -z "$expected_image_prefix" ]]; then
  echo "usage: validate-release-manifest.sh MANIFEST SHA OWNER/REPOSITORY ECR_IMAGE_PREFIX" >&2
  exit 2
fi

if [[ ! "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected SHA must be a full lowercase 40-character Git commit SHA." >&2
  exit 2
fi

if [[ ! -f "$manifest_path" ]]; then
  echo "Release manifest does not exist: ${manifest_path}" >&2
  exit 2
fi

expected_image_prefix="${expected_image_prefix%/}"
if [[ ! "$expected_image_prefix" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9]+([._/-][a-z0-9]+)*$ ]]; then
  echo "Expected image prefix is not a valid registry repository path." >&2
  exit 2
fi

jq -e \
  --arg repository "$expected_repository" \
  --arg sha "$expected_sha" \
  '
    .schemaVersion == 1 and
    .repository == $repository and
    .sha == $sha and
    (.workflowRunId | type == "string" and test("^[0-9]+$")) and
    (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) and
    (.images | keys == ["api", "mcp", "migrate", "web", "worker"])
  ' "$manifest_path" >/dev/null

for target in web api mcp worker migrate; do
  expected_image="${expected_image_prefix}-${target}"
  jq -e \
    --arg target "$target" \
    --arg repository "$expected_image" \
    --arg tag "${expected_image}:sha-${expected_sha}" \
    '
      .images[$target].repository == $repository and
      .images[$target].tag == $tag and
      (.images[$target].digest | type == "string" and
        test("^sha256:[0-9a-f]{64}$")) and
      (.images[$target].runtimeDigest | type == "string" and
        test("^sha256:[0-9a-f]{64}$")) and
      .images[$target].reference ==
        (.images[$target].repository + "@" + .images[$target].digest)
    ' "$manifest_path" >/dev/null
done

echo "Validated release manifest for ${expected_repository}@${expected_sha}."
