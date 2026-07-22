#!/usr/bin/env bash
set -Eeuo pipefail

set +x
umask 077

usage() {
  printf '%s\n' \
    "Usage: ALPHANET_OAUTH_MANIFEST_SHA256=<reviewed-sha256> $0 MANIFEST_FILE SECRET_ARN [AWS_REGION]" \
    "Stages an exact reviewed manifest version; document values never enter argv or normal output."
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage >&2
  exit 2
fi

manifest_file="$1"
secret_arn="$2"
aws_region="${3:-${AWS_REGION:-us-west-2}}"
expected_sha256="${ALPHANET_OAUTH_MANIFEST_SHA256:-}"

if [[ ! "${expected_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ALPHANET_OAUTH_MANIFEST_SHA256 must pin the reviewed manifest." >&2
  exit 2
fi
if [[ ! "${secret_arn}" =~ ^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$ ]]; then
  echo "SECRET_ARN must be a complete Secrets Manager ARN." >&2
  exit 2
fi
if [[ ! "${aws_region}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "AWS_REGION is invalid." >&2
  exit 2
fi
if [[ ! -f "${manifest_file}" || -L "${manifest_file}" || ! -r "${manifest_file}" ]]; then
  echo "The OAuth client manifest must be a readable, non-symlink regular file." >&2
  exit 2
fi

for command_name in aws jq base64 wc tr mktemp awk; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required to stage an OAuth client manifest." >&2
    exit 127
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  checksum_stream() {
    sha256sum | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  checksum_stream() {
    shasum -a 256 | awk '{print $1}'
  }
else
  echo "sha256sum or shasum is required to verify the reviewed manifest." >&2
  exit 127
fi

manifest_bytes="$(wc -c <"${manifest_file}" | tr -d '[:space:]')"
if [[ ! "${manifest_bytes}" =~ ^[0-9]+$ ]] \
  || ((manifest_bytes < 2 || manifest_bytes > 48000)); then
  echo "The OAuth client manifest must contain between 2 and 48000 bytes." >&2
  exit 2
fi
if ! jq -e . "${manifest_file}" >/dev/null 2>&1; then
  echo "The OAuth client manifest is not valid JSON." >&2
  exit 2
fi

manifest_base64="$(base64 <"${manifest_file}" | tr -d '\r\n')"
if [[ -z "${manifest_base64}" || ! "${manifest_base64}" =~ ^[A-Za-z0-9+/=]+$ ]] \
  || ((${#manifest_base64} > 64000)); then
  echo "The OAuth client manifest could not be encoded safely." >&2
  exit 2
fi

if printf '' | base64 --decode >/dev/null 2>&1; then
  BASE64_DECODE=(base64 --decode)
elif printf '' | base64 -D >/dev/null 2>&1; then
  BASE64_DECODE=(base64 -D)
else
  echo "base64 must support --decode or -D." >&2
  exit 127
fi

manifest_sha256="$(
  printf '%s' "${manifest_base64}" \
    | "${BASE64_DECODE[@]}" \
    | checksum_stream
)"
if [[ "${manifest_sha256}" != "${expected_sha256}" ]]; then
  echo "The OAuth client manifest does not match its reviewed SHA-256." >&2
  exit 2
fi

payload_file="$(mktemp)"
response_file="$(mktemp)"
description_file="$(mktemp)"
failure_output="$(mktemp)"
chmod 600 "${payload_file}" "${response_file}" "${description_file}" "${failure_output}"
cleanup() {
  rm -f "${payload_file}" "${response_file}" "${description_file}" "${failure_output}"
}
trap cleanup EXIT

printf '%s' "${manifest_base64}" \
  | jq -Rs --arg sha256 "${manifest_sha256}" \
    '{manifest_base64: ., manifest_sha256: $sha256}' \
    >"${payload_file}"
unset manifest_base64

if ! AWS_CLI_AUTO_PROMPT=off aws secretsmanager describe-secret \
  --region "${aws_region}" \
  --secret-id "${secret_arn}" \
  --output json \
  >"${description_file}" 2>"${failure_output}"; then
  echo "Unable to inspect the dedicated OAuth provisioning secret." >&2
  exit 1
fi
if [[ "$(jq -r '.ARN // empty' "${description_file}")" != "${secret_arn}" ]]; then
  echo "The OAuth provisioning secret ARN did not resolve exactly." >&2
  exit 1
fi

version_exists="$(jq -r --arg version "${manifest_sha256}" '
  (.VersionIdsToStages // {}) | has($version)
' "${description_file}")"
if [[ "${version_exists}" != "true" ]]; then
  if ! AWS_CLI_AUTO_PROMPT=off aws secretsmanager put-secret-value \
    --region "${aws_region}" \
    --secret-id "${secret_arn}" \
    --client-request-token "${manifest_sha256}" \
    --secret-string "file://${payload_file}" \
    --version-stages ALPHANET_OAUTH_CANDIDATE \
    --output json \
    >"${response_file}" 2>"${failure_output}"; then
    echo "Unable to stage the reviewed OAuth provisioning manifest." >&2
    exit 1
  fi
  if [[ "$(jq -r '.ARN // empty' "${response_file}")" != "${secret_arn}" \
    || "$(jq -r '.VersionId // empty' "${response_file}")" != "${manifest_sha256}" ]]; then
    echo "Secrets Manager did not persist the expected digest-addressed version." >&2
    exit 1
  fi
fi

if ! AWS_CLI_AUTO_PROMPT=off aws secretsmanager describe-secret \
  --region "${aws_region}" \
  --secret-id "${secret_arn}" \
  --output json \
  >"${description_file}" 2>"${failure_output}"; then
  echo "Unable to verify the staged OAuth provisioning manifest." >&2
  exit 1
fi

approved_count="$(jq -r '
  [
    (.VersionIdsToStages // {})
    | to_entries[]
    | select(.value | index("ALPHANET_OAUTH_APPROVED"))
  ] | length
' "${description_file}")"
if ((approved_count > 1)); then
  echo "The OAuth provisioning secret has multiple approved versions." >&2
  exit 1
fi

approved_version="$(jq -r '
  [
    (.VersionIdsToStages // {})
    | to_entries[]
    | select(.value | index("ALPHANET_OAUTH_APPROVED"))
    | .key
  ][0] // empty
' "${description_file}")"
if [[ "${approved_version}" != "${manifest_sha256}" ]]; then
  stage_arguments=(
    secretsmanager update-secret-version-stage
    --region "${aws_region}"
    --secret-id "${secret_arn}"
    --version-stage ALPHANET_OAUTH_APPROVED
    --move-to-version-id "${manifest_sha256}"
    --output json
  )
  if [[ -n "${approved_version}" ]]; then
    stage_arguments+=(--remove-from-version-id "${approved_version}")
  fi
  if ! AWS_CLI_AUTO_PROMPT=off aws "${stage_arguments[@]}" \
    >"${response_file}" 2>"${failure_output}"; then
    echo "Unable to promote the reviewed OAuth provisioning manifest." >&2
    exit 1
  fi
fi

if ! AWS_CLI_AUTO_PROMPT=off aws secretsmanager describe-secret \
  --region "${aws_region}" \
  --secret-id "${secret_arn}" \
  --output json \
  >"${description_file}" 2>"${failure_output}"; then
  echo "Unable to verify the approved OAuth provisioning manifest." >&2
  exit 1
fi
if [[ "$(jq -r --arg version "${manifest_sha256}" '
  [
    (.VersionIdsToStages // {})
    | to_entries[]
    | select(.value | index("ALPHANET_OAUTH_APPROVED"))
    | .key
  ] == [$version]
' "${description_file}")" != "true" ]]; then
  echo "The reviewed OAuth provisioning version was not promoted atomically." >&2
  exit 1
fi

echo "Approved Remote MCP OAuth manifest version ${manifest_sha256}."
