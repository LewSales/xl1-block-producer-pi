#!/usr/bin/env bash
# Provision a Raspberry Pi 3 B+ as an XL1 block producer with a local dashboard.
#
# Adapted from Jim's RPi 4 runbook. The differences that matter on a 3 B+:
#   * 1 GB RAM, not 2–8 GB — memory ceilings are explicit and swap is a real
#     backstop rather than a formality
#   * the container images are cross-built on a workstation and loaded from
#     tarballs, because `npm install` of the CLI toolchain on a 1 GB Pi is slow
#     enough to be its own failure mode
#   * gpu_mem is cut to the headless minimum to hand ~48 MB back to the system
#
# Idempotent: safe to re-run. Run with sudo.

set -Eeuo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=/var/lib/xl1
CONF_DIR=/etc/xl1
SWAP_SIZE="${SWAP_SIZE:-4G}"
# Temperature at which the 3 B+ drops the ARM cores from 1.4 GHz to 1.2 GHz.
# Firmware default is 60, firmware maximum is 70 — anything higher is ignored.
TEMP_SOFT_LIMIT="${TEMP_SOFT_LIMIT:-70}"
# Overclocking is opt-in and off unless asked for. Empty means "do not touch
# config.txt", which is the only safe default for a box that holds a wallet seed
# and is expected to run unattended for months.
ARM_FREQ="${ARM_FREQ:-}"
OVER_VOLTAGE="${OVER_VOLTAGE:-}"
DASH_PORT="${DASH_PORT:-8088}"
INSTALL_TAILSCALE="${INSTALL_TAILSCALE:-1}"

log()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    warning: %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line ${LINENO}. Nothing further was changed; re-run after fixing."' ERR

[[ ${EUID} -eq 0 ]] || die "run this with sudo: sudo ${BASH_SOURCE[0]}"

# ---------------------------------------------------------------- 0. preflight

log "Preflight"

ARCH="$(dpkg --print-architecture)"
[[ "${ARCH}" == "arm64" ]] || die "this bundle ships arm64 images but the OS reports '${ARCH}'.
    You are running a 32-bit Raspberry Pi OS. Re-image with the 64-bit build."

MODEL="$(tr -d '\0' < /sys/firmware/devicetree/base/model 2>/dev/null || echo unknown)"
info "Model:  ${MODEL}"
info "Kernel: $(uname -r)"
info "RAM:    $(free -h | awk '/^Mem:/{print $2}')"

case "${MODEL}" in
  *"Pi 3"*) : ;;
  *"Pi 4"*|*"Pi 5"*) info "Larger Pi than this bundle was tuned for — the memory ceilings below are conservative but safe." ;;
  *) warn "Unrecognized model; continuing." ;;
esac

# The producer signs against chain time; a Pi has no RTC, so a wrong clock at
# boot produces confusing failures rather than an obvious one.
if command -v timedatectl >/dev/null 2>&1; then
  if [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ]]; then
    warn "clock not yet NTP-synchronized — the producer unit waits on time-sync.target, so this resolves itself shortly after boot."
  fi
fi

for tar in xl1-local-arm64.tar.gz xl1-dashboard-arm64.tar.gz; do
  [[ -f "${BUNDLE_DIR}/${tar}" ]] || die "missing image tarball ${BUNDLE_DIR}/${tar}"
done

# ------------------------------------------------------------------- 1. swap

log "Swap (${SWAP_SIZE})"

if swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  info "/swapfile already active ($(swapon --show=SIZE --noheadings | head -1))"
else
  # dphys-swapfile owns swap on Raspberry Pi OS and will fight a manual swapfile.
  if systemctl list-unit-files dphys-swapfile.service >/dev/null 2>&1; then
    info "disabling dphys-swapfile (it caps swap at 2 GB and would conflict)"
    systemctl disable --now dphys-swapfile.service >/dev/null 2>&1 || true
    swapoff /var/swap 2>/dev/null || true
    rm -f /var/swap
  fi
  info "allocating ${SWAP_SIZE} swapfile"
  fallocate -l "${SWAP_SIZE}" /swapfile || { rm -f /swapfile; die "could not allocate ${SWAP_SIZE} of swap"; }
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Swap here is an OOM backstop, not working memory. Left at the default 60, a
# 1 GB Pi will page hot objects onto the SD card and both wear the card and
# stall the node; 10 keeps it in reserve.
if [[ "$(cat /proc/sys/vm/swappiness)" != "10" ]]; then
  echo 'vm.swappiness=10' > /etc/sysctl.d/60-xl1-swappiness.conf
  sysctl -q vm.swappiness=10
  info "vm.swappiness set to 10"
fi
free -h | sed 's/^/    /'

# --------------------------------------------------------------- 2. gpu memory

log "Headless GPU memory split"

BOOT_CONFIG=/boot/firmware/config.txt
[[ -f "${BOOT_CONFIG}" ]] || BOOT_CONFIG=/boot/config.txt

if [[ -f "${BOOT_CONFIG}" ]]; then
  if grep -qE '^\s*gpu_mem=16\s*$' "${BOOT_CONFIG}"; then
    info "gpu_mem already 16M"
  else
    sed -i -E '/^\s*gpu_mem=/d' "${BOOT_CONFIG}"
    printf '\n# XL1: headless node, hand GPU RAM back to the system\ngpu_mem=16\n' >> "${BOOT_CONFIG}"
    info "gpu_mem=16 written to ${BOOT_CONFIG} (~48 MB returned on next boot)"
    REBOOT_WANTED=1
  fi
else
  warn "no config.txt found; skipping GPU split"
fi

# --------------------------------------------------- 2b. thermal soft limit

# A 3 B+ clocks itself down from 1.4 GHz to 1.2 GHz at 60 °C and stays there
# until it cools. For a producer in a case that is most of the day, and the
# dashboard reports it as "CPU clock reduced for heat".
#
# `temp_soft_limit` moves that point. It is a 3A+/3B+ key only, it defaults to
# 60, and the firmware clamps it at 70 — 75 or 80 are not available, and there
# is no value that switches the soft limit off. The separate 85 °C hard limit
# (`temp_limit`) is overheat protection and is not raisable at all.
#
# 70 is the ceiling, so it is what we ask for; it is worth having a heatsink on
# the SoC before running there.
if [[ -f "${BOOT_CONFIG}" ]]; then
  if (( TEMP_SOFT_LIMIT > 70 )); then
    warn "TEMP_SOFT_LIMIT=${TEMP_SOFT_LIMIT} exceeds the firmware maximum; using 70"
    TEMP_SOFT_LIMIT=70
  fi
  case "${MODEL}" in
    *"Pi 3 Model A Plus"*|*"Pi 3 Model B Plus"*|*"Pi 3 Model A+"*|*"Pi 3 Model B+"*)
      if grep -qE "^\\s*temp_soft_limit=${TEMP_SOFT_LIMIT}\\s*$" "${BOOT_CONFIG}"; then
        info "temp_soft_limit already ${TEMP_SOFT_LIMIT}"
      else
        sed -i -E '/^\s*temp_soft_limit=/d' "${BOOT_CONFIG}"
        printf '\n# XL1: hold turbo clock until %s C instead of the stock 60 C\ntemp_soft_limit=%s\n' \
          "${TEMP_SOFT_LIMIT}" "${TEMP_SOFT_LIMIT}" >> "${BOOT_CONFIG}"
        info "temp_soft_limit=${TEMP_SOFT_LIMIT} written to ${BOOT_CONFIG} (takes effect on next boot)"
        REBOOT_WANTED=1
      fi
      ;;
    *) info "temp_soft_limit is a 3A+/3B+ key; not applicable to this model" ;;
  esac
fi

# ------------------------------------------------------------ 2c. clock speed

