#!/usr/bin/env bash
# xl1-host-update — keep the Debian packages this producer runs on patched.
#
#   xl1-host-update.sh            check, and upgrade if due (runtime excluded)
#   xl1-host-update.sh --check    report only, change nothing
#   xl1-host-update.sh --runtime  operator-run: upgrade the container runtime
#                                 packages too. This restarts Docker, and with it
#                                 the producer. Run it in a window you chose.
#
# xl1-autoupdate.sh handles the xl1-cli image; this is the layer underneath
# it — the OS packages the Pi itself runs, which drift independently of the
# producer image and were sitting at 63 pending with nothing here to notice.
#
# Runs every few hours (see the .timer) and acts on whichever trigger fires
# first:
#   - a security update is pending (from a *-security suite, the same test the
#     collector uses for the dashboard's "host security updates pending")
#   - XL1_HOST_UPDATE_THRESHOLD or more packages pending      (default 10)
#   - XL1_HOST_UPDATE_MAX_AGE since the last applied upgrade  (default 72h)
# Security first since 2026-10-24: the dashboard flags a host "degraded" from
# the first pending security fix, while this waited for ten packages or three
# days, so the owner was patching the Pi by hand almost every day.
# A timer that only fired every 72h would leave a burst of updates sitting for
# up to three days; a threshold alone could fire every few minutes right after
# a fresh image. Together, whichever is more urgent wins.
#
# Container runtime packages are never upgraded on the timer. On 2026-10-08 an
# unattended run upgraded docker-ce 29.8.2 -> 29.9.0 and containerd 2.3.6 ->
# 2.4.1; docker-ce's maintainer script restarted docker.service, and
# xl1-producer.service (Requires=docker.service) went down with it: a Mainnet
# producer restarted by a cron-like job nobody was watching. Everything else
# still flows -- security fixes included -- and pending runtime upgrades are
# written to ${RUNTIME_FILE} for the collector and dashboard to surface, so
# deferring them is visible rather than silent.
#
# XL1_HOST_UPDATE_REBOOT decides what a required reboot does:
#   auto   (default, unchanged) reboot one minute after the upgrade
#   notify write ${REBOOT_FILE} and leave the reboot to the operator

set -uo pipefail

STATE_DIR="${XL1_STATE_DIR:-/var/lib/xl1}"
APT_LOG="${XL1_HOST_UPDATE_LOG:-/tmp/xl1-host-update.log}"
LAST_FILE="${STATE_DIR}/.host-update-last"
RUNTIME_FILE="${STATE_DIR}/.host-update-runtime-pending"
REBOOT_FILE="${STATE_DIR}/.host-update-reboot-pending"
THRESHOLD="${XL1_HOST_UPDATE_THRESHOLD:-10}"
MAX_AGE="${XL1_HOST_UPDATE_MAX_AGE:-259200}"   # 72h, in seconds
REBOOT_MODE="${XL1_HOST_UPDATE_REBOOT:-auto}"
REBOOT_FLAG="${XL1_REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
# Packages whose upgrade restarts the container runtime. A regex over package
# names (without the architecture suffix).
RUNTIME_RE="${XL1_HOST_UPDATE_RUNTIME_RE:-^(docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker-buildx-plugin|docker-compose-plugin|containerd\.io|containerd|runc|docker\.io)$}"
CHECK_ONLY=0; RUNTIME=0
# Every argument is read, and anything unknown stops here. Only the first used
# to be: a typo for --runtime fell through to a full timer run -- upgrade and,
# in auto mode, a reboot that restarts the producer -- and in "--runtime
# --check" the --check was silently dropped and the runtime upgraded.
for arg in "$@"; do
  case "${arg}" in
    --check)   CHECK_ONLY=1 ;;
    --runtime) RUNTIME=1 ;;
    *) printf 'xl1-host-update: unknown argument %s (use --check and/or --runtime)\n' "${arg}" >&2; exit 2 ;;
  esac
done

log() { printf '%s xl1-host-update: %s\n' "$(date -Is)" "$*"; }

case "${REBOOT_MODE}" in auto|notify) ;; *) log "XL1_HOST_UPDATE_REBOOT=${REBOOT_MODE} is not auto|notify -- refusing to guess"; exit 2 ;; esac

mkdir -p "${STATE_DIR}"

if ! apt-get update -q >"${APT_LOG}" 2>&1; then
  log "apt-get update failed -- leaving packages alone"
  cat "${APT_LOG}"
  exit 1
fi

