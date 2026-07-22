#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT

mock_bin="$test_directory/bin"
mock_state="$test_directory/state"
mkdir -p "$mock_bin" "$mock_state/registered" "$mock_state/current"

readonly deploy_sha="0123456789abcdef0123456789abcdef01234567"
readonly image_prefix="123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet"
readonly manifest_path="$test_directory/release-manifest.json"

cat > "$mock_bin/timeout" <<'MOCK_TIMEOUT'
#!/usr/bin/env bash
set -Eeuo pipefail
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --foreground|--signal=*|--kill-after=*) shift ;;
    *s) shift; break ;;
    *) echo "Unexpected timeout option: $1" >&2; exit 2 ;;
  esac
done
exec "$@"
MOCK_TIMEOUT
chmod +x "$mock_bin/timeout"

cat > "$mock_bin/date" <<'MOCK_DATE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$#" -eq 1 && "$1" == "+%s" &&
      "${MOCK_DATE_ADVANCE_SECONDS:-0}" =~ ^[1-9][0-9]*$ &&
      -f "${MOCK_AWS_STATE:?}/advance-date" ]]; then
  state_path="$MOCK_AWS_STATE/mock-date-epoch"
  if [[ -f "$state_path" ]]; then
    epoch="$(<"$state_path")"
  else
    epoch="$(/bin/date +%s)"
  fi
  epoch="$((epoch + MOCK_DATE_ADVANCE_SECONDS))"
  printf '%s' "$epoch" > "$state_path"
  printf '%s\n' "$epoch"
  exit 0
fi
exec /bin/date "$@"
MOCK_DATE
chmod +x "$mock_bin/date"

top_digest="sha256:$(printf '1%.0s' {1..64})"
runtime_digest="sha256:$(printf '2%.0s' {1..64})"
printf '%s\n' '{"schemaVersion":2}' > "$test_directory/direct-manifest.json"
test "$(bash "$repository_root/.github/scripts/resolve-runtime-digest.sh" \
  "$test_directory/direct-manifest.json" "$top_digest")" = "$top_digest"
jq -n --arg runtime_digest "$runtime_digest" '{
  schemaVersion: 2,
  manifests: [{
    digest: $runtime_digest,
    platform: {os: "linux", architecture: "amd64"}
  }, {
    digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    platform: {os: "unknown", architecture: "unknown"}
  }]
}' > "$test_directory/index-manifest.json"
test "$(bash "$repository_root/.github/scripts/resolve-runtime-digest.sh" \
  "$test_directory/index-manifest.json" "$top_digest")" = "$runtime_digest"
jq '.manifests += [.manifests[0]]' \
  "$test_directory/index-manifest.json" > "$test_directory/ambiguous-index.json"
if bash "$repository_root/.github/scripts/resolve-runtime-digest.sh" \
  "$test_directory/ambiguous-index.json" "$top_digest" >/dev/null 2>&1; then
  echo "Expected an ambiguous linux/amd64 index to fail." >&2
  exit 1
fi

jq -n \
  --arg repository "songzhiyuan98/AlphaNet" \
  --arg sha "$deploy_sha" \
  --arg prefix "$image_prefix" '
  def image($target; $hex):
    {
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
    workflowRunId: "1234",
    createdAt: "2026-07-20T00:00:00Z",
    images: {
      api: image("api"; "a"),
      mcp: image("mcp"; "b"),
      migrate: image("migrate"; "c"),
      web: image("web"; "d"),
      worker: image("worker"; "e")
    }
  }
' > "$manifest_path"

mock_aws_path="$mock_bin/aws"

cat > "$mock_aws_path" <<'MOCK_AWS'
#!/usr/bin/env bash
set -Eeuo pipefail

arg_value() {
  local wanted="$1"
  shift
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "$wanted" ]]; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

target_from_name() {
  if [[ "$1" == *"runtime-smoke" ]]; then
    printf '%s' "runtime-smoke"
    return
  fi
  printf '%s' "${1##*-}"
}

image_for_target() {
  jq -r --arg target "$1" '.images[$target].reference' "$MOCK_MANIFEST"
}

