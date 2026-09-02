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
HEALTH_PORT="${XL1_HEALTH_CHECK_PORT:-9099}"
RACE_WINDOW="${XL1_RACE_WINDOW:-3600}"          # 1h of candidate-race history
RACE_STATE="${STATE_DIR}/.race-buckets"
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
CACHE_SCHEMA=5
SCHEMA_STAMP="${STATE_DIR}/.cache-schema"
if [[ "$(cat "${SCHEMA_STAMP}" 2>/dev/null || echo 0)" != "${CACHE_SCHEMA}" ]]; then
  rm -f "${CLI_CACHE}" "${OS_CACHE}" "${ELIG_CACHE}" "${STATE_DIR}/.last-published" "${STATE_DIR}/.run-builds"
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
RUN_SECONDS=""
if [[ "${RUNNING}" == "true" && -n "${STARTED}" ]]; then
  if START_EPOCH=$(date -d "${STARTED}" +%s 2>/dev/null); then
    SECS=$(( $(date +%s) - START_EPOCH ))
    RUN_SECONDS="${SECS}"
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
  # The number the line names, not the last number on it. The producer writes
  #   [xl1-producer] Published block: 579361 [0x1528a9…82ff0fd7]
  # and taking the last digit run returned a fragment of the hash instead —
  # "78", "871", "0540". Wrong on every line that carries a hash, and when the
  # fragment began with a zero the snapshot was not even valid JSON.
  #
  # Last match in the slice, since a busy window can contain several.
  LAST_BLOCK="$(printf '%s' "${NEW_LOG}" \
    | grep -oiE 'published block:?[[:space:]]+[0-9]+' | tail -n1 | grep -oE '[0-9]+$')"
  printf '%s\t%s\n' "${LAST_PUBLISHED}" "${LAST_BLOCK}" > "${STATE_DIR}/.last-published"
elif [[ -s "${STATE_DIR}/.last-published" ]]; then
  IFS=$'\t' read -r LAST_PUBLISHED LAST_BLOCK < "${STATE_DIR}/.last-published"
fi

ERRORS="$(printf '%s' "${NEW_LOG}" | grep -c -iE '\b(error|fatal|unhandled|exception)\b' || true)"

# ------------------------------------------------------------ candidate race
#
# Why candidates lose, counted from the log slice this run already read. No
# extra `docker logs` call: NEW_LOG is everything since the last cursor, so the
# counters accumulate 30 seconds at a time into a rolling window instead of
# re-reading an hour of log every run.
#
# The anchor line matters. `behind-finalized-head` and `block-number-mismatch`
# are each logged twice — once by the validation viewer and once by the runner —
# while `tx-already-finalized` is logged once. Counting the bracketed tag would
# therefore report 52 losses where 26 happened. "No candidate block can be
# appended" is emitted exactly once per rejected candidate and carries the tag,
# so it is the only honest thing to count.
#
# Wins are deliberately NOT counted here. A log line saying "Published block"
# means submitted, not accepted, and treating it as success is the mistake this
# repo already made once. The dashboard takes wins from the chain scan instead.
race_anchor() { printf '%s' "${NEW_LOG}" | grep -F 'No candidate block can be appended' | grep -cF "[$1]" || true; }

R_BUILT="$(printf '%s' "${NEW_LOG}" | grep -cE 'Building block [0-9]+$' || true)"
R_RETRY="$(printf '%s' "${NEW_LOG}" | grep -cF '(retry' || true)"
R_TXFIN="$(race_anchor tx-already-finalized)"
R_BEHIND="$(race_anchor behind-finalized-head)"
R_MISMATCH="$(race_anchor block-number-mismatch)"

NOW_EPOCH="$(date -u +%s)"
printf '%s %s %s %s %s %s\n' "${NOW_EPOCH}" "${R_BUILT:-0}" "${R_RETRY:-0}" "${R_TXFIN:-0}" "${R_BEHIND:-0}" "${R_MISMATCH:-0}" >> "${RACE_STATE}"

# Prune to the window and total it in one pass. Rewritten whole then renamed so
# a kill mid-write cannot leave a half-line that poisons every later sum.
RACE_SUM="$(awk -v cutoff="$(( NOW_EPOCH - RACE_WINDOW ))" -v tmp="${RACE_STATE}.tmp" \
  'NF == 6 && $1 >= cutoff { print > tmp; b += $2; r += $3; t += $4; h += $5; m += $6; if (first == "") first = $1 }
   END { printf "%d %d %d %d %d %d", b, r, t, h, m, (first == "" ? 0 : first) }' \
  "${RACE_STATE}" 2>/dev/null || true)"
