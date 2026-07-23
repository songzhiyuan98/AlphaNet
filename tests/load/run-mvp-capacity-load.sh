#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly REPOSITORY_ROOT
readonly K6_IMAGE="grafana/k6:2.0.0@sha256:a33a0cfdc4d2483d6b7a3a22e726a499ff2831a671a49239104cd34a9937523c"

PROFILE="${PROFILE:-smoke}"
BASE_URL="${BASE_URL:-}"
TARGET_ENV="${TARGET_ENV:-}"
RELEASE_SHA="${RELEASE_SHA:-}"
CATALOG_FILE="${CATALOG_FILE:-}"
PRINCIPALS_FILE="${PRINCIPALS_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
ALLOW_LOCAL_HTTP="${ALLOW_LOCAL_HTTP:-0}"
ALLOW_SMALL_DATASET="${ALLOW_SMALL_DATASET:-0}"

fail() {
  printf 'capacity gate: %s\n' "$*" >&2
  exit 1
}

case "${PROFILE}" in
  smoke | sustained | burst | hot-read | hot-reply | full) ;;
  *) fail "PROFILE must be smoke, sustained, burst, hot-read, hot-reply, or full" ;;
esac

[[ -n "${BASE_URL}" ]] || fail "BASE_URL is required"
[[ -n "${TARGET_ENV}" ]] || fail "TARGET_ENV is required"
[[ -n "${CATALOG_FILE}" ]] || fail "CATALOG_FILE is required"
[[ -n "${PRINCIPALS_FILE}" ]] || fail "PRINCIPALS_FILE is required"
[[ -f "${CATALOG_FILE}" ]] || fail "CATALOG_FILE does not exist"
[[ -f "${PRINCIPALS_FILE}" ]] || fail "PRINCIPALS_FILE does not exist"
[[ "${BASE_URL}" != *"@"* ]] || fail "BASE_URL must not contain userinfo credentials"
[[ "${BASE_URL}" != *"?"* ]] || fail "BASE_URL must not contain a query string"
[[ "${BASE_URL}" != *"#"* ]] || fail "BASE_URL must not contain a fragment"

if [[ "${BASE_URL}" != https://* ]]; then
  case "${BASE_URL}" in
    http://localhost:* | http://127.0.0.1:* | http://host.docker.internal:*)
      [[ "${ALLOW_LOCAL_HTTP}" == "1" ]] ||
        fail "local HTTP requires ALLOW_LOCAL_HTTP=1"
      ;;
    *) fail "non-local targets must use HTTPS" ;;
  esac
fi

if [[ "${PROFILE}" == "full" ]]; then
  [[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "the full release gate requires a full lowercase RELEASE_SHA"
  [[ "${ALLOW_SMALL_DATASET}" == "0" ]] ||
    fail "the full release gate cannot use ALLOW_SMALL_DATASET=1"
  [[ "${TARGET_ENV}" != "local" ]] ||
    fail "the full release gate must run in an isolated production-shaped environment"
fi

if [[ -z "${OUTPUT_DIR}" ]]; then
  if [[ "${PROFILE}" == "full" ]]; then
    OUTPUT_DIR="${REPOSITORY_ROOT}/artifacts/release"
  else
    OUTPUT_DIR="${REPOSITORY_ROOT}/artifacts/load"
  fi
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  principal_mode="$(stat -f '%Lp' "${PRINCIPALS_FILE}")"
else
  principal_mode="$(stat -c '%a' "${PRINCIPALS_FILE}")"
fi
(( (8#${principal_mode} & 8#077) == 0 )) ||
  fail "PRINCIPALS_FILE must not grant group or world permissions (expected 0600)"

command -v docker >/dev/null 2>&1 || fail "docker is required"
mkdir -p "${OUTPUT_DIR}"
chmod 0700 "${OUTPUT_DIR}"

CATALOG_ABSOLUTE="$(cd -- "$(dirname -- "${CATALOG_FILE}")" && pwd)/$(basename -- "${CATALOG_FILE}")"
readonly CATALOG_ABSOLUTE
PRINCIPALS_ABSOLUTE="$(cd -- "$(dirname -- "${PRINCIPALS_FILE}")" && pwd)/$(basename -- "${PRINCIPALS_FILE}")"
readonly PRINCIPALS_ABSOLUTE
if [[ "${PROFILE}" == "full" ]]; then
  readonly SUMMARY_NAME="capacity-full.json"
else
  readonly SUMMARY_NAME="mvp-capacity-${PROFILE}.json"
fi

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --network bridge \
  --volume "${SCRIPT_DIR}:/work/tests/load:ro" \
  --volume "${CATALOG_ABSOLUTE}:/run/alphanet/catalog.json:ro" \
  --volume "${PRINCIPALS_ABSOLUTE}:/run/alphanet/principals.json:ro" \
  --volume "${OUTPUT_DIR}:/work/artifacts/load:rw" \
  --workdir /work \
  --env "PROFILE=${PROFILE}" \
  --env "BASE_URL=${BASE_URL}" \
  --env "TARGET_ENV=${TARGET_ENV}" \
  --env "RELEASE_SHA=${RELEASE_SHA}" \
  --env "ALLOW_SMALL_DATASET=${ALLOW_SMALL_DATASET}" \
  --env "CATALOG_FILE=/run/alphanet/catalog.json" \
  --env "PRINCIPALS_FILE=/run/alphanet/principals.json" \
  --env "SUMMARY_FILE=artifacts/load/${SUMMARY_NAME}" \
  "${K6_IMAGE}" run tests/load/mvp-capacity.js

[[ -s "${OUTPUT_DIR}/${SUMMARY_NAME}" ]] ||
  fail "k6 completed without producing the release summary"
chmod 0600 "${OUTPUT_DIR}/${SUMMARY_NAME}"
printf 'capacity gate report: %s\n' "${OUTPUT_DIR}/${SUMMARY_NAME}"
