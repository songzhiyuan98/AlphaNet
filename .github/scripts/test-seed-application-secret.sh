#!/usr/bin/env bash
set -Eeuo pipefail
set +x

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
trap 'rm -rf "${test_directory}"' EXIT

mock_bin="${test_directory}/bin"
mock_state="${test_directory}/state"
mock_secret_file="${mock_state}/current-secret.json"
mock_calls_file="${mock_state}/calls"
mock_payload_file="${mock_state}/pending-secret.json"
mkdir -p "${mock_bin}" "${mock_state}"

export MOCK_AWS_CALLS_FILE="${mock_calls_file}"
export MOCK_AWS_PAYLOAD_FILE="${mock_payload_file}"
export MOCK_AWS_SECRET_FILE="${mock_secret_file}"

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

service="$1"
operation="$2"
shift 2
printf '%s %s\n' "${service}" "${operation}" >>"${MOCK_AWS_CALLS_FILE}"

if [[ "${service}" != "secretsmanager" ]]; then
  printf 'Unsupported mock AWS service: %s\n' "${service}" >&2
  exit 1
fi

case "${operation}" in
  list-secret-version-ids)
    printf '%s\n' \
      '{"Versions":[{"VersionId":"current-version","VersionStages":["AWSCURRENT"]}]}'
    ;;
  get-secret-value)
    secret_string="$(jq -c . "${MOCK_AWS_SECRET_FILE}")"
    jq -n --arg secret_string "${secret_string}" \
      '{VersionId:"current-version",SecretString:$secret_string}'
    ;;
  put-secret-value)
    client_token="$(arg_value --client-request-token "$@")"
    [[ "$(arg_value --secret-string "$@")" == "file:///dev/stdin" ]]
    jq -e 'select(type == "object")' >"${MOCK_AWS_PAYLOAD_FILE}"
    printf '%s\n' "${client_token}"
    ;;
  update-secret-version-stage)
    printf '%s\n' '{}'
    ;;
  *)
    printf 'Unsupported mock AWS operation: %s\n' "${operation}" >&2
    exit 1
    ;;
esac
MOCK_AWS
chmod +x "${mock_bin}/aws"

seed_script="${repository_root}/infra/aws/scripts/seed-application-secret.sh"
readonly secret_arn="arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-test-AbCdEf"

assert_rejected_without_put() {
  local case_name="$1"
  local expected_fields="$2"
  local secret_json="$3"
  local output

  printf '%s\n' "${secret_json}" >"${mock_secret_file}"
  : >"${mock_calls_file}"
  rm -f "${mock_payload_file}"

  if output="$(
    PATH="${mock_bin}:${PATH}" \
      bash "${seed_script}" --augment-admin-web "${secret_arn}" us-west-2 2>&1
  )"; then
    printf '%s unexpectedly passed validation.\n' "${case_name}" >&2
    exit 1
  fi
  if [[ "${output}" != "${expected_fields}" ]]; then
    printf '%s returned an unexpected error field: %s\n' \
      "${case_name}" "${output}" >&2
    exit 1
  fi
  if grep -q '^secretsmanager put-secret-value$' "${mock_calls_file}"; then
    printf '%s wrote a Secrets Manager version after validation failed.\n' \
      "${case_name}" >&2
    exit 1
  fi
  if [[ -e "${mock_payload_file}" ]]; then
    printf '%s produced a pending secret after validation failed.\n' \
      "${case_name}" >&2
    exit 1
  fi
}

oidc_short="$(printf 'x%.0s' {1..31})"
oidc_long="$(printf 'x%.0s' {1..513})"
oidc_with_space="$(printf 'x%.0s' {1..31}) "
oidc_with_non_ascii="$(printf 'x%.0s' {1..31})é"
valid_session_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
noncanonical_session_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="
nonstandard_session_key="_${valid_session_key:1}"
wrong_size_session_key="$(printf 'x%.0s' {1..31} | openssl base64 -A)"
valid_audit_digest="$(printf 'a%.0s' {1..64})"
uppercase_audit_digest="$(printf 'A%.0s' {1..64})"
short_audit_digest="$(printf 'a%.0s' {1..63})"

assert_rejected_without_put \
  "short OIDC client secret" \
  "ADMIN_WEB_OIDC_CLIENT_SECRET" \
  "$(jq -cn --arg value "${oidc_short}" \
    '{ADMIN_WEB_OIDC_CLIENT_SECRET:$value}')"
assert_rejected_without_put \
  "OIDC client secret containing a space" \
  "ADMIN_WEB_OIDC_CLIENT_SECRET" \
  "$(jq -cn --arg value "${oidc_with_space}" \
    '{ADMIN_WEB_OIDC_CLIENT_SECRET:$value}')"
