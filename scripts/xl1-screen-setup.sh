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
#   sudo ./xl1-screen-setup.sh --probe                   # which panel is this?
#
# Panels: tft35a (stock) · mhs35 · mhs35b · mhs35ips · mis35 · piscreen (stock)

set -Eeuo pipefail

PANEL=""
ROTATE=90
LCD_SHOW=""
REVERT=0
PROBE=0
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
    --probe)    PROBE=1; shift ;;
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
  # Setup disabled getty@tty1 to take the console. Reverting without putting it
  # back leaves tty1 with neither a dashboard nor a login prompt — while the
  # closing message promises the login prompt is restored.
  if systemctl enable --now getty@tty1.service >/dev/null 2>&1; then
    info "re-enabled getty@tty1 (login prompt restored)"
  else
    warn "could not re-enable getty@tty1 — run: sudo systemctl enable --now getty@tty1"
  fi
  printf '\n%s✓%s reverted. Reboot to return the console to HDMI.\n\n' "${GREEN}" "${RESET}"
  exit 0
fi

# --------------------------------------------------------------------- probe
#
# Every 3.5" SPI panel in this class looks identical from the outside and shows
# the same white screen when driven by the wrong controller. The silkscreen is
# the usual way to tell them apart, and it is often unreadable, missing, or
# under a heatsink.
#
# So ask the panel instead. Overlays can be loaded at runtime, which means each
# candidate can be tried, drawn on, and unloaded in about ten seconds — rather
# than an edit-reboot-squint cycle per guess.
#
# Nothing here is written to config.txt. A probe leaves the system exactly as it
# found it; making a choice permanent is a separate, deliberate run.
if (( PROBE )); then
  log "Probing for the panel"

  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # Bundled blobs first, then every stock overlay the firmware ships for a small
  # SPI TFT. The stock ones matter more than they look: they are guaranteed to
  # apply against the running firmware, and they differ from each other mainly
  # in which GPIOs carry DC and RESET — which is what a white screen is actually
  # complaining about. A controller held on the wrong reset line never
  # initialises and stays white, whatever driver claims to have bound to it.
  # Stock overlays first, and it is not a tie-break.
  #
  # On a Trixie image the bundled vendor blobs — tft35a, mhs35, mhs35ips, mis35 —
  # are rejected by the kernel outright: "Failed to apply overlay". They cannot
  # light any panel, so leading with them means the first candidates tried are
  # the ones that never had a chance, and whichever vendor blob happens to load
  # looks like a winner by default. That is how a real ILI9486 board driven fine
  # by the stock `piscreen` overlay was mistaken for mhs35b.
  CANDIDATES=(piscreen piscreen2r pitft35-resistive rpi-display
              waveshare35a waveshare35b tft9341
              mhs35b tft35a mhs35 mhs35ips mis35)

  LOADED=""
  cleanup_probe() {
    [[ -n "${LOADED}" ]] && dtoverlay -r "${LOADED}" 2>/dev/null || true
    LOADED=""
  }
  trap 'cleanup_probe' EXIT INT TERM

  command -v dtoverlay >/dev/null || die "dtoverlay not found (install libraspberrypi-bin)"

  # A panel overlay applied at boot owns spi0.0 for the life of this boot, and
  # every runtime candidate then collides with it — reporting a kernel failure
  # per candidate, which reads as twelve dead panels rather than one occupied
  # bus. Editing config.txt does not release it; only a reboot does.
  OCCUPANT=""
  for namefile in /sys/class/graphics/fb*/name; do
    [[ -r "${namefile}" ]] || continue
    case "$(cat "${namefile}" 2>/dev/null)" in
      fb_*|*ili9*|*st77*|*hx8*) OCCUPANT="$(cat "${namefile}")" ;;
    esac
  done
  [[ -e /sys/bus/spi/devices/spi0.0/driver ]] && \
    OCCUPANT="${OCCUPANT:-$(basename "$(readlink -f /sys/bus/spi/devices/spi0.0/driver)")}"

  if [[ -n "${OCCUPANT}" ]]; then
    die "a panel driver (${OCCUPANT}) is already bound to spi0.0 from boot.

    Every candidate below would collide with it and report a kernel failure,
    which looks like twelve dead panels instead of one occupied bus.

    Clear it first, then probe from a clean tree:

      sudo ${BASH_SOURCE[0]} --revert
      sudo reboot
      sudo ${BASH_SOURCE[0]} --probe"
  fi

  # The bus first: without it every overlay below binds to nothing and the
  # probe reports six identical failures for one root cause.
  if [[ ! -e /dev/spidev0.0 ]]; then
    info "enabling SPI for this boot"
    dtparam spi=on 2>/dev/null || warn "dtparam spi=on failed; SPI may already be configured differently"
    sleep 1
  fi
  [[ -e /dev/spidev0.0 ]] && info "SPI bus present: /dev/spidev0.0" \
                          || warn "no /dev/spidev0.0 — probes are unlikely to bind"

  # Stage every bundled blob so the loop is not interrupted by a missing file.
  for cand in "${CANDIDATES[@]}"; do
    [[ -f "${OVERLAYS}/${cand}.dtbo" ]] && continue
    [[ -f "${HERE}/overlays/${cand}.dtbo" ]] || continue
    install -m 644 "${HERE}/overlays/${cand}.dtbo" "${OVERLAYS}/${cand}.dtbo"
    info "staged ${cand}.dtbo"
  done

  printf '\n    %sWatch the panel.%s Each candidate gets three seconds of moving\n' "${BOLD}" "${RESET}"
  printf '    static. Static of any kind means that controller is correct —\n'
  printf '    a wrong one stays blank white.\n'

  FOUND=""
  for cand in "${CANDIDATES[@]}"; do
    [[ -f "${OVERLAYS}/${cand}.dtbo" ]] || { info "${cand}: no overlay blob, skipped"; continue; }

    BEFORE="$(ls /dev/fb* 2>/dev/null | tr '\n' ' ' || true)"
    # An overlay that will not apply is a different fault from one that applies
    # and lights nothing, so keep the reason rather than flattening both into
    # "would not load" — four of five reading identically hid that the probe was
    # really only testing one candidate.
    if ! ERR="$(dtoverlay "${cand}" rotate="${ROTATE}" 2>&1)"; then
      printf '    %-18s %sdid not apply%s %s\n' "${cand}" "${DIM}" "${RESET}" \
        "${DIM}$(printf '%s' "${ERR}" | tr '\n' ' ' | cut -c1-60)${RESET}"
      continue
    fi
    LOADED="${cand}"
    sleep 2
    AFTER="$(ls /dev/fb* 2>/dev/null | tr '\n' ' ' || true)"

    NEWFB=""
    for fb in ${AFTER}; do [[ " ${BEFORE} " == *" ${fb} "* ]] || NEWFB="${fb}"; done

    if [[ -z "${NEWFB}" ]]; then
      # Bound to nothing. Almost always the wrong controller for this hardware.
      printf '    %-18s %sapplied, but bound no framebuffer%s\n' "${cand}" "${DIM}" "${RESET}"
      cleanup_probe
      continue
    fi

    GEOM="$(cat "/sys/class/graphics/$(basename "${NEWFB}")/virtual_size" 2>/dev/null || echo '?')"
    printf '    %-18s → %s %s(%s)%s  ' "${cand}" "${NEWFB}" "${DIM}" "${GEOM}" "${RESET}"
    # Noise rather than a solid fill: a panel showing white on its own is the
    # symptom being diagnosed, so the test pattern must be unmistakably not that.
    timeout 3 dd if=/dev/urandom of="${NEWFB}" bs=64k >/dev/null 2>&1 || true

    read -r -p "did the panel show static? [y/N] " ANS </dev/tty
    cleanup_probe
    if [[ "${ANS}" =~ ^[Yy] ]]; then FOUND="${cand}"; break; fi
  done

  trap - EXIT INT TERM
  cleanup_probe

  if [[ -n "${FOUND}" ]]; then
    printf '\n%s✓%s This panel is %s%s%s. Make it permanent with:\n\n' \
      "${GREEN}" "${RESET}" "${BOLD}" "${FOUND}" "${RESET}"
    printf '      sudo %s --panel %s --rotate %s\n\n' "${BASH_SOURCE[0]}" "${FOUND}" "${ROTATE}"
  else
    printf '\n%s✗%s No candidate lit the panel.\n\n' "${YELLOW}" "${RESET}"
    printf '    Check in this order — each is more common than a rare controller:\n'
    printf '      1. The panel is seated on pins 1-26, not shifted down the header\n'
    printf '      2. /dev/spidev0.0 exists (it %s)\n' "$([[ -e /dev/spidev0.0 ]] && echo does || echo does NOT)"
    printf '      3. The silkscreen name — an MPI3508 is an HDMI panel and will\n'
    printf '         never respond to any of these\n\n'
  fi
  exit 0
