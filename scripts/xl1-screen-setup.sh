#!/usr/bin/env bash
# Bring up a 3.5" SPI panel on Raspberry Pi OS Bookworm (64-bit) and put the
# XL1 console dashboard on it.
#
# Why this exists instead of goodtft's LCD-show:
#
#   * LCD-show writes /boot/config.txt. Bookworm reads /boot/firmware/config.txt,
#     so those writes land nowhere and the panel silently never appears.
#   * It overwrites config.txt wholesale from a Debian-11-era template, which
#     discards gpu_mem, the Imager's settings, and anything else already there.
#     This script only appends a marked block, and removes exactly that block on
#     revert.
#   * It installs xserver-xorg-input-evdev and writes xorg.conf.d. There is no X
#     server on RPi OS Lite, and fbturbo was dropped from Bookworm entirely.
#   * It copies /etc/inittab, which systemd has ignored since Debian 8.
#   * It reboots without asking.
#
# The one genuinely useful thing in that tarball is the compiled overlay blobs
# for panels the stock firmware does not ship. This reuses those and nothing else.
#
#   sudo ./xl1-screen-setup.sh --panel mhs35 --lcd-show ~/LCD-show
#   sudo ./xl1-screen-setup.sh --panel tft35a            # stock overlay, no tarball needed
#   sudo ./xl1-screen-setup.sh --revert
#
# Panels: tft35a (stock) · mhs35 · mhs35b · mhs35ips · mis35 · piscreen (stock)

set -Eeuo pipefail

PANEL=""
ROTATE=90
LCD_SHOW=""
REVERT=0
FONT="${FONT:-Terminus:size=8x16}"
MARK_BEGIN="# >>> XL1 screen (managed) >>>"
MARK_END="# <<< XL1 screen (managed) <<<"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'
log()  { printf '\n%s==>%s %s%s%s\n' "${BLUE}${BOLD}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s    warning: %s%s\n' "${YELLOW}" "$*" "${RESET}"; }
die()  { printf '\n%serror:%s %s\n' "${RED}" "${RESET}" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel)    PANEL="$2"; shift 2 ;;
    --rotate)   ROTATE="$2"; shift 2 ;;
    --lcd-show) LCD_SHOW="$2"; shift 2 ;;
    --revert)   REVERT=1; shift ;;
    -h|--help)  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || die "run with sudo"

# Bookworm moved the firmware partition. Support both so this also works if
# someone runs it on an older image.
BOOT=/boot/firmware
[[ -d "${BOOT}" ]] || BOOT=/boot
CONFIG="${BOOT}/config.txt"
CMDLINE="${BOOT}/cmdline.txt"
OVERLAYS="${BOOT}/overlays"
[[ -f "${CONFIG}" ]] || die "${CONFIG} not found — is this a Raspberry Pi OS install?"
info "firmware partition: ${BOOT}"

# ------------------------------------------------------------------- revert

strip_block() {  # strip_block <file>
  [[ -f "$1" ]] || return 0
  sed -i "/^${MARK_BEGIN}$/,/^${MARK_END}$/d" "$1"
}

if (( REVERT )); then
  log "Reverting screen configuration"
  strip_block "${CONFIG}"
  info "removed the managed block from ${CONFIG}"
  # Put KMS back, or reverting would leave the display stack half-dismantled.
  if grep -q 'disabled by xl1-screen-setup' "${CONFIG}"; then
    sed -i 's/^#\(\s*dtoverlay=vc4-kms-v3d[^#]*\)\s*# disabled by xl1-screen-setup.*$/\1/; s/[[:space:]]*$//' "${CONFIG}"
    info "restored vc4-kms-v3d"
  fi
  sed -i 's/ *fbcon=map:[0-9]*//g; s/ *fbcon=font:[A-Za-z0-9]*//g' "${CMDLINE}"
  info "removed fbcon options from ${CMDLINE}"
  systemctl disable --now xl1-screen.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/xl1-screen.service
  systemctl daemon-reload
  info "removed xl1-screen.service"
  printf '\n%s✓%s reverted. Reboot to return the console to HDMI.\n\n' "${GREEN}" "${RESET}"
  exit 0
fi

[[ -n "${PANEL}" ]] || die "--panel is required. One of: tft35a mhs35 mhs35b mhs35ips mis35 piscreen"

# ------------------------------------------------------------------ overlay

log "Overlay for '${PANEL}'"

if [[ -f "${OVERLAYS}/${PANEL}.dtbo" ]]; then
  info "already present in ${OVERLAYS} (stock firmware overlay)"
