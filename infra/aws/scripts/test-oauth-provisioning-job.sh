#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_directory="$(mktemp -d)"
trap 'rm -rf "${test_directory}"' EXIT

mock_bin="${test_directory}/bin"
mock_state="${test_directory}/state"
mkdir -p "${mock_bin}" "${mock_state}"

manifest_file="${test_directory}/oauth-clients.json"
printf '%s\n' \
  '{"schema_version":1,"resource":"https://staging.alphanet.example/mcp","clients":[]}' \
  >"${manifest_file}"

if command -v sha256sum >/dev/null 2>&1; then
  manifest_sha256="$(sha256sum "${manifest_file}" | awk '{print $1}')"
else
  manifest_sha256="$(shasum -a 256 "${manifest_file}" | awk '{print $1}')"
fi
manifest_base64="$(base64 <"${manifest_file}" | tr -d '\r\n')"

export MOCK_AWS_STATE="${mock_state}"
export MOCK_SECRET_ARN="arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging/remote-mcp-oauth-client-provisioning-AbCdEf"
export MOCK_STATE_MACHINE_ARN="arn:aws:states:us-west-2:123456789012:stateMachine:alphanet-staging-oauth-provision"

cat >"${mock_bin}/aws" <<'MOCK_AWS'
#!/usr/bin/env bash
set -Eeuo pipefail