# Off unless asked for:  sudo ARM_FREQ=1450 OVER_VOLTAGE=4 ./provision.sh
#
# A 3 B+ runs at 1400 MHz and builds a block in roughly seventeen seconds
# against a one-second budget, so clock speed is the one software lever left on
# how often this node lands a block. It is also the one change here that can
# make a working producer unstable.
#
# What that instability looks like matters: not a clean crash, but occasional
# silent corruption on the SD card the wallet seed lives on. So this refuses
# anything it cannot argue for, and every line it writes can be deleted from
# config.txt to undo it.
#
# Do not touch this without real cooling. Raising the clock raises the heat, and
# a Pi that hits the soft limit is clocked back to 1.2 GHz — slower than stock
# and hotter with it. Fix airflow first; the dashboard's Throttle tile says
# whether that worked.
if [[ -n "${ARM_FREQ}${OVER_VOLTAGE}" ]]; then
  if [[ ! -f "${BOOT_CONFIG}" ]]; then
    warn "no config.txt found; skipping clock settings"
  else
    case "${MODEL}" in
      *"Pi 3 Model A Plus"*|*"Pi 3 Model B Plus"*|*"Pi 3 Model A+"*|*"Pi 3 Model B+"*)
        OC_OK=1

        if [[ -n "${ARM_FREQ}" ]]; then
          if [[ ! "${ARM_FREQ}" =~ ^[0-9]+$ ]]; then
            warn "ARM_FREQ=${ARM_FREQ} is not a number; skipping clock settings"; OC_OK=0
          elif (( ARM_FREQ < 1400 )); then
            # Almost certainly a typo. Underclocking is a legitimate thing to
            # want, but not something to do to a producer by accident.
            warn "ARM_FREQ=${ARM_FREQ} is below the 1400 MHz stock clock — refusing.
    That would make this node slower, not faster. Remove the arm_freq line from
    ${BOOT_CONFIG} by hand if an underclock is genuinely what you want."
            OC_OK=0
          elif (( ARM_FREQ > 1500 )); then
            warn "ARM_FREQ=${ARM_FREQ} is beyond what a 3 B+ holds reliably; clamping to 1500"
            ARM_FREQ=1500
          fi
        fi

        if [[ -n "${OVER_VOLTAGE}" ]]; then
          if [[ ! "${OVER_VOLTAGE}" =~ ^[0-9]+$ ]]; then
            warn "OVER_VOLTAGE=${OVER_VOLTAGE} is not a number; skipping clock settings"; OC_OK=0
          elif (( OVER_VOLTAGE > 6 )); then
            # The firmware accepts 8, but past 6 the extra heat buys almost no
            # extra stable clock on this SoC and sets the warranty bit.
            warn "OVER_VOLTAGE=${OVER_VOLTAGE} is higher than is sensible here; clamping to 6"
            OVER_VOLTAGE=6
          fi
        fi

        # A 3 B+ rarely holds anything above stock on stock voltage. Saying so
        # is more useful than letting it boot-loop and be discovered later.
        if (( OC_OK )) && [[ -n "${ARM_FREQ}" && "${ARM_FREQ}" != "1400" && -z "${OVER_VOLTAGE}" ]]; then
          warn "ARM_FREQ=${ARM_FREQ} with no OVER_VOLTAGE — this often will not boot.
    Try OVER_VOLTAGE=2 (or 4) alongside it if the Pi hangs on the next start."
        fi

        if (( OC_OK )); then
          # Rewritten as a block so re-running with different values replaces
          # the previous attempt rather than stacking contradictory keys.
          sed -i -E '/^\s*#\s*XL1: clock\b/d; /^\s*arm_freq=/d; /^\s*over_voltage=/d' "${BOOT_CONFIG}"
          {
            printf '\n# XL1: clock — delete these two lines to return to stock\n'
            [[ -n "${ARM_FREQ}" ]]     && printf 'arm_freq=%s\n' "${ARM_FREQ}"
            [[ -n "${OVER_VOLTAGE}" ]] && printf 'over_voltage=%s\n' "${OVER_VOLTAGE}"
          } >> "${BOOT_CONFIG}"
          info "clock settings written to ${BOOT_CONFIG}: arm_freq=${ARM_FREQ:-stock} over_voltage=${OVER_VOLTAGE:-stock}"
          warn "overclock applies on the next boot. If the Pi does not come back:
    put the card in another machine and delete the arm_freq/over_voltage lines
    from config.txt. Nothing else on the card needs touching."
          REBOOT_WANTED=1
        fi
        ;;
      *) info "clock settings here are 3A+/3B+ values; not applying them to this model" ;;
    esac
  fi