digest_for_target() {
  jq -r --arg target "$1" '.images[$target].runtimeDigest' "$MOCK_MANIFEST"
}

printf '%s\n' "$*" >> "$MOCK_AWS_LOG"

service="$1"
operation="$2"
shift 2

if [[ "$service" == "sts" && "$operation" == "get-caller-identity" ]]; then
  echo "123456789012"
  exit 0
fi

if [[ "$service" == "ecr" && "$operation" == "describe-images" ]]; then
  case "${MOCK_ECR_MODE:-exists}" in
    exists)
      echo "${MOCK_ECR_DIGEST}"
      ;;
    absent)
      echo 'An error occurred (ImageNotFoundException) when calling DescribeImages' >&2
      exit 254
      ;;
    denied)
      echo 'An error occurred (AccessDeniedException) when calling DescribeImages' >&2
      exit 254
      ;;
  esac
  exit 0
fi

if [[ "$service" != "ecs" ]]; then
  echo "Unsupported mock AWS service: ${service}" >&2
  exit 1
fi

case "$operation" in
  describe-task-definition)
    task_definition="$(arg_value --task-definition "$@")"
    if [[ "$task_definition" == arn:* ]]; then
      family_revision="${task_definition##*/}"
      family="${family_revision%:*}"
      revision="${family_revision##*:}"
      if [[ -f "$MOCK_AWS_STATE/registered/${family}-${revision}.json" ]]; then
        jq -n \
          --arg arn "$task_definition" \
          --slurpfile task "$MOCK_AWS_STATE/registered/${family}-${revision}.json" '
          {
            taskDefinition: (($task[0] | del(.tags)) + {
              taskDefinitionArn: $arn,
              status: "ACTIVE"
            }),
            tags: ($task[0].tags // [])
          }
        '
        exit 0
      fi
    else
      family="$task_definition"
    fi
    target="$(target_from_name "$family")"
    jq -n \
      --arg arn "$task_definition" \
      --arg family "$family" \
      --arg target "$target" '
      {
        taskDefinition: {
          taskDefinitionArn: $arn,
          family: $family,
          status: "ACTIVE",
          executionRoleArn: "arn:aws:iam::123456789012:role/execution",
          taskRoleArn: "arn:aws:iam::123456789012:role/task",
          networkMode: "awsvpc",
          containerDefinitions: [{
            name: $target,
            image: "old.invalid/image@sha256:old",
            entryPoint: (
              if $target == "migrate" then
                ["/bin/bash", "/opt/alphanet/db/scripts/aws-migrate-release.sh"]
              elif $target == "runtime-smoke" then
                ["/bin/bash", "/opt/alphanet/db/scripts/aws-smoke-runtime.sh"]
              else null end
            ),
            environment: [{name: "APP_VERSION", value: "terraform-placeholder"}]
          }],
          volumes: [],
          placementConstraints: [],
          requiresCompatibilities: ["FARGATE"],
          cpu: "256",
          memory: "512",
          runtimePlatform: {cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX"}
        },
        tags: [
          {key: "alphanet:managed-by", value: "terraform"},
          {key: "alphanet:deployment-baseline", value: "true"}
        ]
      }
    '
    ;;
  register-task-definition)
    input="$(arg_value --cli-input-json "$@")"
    input_path="${input#file://}"
    family="$(jq -r '.family' "$input_path")"
    if [[ -f "$MOCK_AWS_STATE/registered/${family}-2.json" ]]; then
      revision=3
    else
      revision=2
    fi
    cp "$input_path" "$MOCK_AWS_STATE/registered/${family}-${revision}.json"
    echo "arn:aws:ecs:us-west-2:123456789012:task-definition/${family}:${revision}"
    ;;
  deregister-task-definition)
    echo '{}'
    ;;
  run-task)
    if cli_input="$(arg_value --cli-input-json "$@")"; then
      request_path="${cli_input#file://}"
      task_definition="$(jq -r '.taskDefinition' "$request_path")"
      started_by="$(jq -r '.startedBy' "$request_path")"
      client_token="$(jq -r '.clientToken' "$request_path")"
    else
      task_definition="$(arg_value --task-definition "$@")"
      started_by="$(arg_value --started-by "$@")"
      client_token="$(arg_value --client-token "$@")"
    fi
    printf 'run-task-request taskDefinition=%s startedBy=%s clientToken=%s\n' \
      "$task_definition" "$started_by" "$client_token" >> "$MOCK_AWS_LOG"
    if [[ "$task_definition" == *"runtime-smoke"* ]]; then
      task_name="runtime-smoke-task"
    else
      task_name="migrate-task"
    fi
    printf '%s' "$task_definition" > "$MOCK_AWS_STATE/${task_name}-definition"
    timeout_count="${MOCK_RUN_TASK_TIMEOUT_COUNT:-0}"
    timeout_state="$MOCK_AWS_STATE/run-task-timeout-count"
    used_timeouts=0
    if [[ -f "$timeout_state" ]]; then
      used_timeouts="$(<"$timeout_state")"
    fi
    if ((used_timeouts < timeout_count)); then
      printf '%s' "$((used_timeouts + 1))" > "$timeout_state"
      printf '%s' "$started_by" > "$MOCK_AWS_STATE/uncertain-started-by"
      if [[ "${MOCK_TRIGGER_DATE_ON_TIMEOUT:-false}" == "true" ]]; then
        : > "$MOCK_AWS_STATE/advance-date"
      fi
      exit 124
    fi
    jq -n --arg task "arn:aws:ecs:us-west-2:123456789012:task/${task_name}" \
      '{failures: [], tasks: [{taskArn: $task}]}'
    ;;
  stop-task)
    echo '{}'
    ;;
  wait)
    exit 0
    ;;
  describe-services)
    service_names=()
    collect=false
    for value in "$@"; do
      if [[ "$value" == "--services" ]]; then
        collect=true
        continue
      fi
      if [[ "$collect" == "true" && "$value" == --* ]]; then
        break
      fi
      if [[ "$collect" == "true" ]]; then
        service_names+=("$value")
      fi
    done
    services_json='[]'
    for service_name in "${service_names[@]}"; do
      target="$(target_from_name "$service_name")"
      family="alphanet-staging-${target}"
      current_path="$MOCK_AWS_STATE/current/${service_name}"
      desired_path="$MOCK_AWS_STATE/current/${service_name}.desired"
      if [[ -f "$current_path" ]]; then
        task_definition="$(<"$current_path")"
      else
        task_definition="arn:aws:ecs:us-west-2:123456789012:task-definition/${family}:1"
      fi
      lag_path="$MOCK_AWS_STATE/current/${service_name}.lag"
      previous_path="$MOCK_AWS_STATE/current/${service_name}.previous"
      if [[ -f "$lag_path" && "$(<"$lag_path")" -gt 0 ]]; then
        task_definition="$(<"$previous_path")"
        printf '%s' "$(( $(<"$lag_path") - 1 ))" > "$lag_path"
      fi
      if [[ -f "$desired_path" ]]; then
        desired="$(<"$desired_path")"
      elif [[ "${MOCK_ZERO_DESIRED_SERVICE:-}" == "$service_name" ]]; then
        desired=0
      else
        desired=1
      fi
      services_json="$(jq -cn \
        --argjson services "$services_json" \
        --arg service "$service_name" \
        --arg task_definition "$task_definition" \
        --argjson desired "$desired" '
        $services + [{
          serviceName: $service,
          serviceArn: ("arn:aws:ecs:us-west-2:123456789012:service/alphanet-staging/" + $service),
          status: "ACTIVE",
          desiredCount: $desired,
          runningCount: $desired,
          pendingCount: 0,
          taskDefinition: $task_definition,
          deploymentConfiguration: {
            deploymentCircuitBreaker: {enable: true, rollback: true}
          },
          deployments: [{
            status: "PRIMARY",
            taskDefinition: $task_definition,
            desiredCount: $desired,
            runningCount: $desired,
            pendingCount: 0,
            rolloutState: "COMPLETED"
          }],
          events: []
        }]
      ')"
    done
    jq -n --argjson services "$services_json" '{failures: [], services: $services}'
    ;;
  update-service)
    service_name="$(arg_value --service "$@")"
    task_definition="$(arg_value --task-definition "$@")"
    target="$(target_from_name "$service_name")"
    family="alphanet-staging-${target}"
    current_path="$MOCK_AWS_STATE/current/${service_name}"
    if [[ -f "$current_path" ]]; then
      previous_task_definition="$(<"$current_path")"
    else
      previous_task_definition="arn:aws:ecs:us-west-2:123456789012:task-definition/${family}:1"
    fi
    desired_path="$MOCK_AWS_STATE/current/${service_name}.desired"
    if desired="$(arg_value --desired-count "$@")"; then
      :
    elif [[ -f "$desired_path" ]]; then
      desired="$(<"$desired_path")"
    elif [[ "${MOCK_ZERO_DESIRED_SERVICE:-}" == "$service_name" ]]; then
      desired=0
    else
      desired=1
    fi
    printf '%s' "$task_definition" > "$current_path"
    printf '%s' "$desired" > "$desired_path"
    if [[ "${MOCK_EVENTUAL_CONSISTENCY:-false}" == "true" &&
          "$task_definition" != "$previous_task_definition" ]]; then
      printf '%s' "$previous_task_definition" > "$MOCK_AWS_STATE/current/${service_name}.previous"
      printf '%s' 1 > "$MOCK_AWS_STATE/current/${service_name}.lag"
    fi
    echo '{}'
    ;;
  list-tasks)
    if started_by="$(arg_value --started-by "$@")"; then
      if [[ -f "$MOCK_AWS_STATE/uncertain-started-by" &&
            "$(<"$MOCK_AWS_STATE/uncertain-started-by")" == "$started_by" ]]; then
        list_count_path="$MOCK_AWS_STATE/list-task-count"
        list_count=0
        if [[ -f "$list_count_path" ]]; then
          list_count="$(<"$list_count_path")"
        fi
        printf '%s' "$((list_count + 1))" > "$list_count_path"
        if ((list_count < ${MOCK_LIST_TASK_EMPTY_COUNT:-0})); then
          jq -n '{taskArns: []}'
        else
          jq -n '{taskArns: ["arn:aws:ecs:us-west-2:123456789012:task/migrate-task"]}'
        fi
      else
        jq -n '{taskArns: []}'
      fi
      exit 0
    fi
    service_name="$(arg_value --service-name "$@")"
    target="$(target_from_name "$service_name")"
    jq -n --arg task "arn:aws:ecs:us-west-2:123456789012:task/${target}" '[$task]'
    ;;
  describe-tasks)
    task_value="$(arg_value --tasks "$@")"
    if [[ "$task_value" == *"migrate-task" || "$task_value" == *"runtime-smoke-task" ]]; then
      task_name="${task_value##*/}"
      task_definition="$(<"$MOCK_AWS_STATE/${task_name}-definition")"
      image="$(image_for_target migrate)"
      digest="$(digest_for_target migrate)"
      if [[ "$task_name" == "runtime-smoke-task" ]]; then
        container_name="runtime-smoke"
      else
        container_name="migrate"
      fi
      jq -n \
        --arg task_definition "$task_definition" \
        --arg image "$image" \
        --arg digest "$digest" \
        --arg container_name "$container_name" '
        {
          failures: [],
          tasks: [{
            taskDefinitionArn: $task_definition,
            lastStatus: "STOPPED",
            stoppedReason: "Essential container exited",
            containers: [{
              name: $container_name,
              image: $image,
              imageDigest: $digest,
              exitCode: 0
            }]
          }]
        }
      '
    else
      target="${task_value##*/}"
      image="$(image_for_target "$target")"
      digest="$(digest_for_target "$target")"
      jq -n --arg target "$target" --arg image "$image" --arg digest "$digest" '
        {
          failures: [],
          tasks: [{
            lastStatus: "RUNNING",
            containers: [{
              name: $target,
              image: $image,
              imageDigest: $digest,
              healthStatus: (if $target == "worker" then "UNKNOWN" else "HEALTHY" end)
            }]
          }]
        }
      '
    fi
    ;;
  *)
    echo "Unsupported mock ECS operation: ${operation}" >&2
    exit 1
    ;;
