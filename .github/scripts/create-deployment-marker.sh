#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 8 ]]; then
  echo "Usage: $0 <environment> <sha> <manifest> <source-ci-run-id> <deployment-run-id> <mode> <audit-reason> <output-directory>" >&2
  exit 2
fi

environment_name="$1"
deploy_sha="$2"
manifest_path="$3"
source_ci_run_id="$4"
deployment_run_id="$5"
deployment_mode="$6"
audit_reason="$7"
output_directory="$8"

if [[ "$environment_name" != "staging" && "$environment_name" != "production" ]]; then
  echo "Deployment marker environment must be staging or production." >&2
  exit 2
fi
if [[ ! "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Deployment marker SHA must be a full lowercase Git SHA." >&2
  exit 2
fi
if [[ ! -s "$manifest_path" ]]; then
  echo "Release manifest is missing or empty: ${manifest_path}" >&2
  exit 2
fi
for run_id in "$source_ci_run_id" "$deployment_run_id"; do
  if [[ ! "$run_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "Deployment marker run IDs must be positive integers." >&2
    exit 2
  fi
done
if [[ ! "$deployment_mode" =~ ^(automatic|manual-staging|promote|break-glass-rollback)$ ]]; then
  echo "Unsupported deployment marker mode: ${deployment_mode}" >&2
  exit 2
fi

mkdir -p "$output_directory"
manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
deployed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
marker_path="$output_directory/deployment-marker.json"

jq -n \
  --arg environment "$environment_name" \
  --arg sha "$deploy_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  --arg source_ci_run_id "$source_ci_run_id" \
  --arg deployment_run_id "$deployment_run_id" \
  --arg mode "$deployment_mode" \
  --arg audit_reason "$audit_reason" \
  --arg deployed_at "$deployed_at" \
  --arg repository "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" '
  {
    schemaVersion: 1,
    repository: $repository,
    sha: $sha,
    environment: $environment,
    releaseManifestSha256: $manifest_sha256,
    sourceCiRunId: $source_ci_run_id,
    deploymentRunId: $deployment_run_id,
    mode: $mode,
    auditReason: (if $audit_reason == "" then null else $audit_reason end),
    deployedAt: $deployed_at
  }
' > "$marker_path"

(
  cd "$output_directory"
  sha256sum deployment-marker.json > deployment-marker.sha256
)