fi

# ------------------------------------------------------- 3. packages & Docker

log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git ufw curl ca-certificates jq >/dev/null
info "git, ufw, curl, ca-certificates, jq"

log "Docker"
if command -v docker >/dev/null 2>&1; then
  info "already installed: $(docker --version)"
else
  info "installing from get.docker.com (a few minutes on a Pi 3)"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null
  rm -f /tmp/get-docker.sh
  info "installed: $(docker --version)"
fi

# Unbounded container logs are the classic way to fill an SD card and take the
# node down weeks later. Cap them daemon-wide as well as per-unit.
mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
  info "log rotation configured"
else
  info "daemon.json exists, left alone"
fi

systemctl enable --now docker >/dev/null 2>&1 || true

TARGET_USER="${SUDO_USER:-pi}"
if id "${TARGET_USER}" >/dev/null 2>&1 && ! id -nG "${TARGET_USER}" | grep -qw docker; then
  usermod -aG docker "${TARGET_USER}"
  info "added ${TARGET_USER} to the docker group (log out and back in for it to apply)"
fi

# ------------------------------------------------------------- 4. Tailscale

if [[ "${INSTALL_TAILSCALE}" == "1" ]]; then
  log "Tailscale"
  if command -v tailscale >/dev/null 2>&1; then
    info "already installed: $(tailscale version | head -1)"
  else
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    info "installed: $(tailscale version | head -1)"
  fi
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  if tailscale status >/dev/null 2>&1; then
    info "already logged in as: $(tailscale status --json | jq -r '.Self.DNSName // "unknown"' 2>/dev/null || echo unknown)"
  else
    NEEDS_TAILSCALE_LOGIN=1
    info "not logged in yet — run 'sudo tailscale up' after this script finishes"
  fi
fi

# ------------------------------------------------------------------ 5. firewall

log "Firewall (UFW)"

ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow ssh >/dev/null
ufw allow 30303/tcp >/dev/null
ufw allow 30303/udp >/dev/null

# Dashboard reachable from the local subnet and over the tailnet, never from
# the open internet — this box holds a producer mnemonic.
LAN_CIDR="$(ip -o -f inet addr show | awk '$2 != "lo" && $4 !~ /^100\./ {print $4; exit}')"
if [[ -n "${LAN_CIDR}" ]]; then
  LAN_NET="$(ipcalc -n "${LAN_CIDR}" 2>/dev/null | awk -F= '/^NETWORK=/{print $2}')" || true
  [[ -z "${LAN_NET:-}" ]] && LAN_NET="$(python3 -c "import ipaddress,sys; print(ipaddress.ip_network('${LAN_CIDR}', strict=False))" 2>/dev/null || echo "")"
  if [[ -n "${LAN_NET}" ]]; then
    ufw allow from "${LAN_NET}" to any port "${DASH_PORT}" proto tcp >/dev/null
    info "dashboard port ${DASH_PORT} open to ${LAN_NET}"
  fi
fi
if [[ "${INSTALL_TAILSCALE}" == "1" ]]; then
  ufw allow in on tailscale0 to any port "${DASH_PORT}" proto tcp >/dev/null
  ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
  info "dashboard port ${DASH_PORT} open on tailscale0"
fi

ufw --force enable >/dev/null
info "enabled"
ufw status | sed 's/^/    /'

# -------------------------------------------------------------- 6. directories