esac
MOCK_AWS
chmod +x "$mock_aws_path"

cat > "$mock_bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
if [[ "${MOCK_CURL_FAIL:-false}" == "true" ]]; then
  exit 22
fi
output_path=""
url="${!#}"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    output_path="$2"
    shift 2
    continue
  fi
  shift
done
case "$url" in
  */health/ready)
    jq -n --arg version "$DEPLOY_SHA" \
      '{status:"ok", service:"api", version:$version, timestamp:"2026-07-20T00:00:00Z"}' \
      > "$output_path"
    ;;
  */v1/public/communities*)
    printf '%s\n' '{"schema_version":"1","request_id":"req-community-smoke","items":[],"page":{"next_cursor":null,"has_more":false,"limit":1},"ordering":{"snapshot_id":"snapshot-1","ordering_version":"community-v1","as_of":"2026-07-20T00:00:00Z"}}' > "$output_path"
    ;;
  */v1/public/content*)
    printf '%s\n' '{"schema_version":"1","request_id":"req-content-smoke","items":[],"page":{"next_cursor":null,"has_more":false,"limit":1},"ranking":{"snapshot_id":"snapshot-1","ranking_version":"content-v1","as_of":"2026-07-20T00:00:00Z","expires_at":"2026-07-20T00:05:00Z"},"counts_as_of":"2026-07-20T00:00:00Z"}' > "$output_path"
    ;;
  */.well-known/oauth-authorization-server/api/auth)
    if [[ "${MOCK_OAUTH_METADATA_INVALID:-false}" == "true" ]]; then
      printf '%s\n' '{"issuer":"https://attacker.example/api/auth"}' > "$output_path"
    else
      jq -n --arg issuer "${PUBLIC_BASE_URL}/api/auth" '{
        issuer: $issuer,
        authorization_endpoint: ($issuer + "/oauth2/authorize"),
        token_endpoint: ($issuer + "/oauth2/token"),
        jwks_uri: ($issuer + "/jwks"),
        revocation_endpoint: ($issuer + "/oauth2/revoke"),
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"]
      }' > "$output_path"
    fi
    ;;
  *)
    printf '%s\n' '{}' > "$output_path"
    ;;
