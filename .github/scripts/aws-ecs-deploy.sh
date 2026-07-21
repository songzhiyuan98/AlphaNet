#!/usr/bin/env bash
set -Eeuo pipefail

required_commands=(aws curl jq timeout)
required_environment=(
  AWS_REGION
  DEPLOYMENT_MODE
  DEPLOY_SHA
  ECS_API_BASELINE_TASK_DEFINITION_ARN
  ECS_API_SERVICE
  ECS_API_TASK_FAMILY
  ECS_CLUSTER
  ECS_MCP_BASELINE_TASK_DEFINITION_ARN
  ECS_MCP_SERVICE
  ECS_MCP_TASK_FAMILY
  ECS_MIGRATE_BASELINE_TASK_DEFINITION_ARN
  ECS_MIGRATE_TASK_FAMILY
  ECS_RUNTIME_SMOKE_BASELINE_TASK_DEFINITION_ARN
  ECS_RUNTIME_SMOKE_TASK_FAMILY
  ECS_SECURITY_GROUP_IDS
  ECS_SUBNET_IDS
  ECS_WEB_BASELINE_TASK_DEFINITION_ARN
  ECS_WEB_SERVICE
  ECS_WEB_TASK_FAMILY
  ECS_WORKER_BASELINE_TASK_DEFINITION_ARN
  ECS_WORKER_SERVICE
  ECS_WORKER_TASK_FAMILY
  EXPECTED_IMAGE_PREFIX
  EXPECTED_REPOSITORY
  PUBLIC_BASE_URL
  RELEASE_MANIFEST_PATH
  SMOKE_PATHS
  TARGET_ENVIRONMENT
)

for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: ${command_name}" >&2
    exit 2
  }
done

for variable_name in "${required_environment[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required environment variable: ${variable_name}" >&2
    exit 2
  fi
done

readonly deploy_timeout_seconds="${DEPLOY_TIMEOUT_SECONDS:-3900}"
readonly rollback_reserve_seconds="${ROLLBACK_RESERVE_SECONDS:-600}"
readonly poll_interval_seconds="${POLL_INTERVAL_SECONDS:-10}"
readonly aws_command_timeout_seconds="${AWS_COMMAND_TIMEOUT_SECONDS:-90}"

for timeout_value in \
  "$deploy_timeout_seconds" \
  "$rollback_reserve_seconds" \
  "$poll_interval_seconds" \
  "$aws_command_timeout_seconds"; do
  if [[ ! "$timeout_value" =~ ^[0-9]+$ ]]; then
    echo "Deployment timeout values must be non-negative integers." >&2
    exit 2
  fi
done
if ((deploy_timeout_seconds < 120 || deploy_timeout_seconds > 3900)); then
  echo "DEPLOY_TIMEOUT_SECONDS must be between 120 and 3900 seconds." >&2
  exit 2
fi
if ((rollback_reserve_seconds < 60 || rollback_reserve_seconds >= deploy_timeout_seconds)); then
  echo "ROLLBACK_RESERVE_SECONDS must reserve at least 60 seconds before the global deadline." >&2
  exit 2
fi
if ((aws_command_timeout_seconds < 30 || aws_command_timeout_seconds > 120)); then
  echo "AWS_COMMAND_TIMEOUT_SECONDS must be between 30 and 120 seconds." >&2
  exit 2
fi

# Every external AWS command is additionally bounded by GNU timeout. These AWS
# settings keep retries inside that boundary instead of spending the rollback
# reserve on a single network call.
export AWS_CLI_CONNECT_TIMEOUT="${AWS_CLI_CONNECT_TIMEOUT:-10}"
export AWS_CLI_READ_TIMEOUT="${AWS_CLI_READ_TIMEOUT:-30}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-3}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"

deployment_started_epoch="$(date +%s)"
readonly deployment_started_epoch
readonly deployment_deadline_epoch="$((deployment_started_epoch + deploy_timeout_seconds))"
readonly forward_deadline_epoch="$((deployment_deadline_epoch - rollback_reserve_seconds))"

seconds_remaining() {
  local deadline="$1"
  local now
  now="$(date +%s)"
  printf '%s\n' "$((deadline - now))"
}

run_until() {
  local deadline="$1"
  shift
  local remaining
  remaining="$(seconds_remaining "$deadline")"
  if ((remaining <= 0)); then
    echo "::error::Deployment deadline was exhausted before running: $*" >&2
    return 124
  fi
  timeout --foreground --signal=TERM --kill-after=10s "${remaining}s" "$@"
}

aws_until() {
  local deadline="$1"
  shift
  local now command_deadline
  now="$(date +%s)"
  command_deadline="$((now + aws_command_timeout_seconds))"
  if ((command_deadline > deadline)); then
    command_deadline="$deadline"
  fi
  run_until "$command_deadline" aws "$@"
}

sleep_until() {
  local deadline="$1"
  local remaining sleep_seconds
  remaining="$(seconds_remaining "$deadline")"
  if ((remaining <= 0)); then
    return 124
  fi
  sleep_seconds="$poll_interval_seconds"
  if ((sleep_seconds > remaining)); then
    sleep_seconds="$remaining"
  fi
  if ((sleep_seconds > 0)); then
    sleep "$sleep_seconds"
  fi
}

if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_SHA must be a full lowercase Git commit SHA." >&2
  exit 2
fi

if [[ "$TARGET_ENVIRONMENT" != "staging" && "$TARGET_ENVIRONMENT" != "production" ]]; then
  echo "TARGET_ENVIRONMENT must be staging or production." >&2
  exit 2
fi

