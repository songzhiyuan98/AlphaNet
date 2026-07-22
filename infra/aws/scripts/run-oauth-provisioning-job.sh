#!/usr/bin/env bash
set -Eeuo pipefail

set +x
umask 077

usage() {
  printf '%s\n' \
    "Usage: $0 STATE_MACHINE_ARN SECRET_ARN SECRET_VERSION_ID [AWS_REGION] [TIMEOUT_SECONDS]" \
    "SECRET_VERSION_ID must be the exact reviewed manifest SHA-256 carrying ALPHANET_OAUTH_APPROVED."
}

if [[ $# -lt 3 || $# -gt 5 ]]; then
  usage >&2
  exit 2
fi

state_machine_arn="$1"
secret_arn="$2"
secret_version_id="$3"
aws_region="${4:-${AWS_REGION:-us-west-2}}"
timeout_seconds="${5:-900}"

if [[ ! "${state_machine_arn}" =~ ^arn:(aws|aws-us-gov|aws-cn):states:[a-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]+$ ]]; then
  echo "STATE_MACHINE_ARN must be a complete Step Functions state-machine ARN." >&2
  exit 2
fi
if [[ ! "${secret_arn}" =~ ^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$ ]]; then
  echo "SECRET_ARN must be a complete Secrets Manager ARN." >&2
  exit 2
fi
if [[ ! "${secret_version_id}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "SECRET_VERSION_ID must be the reviewed manifest SHA-256." >&2
  exit 2
fi
if [[ ! "${aws_region}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "AWS_REGION is invalid." >&2
  exit 2
fi
if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] \
  || ((timeout_seconds < 60 || timeout_seconds > 3600)); then
  echo "TIMEOUT_SECONDS must be an integer from 60 through 3600." >&2
  exit 2
fi

for command_name in aws date jq mktemp sleep; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required to run OAuth provisioning." >&2
    exit 127
  fi
done

secret_description_file="$(mktemp)"
state_machine_file="$(mktemp)"
execution_input_file="$(mktemp)"
execution_file="$(mktemp)"
failure_output="$(mktemp)"
chmod 600 \
  "${secret_description_file}" \
  "${state_machine_file}" \
  "${execution_input_file}" \
  "${execution_file}" \
  "${failure_output}"
execution_arn=""
execution_name=""

# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup() {
  rm -f \
    "${secret_description_file}" \
    "${state_machine_file}" \
    "${execution_input_file}" \
    "${execution_file}" \
    "${failure_output}"
}
trap cleanup EXIT

if ! AWS_CLI_AUTO_PROMPT=off aws secretsmanager describe-secret \
  --region "${aws_region}" \
  --secret-id "${secret_arn}" \
  --output json \
  >"${secret_description_file}" 2>"${failure_output}"; then
  echo "Unable to inspect the OAuth provisioning secret." >&2
  exit 1
fi
if [[ "$(jq -r '.ARN // empty' "${secret_description_file}")" != "${secret_arn}" \
  || "$(jq -r --arg version "${secret_version_id}" '
    (.VersionIdsToStages[$version] // [])
    | index("ALPHANET_OAUTH_APPROVED") != null
  ' "${secret_description_file}")" != "true" ]]; then
  echo "The requested OAuth manifest version is not the uniquely approved version." >&2
  exit 1
fi
if [[ "$(jq -r '
  [
    (.VersionIdsToStages // {})
    | to_entries[]
    | select(.value | index("ALPHANET_OAUTH_APPROVED"))
  ] | length
' "${secret_description_file}")" != "1" ]]; then
  echo "The OAuth provisioning secret has an ambiguous approved stage." >&2
  exit 1
fi

# The caller needs only states:StartExecution/DescribeExecution/StopExecution on
# one exact ARN. It receives no ECS RunTask, RegisterTaskDefinition, or PassRole
# authority and therefore cannot replace the digest-pinned image, command,
# roles, network, or secret selectors enforced by the trusted state machine.
if ! AWS_CLI_AUTO_PROMPT=off aws stepfunctions describe-state-machine \
  --region "${aws_region}" \
  --state-machine-arn "${state_machine_arn}" \
  --output json \
  >"${state_machine_file}" 2>"${failure_output}"; then
  echo "Unable to inspect the trusted OAuth provisioning launcher." >&2
  exit 1
fi
if ! jq -e --arg expected "${state_machine_arn}" '
  .stateMachineArn == $expected
  and .status == "ACTIVE"
  and .type == "STANDARD"
  and (.name | endswith("-oauth-provision"))
' "${state_machine_file}" >/dev/null; then
  echo "The OAuth provisioning launcher is not the expected active state machine." >&2
  exit 1
fi

jq -n --arg digest "${secret_version_id}" \
  '{expected_manifest_sha256: $digest}' >"${execution_input_file}"

state_machine_name="${state_machine_arn##*:stateMachine:}"
execution_name="manifest-${secret_version_id:0:32}-$(date -u +%Y%m%dT%H%M%S)-$$"
expected_execution_arn="${state_machine_arn/:stateMachine:/:execution:}:${execution_name}"

describe_execution() {
  AWS_CLI_AUTO_PROMPT=off aws stepfunctions describe-execution \
    --region "${aws_region}" \
    --execution-arn "${expected_execution_arn}" \
    --output json \
    >"${execution_file}" 2>"${failure_output}"
}

execution_matches_request() {
  jq -e \
    --arg execution "${expected_execution_arn}" \
    --arg state_machine "${state_machine_arn}" \
    --arg name "${execution_name}" \
    --arg digest "${secret_version_id}" '
      .executionArn == $execution
      and .stateMachineArn == $state_machine
      and .name == $name
      and ((.input | fromjson?) == {expected_manifest_sha256:$digest})
    ' "${execution_file}" >/dev/null
}

if AWS_CLI_AUTO_PROMPT=off aws stepfunctions start-execution \
  --region "${aws_region}" \
  --state-machine-arn "${state_machine_arn}" \
  --name "${execution_name}" \
  --input "file://${execution_input_file}" \
  --output json \
  >"${execution_file}" 2>"${failure_output}"; then
  execution_arn="$(jq -r '.executionArn // empty' "${execution_file}")"
elif describe_execution && execution_matches_request; then
  # A client-side timeout can happen after StartExecution is accepted. The
  # per-invocation name makes the execution ARN deterministic, so continue
  # observing that exact input rather than starting a second task.
  execution_arn="${expected_execution_arn}"
else
  echo "Unable to start or reconcile the trusted OAuth provisioning workflow." >&2
  exit 1
fi

if [[ "${execution_arn}" != "${expected_execution_arn}" \
  || "${state_machine_name}" == "${state_machine_arn}" ]]; then
  echo "The trusted launcher returned an invalid execution identity." >&2
  exit 1
fi

deadline=$(($(date +%s) + timeout_seconds))
while (($(date +%s) < deadline)); do
  if ! describe_execution; then
    echo "Unable to inspect the OAuth provisioning workflow." >&2
    exit 1
  fi
  if ! execution_matches_request; then
    echo "The OAuth provisioning workflow identity or input changed unexpectedly." >&2
    exit 1
  fi
  status="$(jq -r '.status // empty' "${execution_file}")"
  case "${status}" in
    SUCCEEDED)
      echo "Trusted Remote MCP OAuth provisioning completed."
      exit 0
      ;;
    FAILED | TIMED_OUT | ABORTED)
      echo "Remote MCP OAuth provisioning failed; inspect the audited workflow and task logs." >&2
      exit 1
      ;;
    RUNNING)
      sleep 2
      ;;
    *)
      echo "The OAuth provisioning workflow returned an invalid status." >&2
      exit 1
      ;;
  esac
done

stop_requested="true"
if ! AWS_CLI_AUTO_PROMPT=off aws stepfunctions stop-execution \
  --region "${aws_region}" \
  --execution-arn "${execution_arn}" \
  --cause "AlphaNet operator launcher timeout" \
  --output json \
  >/dev/null 2>"${failure_output}"; then
  stop_requested="false"
  echo "Unable to request workflow cancellation; reconciling the exact execution before returning." >&2
fi

# Never turn a local timeout into permission to retry an execution whose final
# database outcome is still unknown. Continue observing the exact named input
# for a bounded interval after StopExecution, even when the stop request itself
# failed or raced a terminal transition.
cancellation_deadline=$(($(date +%s) + 120))
while (($(date +%s) < cancellation_deadline)); do
  if describe_execution && execution_matches_request; then
    status="$(jq -r '.status // empty' "${execution_file}")"
    case "${status}" in
      SUCCEEDED)
        echo "Trusted Remote MCP OAuth provisioning completed after the local timeout."
        exit 0
        ;;
      FAILED | TIMED_OUT | ABORTED)
        echo "Remote MCP OAuth provisioning reached terminal status ${status} after the local timeout; inspect the audited workflow and task logs." >&2
        exit 1
        ;;
      RUNNING)
        ;;
      *)
        echo "The OAuth provisioning workflow returned an invalid status during timeout reconciliation." >&2
        exit 70
        ;;
    esac
  fi
  sleep 2
done

if [[ "${stop_requested}" == "true" ]]; then
  echo "Cancellation was requested, but the workflow outcome is still unknown. Do not retry or move the approved stage until an operator confirms the exact execution and ECS task are terminal." >&2
else
  echo "Cancellation could not be requested and the workflow outcome is unknown. Do not retry or move the approved stage until an operator confirms the exact execution and ECS task are terminal." >&2
fi
exit 70