esac
MOCK_CURL
chmod +x "$mock_bin/curl"

lookup_tag="sha-${deploy_sha}"
test "$(env \
  PATH="$mock_bin:$PATH" \
  MOCK_AWS_LOG="$test_directory/aws.log" \
  MOCK_ECR_MODE=exists \
  MOCK_ECR_DIGEST="$top_digest" \
  bash "$repository_root/.github/scripts/lookup-ecr-image-digest.sh" \
    alphanet-api "$lookup_tag")" = "$top_digest"
set +e
env \
  PATH="$mock_bin:$PATH" \
  MOCK_AWS_LOG="$test_directory/aws.log" \
  MOCK_ECR_MODE=absent \
  MOCK_ECR_DIGEST="$top_digest" \
  bash "$repository_root/.github/scripts/lookup-ecr-image-digest.sh" \
    alphanet-api "$lookup_tag" >/dev/null 2>&1
lookup_status=$?
set -e
test "$lookup_status" -eq 3
if env \
  PATH="$mock_bin:$PATH" \
  MOCK_AWS_LOG="$test_directory/aws.log" \
  MOCK_ECR_MODE=denied \
  MOCK_ECR_DIGEST="$top_digest" \
  bash "$repository_root/.github/scripts/lookup-ecr-image-digest.sh" \
    alphanet-api "$lookup_tag" >/dev/null 2>&1; then
  echo "Expected an ECR access error to fail closed." >&2
  exit 1
