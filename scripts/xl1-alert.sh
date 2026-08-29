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
NODE_NAME="${XL1_ALERT_NAME:-$(hostname)}"

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
if [[ -z "${JSON}" ]] || ! printf '%s' "${JSON}" | jq -e . >/dev/null 2>&1; then
  CONDITIONS="dashboard-unreachable|high|Dashboard API did not answer at ${URL}"
else
  # Bind the root before testing anything. A helper that takes `.` as its input
  # sees the boolean it was piped, not the document — so any message that quoted
  # another field errored, jq exited non-zero, stderr went to /dev/null, and the
  # timer reported nothing wrong every sixty seconds. Silence that looks exactly
  # like good news is the worst failure an alerter has.
  CONDITIONS="$(printf '%s' "${JSON}" | jq -r '
    . as $s |
    [
      (if $s.status == "down"
        then "node-down|urgent|Producer is DOWN" else empty end),
      (if ($s.node.container.running // true) | not
        then "container-stopped|urgent|Producer container is not running" else empty end),
      (if $s.node.eligibility.blocked // false
        then "ineligible|high|Producer cannot produce: " + ($s.node.eligibility.reason // "unknown") else empty end),
      (if ($s.health.ok // true) | not
        then "health-failing|high|Health probe /livez is failing" else empty end),
      (if ($s.chain.ok // true) | not
        then "chain-unreachable|high|Chain gateway unreachable" else empty end),
      (if $s.system.throttle.undervoltageNow // false
        then "undervoltage|high|Pi is undervolting right now" else empty end),
      (if $s.node.stale // false
        then "collector-stale|default|Collector snapshot is stale" else empty end),
      (if $s.release.lag == "behind"
        then "cli-behind|default|xl1-cli " + ($s.release.installed // "?") + " is behind published " + ($s.release.latest // "?") else empty end),
      (if ($s.node.os.securityUpdates // 0) > 0
        then "os-security|default|" + (($s.node.os.securityUpdates|tostring) + " host security update(s) pending") else empty end),
      (if $s.node.os.rebootRequired // false
        then "reboot-required|default|Host reboot required" else empty end),
      (if ($s.system.swap.usedPercent // 0) > 60
        then "swapping|default|Heavy swap use — the Pi is short of RAM" else empty end)
    ] | .[]
  ')"

  # jq failing must never read as "all clear". If the filter cannot run, say so
  # rather than reporting a healthy node.
  if [[ $? -ne 0 ]]; then
    CONDITIONS="alerter-broken|high|xl1-alert could not parse the status document"
  fi
fi

if [[ "${MODE}" == "--status" ]]; then
  if [[ -z "${CONDITIONS}" ]]; then echo "nothing firing"; else printf '%s\n' "${CONDITIONS}"; fi
  exit 0
fi

if [[ "${MODE}" == "--test" ]]; then
  send default "XL1 ${NODE_NAME}: test" "If you are reading this, the channel works."
  exit 0
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
while IFS=$'\t' read -r key _; do
  [[ -z "${key}" ]] && continue
  printf '%s' "${CONDITIONS}" | grep -q "^${key}|" || \
    send default "XL1 ${NODE_NAME}: recovered — ${key}" "Cleared $(date -Is)."
done < "${STATE}"

printf '%s' "${NEW_STATE}" > "${STATE}"
