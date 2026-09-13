#!/usr/bin/env bash
# xl1-host-update — keep the Debian packages this producer runs on patched.
#
#   xl1-host-update.sh            check, and upgrade if due
#   xl1-host-update.sh --check    report only, change nothing
#
# xl1-autoupdate.sh handles the xl1-cli image; this is the layer underneath
# it — the OS packages the Pi itself runs, which drift independently of the
# producer image and were sitting at 63 pending with nothing here to notice.
#
# Runs every few hours (see the .timer) and acts on whichever trigger fires
# first:
#   - XL1_HOST_UPDATE_THRESHOLD or more packages pending      (default 10)
#   - XL1_HOST_UPDATE_MAX_AGE since the last applied upgrade  (default 72h)
# A timer that only fired every 72h would leave a burst of updates sitting for
# up to three days; a threshold alone could fire every few minutes right after
# a fresh image. Together, whichever is more urgent wins.

set -uo pipefail

STATE_DIR="${XL1_STATE_DIR:-/var/lib/xl1}"
LAST_FILE="${STATE_DIR}/.host-update-last"
THRESHOLD="${XL1_HOST_UPDATE_THRESHOLD:-10}"
MAX_AGE="${XL1_HOST_UPDATE_MAX_AGE:-259200}"   # 72h, in seconds
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

log() { printf '%s xl1-host-update: %s\n' "$(date -Is)" "$*"; }

mkdir -p "${STATE_DIR}"

if ! apt-get update -q >/tmp/xl1-host-update.log 2>&1; then
  log "apt-get update failed -- leaving packages alone"
  cat /tmp/xl1-host-update.log
  exit 1
fi

# Same count the dashboard card uses (scripts/xl1-collect.sh), computed fresh
# here rather than read from its cache so this never acts on a stale number.
PENDING="$(apt list --upgradable 2>/dev/null | grep -cF '[upgradable from:' || true)"
PENDING="${PENDING:-0}"

last=0
[[ -s "${LAST_FILE}" ]] && last="$(cat "${LAST_FILE}")"
now="$(date +%s)"
age=$(( now - last ))

if (( PENDING < THRESHOLD )) && (( age < MAX_AGE )); then
  log "${PENDING} pending (threshold ${THRESHOLD}), last applied $(( age / 3600 ))h ago (max $(( MAX_AGE / 3600 ))h) -- nothing to do"
  exit 0
fi

log "${PENDING} pending / last applied $(( age / 3600 ))h ago -- upgrading"
if (( CHECK_ONLY )); then
  log "--check given, stopping here"
  exit 0
fi

if (( PENDING == 0 )); then
  # Nothing to install but the age trigger fired -- record the check so the
  # 72h clock resets rather than firing again on every run until something
  # actually becomes available.
  echo "${now}" > "${LAST_FILE}"
  log "nothing pending to install"
  exit 0
fi

if ! DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
      >/tmp/xl1-host-update.log 2>&1; then
  log "apt-get upgrade FAILED -- see /tmp/xl1-host-update.log"
  exit 1
fi

echo "${now}" > "${LAST_FILE}"
log "upgrade applied"

if [[ -f /var/run/reboot-required ]]; then
  pkgs=""
  [[ -f /var/run/reboot-required.pkgs ]] && pkgs="$(tr '\n' ' ' < /var/run/reboot-required.pkgs)"
  log "reboot required (${pkgs:-kernel/libs}) -- rebooting in 1 minute"
  # xl1-producer.service and xl1-dashboard.service are both enabled, so they
  # come back on their own at boot; the delay just gives this log line and any
  # in-flight journal writes time to land before the box goes down.
  shutdown -r +1 "xl1-host-update: rebooting to finish an applied package upgrade"
else
  log "no reboot required"
fi
