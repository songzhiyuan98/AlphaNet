#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
mkdir -p "$test_directory/bin" "$test_directory/fixtures/release"

readonly deploy_sha="0123456789abcdef0123456789abcdef01234567"
readonly repository="songzhiyuan98/AlphaNet"
readonly image_prefix="123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet"

jq -n \
  --arg repository "$repository" \
  --arg sha "$deploy_sha" \
  --arg prefix "$image_prefix" '
  def image($target; $hex): {
    repository: ($prefix + "-" + $target),
    tag: ($prefix + "-" + $target + ":sha-" + $sha),
    digest: ("sha256:" + ($hex * 64)),
    runtimeDigest: ("sha256:" + ("f" * 64)),
    reference: ($prefix + "-" + $target + "@sha256:" + ($hex * 64))
  };
  {
    schemaVersion: 1,
    repository: $repository,
    sha: $sha,
    workflowRunId: "101",
    createdAt: "2026-07-20T00:00:00Z",
    images: {
      api: image("api"; "a"),
      mcp: image("mcp"; "b"),
      migrate: image("migrate"; "c"),
      web: image("web"; "d"),
      worker: image("worker"; "e")
    }
  }
' > "$test_directory/fixtures/release/release-manifest.json"
(
  cd "$test_directory/fixtures/release"
  sha256sum release-manifest.json > release-manifest.sha256
  zip -q "$test_directory/release-manifest.zip" \
    release-manifest.json release-manifest.sha256
)
manifest_sha="$(sha256sum \
  "$test_directory/fixtures/release/release-manifest.json" | awk '{print $1}')"

for marker_environment in staging production; do
  marker_run_id=202
  if [[ "$marker_environment" == "production" ]]; then
    marker_run_id=303
  fi
  marker_directory="$test_directory/fixtures/marker-${marker_environment}"
  mkdir -p "$marker_directory"
  jq -n \
    --arg repository "$repository" \
    --arg sha "$deploy_sha" \
    --arg environment "$marker_environment" \
    --arg manifest_sha "$manifest_sha" \
    --arg run_id "$marker_run_id" '
    {
      schemaVersion: 1,
      repository: $repository,
      sha: $sha,
      environment: $environment,
      releaseManifestSha256: $manifest_sha,
      sourceCiRunId: "101",
      deploymentRunId: $run_id,
      mode: "automatic",
      auditReason: null,
      deployedAt: "2026-07-20T00:10:00Z"
    }
  ' > "$marker_directory/deployment-marker.json"
  (
    cd "$marker_directory"
    sha256sum deployment-marker.json > deployment-marker.sha256
    zip -q "$test_directory/marker-${marker_environment}.zip" \
      deployment-marker.json deployment-marker.sha256
  )
done

cat > "$test_directory/bin/git" <<'MOCK_GIT'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == "merge-base" && "$2" == "--is-ancestor" ]]; then
  exit 0
fi
echo "Unsupported mock git invocation: $*" >&2
exit 1
MOCK_GIT
chmod +x "$test_directory/bin/git"

cat > "$test_directory/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
output_path=""
url="${!#}"
printf '%s\n' "$url" >> "$MOCK_CURL_LOG"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    output_path="$2"
    shift 2
    continue
  fi
  shift
done

if [[ -n "$output_path" ]]; then
  case "$url" in
    https://artifacts.invalid/release) cp "$FIXTURE_ROOT/release-manifest.zip" "$output_path" ;;
    https://artifacts.invalid/staging) cp "$FIXTURE_ROOT/marker-staging.zip" "$output_path" ;;
    https://artifacts.invalid/production) cp "$FIXTURE_ROOT/marker-production.zip" "$output_path" ;;
    *) echo "Unsupported artifact URL: $url" >&2; exit 1 ;;
  esac
  exit 0
fi