arg_value() {
  local wanted="$1"
  shift
  while (($# > 0)); do
    if [[ "$1" == "${wanted}" ]]; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

printf '%s\n' "$*" >>"${MOCK_AWS_STATE}/calls"
service="$1"
operation="$2"
shift 2

if [[ "${service}" == "secretsmanager" && "${operation}" == "describe-secret" ]]; then
  if [[ -f "${MOCK_AWS_STATE}/version" ]]; then
    version="$(<"${MOCK_AWS_STATE}/version")"
    stages='["ALPHANET_OAUTH_CANDIDATE"]'
    if [[ -f "${MOCK_AWS_STATE}/approved" ]] \
      && [[ "$(<"${MOCK_AWS_STATE}/approved")" == "${version}" ]]; then
      stages='["ALPHANET_OAUTH_CANDIDATE","ALPHANET_OAUTH_APPROVED"]'
    fi
    jq -n \
      --arg arn "${MOCK_SECRET_ARN}" \
      --arg version "${version}" \
      --argjson stages "${stages}" \
      '{ARN:$arn,VersionIdsToStages:{($version):$stages}}'
  else
    jq -n --arg arn "${MOCK_SECRET_ARN}" '{ARN:$arn,VersionIdsToStages:{}}'
  fi
  exit 0
fi

if [[ "${service}" == "secretsmanager" && "${operation}" == "put-secret-value" ]]; then
  version="$(arg_value --client-request-token "$@")"
  secret_string="$(arg_value --secret-string "$@")"
  [[ "${secret_string}" == file://* ]]
  payload_file="${secret_string#file://}"
  jq -e --arg version "${version}" '
    keys == ["manifest_base64", "manifest_sha256"]
    and .manifest_sha256 == $version
    and (.manifest_base64 | type == "string")
  ' "${payload_file}" >/dev/null
  cp "${payload_file}" "${MOCK_AWS_STATE}/payload"
  printf '%s' "${version}" >"${MOCK_AWS_STATE}/version"
  count=0
  [[ ! -f "${MOCK_AWS_STATE}/put-count" ]] || count="$(<"${MOCK_AWS_STATE}/put-count")"
  printf '%s' "$((count + 1))" >"${MOCK_AWS_STATE}/put-count"
  jq -n --arg arn "${MOCK_SECRET_ARN}" --arg version "${version}" \
    '{ARN:$arn,VersionId:$version}'
  exit 0
fi

if [[ "${service}" == "secretsmanager" && "${operation}" == "update-secret-version-stage" ]]; then
  version="$(arg_value --move-to-version-id "$@")"
  [[ "${version}" == "$(<"${MOCK_AWS_STATE}/version")" ]]
  printf '%s' "${version}" >"${MOCK_AWS_STATE}/approved"
  jq -n --arg arn "${MOCK_SECRET_ARN}" '{ARN:$arn}'
  exit 0
fi

if [[ "${service}" == "stepfunctions" && "${operation}" == "describe-state-machine" ]]; then
  [[ "$(arg_value --state-machine-arn "$@")" == "${MOCK_STATE_MACHINE_ARN}" ]]
  jq -n --arg arn "${MOCK_STATE_MACHINE_ARN}" '{
    stateMachineArn: $arn,
    name: "alphanet-staging-oauth-provision",
    status: "ACTIVE",
    type: "STANDARD"
  }'
  exit 0
fi

if [[ "${service}" == "stepfunctions" && "${operation}" == "start-execution" ]]; then
  [[ "$(arg_value --state-machine-arn "$@")" == "${MOCK_STATE_MACHINE_ARN}" ]]
  execution_name="$(arg_value --name "$@")"
  [[ "${execution_name}" =~ ^manifest-[0-9a-f]{32}-[0-9]{8}T[0-9]{6}-[0-9]+$ ]]
  execution_arn="${MOCK_STATE_MACHINE_ARN/:stateMachine:/:execution:}:${execution_name}"
  input_reference="$(arg_value --input "$@")"
  [[ "${input_reference}" == file://* ]]
  input_file="${input_reference#file://}"
  cp "${input_file}" "${MOCK_AWS_STATE}/execution-input"
  printf '%s' "${execution_name}" >"${MOCK_AWS_STATE}/execution-name"
  printf '%s' "${execution_arn}" >"${MOCK_AWS_STATE}/execution-arn"
  jq -e --arg digest "$(<"${MOCK_AWS_STATE}/approved")" \
    '. == {expected_manifest_sha256:$digest}' "${input_file}" >/dev/null
  if [[ -f "${MOCK_AWS_STATE}/start-fail-after-accept" ]]; then
    exit 1
  fi
  jq -n --arg arn "${execution_arn}" '{executionArn:$arn}'
  exit 0
fi

if [[ "${service}" == "stepfunctions" && "${operation}" == "describe-execution" ]]; then
  execution_arn="$(<"${MOCK_AWS_STATE}/execution-arn")"
  execution_name="$(<"${MOCK_AWS_STATE}/execution-name")"
  [[ "$(arg_value --execution-arn "$@")" == "${execution_arn}" ]]
  count=0
  [[ ! -f "${MOCK_AWS_STATE}/describe-count" ]] || count="$(<"${MOCK_AWS_STATE}/describe-count")"
  count=$((count + 1))
  printf '%s' "${count}" >"${MOCK_AWS_STATE}/describe-count"
  mode="success"
  [[ ! -f "${MOCK_AWS_STATE}/execution-mode" ]] || mode="$(<"${MOCK_AWS_STATE}/execution-mode")"
  status="SUCCEEDED"
  if [[ "${mode}" == "timeout-success" && "${count}" -eq 1 ]]; then
    status="RUNNING"
  elif [[ "${mode}" == "timeout-unknown" ]]; then
    status="RUNNING"
  fi
  input="$(jq -c . "${MOCK_AWS_STATE}/execution-input")"
  jq -n \
    --arg arn "${execution_arn}" \
    --arg state_machine "${MOCK_STATE_MACHINE_ARN}" \
    --arg name "${execution_name}" \
    --arg input "${input}" \
    --arg status "${status}" \
    '{executionArn:$arn,stateMachineArn:$state_machine,name:$name,input:$input,status:$status}'
  exit 0
fi

if [[ "${service}" == "stepfunctions" && "${operation}" == "stop-execution" ]]; then
  if [[ -f "${MOCK_AWS_STATE}/stop-fail" ]]; then
    exit 1
  fi
  jq -n '{}'
  exit 0
fi

printf 'Unsupported mock AWS call: %s %s\n' "${service}" "${operation}" >&2
exit 1
MOCK_AWS
chmod +x "${mock_bin}/aws"

cat >"${mock_bin}/psql" <<'MOCK_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail
: >"${MOCK_AWS_STATE}/unexpected-psql-call"
exit 99
MOCK_PSQL
chmod +x "${mock_bin}/psql"

cat >"${mock_bin}/date" <<'MOCK_DATE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == "-u +%Y%m%dT%H%M%S" ]]; then
  printf '%s\n' '20260722T120000'
  exit 0
fi
if [[ "$*" == "+%s" ]]; then
  value=0
  [[ ! -f "${MOCK_AWS_STATE}/date-clock" ]] || value="$(<"${MOCK_AWS_STATE}/date-clock")"
  printf '%s\n' "${value}"
  printf '%s' "$((value + 31))" >"${MOCK_AWS_STATE}/date-clock"
  exit 0
fi
printf 'Unsupported mock date call: %s\n' "$*" >&2
exit 1
MOCK_DATE
chmod +x "${mock_bin}/date"

cat >"${mock_bin}/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
set -Eeuo pipefail
exit 0
MOCK_SLEEP
chmod +x "${mock_bin}/sleep"

export PATH="${mock_bin}:${PATH}"
export ALPHANET_OAUTH_MANIFEST_SHA256="${manifest_sha256}"

if invalid_injection_output="$(
  ALPHANET_MIGRATION_ROLE=alphanet_migration \
  ALPHANET_OAUTH_MANIFEST_BASE64='A===' \
  ALPHANET_OAUTH_MANIFEST_SHA256='0000000000000000000000000000000000000000000000000000000000000000' \
  ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256='0000000000000000000000000000000000000000000000000000000000000000' \
  PGUSER=alphanet_migration \
    bash "${repository_root}/db/scripts/aws-reconcile-remote-mcp-oauth-clients.sh" \
      2>&1
)"; then
  echo "Malformed injected OAuth manifest unexpectedly reached PostgreSQL." >&2
  exit 1
fi
[[ "${invalid_injection_output}" == \
  "The OAuth client manifest could not be decoded safely." ]]
[[ ! -e "${mock_state}/unexpected-psql-call" ]]

stage_output="$(
  bash "${repository_root}/infra/aws/scripts/stage-oauth-client-manifest.sh" \
    "${manifest_file}" "${MOCK_SECRET_ARN}" us-west-2
)"
[[ "${stage_output}" == "Approved Remote MCP OAuth manifest version ${manifest_sha256}." ]]
[[ "$(<"${mock_state}/put-count")" == "1" ]]
jq -e \
  --arg digest "${manifest_sha256}" \
  --arg encoded "${manifest_base64}" \
  '.manifest_sha256 == $digest and .manifest_base64 == $encoded' \
  "${mock_state}/payload" >/dev/null

# Re-approving an immutable digest version is idempotent and must not create a
# second Secrets Manager version. This is the rollback path for an old digest.
bash "${repository_root}/infra/aws/scripts/stage-oauth-client-manifest.sh" \
  "${manifest_file}" "${MOCK_SECRET_ARN}" us-west-2 >/dev/null
[[ "$(<"${mock_state}/put-count")" == "1" ]]

launcher_output="$(
  bash "${repository_root}/infra/aws/scripts/run-oauth-provisioning-job.sh" \
    "${MOCK_STATE_MACHINE_ARN}" \
    "${MOCK_SECRET_ARN}" \
    "${manifest_sha256}" \
    us-west-2 \
    60 \
    2>&1
)"
[[ "${launcher_output}" == "Trusted Remote MCP OAuth provisioning completed." ]]

jq -e \
  --arg version "${manifest_sha256}" \
  '. == {expected_manifest_sha256:$version}' \
  "${mock_state}/execution-input" >/dev/null

rm -f \
  "${mock_state}/date-clock" \
  "${mock_state}/describe-count"
printf '%s' 'timeout-success' >"${mock_state}/execution-mode"
: >"${mock_state}/stop-fail"
timeout_success_output="$(
  bash "${repository_root}/infra/aws/scripts/run-oauth-provisioning-job.sh" \
    "${MOCK_STATE_MACHINE_ARN}" \
    "${MOCK_SECRET_ARN}" \
    "${manifest_sha256}" \
    us-west-2 \
    60 \
    2>&1
)"
[[ "${timeout_success_output}" == *"Unable to request workflow cancellation"* ]]
[[ "${timeout_success_output}" == *"completed after the local timeout"* ]]

rm -f \
  "${mock_state}/date-clock" \
  "${mock_state}/describe-count" \
  "${mock_state}/stop-fail"
printf '%s' 'timeout-unknown' >"${mock_state}/execution-mode"
if timeout_unknown_output="$(
  bash "${repository_root}/infra/aws/scripts/run-oauth-provisioning-job.sh" \
    "${MOCK_STATE_MACHINE_ARN}" \
    "${MOCK_SECRET_ARN}" \
    "${manifest_sha256}" \
    us-west-2 \
    60 \
    2>&1
)"; then
  echo "An unresolved provisioning workflow unexpectedly returned success." >&2
  exit 1
else
  timeout_unknown_status=$?
fi
[[ "${timeout_unknown_status}" -eq 70 ]]
[[ "${timeout_unknown_output}" == *"outcome is still unknown"* ]]
[[ "${timeout_unknown_output}" == *"Do not retry or move the approved stage"* ]]

rm -f \
  "${mock_state}/date-clock" \
  "${mock_state}/describe-count" \
  "${mock_state}/execution-mode"
: >"${mock_state}/start-fail-after-accept"
ambiguous_start_output="$(
  bash "${repository_root}/infra/aws/scripts/run-oauth-provisioning-job.sh" \
    "${MOCK_STATE_MACHINE_ARN}" \
    "${MOCK_SECRET_ARN}" \
    "${manifest_sha256}" \
    us-west-2 \
    60 \
    2>&1
)"
[[ "${ambiguous_start_output}" == "Trusted Remote MCP OAuth provisioning completed." ]]
rm -f "${mock_state}/start-fail-after-accept"

if grep -Eq 'ecs (register-task-definition|run-task)|iam:PassRole' \
  "${mock_state}/calls"; then
  echo "The operator launcher crossed the trusted Step Functions boundary." >&2
  exit 1
fi

if grep -Fq "$(<"${manifest_file}")" "${mock_state}/calls" \
  || grep -Fq "${manifest_base64}" "${mock_state}/calls" \
  || grep -Fq "$(<"${manifest_file}")" <<<"${launcher_output}"; then
  echo "OAuth manifest values leaked into AWS argv or operator output." >&2
  exit 1
fi

echo "OAuth provisioning operator-path tests passed."
