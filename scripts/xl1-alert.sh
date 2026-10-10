#!/usr/bin/env bash
# Tell someone when the producer's state changes.
#
# Reads the dashboard's own /api/status rather than re-deriving anything: the
# dashboard already reconciles four sources and decides what "degraded" means,
# and a second opinion that disagreed with the panel would be worse than none.
#
# Fires on transitions, not on conditions. A node that has been ineligible for a
# week should say so once, not every minute — an alert channel that cries every
# minute is one nobody reads, which is the same as having no alerts.
#
#   /etc/xl1/alert.env    configuration (see alert.env.template)
#   xl1-alert.timer       runs this every 60s
#
#   ./xl1-alert.sh --test    send a test notification through every channel
#   ./xl1-alert.sh --status  show what is currently firing, send nothing

set -uo pipefail

ENV_FILE="${XL1_ALERT_ENV:-/etc/xl1/alert.env}"
[[ -r "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

URL="${XL1_ALERT_URL:-http://127.0.0.1:8088/api/status}"
TOKEN="${XL1_ALERT_TOKEN:-}"
STATE="${XL1_ALERT_STATE:-/var/lib/xl1/.alert-state}"
COOLDOWN="${XL1_ALERT_COOLDOWN:-21600}"     # re-nag an ongoing problem after 6h
# Chain blocks that may pass with none of ours counted before that is a fault
# rather than luck. At a ~7% share we lose about thirteen races for every one we
# win, so short gaps are normal and must not alert; 90 blocks is roughly 85
# minutes, and at p=0.07 the chance of an honest run that long is about 1 in 700.
STALL_BLOCKS="${XL1_ALERT_STALL_BLOCKS:-90}"
# Seconds a container may run without building anything before that is taken as
# a launch that never entered production. Generous on purpose: a build needs a
# pending transaction, and while the chain always has some, the cost of a false
# "restart me" is worse than noticing fifteen minutes later.
LAUNCH_GRACE="${XL1_ALERT_LAUNCH_GRACE:-900}"
NODE_NAME="${XL1_ALERT_NAME:-$(hostname)}"

# A URL that must be pinged regularly, watched by something that is not this
# machine. Everything else here can only report problems it is alive to observe;
# this is the one that covers the Pi losing power, corrupting its card, or
# hanging — where the signal is the absence of a signal.
DEADMAN_URL="${XL1_ALERT_DEADMAN_URL:-}"

NTFY_TOPIC="${XL1_ALERT_NTFY_TOPIC:-}"
NTFY_SERVER="${XL1_ALERT_NTFY_SERVER:-https://ntfy.sh}"
WEBHOOK="${XL1_ALERT_WEBHOOK:-}"
EMAIL="${XL1_ALERT_EMAIL:-}"

MODE="${1:-}"

command -v jq >/dev/null || { echo "xl1-alert: jq is required" >&2; exit 1; }

# ------------------------------------------------------------------- delivery

send() {  # send <priority> <title> <body>
  local prio="$1" title="$2" body="$3" sent=0

  if [[ -n "${NTFY_TOPIC}" ]]; then
    # ntfy needs no account and pushes to a phone app, which is why it is the
    # channel documented first. Tags drive the icon shown on the phone.
    local tag=white_check_mark
    case "${prio}" in high|urgent) tag=rotating_light ;; default) tag=warning ;; esac
    curl -fsS --max-time 15 \
      -H "Title: ${title}" -H "Priority: ${prio}" -H "Tags: ${tag}" \
      -d "${body}" "${NTFY_SERVER}/${NTFY_TOPIC}" >/dev/null 2>&1 && sent=1
  fi

  if [[ -n "${WEBHOOK}" ]]; then
    # Both Slack and Discord accept a bare {"content"/"text"} body, so one
    # payload carrying both keys works on either without configuration.
    local json
    json="$(jq -nc --arg t "${title}" --arg b "${body}" \
      '{content: ($t + "\n" + $b), text: ($t + "\n" + $b)}')"
    curl -fsS --max-time 15 -H 'content-type: application/json' \
      -d "${json}" "${WEBHOOK}" >/dev/null 2>&1 && sent=1
  fi

  if [[ -n "${EMAIL}" ]]; then
    if command -v mail >/dev/null; then
      printf '%s\n' "${body}" | mail -s "${title}" "${EMAIL}" 2>/dev/null && sent=1
    elif command -v sendmail >/dev/null; then
      printf 'To: %s\nSubject: %s\n\n%s\n' "${EMAIL}" "${title}" "${body}" \
        | sendmail -t 2>/dev/null && sent=1
    else
      echo "xl1-alert: XL1_ALERT_EMAIL is set but no mail/sendmail on this host" >&2
    fi
  fi

  (( sent )) || echo "xl1-alert: no channel delivered: ${title}" >&2
  logger -t xl1-alert "${prio}: ${title} — ${body}" 2>/dev/null || true
}