fi

[[ -n "${PANEL}" ]] || die "--panel is required. One of: tft35a mhs35 mhs35b mhs35ips mis35 piscreen
    Not sure which? Run:  sudo ${BASH_SOURCE[0]} --probe"

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
# `disable` without `--now`: a reboot is required for the overlay anyway, and
# `--now` sends SIGTERM to whatever owns tty1 — which may be the very session
# running this script, killing it before the service below is enabled and
# leaving the Pi with no console and no dashboard.
systemctl disable getty@tty1.service >/dev/null 2>&1 || true
systemctl enable xl1-screen.service >/dev/null
info "xl1-screen.service enabled on tty1"

# Touch is optional and silent when the panel has none: xl1-touch is installed
# but not enabled, the page file never appears, and xl1-screen stays on the
# overview exactly as it did before any of this existed.
BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${BUNDLE}/scripts/xl1-touch" ]]; then
  install -m 755 "${BUNDLE}/scripts/xl1-touch" /usr/local/bin/xl1-touch
  install -m 644 "${BUNDLE}/systemd/xl1-touch.service" /etc/systemd/system/xl1-touch.service
  systemctl daemon-reload
  if grep -qi touch /proc/bus/input/devices 2>/dev/null; then
    if systemctl enable --now xl1-touch.service >/dev/null 2>&1; then
      info "touchscreen found — xl1-touch enabled (tap: next page, hold: home)"
    else
      warn "xl1-touch could not start; check: journalctl -u xl1-touch"
    fi
  else
    info "no touchscreen detected — xl1-touch installed but not enabled"
  fi
fi

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
