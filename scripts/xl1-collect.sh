#!/usr/bin/env bash
# Collect producer container state into a JSON file the dashboard reads.
#
# This exists so the dashboard container never needs the Docker socket. A
# read-only socket mount would still grant full control of the daemon, which is
# not something to hand a network-listening service on a box holding a producer
# mnemonic. Instead this runs as root on a timer and drops a plain JSON file.

set -uo pipefail

CONTAINER="${XL1_CONTAINER:-xl1-producer}"
STATE_DIR="${XL1_STATE_DIR:-/var/lib/xl1}"
OUT="${STATE_DIR}/producer-status.json"
CURSOR="${STATE_DIR}/.collect-cursor"
COUNTER="${STATE_DIR}/.blocks-published"
LOG_LINES="${XL1_LOG_LINES:-40}"

mkdir -p "${STATE_DIR}"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# jq is not assumed — emit JSON with printf and a minimal string escaper.
json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  # strip remaining control chars that would make the JSON invalid
  printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037'
}

COLLECTED_AT="$(now_iso)"

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  printf '{"collectedAt":"%s","container":null,"error":"container %s not found"}\n' \
    "${COLLECTED_AT}" "${CONTAINER}" > "${OUT}.tmp"
  mv "${OUT}.tmp" "${OUT}"
  chmod 644 "${OUT}"
  exit 0
fi

read -r STATE RUNNING STARTED RESTARTS IMAGE HEALTH < <(
  docker inspect "${CONTAINER}" --format \
    '{{.State.Status}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
)

UPTIME="unknown"
if [[ "${RUNNING}" == "true" && -n "${STARTED}" ]]; then
  if START_EPOCH=$(date -d "${STARTED}" +%s 2>/dev/null); then
    SECS=$(( $(date +%s) - START_EPOCH ))
    D=$((SECS/86400)); H=$((SECS%86400/3600)); M=$((SECS%3600/60))
    if   (( D > 0 )); then UPTIME="${D}d ${H}h"
    elif (( H > 0 )); then UPTIME="${H}h ${M}m"
    else                   UPTIME="${M}m"; fi
  fi
fi

# Read only the log slice since the previous run, so the cost stays flat as the
# container's log grows, and keep a running total across runs.
SINCE="$(cat "${CURSOR}" 2>/dev/null || echo "")"
if [[ -n "${SINCE}" ]]; then
  NEW_LOG="$(docker logs --since "${SINCE}" "${CONTAINER}" 2>&1 | tail -n 2000)"
else
  NEW_LOG="$(docker logs --tail 2000 "${CONTAINER}" 2>&1)"
fi
echo "${COLLECTED_AT}" > "${CURSOR}"

TOTAL="$(cat "${COUNTER}" 2>/dev/null || echo 0)"
[[ "${TOTAL}" =~ ^[0-9]+$ ]] || TOTAL=0
NEW_PUBLISHED="$(printf '%s' "${NEW_LOG}" | grep -c -i 'published block' || true)"
TOTAL=$(( TOTAL + NEW_PUBLISHED ))
echo "${TOTAL}" > "${COUNTER}"

LAST_PUBLISHED=""
if (( NEW_PUBLISHED > 0 )); then LAST_PUBLISHED="${COLLECTED_AT}"
else LAST_PUBLISHED="$(cat "${STATE_DIR}/.last-published" 2>/dev/null || echo "")"; fi
[[ -n "${LAST_PUBLISHED}" ]] && echo "${LAST_PUBLISHED}" > "${STATE_DIR}/.last-published"

ERRORS="$(printf '%s' "${NEW_LOG}" | grep -c -iE '\b(error|fatal|unhandled|exception)\b' || true)"

# Tail for display comes from the full log so the panel is never empty on a quiet cycle.
TAIL_LOG="$(docker logs --tail "${LOG_LINES}" "${CONTAINER}" 2>&1)"
LOG_JSON="["
FIRST=1
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  [[ ${FIRST} -eq 1 ]] && FIRST=0 || LOG_JSON+=","
  LOG_JSON+="\"$(json_escape "${line}")\""
done <<< "${TAIL_LOG}"
LOG_JSON+="]"

{
  printf '{'
  printf '"collectedAt":"%s",' "${COLLECTED_AT}"
  printf '"container":{"name":"%s","state":"%s","running":%s,"uptime":"%s","restartCount":%s,"image":"%s","health":"%s"},' \
    "$(json_escape "${CONTAINER}")" "$(json_escape "${STATE}")" "${RUNNING}" \
    "$(json_escape "${UPTIME}")" "${RESTARTS}" "$(json_escape "${IMAGE}")" "$(json_escape "${HEALTH}")"
  printf '"blocksPublished":%s,' "${TOTAL}"
  printf '"errorCount":%s,' "${ERRORS:-0}"
  [[ -n "${LAST_PUBLISHED}" ]] && printf '"lastPublishedAt":"%s",' "${LAST_PUBLISHED}"
  printf '"recentLog":%s' "${LOG_JSON}"
  printf '}\n'
} > "${OUT}.tmp"

# Validate before publishing so the dashboard never reads a half-written file.
if node -e "JSON.parse(require('fs').readFileSync('${OUT}.tmp','utf8'))" 2>/dev/null \
   || python3 -c "import json,sys; json.load(open('${OUT}.tmp'))" 2>/dev/null; then
  mv "${OUT}.tmp" "${OUT}"
  chmod 644 "${OUT}"
else
  rm -f "${OUT}.tmp"
  echo "xl1-collect: produced invalid JSON, kept previous snapshot" >&2
  exit 1
fi