if [[ "$DEPLOYMENT_MODE" != "forward" && "$DEPLOYMENT_MODE" != "application-rollback" ]]; then
  echo "DEPLOYMENT_MODE must be forward or application-rollback." >&2
  exit 2
fi
if [[ "$DEPLOYMENT_MODE" == "application-rollback" && "$TARGET_ENVIRONMENT" != "production" ]]; then
  echo "Application-only rollback is limited to production break-glass recovery." >&2
  exit 2
fi

if [[ ! "$PUBLIC_BASE_URL" =~ ^https://[^/]+/?$ ]]; then
  echo "PUBLIC_BASE_URL must be an HTTPS origin without a path." >&2
  exit 2
fi
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

readonly manifest_path="$RELEASE_MANIFEST_PATH"
readonly expected_registry="${EXPECTED_IMAGE_PREFIX%%/*}"
if [[ ! "$expected_registry" =~ ^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$ ]]; then
  echo "EXPECTED_IMAGE_PREFIX must begin with a standard private ECR registry." >&2
  exit 2
fi
readonly aws_account_id="${BASH_REMATCH[1]}"
readonly registry_region="${BASH_REMATCH[2]}"
if [[ "$registry_region" != "$AWS_REGION" ]]; then
  echo "ECR registry region does not match AWS_REGION." >&2
  exit 2
fi
if [[ "$EXPECTED_IMAGE_PREFIX" != "${expected_registry}/"* ]]; then
  echo "EXPECTED_IMAGE_PREFIX must use the authenticated account's regional ECR registry." >&2
  exit 2
fi

caller_account="$(aws_until "$forward_deadline_epoch" sts get-caller-identity \
  --query Account --output text)"
if [[ "$caller_account" != "$aws_account_id" ]]; then
  echo "Authenticated AWS account ${caller_account} does not match the ECR registry account." >&2
  exit 1
fi

bash "${GITHUB_WORKSPACE:-$(pwd)}/.github/scripts/validate-release-manifest.sh" \
  "$manifest_path" "$DEPLOY_SHA" "$EXPECTED_REPOSITORY" "$EXPECTED_IMAGE_PREFIX"

work_directory="$(mktemp -d)"
declare -a updated_services=()
declare -a previous_task_definitions=()
declare -a previous_desired_counts=()
declare -a deployed_task_definitions=()
declare -a deployed_desired_counts=()
rollback_started="false"
active_one_shot_task_arn=""
active_one_shot_label=""
active_one_shot_result_path=""
active_one_shot_started_by=""
active_one_shot_request_path=""

cleanup() {
  rm -rf "$work_directory"
}

image_reference() {
  local target="$1"
  jq -er --arg target "$target" '.images[$target].reference' "$manifest_path"
}

allowed_digests_for_target() {
  local target="$1"
  jq -cer --arg target "$target" \
    '[.images[$target].digest, .images[$target].runtimeDigest] | unique' \
    "$manifest_path"
}

report_task_diagnostics() {
  local task_arn="$1"
  local task_state_path="$2"
  local label="$3"

  echo "::notice::${label} ECS task ARN: ${task_arn}"
  if [[ -s "$task_state_path" ]]; then
    jq -c '{
      taskDefinitionArn: .tasks[0].taskDefinitionArn,
      lastStatus: .tasks[0].lastStatus,
      stopCode: .tasks[0].stopCode,
      stoppedReason: .tasks[0].stoppedReason,
      containers: [.tasks[0].containers[]? |
        {name, lastStatus, reason, exitCode, image, imageDigest}]
    }' "$task_state_path" >&2 || true

    task_definition="$(jq -r '.tasks[0].taskDefinitionArn // empty' "$task_state_path")"
    if [[ -n "$task_definition" ]]; then
      task_definition_path="$work_directory/diagnostic-task-definition.json"
      if aws_until "$deployment_deadline_epoch" ecs describe-task-definition \
        --task-definition "$task_definition" --output json > "$task_definition_path"; then
        task_id="${task_arn##*/}"
        while IFS=$'\t' read -r container_name log_group stream_prefix; do
          if [[ -n "$log_group" && "$log_group" != "null" ]]; then
            echo "::notice::CloudWatch: aws logs tail '${log_group}' --since 1h --follow=false"
            echo "::notice::Expected stream: ${stream_prefix}/${container_name}/${task_id}"
          fi
        done < <(jq -r '
          .taskDefinition.containerDefinitions[] |
          select(.logConfiguration.logDriver == "awslogs") |
          [.name,
           .logConfiguration.options["awslogs-group"],
           .logConfiguration.options["awslogs-stream-prefix"]] | @tsv
        ' "$task_definition_path")
      fi
    fi
  fi
}

poll_task_stopped() {
  local task_arn="$1"
  local result_path="$2"
  local deadline="$3"
  local label="$4"
  local last_status

  while true; do
    aws_until "$deadline" ecs describe-tasks \
      --cluster "$ECS_CLUSTER" \
      --tasks "$task_arn" \
      --output json > "$result_path"

    if ! jq -e '(.failures | length) == 0 and (.tasks | length) == 1' \
      "$result_path" >/dev/null; then
      echo "::error::Unable to describe ${label} task ${task_arn}." >&2
      jq -c '{failures}' "$result_path" >&2 || true
      return 1
    fi

    last_status="$(jq -r '.tasks[0].lastStatus // empty' "$result_path")"
    if [[ "$last_status" == "STOPPED" ]]; then
      return 0
    fi
    if (( $(seconds_remaining "$deadline") <= 0 )); then
      echo "::error::Timed out waiting for ${label} task ${task_arn} to stop." >&2
      return 124
    fi
    sleep_until "$deadline"
  done
}

stop_active_one_shot() {
  if [[ -z "$active_one_shot_task_arn" && -z "$active_one_shot_request_path" ]]; then
    return 0
  fi

  local label="$active_one_shot_label"
  local stop_failed="false"
  local lookup_path="$work_directory/active-one-shot-tasks.json"
  local replay_path="$work_directory/active-one-shot-replay.json"
  local task_arn result_path resolution_deadline
  local -a task_arns=()

  if [[ -n "$active_one_shot_task_arn" ]]; then
    task_arns+=("$active_one_shot_task_arn")
  else
    if [[ ! -s "$active_one_shot_request_path" ]]; then
      echo "::error::Cannot reconcile uncertain ${label} RunTask without its exact idempotent request." >&2
      return 1
    fi

    # A client-side timeout can happen after ECS accepted RunTask but before
    # taskArn reached the runner. Replaying the byte-identical request with the
    # same clientToken is ECS's authoritative idempotency lookup. startedBy is
    # retained only as a second, eventually-consistent discovery path. Never
    # interpret an empty list as proof that no task was accepted.
    resolution_deadline="$((deployment_deadline_epoch - 60))"
    if ((resolution_deadline <= $(date +%s))); then
      resolution_deadline="$deployment_deadline_epoch"
    fi
    while (( $(seconds_remaining "$resolution_deadline") > 0 )); do
      if aws_until "$resolution_deadline" ecs run-task \
        --cli-input-json "file://${active_one_shot_request_path}" \
        --output json > "$replay_path"; then
        if jq -e '(.failures | length) == 0 and (.tasks | length) == 1' \
          "$replay_path" >/dev/null; then
          task_arns+=("$(jq -er '.tasks[0].taskArn' "$replay_path")")
          break
        fi
        echo "::error::Idempotent replay returned no unique ${label} task." >&2
        jq -c '{failures, taskArns: [.tasks[]?.taskArn]}' "$replay_path" >&2 || true
        stop_failed="true"
        break
      fi

      if aws_until "$resolution_deadline" ecs list-tasks \
        --cluster "$ECS_CLUSTER" \
        --started-by "$active_one_shot_started_by" \
        --output json > "$lookup_path"; then
        task_arns=()
        while IFS= read -r task_arn; do
          task_arns+=("$task_arn")
        done < <(jq -r '.taskArns[]?' "$lookup_path")
        if [[ "${#task_arns[@]}" -gt 0 ]]; then
          break
        fi
      fi
      sleep_until "$resolution_deadline" || true
    done
  fi

  if [[ "${#task_arns[@]}" -eq 0 ]]; then
    echo "::error::Could not prove whether the uncertain ${label} RunTask was accepted; cleanup remains unresolved." >&2
    return 1
  fi
  if [[ "${#task_arns[@]}" -ne 1 ]]; then
    echo "::error::Expected one ${label} task for the idempotent RunTask marker but found ${#task_arns[@]}; stopping every match." >&2
    stop_failed="true"
  fi

  if [[ "$label" == "migration" ]]; then
    echo "::notice::Each migration runs in a PostgreSQL transaction with a transaction-scoped advisory lock. Stopping the ECS task closes psql's database session, so PostgreSQL rolls back any open transaction and releases that lock before a retry."
  fi

  for task_arn in "${task_arns[@]}"; do
    result_path="${active_one_shot_result_path:-$work_directory/stopped-one-shot.json}"
    if [[ "${#task_arns[@]}" -gt 1 ]]; then
      result_path="$work_directory/stopped-one-shot-${task_arn##*/}.json"
    fi
    echo "::warning::Stopping in-flight ${label} task ${task_arn}."
    if ! aws_until "$deployment_deadline_epoch" ecs stop-task \
      --cluster "$ECS_CLUSTER" \
      --task "$task_arn" \
      --reason "AlphaNet deployment ${DEPLOY_SHA} cancelled or timed out" \
      >/dev/null; then
      echo "::error::Failed to request stop for ${label} task ${task_arn}." >&2
      stop_failed="true"
    elif ! poll_task_stopped \
      "$task_arn" "$result_path" "$deployment_deadline_epoch" "$label"; then
      echo "::error::${label} task ${task_arn} was not confirmed STOPPED." >&2
      stop_failed="true"
    fi
    report_task_diagnostics "$task_arn" "$result_path" "$label"
  done
  if [[ "$stop_failed" == "true" ]]; then
    return 1
  fi
  active_one_shot_task_arn=""
  active_one_shot_label=""
  active_one_shot_result_path=""
  active_one_shot_started_by=""
  active_one_shot_request_path=""
}

wait_services_stable() {
  local deadline="$1"
  local label="$2"
  shift 2
  local -a specs=("$@")
  local -a services=()
  local spec service expected_task_definition _captured_desired
  local state_path="$work_directory/services-${label//[^A-Za-z0-9_.-]/_}.json"
  local stable

  for spec in "${specs[@]}"; do
    IFS=$'\t' read -r service expected_task_definition _captured_desired <<< "$spec"
    services+=("$service")
  done

  while true; do
    aws_until "$deadline" ecs describe-services \
      --cluster "$ECS_CLUSTER" \
      --services "${services[@]}" \
      --output json > "$state_path"

    if ! jq -e '(.failures | length) == 0' "$state_path" >/dev/null; then
      echo "::error::ECS returned failures while waiting for ${label}." >&2
      jq -c '{failures}' "$state_path" >&2 || true
      return 1
    fi

    stable="true"
    for spec in "${specs[@]}"; do
      IFS=$'\t' read -r service expected_task_definition _captured_desired <<< "$spec"
      if ! jq -e \
        --arg service "$service" \
        --arg task_definition "$expected_task_definition" '
        def is_requested_service:
          .serviceName == $service or
          .serviceArn == $service or
          (.serviceArn | endswith("/" + $service));
        [.services[] | select(is_requested_service)] as $matches |
        ($matches | length) == 1 and
        ($matches[0] |
          .status == "ACTIVE" and
          .desiredCount > 0 and
          .runningCount == .desiredCount and
          .pendingCount == 0 and
          .taskDefinition == $task_definition and
          (.deployments | length) == 1 and
          .deployments[0].status == "PRIMARY" and
          .deployments[0].taskDefinition == $task_definition and
          .deployments[0].desiredCount == .desiredCount and
          .deployments[0].runningCount == .runningCount and
          .deployments[0].pendingCount == 0 and
          .deployments[0].rolloutState == "COMPLETED")
      ' "$state_path" >/dev/null; then
        stable="false"
      fi
    done

    if [[ "$stable" == "true" ]]; then
      return 0
    fi

    # A just-accepted UpdateService can be eventually consistent and initially
    # return only the old deployment. Fail early only when ECS explicitly marks
    # the requested revision FAILED; otherwise continue bounded polling.
    for spec in "${specs[@]}"; do
      IFS=$'\t' read -r service expected_task_definition _captured_desired <<< "$spec"
      if jq -e \
        --arg service "$service" \
        --arg task_definition "$expected_task_definition" '
        def is_requested_service:
          .serviceName == $service or
          .serviceArn == $service or
          (.serviceArn | endswith("/" + $service));
        [.services[] | select(is_requested_service)] as $matches |
        ($matches | length) == 1 and
        ([$matches[0].deployments[] |
          select(.taskDefinition == $task_definition and .rolloutState == "FAILED")] |
          length) > 0
      ' "$state_path" >/dev/null; then
        echo "::error::ECS marked the requested revision FAILED for ${service}." >&2
        jq -c --arg service "$service" '
          .services[] |
          select(.serviceName == $service or .serviceArn == $service or
            (.serviceArn | endswith("/" + $service))) |
          {serviceName, taskDefinition, desiredCount, runningCount, pendingCount,
           deployments, events: (.events[0:5])}
        ' "$state_path" >&2 || true
        return 1
      fi
    done

    if (( $(seconds_remaining "$deadline") <= 0 )); then
      echo "::error::Timed out waiting for ${label}." >&2
      jq -c '.services[] |
        {serviceName, taskDefinition, desiredCount, runningCount, pendingCount,
         deployments, events: (.events[0:5])}' "$state_path" >&2 || true
      return 124
    fi
    sleep_until "$deadline"
  done
}

rollback_services() {
  if [[ "$rollback_started" == "true" ]]; then
    return 0
  fi
  rollback_started="true"

  if [[ "${#updated_services[@]}" -eq 0 ]]; then
    return 0
  fi

  local rollback_failed="false"
  local -a rollback_specs=()
  local index service previous_task_definition previous_desired_count

  echo "::warning::Restoring previous ECS task definitions while preserving autoscaler-owned desired counts."
  for ((index=${#updated_services[@]} - 1; index >= 0; index--)); do
    service="${updated_services[$index]}"
    previous_task_definition="${previous_task_definitions[$index]}"
    previous_desired_count="${previous_desired_counts[$index]}"
    if aws_until "$deployment_deadline_epoch" ecs update-service \
      --cluster "$ECS_CLUSTER" \
      --service "$service" \
      --task-definition "$previous_task_definition" \
      --force-new-deployment \
      >/dev/null; then
      rollback_specs+=("${service}"$'\t'"${previous_task_definition}"$'\t'"${previous_desired_count}")
    else
      echo "::error::Rollback update failed for ${service}." >&2
      rollback_failed="true"
    fi
  done

  if [[ "${#rollback_specs[@]}" -gt 0 ]] &&
    ! wait_services_stable "$deployment_deadline_epoch" rollback "${rollback_specs[@]}"; then
    echo "::error::One or more ECS services did not stabilize after rollback." >&2
    rollback_failed="true"
  fi

  if [[ "$rollback_failed" == "true" ]]; then
    echo "::error::ROLLBACK INCOMPLETE: operator intervention is required before another deployment." >&2
    return 1
  fi
  echo "Rollback completed; desired counts remained autoscaler-owned."
}

handle_failure() {
  local original_status="$1"
  local line_number="$2"
  local cleanup_failed="false"

  if [[ "${BASH_SUBSHELL:-0}" -gt 0 ]]; then
    exit "$original_status"
  fi
  trap - ERR INT TERM
  set +e
  echo "::error::AWS ECS deployment failed at line ${line_number} (status ${original_status})."
  stop_active_one_shot || cleanup_failed="true"
  rollback_services || cleanup_failed="true"
  if [[ "$cleanup_failed" == "true" ]]; then
    exit 70
  fi
  exit "$original_status"
}

handle_signal() {
  local signal_name="$1"
  local signal_status=143
  if [[ "$signal_name" == "INT" ]]; then
    signal_status=130
  fi
  trap - ERR INT TERM
  set +e
  echo "::error::AWS ECS deployment received ${signal_name}; stopping one-shot work and rolling back."
  cleanup_failed="false"
  stop_active_one_shot || cleanup_failed="true"
  rollback_services || cleanup_failed="true"
  if [[ "$cleanup_failed" == "true" ]]; then
    exit 70
  fi
  exit "$signal_status"
}

trap cleanup EXIT
trap 'handle_failure $? $LINENO' ERR
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

register_image_revision() {
  local baseline_task_definition="$1"
  local expected_family="$2"
  local container_name="$3"
  local image="$4"
  local mode="$5"
  local safe_family="${expected_family//[^A-Za-z0-9_.-]/_}"
  local output_path="$work_directory/task-definition-${safe_family}-${mode}.json"
  local source_path="${output_path}.source"

  aws_until "$forward_deadline_epoch" ecs describe-task-definition \
    --task-definition "$baseline_task_definition" \
    --include TAGS \
    --output json > "$source_path"

  if ! jq -e \
    --arg arn "$baseline_task_definition" \
    --arg family "$expected_family" \
    --arg container "$container_name" '
    .taskDefinition.taskDefinitionArn == $arn and
    .taskDefinition.family == $family and
    .taskDefinition.status == "ACTIVE" and
    ([.taskDefinition.containerDefinitions[] | select(.name == $container)] | length) == 1 and
    ([.tags[]? | select(.key == "alphanet:managed-by" and .value == "terraform")] | length) == 1 and
    ([.tags[]? | select(.key == "alphanet:deployment-baseline" and .value == "true")] | length) == 1
  ' "$source_path" >/dev/null; then
    echo "Baseline ${baseline_task_definition} must be the exact ACTIVE Terraform revision for family ${expected_family}, contain one ${container_name} container, and carry the reviewed baseline provenance tags." >&2
    return 1
  fi

  if [[ "$mode" == "migrate" ]] && ! jq -e \
    --arg container "$container_name" '
    [.taskDefinition.containerDefinitions[] | select(.name == $container)][0] |
    .entryPoint == ["/bin/bash", "/opt/alphanet/db/scripts/aws-migrate-release.sh"]
  ' "$source_path" >/dev/null; then
    echo "Migration baseline has an unexpected entry point." >&2
    return 1
  fi
  if [[ "$mode" == "runtime-smoke" ]] && ! jq -e \
    --arg container "$container_name" '
    [.taskDefinition.containerDefinitions[] | select(.name == $container)][0] |
    .entryPoint == ["/bin/bash", "/opt/alphanet/db/scripts/aws-smoke-runtime.sh"]
  ' "$source_path" >/dev/null; then
    echo "Runtime-smoke baseline has an unexpected entry point." >&2
    return 1
  fi

  jq \
    --arg container "$container_name" \
    --arg image "$image" \
    --arg mode "$mode" \
    --arg deploy_sha "$DEPLOY_SHA" '
    . as $source |
    ($source.taskDefinition |
      {
        family,
        taskRoleArn,
        executionRoleArn,
        networkMode,
        containerDefinitions,
        volumes,
        placementConstraints,
        requiresCompatibilities,
        cpu,
        memory,
        pidMode,
        ipcMode,
        proxyConfiguration,
        inferenceAccelerators,
        ephemeralStorage,
        runtimePlatform,
        enableFaultInjection
      }
      | with_entries(select(.value != null))
      | .containerDefinitions |= map(
          if .name == $container then
            .image = $image |
            if $mode == "service" then
              .environment = (
                ((.environment // []) | map(select(.name != "APP_VERSION"))) +
                [{name: "APP_VERSION", value: $deploy_sha}]
              )
            else
              .
            end
          else
            .
          end
        )) +
    {
      tags: (
        ($source.tags // []) |
        map(select(
          .key != "ManagedBy" and
          .key != "alphanet:managed-by" and
          .key != "alphanet:deployment-baseline" and
          .key != "alphanet:release-sha"
        )) + [
          {key: "ManagedBy", value: "github-actions"},
          {key: "alphanet:managed-by", value: "github-actions"},
          {key: "alphanet:deployment-baseline", value: "false"},
          {key: "alphanet:release-sha", value: $deploy_sha}
        ]
      )
    }
  ' "$source_path" > "$output_path"

  aws_until "$forward_deadline_epoch" ecs register-task-definition \
    --cli-input-json "file://${output_path}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
}

network_configuration="$(
  jq -cn \
    --arg subnets "$ECS_SUBNET_IDS" \
    --arg security_groups "$ECS_SECURITY_GROUP_IDS" \
    --arg assign_public_ip "${ECS_ASSIGN_PUBLIC_IP:-DISABLED}" '
      def csv:
        split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0));
      {
        awsvpcConfiguration: {
          subnets: ($subnets | csv),
          securityGroups: ($security_groups | csv),
          assignPublicIp: $assign_public_ip
        }
      }
    '
)"

if ! jq -e '
  (.awsvpcConfiguration.subnets | length > 0) and
  (.awsvpcConfiguration.securityGroups | length > 0) and
  (.awsvpcConfiguration.assignPublicIp == "ENABLED" or
    .awsvpcConfiguration.assignPublicIp == "DISABLED")
' <<<"$network_configuration" >/dev/null; then
  echo "ECS network configuration is invalid." >&2
  exit 2
fi

run_database_job() {
  local label="$1"
  local mode="$2"
  local baseline="$3"
  local family="$4"
  local container_name="$5"
  local registered_task_definition run_request_path run_response_path task_arn result_path
  local migrate_image migrate_allowed_digests
  local run_id run_attempt started_by client_token

  migrate_image="$(image_reference migrate)"
  migrate_allowed_digests="$(allowed_digests_for_target migrate)"
  registered_task_definition="$(register_image_revision \
    "$baseline" "$family" "$container_name" "$migrate_image" "$mode")"

  run_id="${GITHUB_RUN_ID:-local}"
  run_id="${run_id//[^A-Za-z0-9_-]/}"
  run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
  started_by="aln-${TARGET_ENVIRONMENT:0:1}-${mode:0:3}-${DEPLOY_SHA:0:8}-${run_id: -10}-${run_attempt}"
  client_token="alphanet-${mode}-${DEPLOY_SHA:0:12}-${run_id: -12}-${run_attempt}"

  run_response_path="$work_directory/${mode}-run-task.json"
  run_request_path="$work_directory/${mode}-run-task-request.json"
  result_path="$work_directory/${mode}-result.json"
  jq -n \
    --arg cluster "$ECS_CLUSTER" \
    --arg task_definition "$registered_task_definition" \
    --arg started_by "$started_by" \
    --arg client_token "$client_token" \
    --argjson network_configuration "$network_configuration" '
      {
        cluster: $cluster,
        taskDefinition: $task_definition,
        count: 1,
        launchType: "FARGATE",
        networkConfiguration: $network_configuration,
        startedBy: $started_by,
        clientToken: $client_token
      }
    ' > "$run_request_path"
  active_one_shot_task_arn=""
  active_one_shot_label="$label"
  active_one_shot_result_path="$result_path"
  active_one_shot_started_by="$started_by"
  active_one_shot_request_path="$run_request_path"
  aws_until "$forward_deadline_epoch" ecs run-task \
    --cli-input-json "file://${run_request_path}" \
    --output json > "$run_response_path"

  if ! jq -e '(.failures | length) == 0 and (.tasks | length) == 1' \
    "$run_response_path" >/dev/null; then
    jq -c '{failures}' "$run_response_path" >&2
    return 1
  fi

  task_arn="$(jq -er '.tasks[0].taskArn' "$run_response_path")"
  active_one_shot_task_arn="$task_arn"
  poll_task_stopped "$task_arn" "$result_path" "$forward_deadline_epoch" "$label"
  active_one_shot_task_arn=""
  active_one_shot_label=""
  active_one_shot_result_path=""
  active_one_shot_started_by=""
  active_one_shot_request_path=""

  if ! jq -e \
    --arg container "$container_name" \
    --arg image "$migrate_image" \
    --arg task_definition "$registered_task_definition" \
    --argjson allowed_digests "$migrate_allowed_digests" '
    (.failures | length) == 0 and
    (.tasks | length) == 1 and
    (.tasks[0].lastStatus == "STOPPED") and
    (.tasks[0].taskDefinitionArn == $task_definition) and
    ([.tasks[0].containers[] | select(.name == $container)] | length == 1) and
    ([.tasks[0].containers[] | select(.name == $container)][0] as $job |
      $job.exitCode == 0 and
      $job.image == $image and
      ($allowed_digests | index($job.imageDigest) != null))
  ' "$result_path" >/dev/null; then
    report_task_diagnostics "$task_arn" "$result_path" "$label"
    return 1
  fi
}

if [[ "$DEPLOYMENT_MODE" == "forward" ]]; then
  echo "::group::Run forward-only database migration"
  run_database_job \
    migration \
    migrate \
    "$ECS_MIGRATE_BASELINE_TASK_DEFINITION_ARN" \
    "$ECS_MIGRATE_TASK_FAMILY" \
    "${ECS_MIGRATE_CONTAINER_NAME:-migrate}"
  echo "Migration task completed successfully."
  echo "::endgroup::"
else
  echo "::notice::Application-only break-glass rollback: preserving the current forward-only schema and privilege gate; no historical database image will run."
fi

deploy_service() {
  local target="$1"
  local service="$2"
  local baseline_task_definition="$3"
  local family="$4"
  local container_name="$5"
  local service_state_path="$work_directory/service-${target}.json"
  local previous_task_definition previous_desired_count
  local new_task_definition

  aws_until "$forward_deadline_epoch" ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$service" \
    --output json > "$service_state_path"
  if ! jq -e '
    (.failures | length) == 0 and
    (.services | length) == 1 and
    (.services[0].status == "ACTIVE") and
    (.services[0].desiredCount | type == "number") and
    (.services[0].deploymentConfiguration.deploymentCircuitBreaker.enable == true) and
    (.services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback == true)
  ' "$service_state_path" >/dev/null; then
    echo "Service ${service} is missing, inactive, or does not have the required deployment circuit breaker." >&2
    return 1
  fi

  previous_task_definition="$(jq -er '.services[0].taskDefinition' "$service_state_path")"
  previous_desired_count="$(jq -er '.services[0].desiredCount' "$service_state_path")"
  if ((previous_desired_count <= 0)); then
    echo "Service ${service} has desiredCount=0. Complete the Terraform live-capacity apply before enabling routine CD." >&2
    return 1
  fi

  new_task_definition="$(register_image_revision \
    "$baseline_task_definition" "$family" "$container_name" \
    "$(image_reference "$target")" service)"

  # Record rollback state before update-service: a client timeout can occur
  # after AWS accepted the change.
  updated_services+=("$service")
  previous_task_definitions+=("$previous_task_definition")
  previous_desired_counts+=("$previous_desired_count")
  deployed_task_definitions+=("$new_task_definition")
  deployed_desired_counts+=("$previous_desired_count")

  aws_until "$forward_deadline_epoch" ecs update-service \
    --cluster "$ECS_CLUSTER" \
    --service "$service" \
    --task-definition "$new_task_definition" \
    --force-new-deployment \
    >/dev/null
}

echo "::group::Deploy API and MCP tier"
deploy_service api \
  "$ECS_API_SERVICE" \
  "$ECS_API_BASELINE_TASK_DEFINITION_ARN" \
  "$ECS_API_TASK_FAMILY" \
  "${ECS_API_CONTAINER_NAME:-api}"
deploy_service mcp \
  "$ECS_MCP_SERVICE" \
  "$ECS_MCP_BASELINE_TASK_DEFINITION_ARN" \
  "$ECS_MCP_TASK_FAMILY" \
  "${ECS_MCP_CONTAINER_NAME:-mcp}"
wait_services_stable "$forward_deadline_epoch" api-mcp \
  "${updated_services[0]}"$'\t'"${deployed_task_definitions[0]}"$'\t'"${deployed_desired_counts[0]}" \
  "${updated_services[1]}"$'\t'"${deployed_task_definitions[1]}"$'\t'"${deployed_desired_counts[1]}"
echo "::endgroup::"

echo "::group::Deploy worker tier"
deploy_service worker \
  "$ECS_WORKER_SERVICE" \
  "$ECS_WORKER_BASELINE_TASK_DEFINITION_ARN" \
  "$ECS_WORKER_TASK_FAMILY" \
  "${ECS_WORKER_CONTAINER_NAME:-worker}"
wait_services_stable "$forward_deadline_epoch" worker \
  "${updated_services[2]}"$'\t'"${deployed_task_definitions[2]}"$'\t'"${deployed_desired_counts[2]}"
echo "::endgroup::"

echo "::group::Deploy Web tier"
deploy_service web \
  "$ECS_WEB_SERVICE" \
  "$ECS_WEB_BASELINE_TASK_DEFINITION_ARN" \
  "$ECS_WEB_TASK_FAMILY" \
  "${ECS_WEB_CONTAINER_NAME:-web}"
wait_services_stable "$forward_deadline_epoch" web \
  "${updated_services[3]}"$'\t'"${deployed_task_definitions[3]}"$'\t'"${deployed_desired_counts[3]}"
echo "::endgroup::"

if [[ "$DEPLOYMENT_MODE" == "forward" ]]; then
  echo "::group::Smoke-test the runtime database role"
  run_database_job \
    runtime-smoke \
    runtime-smoke \
    "$ECS_RUNTIME_SMOKE_BASELINE_TASK_DEFINITION_ARN" \
    "$ECS_RUNTIME_SMOKE_TASK_FAMILY" \
    "${ECS_RUNTIME_SMOKE_CONTAINER_NAME:-runtime-smoke}"
  echo "Runtime database role write/outbox smoke test passed."
  echo "::endgroup::"
else
  echo "::notice::Historical runtime-smoke code is skipped with the historical migration image; service readiness and public social-read checks prove application/schema compatibility without mutating database state."
fi

echo "::group::Run public social-read smoke checks"
# SMOKE_PATHS is validated through required_environment above.
# shellcheck disable=SC2153
IFS=',' read -r -a smoke_paths <<< "$SMOKE_PATHS"
if [[ "${#smoke_paths[@]}" -eq 0 ]]; then
  echo "SMOKE_PATHS must contain at least one path." >&2
  exit 2
fi

has_ready="false"
has_communities="false"
has_content="false"
for raw_path in "${smoke_paths[@]}"; do
  path="$raw_path"
  if [[ ! "$path" =~ ^/[^[:space:]]*$ ]]; then
    echo "Invalid public smoke path: ${path}" >&2
    exit 2
  fi
  route_path="${path%%\?*}"
  case "$route_path" in
    /health/ready) has_ready="true" ;;
    /v1/public/communities) has_communities="true" ;;
    /v1/public/content) has_content="true" ;;
  esac
done
if [[ "$has_ready" != "true" || "$has_communities" != "true" || "$has_content" != "true" ]]; then
  echo "SMOKE_PATHS must include /health/ready, /v1/public/communities, and /v1/public/content (query strings are allowed)." >&2
  exit 2
fi

smoke_index=0
for raw_path in "${smoke_paths[@]}"; do
  path="$raw_path"
  route_path="${path%%\?*}"
  smoke_response="$work_directory/public-smoke-${smoke_index}.json"
  smoke_index=$((smoke_index + 1))
  remaining="$(seconds_remaining "$forward_deadline_epoch")"
  if ((remaining <= 0)); then
    exit 124
  fi
  curl_budget=120
  if ((curl_budget > remaining)); then
    curl_budget="$remaining"
  fi
  run_until "$forward_deadline_epoch" curl \
    --silent \
    --show-error \
    --fail-with-body \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 5 \
    --retry-max-time "$curl_budget" \
    --output "$smoke_response" \
    "${PUBLIC_BASE_URL}${path}"

  case "$route_path" in
    /health/ready)
      jq -e --arg version "$DEPLOY_SHA" '
        .status == "ok" and .service == "api" and .version == $version
      ' "$smoke_response" >/dev/null || {
        echo "Public API readiness response did not attest the deployed SHA." >&2
        exit 1
      }
      ;;
    /v1/public/communities)
      jq -e '
        type == "object" and
        .schema_version == "1" and
        (.request_id | type == "string" and length > 0) and
        (.items | type == "array") and
        (.page | type == "object") and
        (.page.has_more | type == "boolean") and
        (.page.limit | type == "number" and . >= 1 and . <= 100 and floor == .) and
        ((.page.next_cursor == null) == (.page.has_more == false)) and
        (.ordering.snapshot_id | type == "string" and length > 0) and
        (.ordering.ordering_version | type == "string" and length > 0) and
        (.ordering.as_of | type == "string" and length > 0)
      ' "$smoke_response" >/dev/null || {
        echo "Public Community response violated its versioned cursor/ordering contract." >&2
        exit 1
      }
      ;;
    /v1/public/content)
      jq -e '
        type == "object" and
        .schema_version == "1" and
        (.request_id | type == "string" and length > 0) and
        (.items | type == "array") and
        (.page | type == "object") and
        (.page.has_more | type == "boolean") and
        (.page.limit | type == "number" and . >= 1 and . <= 100 and floor == .) and
        ((.page.next_cursor == null) == (.page.has_more == false)) and
        (.ranking.snapshot_id | type == "string" and length > 0) and
        (.ranking.ranking_version | type == "string" and length > 0) and
        (.ranking.as_of | type == "string" and length > 0) and
        (.ranking.expires_at | type == "string" and length > 0) and
        (.counts_as_of | type == "string" and length > 0)
      ' "$smoke_response" >/dev/null || {
        echo "Public Content response violated its versioned cursor/ranking contract." >&2
        exit 1
      }
      ;;
  esac
