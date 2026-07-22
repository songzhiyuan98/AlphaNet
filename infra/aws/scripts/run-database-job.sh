#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    "Usage: $0 JOB CLUSTER TASK_DEFINITION SUBNET_IDS SECURITY_GROUP_ID [AWS_REGION] [TIMEOUT_SECONDS]" \
    "JOB must be bootstrap, migrate, oauth-provision, or runtime-smoke; SUBNET_IDS is comma separated." \
    "Default timeout: 1800 seconds for bootstrap/migrate, 600 for oauth-provision/runtime-smoke." \
    "ALPHANET_JOB_TIMEOUT_SECONDS and ALPHANET_JOB_POLL_SECONDS may override defaults."
}

if [[ $# -lt 5 || $# -gt 7 ]]; then
  usage >&2
  exit 2
fi

job="$1"
cluster="$2"
task_definition="$3"
subnet_ids="$4"
security_group_id="$5"
aws_region="${6:-${AWS_REGION:-us-west-2}}"

if [[ ! "${job}" =~ ^(bootstrap|migrate|oauth-provision|runtime-smoke)$ ]]; then
  usage >&2
  exit 2
fi

if [[ "${job}" == "runtime-smoke" || "${job}" == "oauth-provision" ]]; then
  default_timeout_seconds=600
else
  default_timeout_seconds=1800
fi
timeout_seconds="${7:-${ALPHANET_JOB_TIMEOUT_SECONDS:-${default_timeout_seconds}}}"
poll_seconds="${ALPHANET_JOB_POLL_SECONDS:-10}"

if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] || (( timeout_seconds < 60 )); then
  printf '%s\n' "TIMEOUT_SECONDS must be an integer of at least 60." >&2
  exit 2
fi
if [[ ! "${poll_seconds}" =~ ^[0-9]+$ ]] || (( poll_seconds < 1 || poll_seconds > 60 )); then
  printf '%s\n' "ALPHANET_JOB_POLL_SECONDS must be an integer between 1 and 60." >&2
  exit 2
fi

for command_name in aws jq; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf '%s is required.\n' "${command_name}" >&2
    exit 127
  fi
done

subnets_json="$(jq -cn --arg value "${subnet_ids}" '$value | split(",")')"
network_configuration="$(jq -cn \
  --argjson subnets "${subnets_json}" \
  --arg security_group "${security_group_id}" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"DISABLED"}}')"

run_response="$(aws ecs run-task \
  --region "${aws_region}" \
  --cluster "${cluster}" \
  --task-definition "${task_definition}" \
  --launch-type FARGATE \
  --network-configuration "${network_configuration}" \
  --count 1 \
  --started-by "alphanet-${job}")"

if [[ "$(jq '.failures | length' <<<"${run_response}")" != "0" ]]; then
  jq '.failures' <<<"${run_response}" >&2
  exit 1
fi

task_arn="$(jq -er '.tasks[0].taskArn' <<<"${run_response}")"
printf 'Started %s task %s with a %ss deadline.\n' "${job}" "${task_arn}" "${timeout_seconds}"

task_result=""
task_stopped=false

describe_task() {
  aws ecs describe-tasks \
    --region "${aws_region}" \
    --cluster "${cluster}" \
    --tasks "${task_arn}"
}

print_task_result() {
  if [[ -z "${task_result}" ]]; then
    return
  fi
  jq -c --arg job "${job}" '
    .tasks[0] as $task |
    {
      taskArn: $task.taskArn,
      lastStatus: $task.lastStatus,
      stopCode: $task.stopCode,
      stoppedReason: $task.stoppedReason,
      container: (
        [$task.containers[]? | select(.name == $job) |
          {name, lastStatus, exitCode, reason}][0] // null
      )
    }
  ' <<<"${task_result}" >&2
}

stop_and_report() {
  local reason="$1"
  local attempt

  if [[ "${task_stopped}" != "true" ]]; then
    if ! aws ecs stop-task \
      --region "${aws_region}" \
      --cluster "${cluster}" \
      --task "${task_arn}" \
      --reason "${reason}" >/dev/null; then
      printf 'Unable to request stop for task %s.\n' "${task_arn}" >&2
    fi
  fi

  # Give ECS a bounded window to deliver SIGTERM and release any database lock.
  for ((attempt = 0; attempt < 18; attempt += 1)); do
    if task_result="$(describe_task)"; then
      if [[ "$(jq -r '.tasks[0].lastStatus // "MISSING"' <<<"${task_result}")" == "STOPPED" ]]; then
        task_stopped=true
        break
      fi
    fi
    sleep 5
  done

  printf 'Final observed result for task %s:\n' "${task_arn}" >&2
  print_task_result
}

handle_signal() {
  local signal_name="$1"
  local exit_code="$2"
  trap - INT TERM
  printf 'Received %s while waiting for task %s; requesting stop.\n' \
    "${signal_name}" "${task_arn}" >&2
  stop_and_report "AlphaNet operator wait interrupted by ${signal_name}"
  exit "${exit_code}"
}

trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  task_result="$(describe_task)"
  if [[ "$(jq '.failures | length' <<<"${task_result}")" != "0" ]]; then
    jq '.failures' <<<"${task_result}" >&2
    exit 1
  fi

  last_status="$(jq -er '.tasks[0].lastStatus' <<<"${task_result}")"
  if [[ "${last_status}" == "STOPPED" ]]; then
    task_stopped=true
    break
  fi
  sleep "${poll_seconds}"
done

if [[ "${task_stopped}" != "true" ]]; then
  printf '%s task %s exceeded its %ss deadline.\n' \
    "${job}" "${task_arn}" "${timeout_seconds}" >&2
  stop_and_report "AlphaNet ${job} exceeded ${timeout_seconds}s deadline"
  exit 124
fi

trap - INT TERM
printf 'Stopped result for task %s:\n' "${task_arn}"
print_task_result

exit_code="$(jq -er --arg job "${job}" '.tasks[0].containers[] | select(.name == $job) | .exitCode' <<<"${task_result}")"
if [[ "${exit_code}" != "0" ]]; then
  jq -r --arg job "${job}" '.tasks[0].containers[] | select(.name == $job) | {exitCode,reason,lastStatus}' <<<"${task_result}" >&2
  exit "${exit_code}"
fi

printf '%s database job passed.\n' "${job}"
