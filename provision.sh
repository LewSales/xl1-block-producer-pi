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

mkdir -p "${STATE_DIR}/data" "${CONF_DIR}"
chmod 755 "${STATE_DIR}"
# The producer runs as uid 1000 (`node`) inside the image and owns /data.
chown -R 1000:1000 "${STATE_DIR}/data"

install_config() {
  local src="$1" dest="$2" mode="$3"
  if [[ -f "${dest}" ]]; then
    info "$(basename "${dest}") already exists — left untouched"
  else
    install -m "${mode}" "${src}" "${dest}"
    info "installed $(basename "${dest}") (mode ${mode})"
  fi
}

# A real env file shipped alongside this script wins over the blank template, so
# an operator who already has working credentials does not retype them.
PRODUCER_SRC="${BUNDLE_DIR}/sequence-producer.env"
[[ -f "${PRODUCER_SRC}" ]] || PRODUCER_SRC="${BUNDLE_DIR}/sequence-producer.env.template"
DASHBOARD_SRC="${BUNDLE_DIR}/dashboard.env"
[[ -f "${DASHBOARD_SRC}" ]] || DASHBOARD_SRC="${BUNDLE_DIR}/dashboard.env.template"

install_config "${PRODUCER_SRC}"  "${CONF_DIR}/sequence-producer.env" 600
install_config "${DASHBOARD_SRC}" "${CONF_DIR}/dashboard.env"         644

# If the credentials arrived on the boot partition, that partition is FAT and
# readable by anyone who puts the card in a reader. Remove the staged copy once
# it is safely at /etc/xl1 with mode 0600.
if [[ "${PRODUCER_SRC}" == "${BUNDLE_DIR}/sequence-producer.env" ]] \
   && grep -qE '^XL1_MNEMONIC=.+$' "${CONF_DIR}/sequence-producer.env"; then
  shred -u "${PRODUCER_SRC}" 2>/dev/null || rm -f "${PRODUCER_SRC}"
  warn "removed the staged copy of sequence-producer.env from the bundle directory.
    Note that shred cannot reliably erase FAT/SD storage — if that bundle sat on
    the boot partition, treat the seed as having been exposed to anyone with
    physical access to the card."
fi

install -m 755 "${BUNDLE_DIR}/scripts/xl1-collect.sh" /usr/local/bin/xl1-collect.sh
info "installed /usr/local/bin/xl1-collect.sh"

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

# ---------------------------------------------------------------- 8. services

log "systemd units"
install -m 644 "${BUNDLE_DIR}"/systemd/xl1-*.service "${BUNDLE_DIR}"/systemd/xl1-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable xl1-collect.timer >/dev/null
systemctl enable xl1-dashboard.service >/dev/null
info "enabled xl1-collect.timer and xl1-dashboard.service"

# The producer stays disabled until the operator supplies a mnemonic — starting
# it with the placeholder env would only produce an authentication failure loop.
if grep -qE '^XL1_MNEMONIC=.+$' "${CONF_DIR}/sequence-producer.env" 2>/dev/null; then
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
    A reboot is needed for the GPU memory split to take effect:

      sudo reboot

EOF
fi
