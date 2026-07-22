#!/usr/bin/env bash
set -Eeuo pipefail

# This command handles an approved public-client manifest. Never enable xtrace:
# the manifest is deliberately streamed over COPY STDIN instead of appearing in
# argv, SQL text, or ordinary command output.
set +x
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SQL_FILE="${DB_DIR}/aws/reconcile-remote-mcp-oauth-clients.sql"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"
EXPECTED_SHA256="${ALPHANET_OAUTH_MANIFEST_SHA256:-}"
EXPECTED_APPROVED_SHA256="${ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256:-}"
EXPECTED_RESOURCE="${ALPHANET_EXPECTED_OAUTH_RESOURCE:-}"
INJECTED_MANIFEST_BASE64="${ALPHANET_OAUTH_MANIFEST_BASE64:-}"
unset ALPHANET_OAUTH_MANIFEST_BASE64

if (($# > 1)); then
  echo "Usage: ALPHANET_OAUTH_MANIFEST_SHA256=<approved-sha256> $0 [manifest.json]" >&2
  exit 2
fi

if [[ ! "${MIGRATION_ROLE}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "ALPHANET_MIGRATION_ROLE must be a canonical PostgreSQL role name." >&2
  exit 2
fi
if [[ "${PGUSER:-}" != "${MIGRATION_ROLE}" ]]; then
  echo "OAuth client reconciliation must connect as ALPHANET_MIGRATION_ROLE." >&2
  exit 2
fi
if [[ ! "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ALPHANET_OAUTH_MANIFEST_SHA256 must pin the reviewed manifest." >&2
  exit 2
fi
if [[ -n "${EXPECTED_APPROVED_SHA256}" ]] && {
  [[ ! "${EXPECTED_APPROVED_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || [[ "${EXPECTED_APPROVED_SHA256}" != "${EXPECTED_SHA256}" ]]
}; then
  echo "The approved OAuth manifest does not match the trusted launch request." >&2
  exit 2
fi
if (($# == 0)) && [[ -z "${EXPECTED_APPROVED_SHA256}" ]]; then
  echo "Injected OAuth provisioning requires a trusted approved digest." >&2
  exit 2
fi
if [[ -n "${EXPECTED_RESOURCE}" ]] && {
  ((${#EXPECTED_RESOURCE} > 500)) || [[ "${EXPECTED_RESOURCE}" =~ [[:space:][:cntrl:]] ]]
}; then
  echo "ALPHANET_EXPECTED_OAUTH_RESOURCE is invalid." >&2
  exit 2
fi
if [[ ! -r "${SQL_FILE}" ]]; then
  echo "The OAuth client reconciliation SQL is unavailable." >&2
  exit 2
fi

for command_name in psql base64 wc tr mktemp awk cat; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required to reconcile Remote MCP OAuth clients." >&2
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

if printf '' | base64 --decode >/dev/null 2>&1; then
  BASE64_DECODE=(base64 --decode)
elif printf '' | base64 -D >/dev/null 2>&1; then
  BASE64_DECODE=(base64 -D)
else
  echo "base64 must support --decode or -D." >&2
  exit 127
fi

if (($# == 1)); then
  MANIFEST_FILE="$1"
  if [[ -n "${INJECTED_MANIFEST_BASE64}" ]]; then
    echo "File and injected OAuth manifests cannot be combined." >&2
    exit 2
  fi
  if [[ ! -f "${MANIFEST_FILE}" || -L "${MANIFEST_FILE}" || ! -r "${MANIFEST_FILE}" ]]; then
    echo "The OAuth client manifest must be a readable, non-symlink regular file." >&2
    exit 2
  fi
  manifest_bytes="$(wc -c <"${MANIFEST_FILE}" | tr -d '[:space:]')"
  if [[ ! "${manifest_bytes}" =~ ^[0-9]+$ ]] \
    || ((manifest_bytes < 2 || manifest_bytes > 48000)); then
    echo "The OAuth client manifest must contain between 2 and 48000 bytes." >&2
    exit 2
  fi
  manifest_base64="$(base64 <"${MANIFEST_FILE}" | tr -d '\r\n')"
else
  manifest_base64="${INJECTED_MANIFEST_BASE64}"
fi
unset INJECTED_MANIFEST_BASE64

if [[ -z "${manifest_base64}" || ! "${manifest_base64}" =~ ^[A-Za-z0-9+/=]+$ ]] \
  || ((${#manifest_base64} > 64000)); then
  echo "The OAuth client manifest could not be encoded safely." >&2
  exit 2
fi

if ! manifest_bytes="$(
  printf '%s' "${manifest_base64}" \
    | "${BASE64_DECODE[@]}" 2>/dev/null \
    | wc -c \
    | tr -d '[:space:]'
)"; then
  echo "The OAuth client manifest could not be decoded safely." >&2
  exit 2
fi
if [[ ! "${manifest_bytes}" =~ ^[0-9]+$ ]] \
  || ((manifest_bytes < 2 || manifest_bytes > 48000)); then
  echo "The OAuth client manifest must contain between 2 and 48000 bytes." >&2
  exit 2
fi

# Hash the exact in-memory payload that will be copied, not a second read of the
# path. This closes the checksum/read race for a concurrently replaced file.
if ! manifest_sha256="$(
  printf '%s' "${manifest_base64}" \
    | "${BASE64_DECODE[@]}" 2>/dev/null \
    | checksum_stream
)"; then
  echo "The OAuth client manifest could not be hashed safely." >&2
  exit 2
fi
if [[ "${manifest_sha256}" != "${EXPECTED_SHA256}" ]]; then
  echo "The OAuth client manifest does not match its reviewed SHA-256." >&2
  exit 2
fi

expected_resource_base64="$(
  printf '%s' "${EXPECTED_RESOURCE}" | base64 | tr -d '\r\n'
)"

failure_output="$(mktemp)"
chmod 600 "${failure_output}"
cleanup() {
  rm -f "${failure_output}"
}
trap cleanup EXIT

# COPY STDIN keeps manifest bytes out of process arguments and SQL statement
# text. The SQL transaction validates the entire document before any durable
# write and rolls every change back on the first mismatch.
if ! {
  printf '%s\n' '\set ON_ERROR_STOP on'
  printf '%s\n' 'BEGIN;'
  printf '%s\n' \
    'CREATE TEMP TABLE alphanet_remote_mcp_oauth_manifest_input (encoded_document text NOT NULL CHECK (length(encoded_document) BETWEEN 4 AND 64000)) ON COMMIT DROP;'
  printf '%s\n' \
    'CREATE TEMP TABLE alphanet_remote_mcp_oauth_expected_configuration (migration_role text NOT NULL, encoded_resource text NOT NULL) ON COMMIT DROP;'
  printf '%s\n' \
    '\copy pg_temp.alphanet_remote_mcp_oauth_expected_configuration (migration_role, encoded_resource) FROM STDIN WITH (FORMAT text)'
  printf '%s\t%s\n' "${MIGRATION_ROLE}" "${expected_resource_base64}"
  printf '%s\n' '\.'
  printf '%s\n' \
    '\copy pg_temp.alphanet_remote_mcp_oauth_manifest_input (encoded_document) FROM STDIN WITH (FORMAT text)'
  printf '%s\n' "${manifest_base64}"
  printf '%s\n' '\.'
  cat "${SQL_FILE}"
} | psql \
  -X \
  --quiet \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  >"${failure_output}" 2>&1; then
  echo "Remote MCP OAuth client reconciliation failed; no changes were committed." >&2
  exit 1
fi

echo "Remote MCP OAuth resource and public-client allowlist reconciled atomically."