log "Directories and configuration"

mkdir -p "${STATE_DIR}/data" "${STATE_DIR}/dashboard" "${CONF_DIR}"
chmod 755 "${STATE_DIR}"
# The producer runs as uid 1000 (`node`) inside the image and owns /data.
chown -R 1000:1000 "${STATE_DIR}/data"
# The dashboard runs as the same uid and is the only writer here — everything
# else it sees is mounted read-only. This is its long-range history, which is
# the one thing on that page that cannot survive a container restart otherwise.
chown 1000:1000 "${STATE_DIR}/dashboard"
chmod 755 "${STATE_DIR}/dashboard"

# Returns 0 only when it actually installed the file. Callers must not infer
# "the destination has my content" from "this ran without error" — the whole
# point of the function is that it sometimes declines.
install_config() {
  local src="$1" dest="$2" mode="$3"
  if [[ -f "${dest}" ]]; then
    info "$(basename "${dest}") already exists — left untouched"
    if ! cmp -s "${src}" "${dest}"; then
      warn "$(basename "${src}") in the bundle DIFFERS from the installed
    $(basename "${dest}") and was NOT applied. Edit ${dest} directly, or remove
    it first if you intend the bundle copy to replace it."
    fi
    return 1
  fi
  install -m "${mode}" "${src}" "${dest}"
  info "installed $(basename "${dest}") (mode ${mode})"
}

# A mnemonic that is present but empty is not a mnemonic. `.+` matches the two
# quote characters of XL1_MNEMONIC="", which was enough to arm the shred below
# and to convince the service gate that credentials existed.
has_mnemonic() {
  grep -qE '^XL1_MNEMONIC=["'"'"']*[A-Za-z]' "$1" 2>/dev/null
}

# A real env file shipped alongside this script wins over the blank template, so
# an operator who already has working credentials does not retype them.
PRODUCER_SRC="${BUNDLE_DIR}/sequence-producer.env"
[[ -f "${PRODUCER_SRC}" ]] || PRODUCER_SRC="${BUNDLE_DIR}/sequence-producer.env.template"
DASHBOARD_SRC="${BUNDLE_DIR}/dashboard.env"
[[ -f "${DASHBOARD_SRC}" ]] || DASHBOARD_SRC="${BUNDLE_DIR}/dashboard.env.template"

PRODUCER_INSTALLED=0
if install_config "${PRODUCER_SRC}" "${CONF_DIR}/sequence-producer.env" 600; then
  PRODUCER_INSTALLED=1
fi
install_config "${DASHBOARD_SRC}" "${CONF_DIR}/dashboard.env" 644 || true

ALERT_SRC="${BUNDLE_DIR}/alert.env"
[[ -f "${ALERT_SRC}" ]] || ALERT_SRC="${BUNDLE_DIR}/alert.env.template"
install_config "${ALERT_SRC}" "${CONF_DIR}/alert.env" 600 || true

# If the credentials arrived on the boot partition, that partition is FAT and
# readable by anyone who puts the card in a reader. Remove the staged copy once
# it is safely at /etc/xl1 with mode 0600.
#
# Gated on this run having actually installed the file. Previously it checked
# only that the DESTINATION held a mnemonic — so re-provisioning with a new seed
# in the bundle shredded that new seed, because the old installed config
# satisfied the test. The new phrase was destroyed having never been copied
# anywhere, by the code path whose warning claims it is "safely at /etc/xl1".
if (( PRODUCER_INSTALLED )) \
   && [[ "${PRODUCER_SRC}" == "${BUNDLE_DIR}/sequence-producer.env" ]] \
   && has_mnemonic "${CONF_DIR}/sequence-producer.env"; then
  shred -u "${PRODUCER_SRC}" 2>/dev/null || rm -f "${PRODUCER_SRC}"
  warn "removed the staged copy of sequence-producer.env from the bundle directory.
    Note that shred cannot reliably erase FAT/SD storage — if that bundle sat on
    the boot partition, treat the seed as having been exposed to anyone with
    physical access to the card."