fi

run_deploy() {
  env \
    PATH="$mock_bin:$PATH" \
    GITHUB_WORKSPACE="$repository_root" \
    MOCK_AWS_LOG="$test_directory/aws.log" \
    MOCK_AWS_STATE="$mock_state" \
    MOCK_CURL_LOG="$test_directory/curl.log" \
    MOCK_MANIFEST="$manifest_path" \
    MOCK_DATE_ADVANCE_SECONDS="${MOCK_DATE_ADVANCE_SECONDS:-0}" \
    MOCK_LIST_TASK_EMPTY_COUNT="${MOCK_LIST_TASK_EMPTY_COUNT:-0}" \
    MOCK_RUN_TASK_TIMEOUT_COUNT="${MOCK_RUN_TASK_TIMEOUT_COUNT:-0}" \
    MOCK_TRIGGER_DATE_ON_TIMEOUT="${MOCK_TRIGGER_DATE_ON_TIMEOUT:-false}" \
    AWS_REGION="us-west-2" \
    DEPLOYMENT_MODE="${DEPLOYMENT_MODE:-forward}" \
    DEPLOY_SHA="$deploy_sha" \
    DEPLOY_TIMEOUT_SECONDS="120" \
    ROLLBACK_RESERVE_SECONDS="60" \
    POLL_INTERVAL_SECONDS="0" \
    ECS_API_SERVICE="alphanet-staging-api" \
    ECS_API_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-api:1" \
    ECS_API_TASK_FAMILY="alphanet-staging-api" \
    ECS_CLUSTER="alphanet-staging" \
    ECS_MCP_SERVICE="alphanet-staging-mcp" \
    ECS_MCP_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-mcp:1" \
    ECS_MCP_TASK_FAMILY="alphanet-staging-mcp" \
    ECS_MIGRATE_TASK_FAMILY="alphanet-staging-migrate" \
    ECS_MIGRATE_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-migrate:1" \
    ECS_RUNTIME_SMOKE_TASK_FAMILY="alphanet-staging-runtime-smoke" \
    ECS_RUNTIME_SMOKE_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-runtime-smoke:1" \
    ECS_SECURITY_GROUP_IDS="sg-123456" \
    ECS_SUBNET_IDS="subnet-123456,subnet-abcdef" \
    ECS_WEB_SERVICE="alphanet-staging-web" \
    ECS_WEB_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-web:1" \
    ECS_WEB_TASK_FAMILY="alphanet-staging-web" \
    ECS_WORKER_SERVICE="alphanet-staging-worker" \
    ECS_WORKER_BASELINE_TASK_DEFINITION_ARN="arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-worker:1" \
    ECS_WORKER_TASK_FAMILY="alphanet-staging-worker" \
    EXPECTED_IMAGE_PREFIX="$image_prefix" \
    EXPECTED_REPOSITORY="songzhiyuan98/AlphaNet" \
    PUBLIC_BASE_URL="https://staging.alphanet.example" \
    RELEASE_MANIFEST_PATH="$manifest_path" \
    SMOKE_PATHS="/health/ready,/v1/public/communities?limit=1,/v1/public/content?scope=global&sort=latest&limit=1,/.well-known/oauth-authorization-server/api/auth" \
    TARGET_ENVIRONMENT="${TARGET_ENVIRONMENT:-staging}" \
    MOCK_CURL_FAIL="${MOCK_CURL_FAIL:-false}" \
    bash "$repository_root/.github/scripts/aws-ecs-deploy.sh"
}

