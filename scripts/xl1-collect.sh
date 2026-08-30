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

# How far back to scan the log for the node's own reason it cannot produce. Long
# enough to survive a quiet period, short enough that a resolved problem stops
# being reported as a current fault.
ELIGIBILITY_WINDOW="${XL1_ELIGIBILITY_WINDOW:-20m}"
# Reading twenty minutes of log is far more expensive than the thirty-second
# slice the rest of this script works from, and eligibility does not change
# between one cycle and the next. Scanned on its own interval so the snapshot
# never goes stale waiting for it.
ELIGIBILITY_INTERVAL="${XL1_ELIGIBILITY_INTERVAL:-120}"
ELIG_CACHE="${STATE_DIR}/.eligibility"

# The slow readers. Each shells out to something far more expensive than a log
# tail, and each answers a question that changes daily at most, so they run on
# their own cadence rather than every 30s with the rest of the snapshot.
CLI_CHECK_INTERVAL="${XL1_CLI_CHECK_INTERVAL:-21600}"   # 6h
OS_UPDATE_INTERVAL="${XL1_OS_UPDATE_INTERVAL:-21600}"   # 6h when nothing pending
OS_PENDING_INTERVAL="${XL1_OS_PENDING_INTERVAL:-900}"   # 15m while something is
CLI_CACHE="${STATE_DIR}/.cli-version"
OS_CACHE="${STATE_DIR}/.os-updates"

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

# Seconds since a cache file was last written; a huge number if it never was.
cache_age() {
  local m
  m="$(stat -c %Y "$1" 2>/dev/null)" || { printf '999999999'; return; }
  printf '%s' "$(( $(date +%s) - m ))"
}

# Cache format version. Bump when the layout of any dotfile below changes.
#
# Without this, a shipped format change is only discovered by an operator being
# told to `rm` a specific dotfile — and until they are, a short read leaves a
# field empty, the emitted JSON fails validation, and the previous snapshot is
# served unchanged for up to six hours while the page looks perfectly alive.
CACHE_SCHEMA=3
SCHEMA_STAMP="${STATE_DIR}/.cache-schema"
if [[ "$(cat "${SCHEMA_STAMP}" 2>/dev/null || echo 0)" != "${CACHE_SCHEMA}" ]]; then
  rm -f "${CLI_CACHE}" "${OS_CACHE}" "${ELIG_CACHE}" "${STATE_DIR}/.last-published"
  printf '%s' "${CACHE_SCHEMA}" > "${SCHEMA_STAMP}"
  echo "xl1-collect: cache schema changed — derived values will be re-read" >&2
fi

COLLECTED_AT="$(now_iso)"

# One inspect, captured once. Two separate calls let the container disappear
# between them — an xl1ctl restart is enough — after which `read` fills every
# variable with the empty string and the JSON below emits bare commas, fails
# validation, and silently leaves the previous snapshot in place.
#
# .Config.Image is the tag the container was started from and does not change
# when that tag is repointed at a new build. .Image is the resolved image ID,
# which is what actually says whether this is the same software as last time.
INSPECT=""
if ! INSPECT="$(docker inspect "${CONTAINER}" --format \
    '{{.State.Status}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}}' 2>/dev/null)" \
   || [[ -z "${INSPECT}" ]]; then
  printf '{"collectedAt":"%s","container":null,"error":"container %s not found"}\n' \
    "${COLLECTED_AT}" "${CONTAINER}" > "${OUT}.tmp"
  mv "${OUT}.tmp" "${OUT}"
  chmod 644 "${OUT}"
  exit 0
fi
read -r STATE RUNNING STARTED RESTARTS IMAGE HEALTH IMAGE_ID <<< "${INSPECT}"
[[ -n "${STATE}" && -n "${RUNNING}" && -n "${RESTARTS}" ]] || {
  echo "xl1-collect: incomplete inspect output, kept previous snapshot" >&2
  exit 1
}

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