assert_rejected_without_put \
  "long OIDC client secret" \
  "ADMIN_WEB_OIDC_CLIENT_SECRET" \
  "$(jq -cn --arg value "${oidc_long}" \
    '{ADMIN_WEB_OIDC_CLIENT_SECRET:$value}')"
assert_rejected_without_put \
  "non-ASCII OIDC client secret" \
  "ADMIN_WEB_OIDC_CLIENT_SECRET" \
  "$(jq -cn --arg value "${oidc_with_non_ascii}" \
    '{ADMIN_WEB_OIDC_CLIENT_SECRET:$value}')"
assert_rejected_without_put \
  "non-standard session base64" \
  "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64" \
  "$(jq -cn --arg value "${nonstandard_session_key}" \
    '{ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64:$value}')"
assert_rejected_without_put \
  "wrong-size session key" \
  "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64" \
  "$(jq -cn --arg value "${wrong_size_session_key}" \
    '{ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64:$value}')"
assert_rejected_without_put \
  "noncanonical session base64" \
  "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64" \
  "$(jq -cn --arg value "${noncanonical_session_key}" \
    '{ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64:$value}')"
assert_rejected_without_put \
  "uppercase audit digest" \
  "ADMIN_AUDIT_SUBJECT_DIGEST_KEY" \
  "$(jq -cn --arg value "${uppercase_audit_digest}" \
    '{ADMIN_AUDIT_SUBJECT_DIGEST_KEY:$value}')"
assert_rejected_without_put \
  "short audit digest" \
  "ADMIN_AUDIT_SUBJECT_DIGEST_KEY" \
  "$(jq -cn --arg value "${short_audit_digest}" \
    '{ADMIN_AUDIT_SUBJECT_DIGEST_KEY:$value}')"
assert_rejected_without_put \
  "multiple invalid Admin Web fields" \
  $'ADMIN_WEB_OIDC_CLIENT_SECRET\nADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64\nADMIN_AUDIT_SUBJECT_DIGEST_KEY' \
  "$(jq -cn \
    --arg oidc "${oidc_short}" \
    --arg session "${noncanonical_session_key}" \
    --arg audit "${uppercase_audit_digest}" '
    {
      ADMIN_WEB_OIDC_CLIENT_SECRET: $oidc,
      ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: $session,
      ADMIN_AUDIT_SUBJECT_DIGEST_KEY: $audit
    }
  ')"

valid_oidc_secret="$(printf 's%.0s' {1..32})"
jq -n \
  --arg session_key "${valid_session_key}" \
  --arg audit_digest "${valid_audit_digest}" \
  '{
    EXISTING_APPLICATION_FIELD: "preserve-this-value",
    ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: $session_key,
    ADMIN_AUDIT_SUBJECT_DIGEST_KEY: $audit_digest
  }' >"${mock_secret_file}"
: >"${mock_calls_file}"
rm -f "${mock_payload_file}"

success_output="$(
  ADMIN_WEB_OIDC_CLIENT_SECRET="${valid_oidc_secret}" \
  PATH="${mock_bin}:${PATH}" \
    bash "${seed_script}" --augment-admin-web "${secret_arn}" us-west-2
)"
[[ "${success_output}" == \
  "Application secret augmented with absent Admin Web keys; existing values were preserved." ]]
[[ "$(grep -c '^secretsmanager put-secret-value$' "${mock_calls_file}")" == "1" ]]
[[ -f "${mock_payload_file}" ]]
jq -e \
  --arg oidc_secret "${valid_oidc_secret}" \
  --arg session_key "${valid_session_key}" \
  --arg audit_digest "${valid_audit_digest}" '
  .EXISTING_APPLICATION_FIELD == "preserve-this-value"
  and .ADMIN_WEB_OIDC_CLIENT_SECRET == $oidc_secret
  and .ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64 == $session_key
  and .ADMIN_AUDIT_SUBJECT_DIGEST_KEY == $audit_digest
' "${mock_payload_file}" >/dev/null

preserved_session_key="$(
  jq -er '.ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64' "${mock_payload_file}"
)"
[[ "$(
  printf '%s' "${preserved_session_key}" |
    openssl base64 -d -A |
    wc -c |
    tr -d '[:space:]'
)" == "32" ]]
[[ "$(
  printf '%s' "${preserved_session_key}" |
    openssl base64 -d -A |
    openssl base64 -A
)" == "${preserved_session_key}" ]]

printf '%s\n' "Admin Web application-secret augmentation tests passed."