fi

install -m 755 "${BUNDLE_DIR}/scripts/xl1-collect.sh" /usr/local/bin/xl1-collect.sh
info "installed /usr/local/bin/xl1-collect.sh"

install -m 755 "${BUNDLE_DIR}/scripts/xl1-alert.sh" /usr/local/bin/xl1-alert.sh
info "installed /usr/local/bin/xl1-alert.sh"

# Root-owned and not operator-writable: the sudoers grant below would otherwise
# be a way to escalate by editing the script it exempts.
install -o root -g root -m 755 "${BUNDLE_DIR}/scripts/xl1ctl" /usr/local/bin/xl1ctl
info "installed /usr/local/bin/xl1ctl"

# The console dashboard is installed but not wired to a display: attaching a
# panel changes boot config and needs a reboot, so it stays an explicit step.
install -o root -g root -m 755 "${BUNDLE_DIR}/scripts/xl1-screen" /usr/local/bin/xl1-screen
info "installed /usr/local/bin/xl1-screen (run xl1-screen-setup.sh to put it on a panel)"

# Let the operator drive xl1ctl without retyping a password, so the desktop
# shortcuts work in one click. Scoped to this one command, nothing else.
if [[ -n "${TARGET_USER}" ]] && id "${TARGET_USER}" >/dev/null 2>&1; then
  SUDOERS=/etc/sudoers.d/xl1ctl
  # Scoped to the read-only and service-control verbs, NOT to the bare binary.
  #
  # A blanket grant on /usr/local/bin/xl1ctl covers every argument, and xl1ctl
  # takes paths: `sudo xl1ctl update /home/anyone/dir` would docker-load an
  # arbitrary image, retag it xl1:local and restart the producer with the
  # mnemonic mounted in — passwordless root plus seed exfiltration. `backup
  # /any/path` writes a root-owned file wherever it is pointed.
  #
  # The verbs that take a path (update, backup, restore) are deliberately absent
  # and still prompt for a password.
  {
    for verb in status addr logs health doctor start stop restart dashboard; do
      printf '%s ALL=(root) NOPASSWD: /usr/local/bin/xl1ctl %s, /usr/local/bin/xl1ctl %s *\n' \
        "${TARGET_USER}" "${verb}" "${verb}"
    done
  } > "${SUDOERS}.tmp"
  chmod 440 "${SUDOERS}.tmp"
  if visudo -c -f "${SUDOERS}.tmp" >/dev/null 2>&1; then
    mv "${SUDOERS}.tmp" "${SUDOERS}"
    info "${TARGET_USER} may run the read-only and service-control xl1ctl verbs without a password"
    info "(update/backup/restore still prompt — they take paths and run as root)"
  else
    rm -f "${SUDOERS}.tmp"
    warn "sudoers snippet failed validation; skipped (you will be asked for a password)"
  fi
fi

# ------------------------------------------------------------------ 7. images

log "Loading container images"
for tar in xl1-local-arm64 xl1-dashboard-arm64; do
  info "loading ${tar}.tar.gz (slow on a Pi — decompressing ~100–200 MB)"
  gunzip -c "${BUNDLE_DIR}/${tar}.tar.gz" | docker load | sed 's/^/      /'
done

# The units reference short tags; the tarballs carry the -arm64 build tags.
docker tag xl1:local-arm64 xl1:local
docker tag xl1-dashboard:local-arm64 xl1-dashboard:local
info "tagged xl1:local and xl1-dashboard:local"

# Also tag the producer by its own version, so `xl1ctl versions` has something
# to show on a fresh install and the first update has a named image to fall back
# to. The label is stamped at build time; older bundles have none, and this
# quietly does nothing rather than starting a container to find out.
PROVISIONED_VERSION="$(docker image inspect \
  -f '{{index .Config.Labels "org.xyo.xl1-cli.version"}}' xl1:local 2>/dev/null || true)"