# Which block, not just when. "Blocks submitted: 3" is a number an operator has
# to take on faith; a block height is something they can open in the explorer
# and see. The producer names it in the same line it announces the publish.
LAST_PUBLISHED=""; LAST_BLOCK=""
if (( NEW_PUBLISHED > 0 )); then
  LAST_PUBLISHED="${COLLECTED_AT}"
  # Last match in the slice, since a busy window can contain several.
  LAST_BLOCK="$(printf '%s' "${NEW_LOG}" | grep -i 'published block' \
    | grep -oE '[0-9]{2,}' | tail -n1)"
  printf '%s\t%s\n' "${LAST_PUBLISHED}" "${LAST_BLOCK}" > "${STATE_DIR}/.last-published"
elif [[ -s "${STATE_DIR}/.last-published" ]]; then
  IFS=$'\t' read -r LAST_PUBLISHED LAST_BLOCK < "${STATE_DIR}/.last-published"
fi

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

# ------------------------------------------------------ why it cannot produce
#
# A producer that is authorized but ineligible looks identical to a healthy one
# from the outside: container up, health probe green, zero errors, zero blocks.
# The node does say why, in its own words, on stderr — so ask it.
#
# Scanned over a window rather than the whole history: a complaint from two days
# ago that has since been resolved is not a current fault, and reporting it as
# one is worse than reporting nothing.
if (( $(cache_age "${ELIG_CACHE}") > ELIGIBILITY_INTERVAL )); then
BLOCKED_REASON=""; BLOCKED_KEY=""
ELIG_LOG="$(docker logs --since "${ELIGIBILITY_WINDOW}" "${CONTAINER}" 2>&1 | tail -n 4000 | tr '[:upper:]' '[:lower:]')"
if [[ -n "${ELIG_LOG}" ]]; then
  # needle|reason — the protocol's own phrasing on the left, plain English right.
  # needle|key|reason. The key is stable and machine-readable; the reason is
  # prose and may be reworded. Anything classifying these must use the key —
  # whether a complaint matters depends on the network, and that decision is
  # made by the dashboard, which knows which network this is. This script only
  # reports what the node said.
  while IFS='|' read -r needle key reason; do
    [[ -z "${needle}" ]] && continue
    if [[ "${ELIG_LOG}" == *"${needle}"* ]]; then
      BLOCKED_REASON="${reason}"; BLOCKED_KEY="${key}"; break
    fi
  done <<'PATTERNS'
insufficient stake|insufficient-stake|insufficient stake
add stake to contract|insufficient-stake|insufficient stake — no intent declared
has no balance|no-balance|no balance
not in the allowed|not-allowed|not on the allowed-producer list
not an allowed producer|not-allowed|not on the allowed-producer list
no-intent|no-intent|no stake intent declared
unseasoned-or-understaked|unseasoned|stake too new or too small
unseasoned|unseasoned|stake not yet seasoned
insufficient-self-bond|self-bond|self-bond below the minimum
behind-finalized-head|too-slow|blocks rejected: built too slowly for the chain
PATTERNS
fi
  # Only cache a result we actually derived. An empty log means `docker logs`
  # failed, and caching "no complaint" from that is indistinguishable from a
  # clean read — for the one signal that exists because a blocked producer looks
  # healthy from every other angle.
  if [[ -n "${ELIG_LOG}" ]]; then
    printf '%s\t%s\n' "${BLOCKED_KEY:-}" "${BLOCKED_REASON}" > "${ELIG_CACHE}"
  else
    echo "xl1-collect: could not read container log for eligibility; keeping previous answer" >&2
  fi
fi
# `read` reports failure at EOF even when it populated the variables, so a
# trailing newline above is load-bearing and the result is not tested for
# success — doing so discarded the values it had just read.
BLOCKED_KEY=""; BLOCKED_REASON=""
[[ -s "${ELIG_CACHE}" ]] && IFS=$'\t' read -r BLOCKED_KEY BLOCKED_REASON < "${ELIG_CACHE}"

