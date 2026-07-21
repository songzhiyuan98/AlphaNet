#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  AWS_DEPLOY_ENABLED
  AWS_ECR_PUBLISH_ENABLED
  AWS_ECR_REGISTRY
  AWS_ECR_REPOSITORY_PREFIX
  AWS_REGION
  CONFIRM_PRODUCTION
  CONFIRM_SCHEMA_COMPATIBLE
  DEPLOY_MODE
  DEPLOY_SHA
  GH_TOKEN
  GITHUB_API_URL
  GITHUB_OUTPUT
  GITHUB_REF
  GITHUB_REPOSITORY
  GITHUB_RUN_ID
)
for variable_name in "${required_environment[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required environment variable: ${variable_name}" >&2
    exit 2
  fi
done

if [[ "$AWS_DEPLOY_ENABLED" != "true" ]]; then
  echo "::error::AWS deployment is not enabled; no ECS deployment was attempted."
  exit 1
fi
if [[ "$AWS_ECR_PUBLISH_ENABLED" != "true" ]]; then
  echo "::error::AWS deployment requires ECR publishing to be enabled."
  exit 1
fi
if [[ ! "$AWS_ECR_REGISTRY" =~ ^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$ ||
      "${BASH_REMATCH[1]:-}" != "$AWS_REGION" ]]; then
  echo "::error::AWS_ECR_REGISTRY must be the private ECR registry for AWS_REGION."
  exit 1
fi
if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then
  echo "::error::Manual Deploy must be dispatched from the main branch."
  exit 1
fi
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::deploy_sha must be a full lowercase 40-character Git commit SHA."
  exit 1
fi
if [[ ! "$DEPLOY_MODE" =~ ^(staging|promote|break-glass-rollback)$ ]]; then
  echo "::error::Unsupported manual deployment mode."
  exit 1
fi

target_environment="staging"
if [[ "$DEPLOY_MODE" != "staging" ]]; then
  target_environment="production"
  if [[ "$CONFIRM_PRODUCTION" != "true" ]]; then
    echo "::error::Production deployment requires confirm_production."
    exit 1
  fi