else
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SRC=""
  # Bundled blobs first; fall back to an extracted vendor tarball.
  for cand in \
      "${HERE}/overlays/${PANEL}.dtbo" \
      ${LCD_SHOW:+"${LCD_SHOW}/usr/${PANEL}-overlay.dtb"} \
      ${LCD_SHOW:+"${LCD_SHOW}/usr/${PANEL}.dtb"}; do
    [[ -f "${cand}" ]] && { SRC="${cand}"; break; }
  done
  [[ -n "${SRC}" ]] || die "no overlay blob for '${PANEL}'.
    Looked in ${HERE}/overlays/ ${LCD_SHOW:+and ${LCD_SHOW}/usr/}
    Available here: $(ls "${HERE}/overlays/"*.dtbo 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/.dtbo//' | tr '\n' ' ')
    Or point at an extracted vendor tarball:  --lcd-show ~/LCD-show"
  install -m 644 "${SRC}" "${OVERLAYS}/${PANEL}.dtbo"
  info "installed ${SRC} → ${OVERLAYS}/${PANEL}.dtbo"
fi

# ------------------------------------------------------------------- config

log "Firmware configuration"

cp -a "${CONFIG}" "${CONFIG}.xl1-backup.$(date +%Y%m%d-%H%M%S)"
info "backed up ${CONFIG}"

strip_block "${CONFIG}"

# fbtft is a legacy fbdev driver; the full KMS stack takes over the display and
# the console will not follow onto the SPI panel while it is loaded. A headless
# producer has no use for 3D, so stand it down.
if grep -qE '^\s*dtoverlay=vc4-kms-v3d' "${CONFIG}"; then
  sed -i 's/^\(\s*dtoverlay=vc4-kms-v3d.*\)$/#\1  # disabled by xl1-screen-setup (conflicts with fbtft SPI panels)/' "${CONFIG}"
  info "commented out vc4-kms-v3d"
fi

cat >> "${CONFIG}" <<EOF
${MARK_BEGIN}
# 3.5" SPI panel, ${PANEL}, rotated ${ROTATE}°.
# Remove with: sudo xl1-screen-setup.sh --revert
dtparam=spi=on
dtoverlay=${PANEL}:rotate=${ROTATE}
${MARK_END}
EOF
info "appended managed block (spi=on, dtoverlay=${PANEL}:rotate=${ROTATE})"

# ------------------------------------------------------------------ console

log "Console on the panel"

cp -a "${CMDLINE}" "${CMDLINE}.xl1-backup.$(date +%Y%m%d-%H%M%S)"
# cmdline.txt must stay exactly one line.
sed -i 's/ *fbcon=map:[0-9]*//g' "${CMDLINE}"
sed -i "1s|\$| fbcon=map:10|" "${CMDLINE}"
tr -d '\n' < "${CMDLINE}" > "${CMDLINE}.tmp" && printf '\n' >> "${CMDLINE}.tmp" && mv "${CMDLINE}.tmp" "${CMDLINE}"
info "set fbcon=map:10 (console follows onto the SPI framebuffer)"

# 480x320 with an 8x16 font gives 60x20 cells, which is what the dashboard
# layout is built against.
if [[ -f /etc/default/console-setup ]]; then
  sed -i 's/^FONTFACE=.*/FONTFACE="Terminus"/; s/^FONTSIZE=.*/FONTSIZE="8x16"/' /etc/default/console-setup
  grep -q '^FONTFACE=' /etc/default/console-setup || echo 'FONTFACE="Terminus"' >> /etc/default/console-setup
  grep -q '^FONTSIZE=' /etc/default/console-setup || echo 'FONTSIZE="8x16"' >> /etc/default/console-setup
  command -v setupcon >/dev/null 2>&1 && setupcon --force >/dev/null 2>&1 || true
  info "console font set to Terminus 8x16 (60x20 on a 480x320 panel)"
fi

# ------------------------------------------------------------------ service

log "Dashboard service"

install -o root -g root -m 755 "$(dirname "${BASH_SOURCE[0]}")/xl1-screen" /usr/local/bin/xl1-screen 2>/dev/null \
  || info "xl1-screen already installed"

cat > /etc/systemd/system/xl1-screen.service <<'EOF'
[Unit]
Description=XL1 console dashboard on the attached display
After=xl1-dashboard.service getty@tty1.service
Wants=xl1-dashboard.service
# Take over tty1 from the login prompt.
Conflicts=getty@tty1.service

[Service]
Type=simple
ExecStart=/usr/local/bin/xl1-screen
Restart=always
RestartSec=5

StandardInput=tty
StandardOutput=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=no
Environment=TERM=linux

Nice=10
MemoryMax=64M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl disable --now getty@tty1.service >/dev/null 2>&1 || true
systemctl enable xl1-screen.service >/dev/null
info "xl1-screen.service enabled on tty1"

# ------------------------------------------------------------------- report

cat <<EOF

$(printf '%s==>%s %sReboot required%s' "${BLUE}${BOLD}" "${RESET}" "${BOLD}" "${RESET}")

    The overlay only loads at boot:

      sudo reboot

    After it comes back the panel should show the dashboard. If it stays dark:

      ls /dev/fb*                      expect fb0 and fb1
      dmesg | grep -i -E 'fbtft|${PANEL}'
      sudo systemctl status xl1-screen

    Wrong way up?   sudo ./xl1-screen-setup.sh --panel ${PANEL} --rotate 270 ...
    Wrong panel?    try tft35a, mhs35, mhs35b, mhs35ips, mis35
    Undo all of it? sudo ./xl1-screen-setup.sh --revert

    Note: tty1 now shows the dashboard instead of a login prompt. SSH is
    unaffected, and --revert gives the login prompt back.

EOF
