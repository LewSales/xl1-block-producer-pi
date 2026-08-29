#!/usr/bin/env bash
# Read-only readiness check. Run this on the Pi after first boot, BEFORE
# provision.sh — it changes nothing and takes about 30 seconds.
#
# Catches the mistakes that are cheap to find now and expensive to find after a
# 40-minute provision run: a 32-bit OS, a dead clock, an undervolting supply, no
# route to the chain.
#
#   ./preflight.sh          # full check
#   ./preflight.sh --quiet  # only problems
#
# Exit 0 = ready to provision. Exit 1 = blockers found.

set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" || "${1:-}" == "-q" ]] && QUIET=1

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'

FAILURES=0
WARNINGS=0

pass() { (( QUIET )) || printf '  %sPASS%s  %-26s %s\n' "${GREEN}" "${RESET}" "$1" "${DIM}$2${RESET}"; }
warn() { printf '  %sWARN%s  %-26s %s\n' "${YELLOW}" "${RESET}" "$1" "$2"; WARNINGS=$((WARNINGS+1)); }
fail() { printf '  %sFAIL%s  %-26s %s\n' "${RED}" "${RESET}" "$1" "$2"; FAILURES=$((FAILURES+1)); }
info() { (( QUIET )) || printf '  %s        %-26s %s%s\n' "${DIM}" "$1" "$2" "${RESET}"; }
head_() { (( QUIET )) || printf '\n%s%s%s\n' "${BOLD}${BLUE}" "$1" "${RESET}"; }

(( QUIET )) || printf '\n%sXL1 producer preflight%s  %s\n' "${BOLD}" "${RESET}" "${DIM}$(date)${RESET}"

# ------------------------------------------------------------------ hardware

head_ "Hardware"

MODEL="$(tr -d '\0' < /sys/firmware/devicetree/base/model 2>/dev/null || echo unknown)"
case "${MODEL}" in
  *"Pi 3 Model B Plus"*|*"Pi 3 Model B+"*) pass "Model" "${MODEL}" ;;
  *"Pi 3"*)  pass "Model" "${MODEL}" ;;
  *"Pi 4"*|*"Pi 5"*) pass "Model" "${MODEL} (ceilings will be conservative)" ;;
  unknown)   warn "Model" "could not read device tree" ;;
  *)         warn "Model" "${MODEL} — untested for this bundle" ;;
esac

MEM_KB="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
MEM_MB=$(( MEM_KB / 1024 ))
if   (( MEM_MB < 450 )); then fail "RAM" "${MEM_MB} MB — too little to run a producer"
elif (( MEM_MB < 900 )); then warn "RAM" "${MEM_MB} MB — tighter than the 1 GB this was tuned for"
else pass "RAM" "${MEM_MB} MB"; fi

# ------------------------------------------------------------- architecture

head_ "Architecture"

ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
KARCH="$(uname -m)"
if [[ "${ARCH}" == "arm64" && "${KARCH}" == "aarch64" ]]; then
  pass "Userland + kernel" "${ARCH} / ${KARCH}"
else
  fail "Userland + kernel" "${ARCH} / ${KARCH} — THIS IS THE BLOCKER"
  cat <<EOF

    ${RED}${BOLD}You are running a 32-bit Raspberry Pi OS.${RESET}
    The container images in this bundle are arm64 and will not run here.

    Re-image the card with ${BOLD}Raspberry Pi OS Lite (64-bit)${RESET} and start again.
    A 64-bit card has kernel8.img in its boot partition; a 32-bit one does not.

EOF
fi

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  case "${VERSION_CODENAME:-}" in
    bookworm) pass "OS" "${PRETTY_NAME}" ;;
    trixie)   pass "OS" "${PRETTY_NAME} (newer than tested, should be fine)" ;;
    "")       warn "OS" "${PRETTY_NAME:-unknown}" ;;
    *)        warn "OS" "${PRETTY_NAME} — bundle targets Debian 12 (bookworm)" ;;
  esac