# ------------------------------------------------- which CLI the node is running
#
# `docker exec` costs about a second on a 3 B+, and the answer changes when the
# image is rebuilt and never in between, so it is cached rather than re-asked
# every 30 seconds. The dashboard compares this against the published release.
#
# Keyed on the image ID, not on elapsed time. A version cache that outlives the
# container it describes reports the old version after an upgrade and keeps
# doing so for hours — the operator is shown a number that was true this morning
# and has no way to tell. A new image ID invalidates it immediately; the time
# interval only covers a re-read that failed.
CLI_CACHED_ID=""; CLI_INSTALLED=""
[[ -s "${CLI_CACHE}" ]] && IFS=$'\t' read -r CLI_CACHED_ID CLI_INSTALLED < "${CLI_CACHE}"

if [[ "${CLI_CACHED_ID}" != "${IMAGE_ID}" ]] || (( $(cache_age "${CLI_CACHE}") > CLI_CHECK_INTERVAL )); then
  V="$(docker exec "${CONTAINER}" xl1 --version 2>/dev/null | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  if [[ -n "${V}" ]]; then
    printf '%s\t%s\n' "${IMAGE_ID}" "${V}" > "${CLI_CACHE}"
    CLI_INSTALLED="${V}"
  else
    # Back off on a failing exec — retrying every 30s achieves nothing. The
    # previous answer is kept, since a stale version beats no version, but the
    # image ID is not stamped so a later cycle will try again.
    touch "${CLI_CACHE}"
  fi
fi

# ------------------------------------------------------- the layer underneath
#
# A host can sit unpatched for months while every node signal reads perfectly
# normal, and nothing else here looks at it.
#
# The staleness figure is not decoration. `apt list --upgradable` answers against
# the last `apt update`, so a host whose lists have not been refreshed in months
# reports "0 updates" — confidently, and wrongly. That is a worse failure than
# not checking at all, because it reads as good news. Reporting how old the lists
# are is what makes the zero interpretable.
OS_TOTAL=""; OS_SEC=""; OS_AGE=""; OS_REBOOT="false"
if (( OS_UPDATE_INTERVAL > 0 )); then
  OS_PENDING=0
  if [[ -s "${OS_CACHE}" ]]; then
    read -r _t _s _a _r < "${OS_CACHE}"
    [[ "${_t:-0}" != "0" || "${_s:-0}" != "0" || "${_r:-false}" == "true" ]] && OS_PENDING=1
  fi
  # Pending means someone may be about to act on it, so look again soon — a host
  # just patched should say so within minutes, not at the end of a six-hour cache.
  OS_INTERVAL=$(( OS_PENDING ? OS_PENDING_INTERVAL : OS_UPDATE_INTERVAL ))
  if (( $(cache_age "${OS_CACHE}") > OS_INTERVAL )); then
    UPG="$(apt list --upgradable 2>/dev/null | grep -F '[upgradable from:' || true)"
    T=0; SEC=0
    while IFS= read -r line; do
      [[ -z "${line}" ]] && continue
      T=$(( T + 1 ))
      # pkg/suite version arch [upgradable from: older] — suite may be a comma list.
      suite="${line#*/}"; suite="${suite%% *}"
      # Stock Debian puts security fixes in their own suite. Raspberry Pi OS does
      # NOT — its packages arrive through plain `stable`, security included — so
      # this finds nothing on a Pi however many are pending. Kept because it is
      # right where it applies and costs nothing where it does not, but nothing
      # downstream may depend on it or it goes permanently silent here.
      [[ "${suite}" == *-security* ]] && SEC=$(( SEC + 1 ))
    done <<< "${UPG}"

    # How old the package lists are. apt-daily refreshes these on most Debian
    # hosts, but "most" is not "this one", so it is measured rather than assumed.
    AGE=""
    for pth in /var/lib/apt/periodic/update-success-stamp /var/lib/apt/lists; do
      if M="$(stat -c %Y "${pth}" 2>/dev/null)"; then
        AGE="$(awk -v n="$(date +%s)" -v m="${M}" 'BEGIN{printf "%.1f",(n-m)/3600}')"
        break
      fi
    done

    # Written by a kernel or libc upgrade. Absent on a host without
    # update-notifier-common, which is why absence is false rather than unknown.
    R="false"; [[ -e /var/run/reboot-required || -e /run/reboot-required ]] && R="true"

    printf '%s %s %s %s\n' "${T}" "${SEC}" "${AGE:--}" "${R}" > "${OS_CACHE}"
  fi
  if [[ -s "${OS_CACHE}" ]]; then
    read -r OS_TOTAL OS_SEC OS_AGE OS_REBOOT < "${OS_CACHE}"
    [[ "${OS_AGE}" == "-" ]] && OS_AGE=""
  fi