MOCK_EVENTUAL_CONSISTENCY=true run_deploy > "$test_directory/success.out"
grep -q 'AWS ECS deployment completed' "$test_directory/success.out"
test "$(grep -c '^ecs run-task ' "$test_directory/aws.log")" -eq 2
test "$(grep -c '^ecs update-service ' "$test_directory/aws.log")" -eq 4
test "$(wc -l < "$test_directory/curl.log" | tr -d ' ')" -eq 4
first_run_task_line="$(grep -n '^ecs run-task ' "$test_directory/aws.log" | head -n 1 | cut -d: -f1)"
second_run_task_line="$(grep -n '^ecs run-task ' "$test_directory/aws.log" | tail -n 1 | cut -d: -f1)"
first_update_line="$(grep -n '^ecs update-service ' "$test_directory/aws.log" | head -n 1 | cut -d: -f1)"
last_update_line="$(grep -n '^ecs update-service ' "$test_directory/aws.log" | tail -n 1 | cut -d: -f1)"
test "$first_run_task_line" -lt "$first_update_line"
test "$second_run_task_line" -gt "$last_update_line"
deployed_services=()
while IFS= read -r service; do
  deployed_services+=("$service")
done < <(
  grep '^ecs update-service ' "$test_directory/aws.log" |
    head -n 4 |
    sed -E 's/.*--service ([^ ]+).*/\1/'
)
expected_deploy_order=(
  alphanet-staging-api
  alphanet-staging-mcp
  alphanet-staging-worker
  alphanet-staging-web
)
for index in 0 1 2 3; do
  test "${deployed_services[$index]}" = "${expected_deploy_order[$index]}"