fi

# ------------------------------------------------------------------ storage

head_ "Storage"

ROOT_AVAIL_MB=$(( $(df --output=avail -k / | tail -1) / 1024 ))
if   (( ROOT_AVAIL_MB < 3000 )); then fail "Free space on /" "${ROOT_AVAIL_MB} MB — need ~3 GB for swap + images"
elif (( ROOT_AVAIL_MB < 6000 )); then warn "Free space on /" "${ROOT_AVAIL_MB} MB — tight"
else pass "Free space on /" "${ROOT_AVAIL_MB} MB"; fi

# A card that writes this slowly will make swap pathological and stall the node.
if command -v dd >/dev/null; then
  TMPF="$(mktemp -p /var/tmp xl1-speed.XXXXXX)"
  SPEED="$(LC_ALL=C dd if=/dev/zero of="${TMPF}" bs=1M count=48 conv=fsync 2>&1 | tail -1 | grep -oE '[0-9.]+ [kMG]B/s' | head -1)"
  rm -f "${TMPF}"
  if [[ -z "${SPEED}" ]]; then
    info "SD write speed" "could not measure"
  else
    NUM="${SPEED%% *}"; UNIT="${SPEED#* }"
    case "${UNIT}" in
      kB/s) fail "SD write speed" "${SPEED} — card is failing or counterfeit" ;;
      GB/s) pass "SD write speed" "${SPEED}" ;;
      *) if awk "BEGIN{exit !(${NUM} < 8)}"; then
           warn "SD write speed" "${SPEED} — slow; expect sluggish swap"
         else pass "SD write speed" "${SPEED}"; fi ;;
    esac
  fi
fi

SWAP_MB=$(( $(awk '/^SwapTotal:/{print $2}' /proc/meminfo) / 1024 ))
if (( SWAP_MB < 1000 )); then info "Swap" "${SWAP_MB} MB — provision.sh will set up 4 GB"
else pass "Swap" "${SWAP_MB} MB"; fi

# -------------------------------------------------------------------- power

head_ "Power"

THROTTLE_FILE=/sys/devices/platform/soc/soc:firmware/get_throttled
if command -v vcgencmd >/dev/null 2>&1; then
  T="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
elif [[ -r "${THROTTLE_FILE}" ]]; then
  T="$(cat "${THROTTLE_FILE}")"
else
  T=""
fi

if [[ -n "${T}" ]]; then
  BITS=$(( T ))
  UV_NOW=$(( (BITS >> 0) & 1 )); THR_NOW=$(( (BITS >> 2) & 1 ))
  UV_EVER=$(( (BITS >> 16) & 1 )); THR_EVER=$(( (BITS >> 18) & 1 ))
  if   (( UV_NOW )); then fail "Power supply" "UNDERVOLTING RIGHT NOW — use a 5V/2.5A supply"
  elif (( UV_EVER )); then warn "Power supply" "undervolted since boot — supply is marginal"
  else pass "Power supply" "stable"; fi
  (( THR_NOW )) && warn "Throttling" "throttled right now"
  (( THR_EVER && !THR_NOW )) && info "Throttling" "throttled at some point since boot"
else
  info "Power supply" "throttle status unavailable"
fi

TEMP_RAW="$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "")"
if [[ -n "${TEMP_RAW}" ]]; then
  TEMP=$(( TEMP_RAW / 1000 ))
  if   (( TEMP >= 75 )); then warn "CPU temperature" "${TEMP}°C — add a heatsink"
  else pass "CPU temperature" "${TEMP}°C"; fi
fi

# --------------------------------------------------------------------- time

head_ "Clock"