fi

{
  printf '{'
  printf '"collectedAt":"%s",' "${COLLECTED_AT}"
  printf '"container":{"name":"%s","state":"%s","running":%s,"uptime":"%s","restartCount":%s,"image":"%s","health":"%s"},' \
    "$(json_escape "${CONTAINER}")" "$(json_escape "${STATE}")" "${RUNNING}" \
    "$(json_escape "${UPTIME}")" "${RESTARTS}" "$(json_escape "${IMAGE}")" "$(json_escape "${HEALTH}")"
  printf '"blocksPublished":%s,' "${TOTAL}"
  printf '"errorCount":%s,' "${ERRORS:-0}"

  # Absence is a real answer here and is reported as absence, not as a zero or a
  # false. "We did not look" and "we looked and found nothing" are different
  # claims, and the dashboard renders them differently.
  if [[ -n "${BLOCKED_REASON}" ]]; then
    printf '"eligibility":{"blocked":true,"key":"%s","reason":"%s","window":"%s"},' \
      "$(json_escape "${BLOCKED_KEY}")" "$(json_escape "${BLOCKED_REASON}")" "$(json_escape "${ELIGIBILITY_WINDOW}")"
  else
    printf '"eligibility":{"blocked":false,"window":"%s"},' "$(json_escape "${ELIGIBILITY_WINDOW}")"
  fi

  [[ -n "${CLI_INSTALLED}" ]] && printf '"cliVersion":"%s",' "$(json_escape "${CLI_INSTALLED}")"

  if [[ -n "${OS_TOTAL}" ]]; then
    printf '"os":{"updates":%s,"securityUpdates":%s,"rebootRequired":%s' \
      "${OS_TOTAL}" "${OS_SEC}" "${OS_REBOOT}"
    [[ -n "${OS_AGE}" ]] && printf ',"aptAgeHours":%s' "${OS_AGE}"
    printf '},'
  fi
  [[ -n "${LAST_PUBLISHED}" ]] && printf '"lastPublishedAt":"%s",' "${LAST_PUBLISHED}"
  [[ "${LAST_BLOCK}" =~ ^[0-9]+$ ]] && printf '"lastPublishedBlock":%s,' "${LAST_BLOCK}"
  printf '"recentLog":%s' "${LOG_JSON}"
  printf '}\n'
} > "${OUT}.tmp"

# Validate before publishing so the dashboard never reads a half-written file.
# jq first: it is the only one of the three that provision.sh installs. Falling
# back to node or python3 meant a host with neither failed validation on every
# cycle and never delivered a first snapshot — reported identically to genuinely
# corrupt JSON.
if jq -e . "${OUT}.tmp" >/dev/null 2>&1 \
   || node -e "JSON.parse(require('fs').readFileSync('${OUT}.tmp','utf8'))" 2>/dev/null \
   || python3 -c "import json,sys; json.load(open('${OUT}.tmp'))" 2>/dev/null; then
  mv "${OUT}.tmp" "${OUT}"
  chmod 644 "${OUT}"
else
  rm -f "${OUT}.tmp"
  echo "xl1-collect: produced invalid JSON, kept previous snapshot" >&2
  exit 1
fi