done
echo "::endgroup::"

verify_service_digest() {
  local target="$1"
  local service="$2"
  local container_name="$3"
  local expected_task_definition="$4"
  local require_container_health="$6"
  local expected_image allowed_runtime_digests service_state task_definition_state
  local current_desired_count task_arns task_state

  expected_image="$(image_reference "$target")"
  allowed_runtime_digests="$(allowed_digests_for_target "$target")"
  service_state="$(aws_until "$forward_deadline_epoch" ecs describe-services \
    --cluster "$ECS_CLUSTER" --services "$service" --output json)"
  current_desired_count="$(jq -er '.services[0].desiredCount' <<< "$service_state")"
  jq -e \
    --arg task_definition "$expected_task_definition" '
    (.failures | length) == 0 and
    (.services | length) == 1 and
    (.services[0].status == "ACTIVE") and
    (.services[0].desiredCount > 0) and
    (.services[0].runningCount == .services[0].desiredCount) and
    (.services[0].pendingCount == 0) and
    (.services[0].taskDefinition == $task_definition)
  ' <<< "$service_state" >/dev/null

  task_definition_state="$(aws_until "$forward_deadline_epoch" ecs describe-task-definition \
    --task-definition "$expected_task_definition" --include TAGS --output json)"
  jq -e \
    --arg container "$container_name" \
    --arg image "$expected_image" \
    --arg version "$DEPLOY_SHA" '
    [.taskDefinition.containerDefinitions[] |
      select(
        .name == $container and
        .image == $image and
        ([.environment[]? | select(.name == "APP_VERSION" and .value == $version)] | length) == 1
      )] | length == 1
  ' <<< "$task_definition_state" >/dev/null
  jq -e --arg sha "$DEPLOY_SHA" '
    ([.tags[]? | select(.key == "alphanet:release-sha" and .value == $sha)] | length) == 1 and
    ([.tags[]? | select(.key == "alphanet:deployment-baseline" and .value == "false")] | length) == 1
  ' <<< "$task_definition_state" >/dev/null

  task_arns="$(aws_until "$forward_deadline_epoch" ecs list-tasks \
    --cluster "$ECS_CLUSTER" \
    --service-name "$service" \
    --desired-status RUNNING \
    --query 'taskArns' \
    --output json)"
  if ! jq -e --argjson desired "$current_desired_count" \
    'length == $desired and length > 0 and length <= 100' \
    <<< "$task_arns" >/dev/null; then
    echo "Service ${service} running-task count does not match desiredCount or exceeds one verification page." >&2
    return 1
  fi

  task_arn_array=()
  while IFS= read -r task_arn; do
    task_arn_array+=("$task_arn")
  done < <(jq -r '.[]' <<< "$task_arns")
  task_state="$(aws_until "$forward_deadline_epoch" ecs describe-tasks \
    --cluster "$ECS_CLUSTER" \
    --tasks "${task_arn_array[@]}" \
    --output json)"
  jq -e \
    --arg container "$container_name" \
    --arg require_health "$require_container_health" \
    --argjson allowed_digests "$allowed_runtime_digests" '
    (.failures | length) == 0 and
    (.tasks | length > 0) and
    all(.tasks[];
      . as $task |
      .lastStatus == "RUNNING" and
      ([.containers[] | select(.name == $container)] | length == 1) and
      ([$task.containers[] | select(.name == $container)][0] as $app |
        ($allowed_digests | index($app.imageDigest) != null) and
        ($require_health != "true" or $app.healthStatus == "HEALTHY"))
    )
  ' <<< "$task_state" >/dev/null
}

echo "::group::Verify running task digests and internal health"
verify_service_digest api "$ECS_API_SERVICE" "${ECS_API_CONTAINER_NAME:-api}" \
  "${deployed_task_definitions[0]}" "${deployed_desired_counts[0]}" true
verify_service_digest mcp "$ECS_MCP_SERVICE" "${ECS_MCP_CONTAINER_NAME:-mcp}" \
  "${deployed_task_definitions[1]}" "${deployed_desired_counts[1]}" true
verify_service_digest worker "$ECS_WORKER_SERVICE" "${ECS_WORKER_CONTAINER_NAME:-worker}" \
  "${deployed_task_definitions[2]}" "${deployed_desired_counts[2]}" false
verify_service_digest web "$ECS_WEB_SERVICE" "${ECS_WEB_CONTAINER_NAME:-web}" \
  "${deployed_task_definitions[3]}" "${deployed_desired_counts[3]}" true
echo "::endgroup::"

trap - ERR INT TERM
echo "AWS ECS deployment completed for ${EXPECTED_REPOSITORY}@${DEPLOY_SHA} in ${TARGET_ENVIRONMENT}."