fi
if [[ "$DEPLOY_MODE" == "break-glass-rollback" ]]; then
  if [[ "$CONFIRM_SCHEMA_COMPATIBLE" != "true" ]]; then
    echo "::error::Break-glass rollback requires an explicit schema-compatibility confirmation."
    exit 1
  fi
  audit_reason="${AUDIT_REASON:-}"
  if ((${#audit_reason} < 20)); then
    echo "::error::Break-glass rollback requires an audit reason of at least 20 characters."
    exit 1
  fi
fi

if ! git merge-base --is-ancestor "$DEPLOY_SHA" HEAD; then
  echo "::error::deploy_sha is not reachable from main."
  exit 1
fi

api_headers=(
  --header "Accept: application/vnd.github+json"
  --header "Authorization: Bearer ${GH_TOKEN}"
  --header "X-GitHub-Api-Version: 2022-11-28"
)
api_get() {
  curl --silent --show-error --fail-with-body "${api_headers[@]}" "$1"
}

runs_url="${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&head_sha=${DEPLOY_SHA}&per_page=100"
runs_response="$(api_get "$runs_url")"
candidate_run_ids=()
while IFS= read -r candidate_run_id; do
  candidate_run_ids+=("$candidate_run_id")
done < <(jq -r '
  .workflow_runs | sort_by(.run_number) | reverse | .[].id
' <<< "$runs_response")

source_run_id=""
artifact_url=""
manifest_name="release-manifest-${DEPLOY_SHA}"
for candidate_run_id in "${candidate_run_ids[@]}"; do
  jobs_url="${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${candidate_run_id}/jobs?filter=latest&per_page=100"
  jobs_response="$(api_get "$jobs_url")"
  if ! jq -e '
    ([.jobs[] | select(.name == "Required" and .conclusion == "success")] | length) == 1 and
    ([.jobs[] | select(.name == "Release manifest" and .conclusion == "success")] | length) == 1 and
    ([.jobs[] | select(.name | startswith("Publish ("))] | length) == 5 and
    all(.jobs[] | select(.name | startswith("Publish (")); .conclusion == "success")
  ' <<< "$jobs_response" >/dev/null; then
    continue
  fi

  artifacts_url="${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${candidate_run_id}/artifacts?name=${manifest_name}&per_page=100"
  artifacts_response="$(api_get "$artifacts_url")"
  candidate_artifact_url="$(jq -r --arg name "$manifest_name" '
    [.artifacts[] | select(.name == $name and .expired == false)] |
    first | .archive_download_url // empty
  ' <<< "$artifacts_response")"
  if [[ -n "$candidate_artifact_url" ]]; then
    source_run_id="$candidate_run_id"
    artifact_url="$candidate_artifact_url"
    break
  fi
done

if [[ -z "$source_run_id" || -z "$artifact_url" ]]; then
  echo "::error::No completed main CI run has successful Required, Release manifest, all five Publish jobs, and an unexpired manifest artifact for deploy_sha."
  exit 1
fi

mkdir -p release
curl --silent --show-error --fail-with-body --location \
  "${api_headers[@]}" --output release-manifest.zip "$artifact_url"
unzip -q release-manifest.zip -d release
(
  cd release
  sha256sum --check release-manifest.sha256
)
bash "${GITHUB_WORKSPACE:-$(pwd)}/.github/scripts/validate-release-manifest.sh" \
  release/release-manifest.json "$DEPLOY_SHA" "$GITHUB_REPOSITORY" \
  "${AWS_ECR_REGISTRY}/${AWS_ECR_REPOSITORY_PREFIX}"
if ! jq -e --arg run_id "$source_run_id" '.workflowRunId == $run_id' \
  release/release-manifest.json >/dev/null; then
  echo "::error::Release manifest workflowRunId does not match the CI run that supplied the artifact."
  exit 1
fi
release_manifest_sha256="$(sha256sum release/release-manifest.json | awk '{print $1}')"

verify_deployment_marker() {
  local environment_name="$1"
  local expected_job_name="$2"
  local marker_name="deployment-marker-${environment_name}-${DEPLOY_SHA}"
  local marker_index marker_artifacts marker_id marker_run_id marker_url
  local marker_run marker_jobs marker_directory

  marker_index="$(api_get \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${marker_name}&per_page=100")"
  marker_artifacts=()
  while IFS= read -r marker_artifact; do
    marker_artifacts+=("$marker_artifact")
  done < <(jq -r '
    [.artifacts[] | select(.expired == false)] |
    sort_by(.created_at) | reverse | .[] | [.id, .workflow_run.id, .archive_download_url] | @tsv
  ' <<< "$marker_index")

  for marker_artifact in "${marker_artifacts[@]}"; do
    IFS=$'\t' read -r marker_id marker_run_id marker_url <<< "$marker_artifact"
    marker_run="$(api_get \
      "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${marker_run_id}")"
    if ! jq -e '
      .status == "completed" and
      .head_branch == "main" and
      (.event == "push" or .event == "workflow_dispatch") and
      (.name == "CI" or .name == "Manual Deploy")
    ' <<< "$marker_run" >/dev/null; then
      continue
    fi
    marker_jobs="$(api_get \
      "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${marker_run_id}/jobs?filter=latest&per_page=100")"
    if ! jq -e --arg job "$expected_job_name" '
      ([.jobs[] | select(.name == $job and .conclusion == "success")] | length) == 1
    ' <<< "$marker_jobs" >/dev/null; then
      continue
    fi

    marker_directory="deployment-marker-${marker_id}"
    mkdir -p "$marker_directory"
    curl --silent --show-error --fail-with-body --location \
      "${api_headers[@]}" --output deployment-marker.zip "$marker_url"
    unzip -q deployment-marker.zip -d "$marker_directory"
    if ! (
      cd "$marker_directory"
      sha256sum --check deployment-marker.sha256
    ); then
      continue
    fi
    if jq -e \
      --arg repository "$GITHUB_REPOSITORY" \
      --arg sha "$DEPLOY_SHA" \
      --arg environment "$environment_name" \
      --arg manifest_sha "$release_manifest_sha256" \
      --arg run_id "$marker_run_id" '
      .schemaVersion == 1 and
      .repository == $repository and
      .sha == $sha and
      .environment == $environment and
      .releaseManifestSha256 == $manifest_sha and
      .deploymentRunId == $run_id and
      (.deployedAt | type == "string" and length > 0)
    ' "$marker_directory/deployment-marker.json" >/dev/null; then
      return 0
    fi
  done
  return 1
}

if [[ "$DEPLOY_MODE" == "break-glass-rollback" ]] &&
  ! verify_deployment_marker production "Deploy production"; then
  echo "::error::Break-glass rollback is limited to an exact release previously deployed successfully to production."
  exit 1
fi

validated_artifact="validated-release-manifest-${DEPLOY_SHA}-${GITHUB_RUN_ID}"
{
  echo "deploy_sha=$DEPLOY_SHA"
  echo "manifest_artifact=$validated_artifact"
  echo "mode=$DEPLOY_MODE"
  echo "source_run_id=$source_run_id"
  echo "target=$target_environment"
} >> "$GITHUB_OUTPUT"