# The Pi has no RTC and the producer signs against chain time.
if command -v timedatectl >/dev/null 2>&1; then
  SYNCED="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
  if [[ "${SYNCED}" == "yes" ]]; then
    pass "NTP synchronized" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  else
    warn "NTP synchronized" "not yet — the producer unit waits on time-sync.target, so this usually clears on its own"
  fi
else
  info "NTP" "timedatectl unavailable"
fi

# ------------------------------------------------------------------ network

head_ "Network"

IFACE="$(ip -o -4 route show to default 2>/dev/null | awk '{print $5}' | head -1)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "${IP}" ]]; then
  case "${IFACE}" in
    eth0) pass "Connectivity" "${IP} via ${IFACE} (wired)" ;;
    wlan0) warn "Connectivity" "${IP} via ${IFACE} — Wi-Fi on a 3 B+ is less stable under load; prefer Ethernet" ;;
    *) pass "Connectivity" "${IP} via ${IFACE:-unknown}" ;;
  esac
else
  fail "Connectivity" "no IPv4 address"
fi

if getent hosts deb.debian.org >/dev/null 2>&1; then pass "DNS" "resolving"
else fail "DNS" "cannot resolve deb.debian.org — apt and Docker install will fail"; fi

# The one endpoint the producer genuinely cannot work without.
RPC="https://beta.api.chain.xyo.network/rpc"
if command -v curl >/dev/null 2>&1; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "${RPC}" \
          -H 'content-type: application/json' --data '{}' 2>/dev/null || echo 000)"
  if [[ "${CODE}" == "000" ]]; then fail "XL1 Sequence gateway" "unreachable at ${RPC}"
  else pass "XL1 Sequence gateway" "reachable (HTTP ${CODE})"; fi

  curl -sf --max-time 15 https://get.docker.com -o /dev/null 2>/dev/null \
    && pass "get.docker.com" "reachable" \
    || warn "get.docker.com" "unreachable — Docker install will fail"
else
  warn "curl" "not installed; provision.sh installs it"
fi

# ------------------------------------------------------------------- bundle

head_ "Bundle"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in provision.sh systemd/xl1-producer.service scripts/xl1-collect.sh; do
  [[ -f "${HERE}/${f}" ]] && pass "${f}" "present" || fail "${f}" "missing from ${HERE}"
done

MISSING_TARS=0
for t in xl1-local-arm64.tar.gz xl1-dashboard-arm64.tar.gz; do
  if [[ -f "${HERE}/${t}" ]]; then
    pass "${t}" "$(du -h "${HERE}/${t}" | cut -f1)"
  else
    MISSING_TARS=1
    fail "${t}" "missing — build it with ./build-images.sh on a workstation"
  fi
done

if command -v docker >/dev/null 2>&1; then
  info "Docker" "already installed ($(docker --version 2>/dev/null | cut -d, -f1))"
else
  info "Docker" "not installed; provision.sh installs it"
fi

# ------------------------------------------------------------------ verdict

printf '\n%s%s%s\n' "${BOLD}" "────────────────────────────────────────────────────────" "${RESET}"
if (( FAILURES > 0 )); then
  printf '%s%s✗ NOT READY%s — %d blocker(s), %d warning(s)\n\n' "${BOLD}" "${RED}" "${RESET}" "${FAILURES}" "${WARNINGS}"
  printf '  Fix the FAIL lines above, then run this again.\n\n'
  exit 1
elif (( WARNINGS > 0 )); then
  printf '%s%s✓ READY%s — with %d warning(s) worth reading\n\n' "${BOLD}" "${YELLOW}" "${RESET}" "${WARNINGS}"
  printf '  Provision with:  %ssudo ./provision.sh%s\n\n' "${BOLD}" "${RESET}"
  exit 0
else
  printf '%s%s✓ READY%s — everything checks out\n\n' "${BOLD}" "${GREEN}" "${RESET}"
  printf '  Provision with:  %ssudo ./provision.sh%s\n\n' "${BOLD}" "${RESET}"
  exit 0
fi