case "$url" in
  *'/actions/workflows/ci.yml/runs?'*)
    printf '%s\n' '{"workflow_runs":[{"id":101,"run_number":8,"status":"completed","conclusion":"failure"}]}'
    ;;
  *'/actions/runs/101/jobs?'*)
    printf '%s\n' '{"jobs":[{"name":"Required","conclusion":"success"},{"name":"Release manifest","conclusion":"success"},{"name":"Publish (api)","conclusion":"success"},{"name":"Publish (mcp)","conclusion":"success"},{"name":"Publish (migrate)","conclusion":"success"},{"name":"Publish (web)","conclusion":"success"},{"name":"Publish (worker)","conclusion":"success"}]}'
    ;;
  *'/actions/runs/101/artifacts?'*)
    printf '%s\n' '{"artifacts":[{"name":"release-manifest-'"$DEPLOY_SHA"'","expired":false,"archive_download_url":"https://artifacts.invalid/release"}]}'
    ;;
  *'/actions/artifacts?name=deployment-marker-staging-'*)
    printf '%s\n' '{"artifacts":[{"id":2021,"expired":false,"created_at":"2026-07-20T00:10:00Z","archive_download_url":"https://artifacts.invalid/staging","workflow_run":{"id":202}}]}'
    ;;
  *'/actions/artifacts?name=deployment-marker-production-'*)
    printf '%s\n' '{"artifacts":[{"id":3031,"expired":false,"created_at":"2026-07-20T00:20:00Z","archive_download_url":"https://artifacts.invalid/production","workflow_run":{"id":303}}]}'
    ;;
  *'/actions/runs/202/jobs?'*)
    printf '%s\n' '{"jobs":[{"name":"Deploy staging","conclusion":"success"}]}'
    ;;
  *'/actions/runs/303/jobs?'*)
    printf '%s\n' '{"jobs":[{"name":"Deploy production","conclusion":"success"}]}'
    ;;
  *'/actions/runs/202')
    # Overall failure is intentional: staging proof stays valid when a later
    # production job in the same CI run failed.
    printf '%s\n' '{"status":"completed","conclusion":"failure","head_branch":"main","event":"push","name":"CI"}'
    ;;
  *'/actions/runs/303')
    printf '%s\n' '{"status":"completed","conclusion":"success","head_branch":"main","event":"push","name":"CI"}'
    ;;
  *) echo "Unsupported mock API URL: $url" >&2; exit 1 ;;
esac
MOCK_CURL
chmod +x "$test_directory/bin/curl"

run_mode() {
  local mode="$1"
  local confirm_production="false"
  local confirm_schema="false"
  local audit_reason=""
  local mode_directory="$test_directory/run-${mode}"
  mkdir -p "$mode_directory"
  if [[ "$mode" != "staging" ]]; then
    confirm_production="true"
  fi
  if [[ "$mode" == "break-glass-rollback" ]]; then
    confirm_schema="true"
    audit_reason="Incident rollback approved; schema compatibility reviewed."
  fi

  (
    cd "$mode_directory"
    env \
      PATH="$test_directory/bin:$PATH" \
      FIXTURE_ROOT="$test_directory" \
      AWS_DEPLOY_ENABLED=true \
      AWS_ECR_PUBLISH_ENABLED=true \
      AWS_ECR_REGISTRY="123456789012.dkr.ecr.us-west-2.amazonaws.com" \
      AWS_ECR_REPOSITORY_PREFIX=alphanet \
      AWS_REGION=us-west-2 \
      AUDIT_REASON="$audit_reason" \
      CONFIRM_PRODUCTION="$confirm_production" \
      CONFIRM_SCHEMA_COMPATIBLE="$confirm_schema" \
      DEPLOY_MODE="$mode" \
      DEPLOY_SHA="$deploy_sha" \
      GH_TOKEN=test-token \
      GITHUB_API_URL=https://api.github.invalid \
      GITHUB_OUTPUT="$mode_directory/github-output" \
      GITHUB_REF=refs/heads/main \
      GITHUB_REPOSITORY="$repository" \
      GITHUB_RUN_ID=404 \
      GITHUB_WORKSPACE="$repository_root" \
      MOCK_CURL_LOG="$mode_directory/curl.log" \
      bash "$repository_root/.github/scripts/resolve-manual-release.sh"
  )
  grep -q "mode=${mode}" "$mode_directory/github-output"
  if [[ "$mode" == "promote" ]] &&
    grep -q '/actions/artifacts?name=deployment-marker-staging-' \
      "$mode_directory/curl.log"; then
    echo "Promote must rely on its same-workflow staging dependency, not a historical marker." >&2
    exit 1
  fi
}

run_mode staging
run_mode promote
run_mode break-glass-rollback

echo "Manual release resolution fixture tests passed."