done
jq -e '
  [.containerDefinitions[] | select(.name == "migrate")][0] as $container |
  $container.entryPoint == ["/bin/bash", "/opt/alphanet/db/scripts/aws-migrate-release.sh"]
' "$mock_state/registered/alphanet-staging-migrate-2.json" >/dev/null
jq -e '
  [.containerDefinitions[] | select(.name == "runtime-smoke")][0] as $container |
  $container.entryPoint == ["/bin/bash", "/opt/alphanet/db/scripts/aws-smoke-runtime.sh"]
' "$mock_state/registered/alphanet-staging-runtime-smoke-2.json" >/dev/null
for target in api mcp worker web; do
  jq -e --arg sha "$deploy_sha" --arg target "$target" '
    ([.containerDefinitions[] | select(.name == $target)][0] as $container |
      [$container.environment[] | select(.name == "APP_VERSION" and .value == $sha)] | length == 1) and
    ([.tags[] | select(.key == "alphanet:managed-by" and .value == "github-actions")] | length == 1) and
    ([.tags[] | select(.key == "alphanet:deployment-baseline" and .value == "false")] | length == 1) and
    ([.tags[] | select(.key == "alphanet:release-sha" and .value == $sha)] | length == 1)
  ' "$mock_state/registered/alphanet-staging-${target}-2.json" >/dev/null
done
if grep '^ecs update-service ' "$test_directory/aws.log" | grep -q -- '--desired-count'; then
  echo "Routine CD must not race service autoscaling by pinning desiredCount." >&2
  exit 1
fi
if grep -q '^ecs describe-task-definition --task-definition alphanet-staging-' \
  "$test_directory/aws.log"; then
  echo "Deployment must never resolve a task definition by family latest." >&2
  exit 1
fi

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

if MOCK_OAUTH_METADATA_INVALID=true run_deploy \
  > "$test_directory/invalid-oauth-metadata.out" 2>&1; then
  echo "Expected invalid public OAuth discovery metadata to fail the deployment." >&2
  exit 1
fi
grep -q 'Public OAuth discovery response violated' \
  "$test_directory/invalid-oauth-metadata.out"

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

if MOCK_CURL_FAIL=true run_deploy > "$test_directory/failure.out" 2>&1; then
  echo "Expected smoke failure to fail the deployment." >&2
  exit 1
fi

test "$(grep -c '^ecs update-service ' "$test_directory/aws.log")" -eq 8
rollback_services=()
while IFS= read -r service; do
  rollback_services+=("$service")
done < <(
  grep '^ecs update-service ' "$test_directory/aws.log" |
    tail -n 4 |
    sed -E 's/.*--service ([^ ]+).*/\1/'
)
expected_rollback=(
  alphanet-staging-web
  alphanet-staging-worker
  alphanet-staging-mcp
  alphanet-staging-api
)
for index in 0 1 2 3; do
  test "${rollback_services[$index]}" = "${expected_rollback[$index]}"
done
if grep '^ecs update-service ' "$test_directory/aws.log" | grep -q -- '--desired-count'; then
  echo "Rollback must preserve the autoscaler-owned current desiredCount." >&2
  exit 1