[[ -s "${RACE_STATE}.tmp" ]] && mv "${RACE_STATE}.tmp" "${RACE_STATE}" || rm -f "${RACE_STATE}.tmp"
read -r W_BUILT W_RETRY W_TXFIN W_BEHIND W_MISMATCH W_FIRST <<< "${RACE_SUM:-0 0 0 0 0 0}"

# ------------------------------------------------- did this run ever produce?
#
# A producer can start, log "system ready", pass its /livez healthcheck and
# never build a single block — reported upstream against xl1-docker-images,
# reproduced across repeated launches of the same image with the same env. It
# never recovers: /livez only reports process liveness, so the container is
# never unhealthy, never exits, and no restart policy fires. Every signal an
# operator has says normal while the node is absent from consensus.
#
# Readiness time was the proposed tell — ~671ms on a bad launch against ~7982ms
# on a good one. It does not hold here: this node reported ready in 1243ms and
# built sixteen blocks in the same run. So count the thing itself. A build is
# the first act of actually producing, and zero of them well past startup is
# the state that cannot be recovered from.
#
# Counted per run, not cumulatively, because the question is about *this*
# launch. On a restart the count is re-derived from container start — cheap,
# since the log is by definition short at that point — and incremented from the
# usual slice thereafter, so the steady-state cost stays one grep.
RUN_STATE="${STATE_DIR}/.run-builds"
PREV_STARTED=""; BUILDS=0
[[ -s "${RUN_STATE}" ]] && IFS=$'\t' read -r PREV_STARTED BUILDS < "${RUN_STATE}"
[[ "${BUILDS}" =~ ^[0-9]+$ ]] || BUILDS=0
if [[ "${PREV_STARTED}" != "${STARTED}" ]]; then
  BUILDS="$(docker logs --since "${STARTED}" "${CONTAINER}" 2>&1 | grep -c -i 'building block' || true)"
else
  BUILDS=$(( BUILDS + $(printf '%s' "${NEW_LOG}" | grep -c -i 'building block' || true) ))
fi
[[ "${BUILDS}" =~ ^[0-9]+$ ]] || BUILDS=0
printf '%s\t%s\n' "${STARTED}" "${BUILDS}" > "${RUN_STATE}"