if [[ -n "${PROVISIONED_VERSION}" && "${PROVISIONED_VERSION}" != "<no value>" ]]; then
  docker tag xl1:local "xl1:${PROVISIONED_VERSION}"
  info "tagged xl1:${PROVISIONED_VERSION} (rollback point)"
fi

# Same reasoning as xl1ctl: a local overlay at /etc/xl1/ui holds patches applied
# on top of the shipped image, and the retag above just discarded them.
if [[ -f /etc/xl1/ui/Dockerfile ]]; then
  if docker build -q -t xl1-dashboard:local /etc/xl1/ui >/dev/null 2>&1; then
    info "re-applied the local dashboard overlay from /etc/xl1/ui"
  else
    warn "local dashboard overlay at /etc/xl1/ui failed to build — running the stock image"
  fi
fi

# ---------------------------------------------------------------- 8. services

log "systemd units"
install -m 644 "${BUNDLE_DIR}"/systemd/xl1-*.service "${BUNDLE_DIR}"/systemd/xl1-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable xl1-collect.timer >/dev/null
systemctl enable xl1-dashboard.service >/dev/null
info "enabled xl1-collect.timer and xl1-dashboard.service"

# The alerter stays disabled until a channel is configured. Enabling it with an
# empty alert.env would run a timer every 60s that can only ever log that it had
# nowhere to deliver.
if grep -qE '^XL1_ALERT_(NTFY_TOPIC|WEBHOOK|EMAIL)=.+$' "${CONF_DIR}/alert.env" 2>/dev/null; then
  systemctl enable xl1-alert.timer >/dev/null
  systemctl start xl1-alert.timer
  info "alert channel configured — enabled xl1-alert.timer"
else
  info "xl1-alert.timer installed but NOT enabled (no channel in ${CONF_DIR}/alert.env)"
fi

# The producer stays disabled until the operator supplies a mnemonic — starting
# it with the placeholder env would only produce an authentication failure loop.
if has_mnemonic "${CONF_DIR}/sequence-producer.env"; then
  systemctl enable xl1-producer.service >/dev/null
  info "credentials present — enabled xl1-producer.service"
  PRODUCER_READY=1
else
  info "xl1-producer.service installed but NOT enabled (no mnemonic configured yet)"
fi

systemctl start xl1-collect.timer
systemctl restart xl1-dashboard.service || warn "dashboard did not start; check: journalctl -u xl1-dashboard -n 50"

# ------------------------------------------------------------------- 9. report

IP="$(hostname -I | awk '{print $1}')"
log "Provisioning complete"
cat <<EOF

    Dashboard   http://${IP}:${DASH_PORT}
                http://$(hostname).local:${DASH_PORT}
    JSON API    http://${IP}:${DASH_PORT}/api/status

    Operate it with 'xl1ctl':

      xl1ctl status         what is running, chain position, balances
      xl1ctl addr           which address the node actually signs as
      xl1ctl logs -f        follow the producer log
      xl1ctl doctor         diagnose a producer that is not working
      xl1ctl backup         encrypted backup of /etc/xl1
      xl1ctl --help         everything else

EOF

if [[ -z "${PRODUCER_READY:-}" ]]; then
  cat <<EOF
    NEXT — the producer is not running yet. Add your credentials:

      sudo nano ${CONF_DIR}/sequence-producer.env      # XL1_MNEMONIC + XL1_REWARD_ADDRESS
      sudo systemctl enable --now xl1-producer
      sudo journalctl -u xl1-producer -f

EOF
fi

if [[ -n "${NEEDS_TAILSCALE_LOGIN:-}" ]]; then
  cat <<EOF
    NEXT — connect the tailnet so you can reach the dashboard off-network:

      sudo tailscale up

EOF
fi

if [[ -n "${REBOOT_WANTED:-}" ]]; then
  cat <<EOF
    A reboot is needed for the config.txt changes (GPU memory split,
    thermal soft limit) to take effect:

      sudo reboot

EOF
fi