# --------------------------------------------------------------- what is true

fetch() {
  local u="${URL}"
  [[ -n "${TOKEN}" ]] && u="${URL}?token=${TOKEN}"
  curl -fsS --max-time 20 "${u}" 2>/dev/null
}

JSON="$(fetch)"

# The dashboard being unreachable is itself a condition worth reporting — but
# only from a host that is up enough to run this, so it means the dashboard
# died, not the Pi. A dead Pi cannot report anything, which is what a dead-man
# switch is for and this deliberately is not.
READABLE=1
# Valid JSON is not the same as *our* JSON. Every predicate below defaults with
# `// false`, so a 200 carrying an unexpected shape — a renamed field, an error
# object — evaluates to "nothing is wrong", forever. Require the one field whose
# vocabulary we control.
if [[ -z "${JSON}" ]] || ! printf '%s' "${JSON}" \
     | jq -e '.status == "ok" or .status == "degraded" or .status == "down"' >/dev/null 2>&1; then
  READABLE=0
  if [[ -z "${JSON}" ]]; then
    CONDITIONS="dashboard-unreachable|high|Dashboard API did not answer at ${URL}"
  else
    CONDITIONS="alerter-broken|high|Status document from ${URL} is not in the expected shape"
  fi
else
  # Bind the root before testing anything. A helper that takes `.` as its input
  # sees the boolean it was piped, not the document — so any message that quoted
  # another field errored, jq exited non-zero, stderr went to /dev/null, and the
  # timer reported nothing wrong every sixty seconds. Silence that looks exactly
  # like good news is the worst failure an alerter has.
  CONDITIONS="$(printf '%s' "${JSON}" | jq -r --argjson stall "${STALL_BLOCKS}" --argjson grace "${LAUNCH_GRACE}" '
    . as $s |
    [
      (if $s.status == "down"
        then "node-down|urgent|Producer is DOWN" else empty end),
      (if ($s.node.ok // false) and ($s.node.container == null)
        then "container-missing|urgent|Producer container does not exist" else empty end),
      (if ($s.node.container.running == false)
        then "container-stopped|urgent|Producer container is not running" else empty end),
      (if ($s.node.ok // true) | not
        then "collector-down|high|Collector is not reporting: " + ($s.node.error // "unknown") else empty end),
      (if ($s.node.eligibility.blocked // false) and (($s.node.eligibilityIgnored // false) | not)
        then "ineligible|high|Producer cannot produce: " + ($s.node.eligibility.reason // "unknown") else empty end),
      (if ($s.health.ok // true) | not
        then "health-failing|high|Health probe /livez is failing" else empty end),
      (if ($s.chain.ok // true) | not
        then "chain-unreachable|high|Chain gateway unreachable" else empty end),
      (if $s.system.throttle.undervoltageNow // false
        then "undervoltage|high|Pi is undervolting right now" else empty end),
      (if $s.system.throttle.throttledNow // false
        then "overheating|high|SoC hit the 85C hard limit — clocks and voltage forced to defaults" else empty end),
      # The gentle limit, and the one a 3 B+ in a case actually hits. It costs
      # about 17% of clock silently: nothing fails, nothing restarts, blocks
      # just take longer to build and land less often. Worth a notification
      # because the usual cause is a fan that stopped or an intake that clogged,
      # and neither announces itself.
      (if $s.system.throttle.softTempLimitNow // false
        then "thermal-throttle|default|CPU clocked down for heat (1.4 → 1.2 GHz) — check the fan and airflow" else empty end),
      (if $s.node.stale // false
        then "collector-stale|default|Collector snapshot is stale" else empty end),
      (if $s.release.lag == "behind"
        then "cli-behind|default|xl1-cli " + ($s.release.installed // "?") + " is behind published " + ($s.release.latest // "?") else empty end),
      (if ($s.node.os.securityUpdates // 0) > 0
        then "os-security|default|" + (($s.node.os.securityUpdates|tostring) + " host security update(s) pending") else empty end),
      (if $s.node.os.rebootRequired // false
        then "reboot-required|default|Host reboot required" else empty end),
      (if ($s.system.swap.usedPercent // 0) > 60
        then "swapping|default|Heavy swap use — the Pi is short of RAM" else empty end),
      # The one every other check here misses. On 2026-08-31 this node went two
      # hours without landing a block while the container was up, /livez was
      # green, the chain was reachable, nothing was throttling and the log was
      # still printing a clean "Published block:" every minute. Every predicate
      # above said healthy, because every one of them was — the candidates were
      # simply losing every race. Not producing is the only symptom that failure
      # has, and it is the one that costs money, so it is worth a notification
      # even though nothing is technically broken.
      #
      # Counted from the chain, not from the log: "Published" means submitted,
      # and a node can submit all day without a single block being accepted.
      # A producer that never entered production on this launch, as distinct
      # from one that is producing and losing. It cannot recover on its own —
      # /livez passes on a node that has never built a block, so the container
      # is never unhealthy, never exits, and no restart policy fires. Only an
      # operator restarting it clears this, which is exactly why it pages.
      #
      # Guarded on the container actually running, so a stopped container
      # reports container-stopped and not this.
      (if ($s.node.container.running // false)
          and (($s.node.runSeconds // 0) > $grace)
          and (($s.node.buildsThisRun // 1) == 0)
        then "never-produced|urgent|Producer has been up "
             + ((($s.node.runSeconds // 0) / 60) | floor | tostring)
             + " min and has never built a block — it came up in the non-producing state and will not recover without a restart" else empty end),
      (if ($s.derived.blocksSinceLast // 0) > $stall
        then "not-producing|high|No block counted in "
             + ($s.derived.blocksSinceLast|tostring) + " chain blocks (~"
             + ((($s.derived.blocksSinceLast * ($s.derived.secondsPerBlock // 57)) / 60) | floor | tostring)
             + " min) — the node looks healthy but is not landing anything" else empty end)
    ] | .[]
  ')"

  # jq failing must never read as "all clear". If the filter cannot run, say so
  # rather than reporting a healthy node.
  if [[ $? -ne 0 ]]; then
    READABLE=0
    CONDITIONS="alerter-broken|high|xl1-alert could not parse the status document"
  fi
fi

# --------------------------------------------------------------- maintenance holds
#
# A planned restart of something this watches (the dashboard, say) must not page
# as an outage -- and must not be handled by switching alerting off, which also
# silences the producer. A hold names ONE condition key, lasts at most
# HOLD_MAX_MINUTES, and expires on its own; every other condition keeps firing.
# The keys that mean the producer itself is down are refused unless
# XL1_ALERT_HOLD_CRITICAL=1 says so explicitly (a producer maintenance window).
#
#   xl1-alert.sh --hold <key> <minutes> <reason...>
#   xl1-alert.sh --release [key]       (all holds when no key)
#   xl1-alert.sh --holds
HOLD_FILE="$(dirname "${STATE}")/.alert-hold"
HOLD_MAX_MINUTES="${XL1_ALERT_HOLD_MAX_MINUTES:-60}"
CRITICAL_KEYS=" node-down container-missing container-stopped "
NOW_HOLD="$(date +%s)"
active_holds() {  # key<TAB>until<TAB>reason, unexpired only
  [[ -s "${HOLD_FILE}" ]] || return 0
  while IFS=$'\t' read -r k u r; do
    [[ -n "${k}" && "${u}" =~ ^[0-9]+$ ]] && (( u > NOW_HOLD )) && printf '%s\t%s\t%s\n' "${k}" "${u}" "${r}"
  done < "${HOLD_FILE}"
}
case "${MODE}" in
  --hold)
    key="${2:-}"; mins="${3:-}"; shift 3 2>/dev/null || true; reason="$*"
    [[ "${key}" =~ ^[a-z0-9-]+$ ]] || { echo "xl1-alert: --hold needs a condition key (e.g. dashboard-unreachable)" >&2; exit 2; }
    [[ "${mins}" =~ ^[0-9]+$ ]] && (( mins >= 1 && mins <= HOLD_MAX_MINUTES )) \
      || { echo "xl1-alert: minutes must be 1-${HOLD_MAX_MINUTES}" >&2; exit 2; }
    [[ -n "${reason}" ]] || { echo "xl1-alert: give a reason; it is logged with the hold" >&2; exit 2; }
    if [[ "${CRITICAL_KEYS}" == *" ${key} "* && "${XL1_ALERT_HOLD_CRITICAL:-0}" != "1" ]]; then
      echo "xl1-alert: ${key} means the producer is down; set XL1_ALERT_HOLD_CRITICAL=1 to hold it on purpose" >&2; exit 2
    fi
    # Success is reported only after the hold reads back as active. An
    # unprivileged run used to print "held …" after the write had failed,
    # which looks exactly like a hold that is protecting a deploy.
    if ! { mkdir -p "$(dirname "${HOLD_FILE}")" 2>/dev/null \
           && { active_holds | grep -v "^${key}	" || true; printf '%s\t%s\t%s\n' "${key}" $(( NOW_HOLD + mins * 60 )) "${reason}"; } > "${HOLD_FILE}.tmp" 2>/dev/null \
           && mv "${HOLD_FILE}.tmp" "${HOLD_FILE}" 2>/dev/null; } \
       || ! active_holds | grep -q "^${key}	"; then
      rm -f "${HOLD_FILE}.tmp" 2>/dev/null
      echo "xl1-alert: could not write ${HOLD_FILE} (permission? run with sudo) -- NO hold is active" >&2
      exit 1
    fi
    echo "held ${key} for ${mins} min ($(date -d "@$(( NOW_HOLD + mins * 60 ))" -Is 2>/dev/null || echo "+${mins}m")): ${reason}"
    exit 0 ;;
  --release)
    key="${2:-}"
    if [[ -n "${key}" ]] && ! active_holds | grep -q "^${key}	"; then
      echo "no active hold on ${key}"
    elif [[ -n "${key}" ]]; then
      if ! { { active_holds | grep -v "^${key}	" || true; } > "${HOLD_FILE}.tmp" 2>/dev/null && mv "${HOLD_FILE}.tmp" "${HOLD_FILE}" 2>/dev/null; } \
         || active_holds | grep -q "^${key}	"; then
        rm -f "${HOLD_FILE}.tmp" 2>/dev/null
        echo "xl1-alert: could not update ${HOLD_FILE} (permission? run with sudo) -- ${key} is STILL held" >&2; exit 1
      fi
      echo "released ${key}"
    else
      if [[ -e "${HOLD_FILE}" ]] && ! : > "${HOLD_FILE}" 2>/dev/null; then
        echo "xl1-alert: could not clear ${HOLD_FILE} (permission? run with sudo) -- holds are STILL active" >&2; exit 1
      fi
      echo "released all holds"
    fi
    exit 0 ;;
  --holds)
    h="$(active_holds)"; [[ -n "${h}" ]] && printf '%s\n' "${h}" || echo "no active holds"; exit 0 ;;
esac
HOLDS="$(active_holds)"
is_held() { [[ -n "${HOLDS}" ]] && grep -q "^$1	" <<< "${HOLDS}"; }
if [[ -n "${HOLDS}" ]]; then
  while IFS=$'\t' read -r k u r; do echo "xl1-alert: hold active: ${k} until $(date -d "@${u}" -Is 2>/dev/null || echo "${u}") (${r})" >&2; done <<< "${HOLDS}"
  HELD_OUT=""; KEPT=""
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    if is_held "${line%%|*}"; then HELD_OUT+="${line}"$'\n'; else KEPT+="${line}"$'\n'; fi
  done <<< "${CONDITIONS}"
  CONDITIONS="${KEPT%$'\n'}"
fi

if [[ "${MODE}" == "--status" ]]; then
  [[ -n "${HELD_OUT:-}" ]] && printf 'held (not notified):\n%s' "${HELD_OUT}"
  # "Could not look" and "looked, found nothing" are different answers.
  if (( ! READABLE )); then printf 'COULD NOT READ STATUS\n%s\n' "${CONDITIONS}"
  elif [[ -z "${CONDITIONS}" ]]; then echo "nothing firing"
  else printf '%s\n' "${CONDITIONS}"; fi
  exit 0
fi

# --------------------------------------------------------------- dead man
#
# Pinged after the conditions are known, so a run that got as far as reading the
# status document is what counts as alive — not merely a timer that fired.
#
# The /fail variant turns an outage into an immediate alarm rather than waiting
# out the service's grace period; without it a hard failure would be reported no
# sooner than a silent death, which wastes the one thing this adds.
deadman() {
  [[ -n "${DEADMAN_URL}" ]] || return 0
  local suffix="${1:-}"
  curl -fsS --max-time 15 --retry 2 -o /dev/null "${DEADMAN_URL}${suffix}" 2>/dev/null \
    || echo "xl1-alert: dead-man ping to ${DEADMAN_URL}${suffix} failed" >&2
}

if [[ "${MODE}" == "--test" ]]; then
  send default "XL1 ${NODE_NAME}: test" "If you are reading this, the channel works."
  if [[ -n "${DEADMAN_URL}" ]]; then
    deadman && echo "dead-man ping sent to ${DEADMAN_URL}"
  else
    echo "dead-man: not configured (XL1_ALERT_DEADMAN_URL is empty)"
  fi
  exit 0
fi

if (( READABLE )); then
  # A node that is DOWN is a definite failure, not a missed check-in.
  if printf '%s' "${CONDITIONS}" | grep -qE '^(node-down|container-stopped)\|'; then
    deadman /fail
  else
    deadman
  fi
fi

# --------------------------------------------------------------- transitions

mkdir -p "$(dirname "${STATE}")"
touch "${STATE}"
NOW="$(date +%s)"
NEW_STATE=""

while IFS='|' read -r key prio msg; do
  [[ -z "${key}" ]] && continue
  LAST="$(grep -m1 "^${key}	" "${STATE}" 2>/dev/null | cut -f2)"
  if [[ -z "${LAST}" ]]; then
    send "${prio}" "XL1 ${NODE_NAME}: ${msg}" "Started $(date -Is)."
    NEW_STATE+="${key}	${NOW}"$'\n'
  elif (( NOW - LAST >= COOLDOWN )); then
    # Still true hours later. Say so once more, then go quiet again.
    send "${prio}" "XL1 ${NODE_NAME}: still — ${msg}" \
      "Unresolved for $(( (NOW - LAST) / 3600 ))h."
    NEW_STATE+="${key}	${NOW}"$'\n'
  else
    NEW_STATE+="${key}	${LAST}"$'\n'
  fi
done <<< "${CONDITIONS}"

# Recovery is worth as much as the alarm: an operator who was told something
# broke and never told it healed keeps checking by hand.
#
# But only when we could actually see. When the fetch fails, CONDITIONS holds a
# single synthetic entry, so every real condition looks absent — and the pass
# below cheerfully reported the ineligibility resolved and the security updates
# gone, seconds after the dashboard container died. Not seeing a problem is not
# the same as the problem being fixed. Carry the old state forward untouched.
if (( READABLE )); then
  while IFS=$'\t' read -r key ts; do
    [[ -z "${key}" ]] && continue
    # A held key is not observed, so it can be neither still-firing nor
    # recovered: carry its entry forward and decide when the hold ends.
    if is_held "${key}"; then NEW_STATE+="${key}	${ts}"$'\n'; continue; fi
    printf '%s' "${CONDITIONS}" | grep -q "^${key}|" || \
      send default "XL1 ${NODE_NAME}: recovered — ${key}" "Cleared $(date -Is)."
  done < "${STATE}"
else
  while IFS=$'\t' read -r key ts; do
    [[ -z "${key}" ]] && continue
    grep -q "^${key}	" <<< "${NEW_STATE}" || NEW_STATE+="${key}	${ts}"$'\n'
  done < "${STATE}"
fi

# Atomically: a SIGKILL partway through this write leaves a truncated state
# file, after which every condition looks new and re-fires at full priority.
printf '%s' "${NEW_STATE}" > "${STATE}.tmp" && mv "${STATE}.tmp" "${STATE}"

# --------------------------------------------------------------- what is armed
#
# Which channels are configured, so the dashboard can say so. The state file
# next to this one says what is FIRING, and that is a different question from
# whether anything is listening -- an alerter with every channel blank writes an
# empty state file on every run and looks exactly like a quiet, healthy node.
#
# Names only. No URL, no topic, no password: this file sits in the state
# directory the dashboard mounts, and the dashboard has no business holding a
# credential it does not need.
CHANNELS=""
[[ -n "${NTFY_TOPIC}" ]] && CHANNELS="${CHANNELS}\"ntfy\","
[[ -n "${WEBHOOK}" ]] && CHANNELS="${CHANNELS}\"webhook\","
[[ -n "${EMAIL}" ]] && CHANNELS="${CHANNELS}\"email\","
CHANNELS="${CHANNELS%,}"

# The dead-man switch is reported on its own, because it is the only check here
# that keeps working when nothing else can -- and an operator who has set up
# three channels and skipped this one has covered every failure except the
# total ones.
DEADMAN_SET=false
[[ -n "${DEADMAN_URL}" ]] && DEADMAN_SET=true

STATUS_FILE="$(dirname "${STATE}")/.alert-status"
# Advisory only, and never fatal: a dashboard that cannot read this shows one
# row less, but an alerter that died writing its own telemetry would be a
# monitoring tool defeated by itself.
# Active holds are published too: a held alert must be visible as held, never
# indistinguishable from a quiet node. Keys and expiry only, no reasons.
HOLDS_JSON=""
while IFS=$'\t' read -r k u _; do [[ -n "${k}" ]] && HOLDS_JSON+="{\"key\":\"${k}\",\"until\":${u}},"; done <<< "${HOLDS:-}"
printf '{"node":"%s","ranAt":"%s","channels":[%s],"deadman":%s,"cooldownSeconds":%s,"stallBlocks":%s,"launchGraceSeconds":%s,"holds":[%s]}' \
  "${NODE_NAME}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CHANNELS}" "${DEADMAN_SET}" \
  "${COOLDOWN}" "${STALL_BLOCKS}" "${LAUNCH_GRACE}" "${HOLDS_JSON%,}" \
  > "${STATUS_FILE}.tmp" 2>/dev/null && mv "${STATUS_FILE}.tmp" "${STATUS_FILE}" 2>/dev/null || true