# Names of upgradable packages, split into the runtime set and the rest.
UPG_LINES="$(apt list --upgradable 2>/dev/null | grep -F '[upgradable from:' || true)"
UPGRADABLE="$(printf '%s\n' "${UPG_LINES}" | cut -d/ -f1 | grep -v '^$' || true)"
RUNTIME_PKGS="$(printf '%s\n' "${UPGRADABLE}" | grep -E "${RUNTIME_RE}" || true)"
OTHER_PKGS="$(printf '%s\n' "${UPGRADABLE}" | grep -vE "${RUNTIME_RE}" | grep -v '^$' || true)"
# Security fixes among the packages the timer may install: "pkg/suite[,suite] ...",
# a suite ending -security. (Raspberry Pi OS ships some fixes through plain
# stable; those still flow on the threshold and age triggers.)
SECURITY_PKGS="$(printf '%s\n' "${UPG_LINES}" | awk '{ split($1, a, "/"); if (a[2] ~ /-security/) print a[1] }' | grep -vE "${RUNTIME_RE}" | grep -v '^$' || true)"
count() { [[ -z "$1" ]] && echo 0 || printf '%s\n' "$1" | grep -c .; }
PENDING="$(count "${UPGRADABLE}")"
RUNTIME_PENDING="$(count "${RUNTIME_PKGS}")"
OTHER_PENDING="$(count "${OTHER_PKGS}")"
SECURITY_PENDING="$(count "${SECURITY_PKGS}")"

# Always record what the runtime is waiting on, so the deferral is visible.
if (( RUNTIME_PENDING > 0 )); then
  printf '%s\n' "${RUNTIME_PKGS}" | tr '\n' ' ' | sed 's/ $/\n/' > "${RUNTIME_FILE}"
else
  rm -f "${RUNTIME_FILE}"
fi

if (( RUNTIME )); then
  if (( CHECK_ONLY )); then exit 0; fi
  if (( RUNTIME_PENDING == 0 )); then log "no container runtime upgrade pending"; exit 0; fi
  log "operator-run runtime upgrade: $(tr '\n' ' ' <<< "${RUNTIME_PKGS}")-- Docker and the producer will restart"
  # shellcheck disable=SC2086
  if ! DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        ${RUNTIME_PKGS} >"${APT_LOG}" 2>&1; then
    log "runtime upgrade FAILED -- see ${APT_LOG}"
    exit 1
  fi
  rm -f "${RUNTIME_FILE}"
  log "runtime upgrade applied"
  exit 0
fi

last=0
[[ -s "${LAST_FILE}" ]] && last="$(cat "${LAST_FILE}")"
now="$(date +%s)"
age=$(( now - last ))

if (( SECURITY_PENDING == 0 )) && (( PENDING < THRESHOLD )) && (( age < MAX_AGE )); then
  log "${PENDING} pending (0 security, ${RUNTIME_PENDING} runtime, deferred; threshold ${THRESHOLD}), last applied $(( age / 3600 ))h ago (max $(( MAX_AGE / 3600 ))h) -- nothing to do"
  exit 0
fi

if (( SECURITY_PENDING > 0 )); then
  log "${SECURITY_PENDING} security update(s) pending ($(tr '\n' ' ' <<< "${SECURITY_PKGS}")) -- upgrading now, with the other ${OTHER_PENDING} non-runtime package(s)"
else
  log "${PENDING} pending (${RUNTIME_PENDING} runtime, deferred) / last applied $(( age / 3600 ))h ago -- upgrading"
fi
if (( CHECK_ONLY )); then
  log "--check given, stopping here"
  exit 0
fi

if (( OTHER_PENDING == 0 )); then
  # Nothing to install on the timer but the age trigger fired -- record the
  # check so the 72h clock resets rather than firing again on every run.
  echo "${now}" > "${LAST_FILE}"
  if (( RUNTIME_PENDING > 0 )); then
    log "nothing pending to install on the timer (runtime upgrade waits for --runtime)"
  else
    log "nothing pending to install"
  fi
  exit 0
fi

# Named packages only, so a runtime package is never pulled in by `upgrade`.
# shellcheck disable=SC2086
if ! DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
      ${OTHER_PKGS} >"${APT_LOG}" 2>&1; then
  log "apt-get upgrade FAILED -- see ${APT_LOG}"
  exit 1
fi

echo "${now}" > "${LAST_FILE}"
log "upgrade applied (${OTHER_PENDING} package(s); ${RUNTIME_PENDING} runtime deferred)"

if [[ -f "${REBOOT_FLAG}" ]]; then
  pkgs=""
  [[ -f "${REBOOT_FLAG}.pkgs" ]] && pkgs="$(tr '\n' ' ' < "${REBOOT_FLAG}.pkgs")"
  if [[ "${REBOOT_MODE}" == "notify" ]]; then
    printf '%s\n' "${pkgs:-kernel/libs}" > "${REBOOT_FILE}"
    log "reboot required (${pkgs:-kernel/libs}) -- XL1_HOST_UPDATE_REBOOT=notify, leaving it to the operator"
  else
    log "reboot required (${pkgs:-kernel/libs}) -- rebooting in 1 minute"
    # xl1-producer.service and xl1-dashboard.service are both enabled, so they
    # come back on their own at boot; the delay just gives this log line and any
    # in-flight journal writes time to land before the box goes down.
    shutdown -r +1 "xl1-host-update: rebooting to finish an applied package upgrade"
  fi
else
  rm -f "${REBOOT_FILE}"
  log "no reboot required"
fi