fi

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

if MOCK_ZERO_DESIRED_SERVICE=alphanet-staging-worker run_deploy \
  > "$test_directory/zero-desired.out" 2>&1; then
  echo "Expected routine CD to reject a zero-capacity Terraform bootstrap service." >&2
  exit 1
fi
grep -q 'Complete the Terraform live-capacity apply' \
  "$test_directory/zero-desired.out"
if grep '^ecs update-service ' "$test_directory/aws.log" |
  grep -q -- '--service alphanet-staging-worker '; then
  echo "Zero-capacity service must not be started by routine CD." >&2
  exit 1
fi

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

if MOCK_RUN_TASK_TIMEOUT_COUNT=1 run_deploy \
  > "$test_directory/run-task-timeout.out" 2>&1; then
  echo "Expected an ambiguous migration RunTask timeout to fail the deployment." >&2
  exit 1
fi
test "$(grep -c '^ecs run-task ' "$test_directory/aws.log")" -eq 2
test "$(grep '^run-task-request ' "$test_directory/aws.log" | sed -E 's/.*clientToken=//' | sort -u | wc -l | tr -d ' ')" -eq 1
grep -q '^ecs stop-task .*--task arn:aws:ecs:us-west-2:123456789012:task/migrate-task ' \
  "$test_directory/aws.log"
test "$(grep -c '^ecs update-service ' "$test_directory/aws.log" || true)" -eq 0

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

if MOCK_RUN_TASK_TIMEOUT_COUNT=4 MOCK_LIST_TASK_EMPTY_COUNT=2 run_deploy \
  > "$test_directory/run-task-delayed-visibility.out" 2>&1; then
  echo "Expected the delayed-visibility migration timeout to fail after safe cleanup." >&2
  exit 1
fi
test "$(grep -c '^ecs list-tasks .*--started-by ' "$test_directory/aws.log")" -eq 3
grep -q '^ecs stop-task .*--task arn:aws:ecs:us-west-2:123456789012:task/migrate-task ' \
  "$test_directory/aws.log"

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

set +e
MOCK_RUN_TASK_TIMEOUT_COUNT=999 \
  MOCK_LIST_TASK_EMPTY_COUNT=999 \
  MOCK_DATE_ADVANCE_SECONDS=30 \
  MOCK_TRIGGER_DATE_ON_TIMEOUT=true \
  run_deploy > "$test_directory/run-task-permanently-uncertain.out" 2>&1
permanently_uncertain_status=$?
set -e
test "$permanently_uncertain_status" -eq 70
grep -q 'cleanup remains unresolved' \
  "$test_directory/run-task-permanently-uncertain.out"
test "$(grep -c '^ecs stop-task ' "$test_directory/aws.log" || true)" -eq 0

rm -rf "$mock_state"
mkdir -p "$mock_state/registered" "$mock_state/current"
: > "$test_directory/aws.log"
: > "$test_directory/curl.log"

DEPLOYMENT_MODE=application-rollback TARGET_ENVIRONMENT=production run_deploy \
  > "$test_directory/application-rollback.out"
grep -q 'Application-only break-glass rollback' "$test_directory/application-rollback.out"
test "$(grep -c '^ecs run-task ' "$test_directory/aws.log" || true)" -eq 0
test "$(grep -c '^ecs update-service ' "$test_directory/aws.log")" -eq 4
if grep -q 'alphanet-staging-migrate-2' "$test_directory/aws.log"; then
  echo "Application rollback must not register or run a historical database image." >&2
  exit 1
fi

# These are intentional literal GitHub expression wiring assertions.
# shellcheck disable=SC2016
grep -Fq 'DEPLOYMENT_MODE: ${{ inputs.deployment-mode }}' \
  "$repository_root/.github/actions/deploy-ecs-release/action.yml"
grep -Fq "deployment-mode: \${{ needs.resolve.outputs.mode == 'break-glass-rollback' && 'application-rollback' || 'forward' }}" \
  "$repository_root/.github/workflows/deploy.yml"

echo "AWS ECS deployment fixture tests passed."