# Tail for display comes from the full log so the panel is never empty on a quiet cycle.
#
# With timestamps, because every question the panel gets asked is about *when*:
# did it stop an hour ago or a minute ago, is it still attempting a block a
# minute, did that error come before the last publish or after it. Without them
# the 40 lines are a wall of text that could be five seconds or five hours old.
#
# Docker stamps UTC, as 2026-08-30T23:41:12.229348397Z — too wide for the panel
# and in the wrong zone. Rewritten to a local HH:MM:SS with the offset computed
# once and the arithmetic done in a single awk pass, because `date -d` per line
# would be forty forks on a Pi 3 every collection cycle.
TZ_OFFSET="$(date +%z)"                       # e.g. -0600
TZ_SECS=$(( 10#${TZ_OFFSET:1:2} * 3600 + 10#${TZ_OFFSET:3:2} * 60 ))
[[ "${TZ_OFFSET:0:1}" == "-" ]] && TZ_SECS=$(( -TZ_SECS ))

TAIL_LOG="$(docker logs --timestamps --tail "${LOG_LINES}" "${CONTAINER}" 2>&1 |
  awk -v off="${TZ_SECS}" '
      # Rewrite only lines carrying the fixed-width docker stamp; anything else
      # (a wrapped line, an error from docker itself) passes through intact.
      substr($0, 5, 1) == "-" && substr($0, 11, 1) == "T" {
        t = (substr($0, 12, 2) * 3600 + substr($0, 15, 2) * 60 + substr($0, 18, 2) + off + 86400) % 86400
        sp = index($0, " ")
        printf "%02d:%02d:%02d %s\n", t / 3600, (t % 3600) / 60, t % 60, substr($0, sp + 1)
        next
      }
      { print }
    ')"
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
  # Every needle here is an authorization or stake gate — a reason the node is
  # not *allowed* to produce. `behind-finalized-head` was in this list and did
  # not belong: it is emitted per candidate, by every producer, whenever the
  # head advances during a build. On a 3 B+ that is the ordinary steady state,
  # so it pinned "Producer cannot produce" on a node that had produced 179
  # blocks and paged high priority every six hours forever. Losing a race is not
  # ineligibility. The condition worth waking someone for is not winning at all,
  # and xl1-alert.sh measures that directly from the chain as `not-producing`.
  #
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

# ------------------------------------------------------------- power/throttle
#
# The dashboard reads the throttle flags from
# /sys/devices/platform/soc/soc:firmware/get_throttled, which this kernel does
# not expose — so the panel reports POWER unknown on the one machine the reading
# exists for. vcgencmd does have it, but only on the host: the container has
# neither the binary nor /dev/vcio. So the host reads it and passes it along,
# which is the same reason this script exists at all.
THROTTLE_RAW=""
if command -v vcgencmd >/dev/null 2>&1; then
  THROTTLE_RAW="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
fi
[[ -z "${THROTTLE_RAW}" && -r /sys/devices/platform/soc/soc:firmware/get_throttled ]] \
  && THROTTLE_RAW="$(cat /sys/devices/platform/soc/soc:firmware/get_throttled 2>/dev/null)"

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

# ---------------------------------------------------------------- latency
#
# The producer already measures this. ProducerActor times every stage and the
# status server hands the whole snapshot over on the health port, so the numbers
# below cost one request to 127.0.0.1 against in-memory counters — no chain RPC,
# no work the node was not doing anyway. That matters: a dashboard that pinged
# the gateway itself would add load to the shared endpoint this node is judged
# on, to answer a question the node had already answered.
#
# headFetch is the honest latency signal. It runs on every single check, and its
# min is the wire floor to the gateway while its p50 includes the local work of
# parsing and validating what came back — so the two together separate "the
# network is slow" from "this box is slow", which is the thing an operator is
# actually guessing at.
#
# --max-time keeps a wedged status server from stalling the whole snapshot; a
# failed read omits the field rather than reporting a zero that reads as "fast".
STATZ="$(curl -fsS --max-time 2 "http://127.0.0.1:${HEALTH_PORT}/statz" 2>/dev/null || true)"

# One stage's object out of the compact JSON, then one number out of that. Each
# stage name occurs once, so the greedy match cannot cross into a neighbour.
statz_num() {
  [[ -z "${STATZ}" ]] && return 0
  printf '%s' "${STATZ}" \
    | sed -n "s/.*\"$1\":{\([^}]*\)}.*/\1/p" \
    | sed -n "s/.*\"$2\":\([0-9][0-9.]*\).*/\1/p"
}

HF_MIN="$(statz_num headFetch minMs)"
HF_P50="$(statz_num headFetch p50Ms)"
HF_P95="$(statz_num headFetch p95Ms)"
HF_N="$(statz_num headFetch count)"
CYC_P50="$(statz_num productionCycle p50Ms)"
CYC_P95="$(statz_num productionCycle p95Ms)"

# Where a cycle's time goes. Same STATZ payload already in hand — no second
# request — pulled out per stage so the dashboard can show the split instead of
# a single number.
#
# These stages do NOT sum to productionCycle, and the dashboard says so rather
# than quietly normalising. generateTimePayload and the reward diviner's
# divine() both sit on the producing path and appear in no ProducerTimingNames
# entry, so the remainder is real work that the producer does not time. Pretending
# the parts add up would invent precision the instrumentation does not have.
BP_P50="$(statz_num blockProduction p50Ms)"
MPT_P50="$(statz_num mempoolPendingTransactionsFetch p50Ms)"
MPB_P50="$(statz_num mempoolPendingBlocksFetch p50Ms)"
SUB_P50="$(statz_num mempoolSubmitBlock p50Ms)"

{
  printf '{'
  printf '"collectedAt":"%s",' "${COLLECTED_AT}"
  printf '"container":{"name":"%s","state":"%s","running":%s,"uptime":"%s","restartCount":%s,"image":"%s","health":"%s"},' \
    "$(json_escape "${CONTAINER}")" "$(json_escape "${STATE}")" "${RUNNING}" \
    "$(json_escape "${UPTIME}")" "${RESTARTS}" "$(json_escape "${IMAGE}")" "$(json_escape "${HEALTH}")"
  printf '"blocksPublished":%s,' "${TOTAL}"
  # Every field or none: a partial latency object would leave the page deciding
  # what a missing percentile means.
  if [[ "${HF_P50}" =~ ^[0-9.]+$ && "${HF_P95}" =~ ^[0-9.]+$ && "${HF_N}" =~ ^[0-9]+$ ]]; then
    printf '"latency":{"headFetchMinMs":%s,"headFetchP50Ms":%s,"headFetchP95Ms":%s,"samples":%s' \
      "${HF_MIN:-null}" "${HF_P50}" "${HF_P95}" "${HF_N}"
    [[ "${CYC_P50}" =~ ^[0-9.]+$ ]] && printf ',"cycleP50Ms":%s' "${CYC_P50}"
    [[ "${CYC_P95}" =~ ^[0-9.]+$ ]] && printf ',"cycleP95Ms":%s' "${CYC_P95}"
    printf ',"stages":{'
    STAGE_FIRST=1
    for pair in "headFetch:${HF_P50}" "blockProduction:${BP_P50}" \
                "mempoolTx:${MPT_P50}" "mempoolBlocks:${MPB_P50}" "submit:${SUB_P50}"; do
      v="${pair#*:}"; k="${pair%%:*}"
      [[ "${v}" =~ ^[0-9.]+$ ]] || continue
      [[ ${STAGE_FIRST} -eq 1 ]] && STAGE_FIRST=0 || printf ','
      printf '"%s":%s' "${k}" "${v}"
    done
    printf '}},'
  fi
  printf '"errorCount":%s,' "${ERRORS:-0}"
  printf '"buildsThisRun":%s,' "${BUILDS:-0}"
  if [[ "${W_BUILT}" =~ ^[0-9]+$ ]]; then
    printf '"race":{"windowSeconds":%s,"observedSeconds":%s,"built":%s,"retries":%s,"lost":{"txAlreadyFinalized":%s,"behindFinalizedHead":%s,"blockNumberMismatch":%s}},' \
      "${RACE_WINDOW}" "$(( W_FIRST > 0 ? NOW_EPOCH - W_FIRST : 0 ))" \
      "${W_BUILT}" "${W_RETRY}" "${W_TXFIN}" "${W_BEHIND}" "${W_MISMATCH}"
  fi
  [[ "${RUN_SECONDS}" =~ ^[0-9]+$ ]] && printf '"runSeconds":%s,' "${RUN_SECONDS}"

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
  [[ "${THROTTLE_RAW}" =~ ^0x[0-9a-fA-F]+$ ]] && printf '"throttleRaw":"%s",' "${THROTTLE_RAW}"

  if [[ -n "${OS_TOTAL}" ]]; then
    printf '"os":{"updates":%s,"securityUpdates":%s,"rebootRequired":%s' \
      "${OS_TOTAL}" "${OS_SEC}" "${OS_REBOOT}"
    [[ -n "${OS_AGE}" ]] && printf ',"aptAgeHours":%s' "${OS_AGE}"
    printf '},'
  fi
  [[ -n "${LAST_PUBLISHED}" ]] && printf '"lastPublishedAt":"%s",' "${LAST_PUBLISHED}"
  # JSON-number shape, not merely "digits": 0540 is digits and is not a number,
  # and this printf is the last thing standing between a bad read and a snapshot
  # the dashboard cannot parse.
  [[ "${LAST_BLOCK}" =~ ^(0|[1-9][0-9]*)$ ]] && printf '"lastPublishedBlock":%s,' "${LAST_BLOCK}"
  printf '"recentLog":%s' "${LOG_JSON}"
  printf '}\n'
} > "${OUT}.tmp"

# Validate before publishing, so the dashboard never reads a document it cannot
# parse.
#
# One parser decides, and it is the strictest one installed — not a chain of
# `||`, which publishes whatever the most *permissive* parser on the box will
# accept. jq 1.7 reads `0540` as the number 540; Node, which is what actually
# reads this file, rejects it. So a jq-blessed snapshot took the entire Producer
# panel down with "Unexpected number in JSON at position 452" while this script
# reported a clean cycle. Node first because it is the consumer, python3 next
# because it is on every Debian, jq last because provision.sh installs it and
# nothing else — and no validation at all is worse than a lenient one.
valid_json() {
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -e . "$1" >/dev/null 2>&1
  else
    echo "xl1-collect: no JSON parser installed, publishing unvalidated" >&2
  fi
}

if valid_json "${OUT}.tmp"; then
  mv "${OUT}.tmp" "${OUT}"
  chmod 644 "${OUT}"
else
  rm -f "${OUT}.tmp"
  echo "xl1-collect: produced invalid JSON, kept previous snapshot" >&2
  exit 1
fi
