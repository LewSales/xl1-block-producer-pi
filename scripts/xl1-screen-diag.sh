#!/usr/bin/env bash
# Why the panel is still white. Read-only — changes nothing.
#
# A white 3.5" SPI panel means the backlight is on and the controller was never
# spoken to. That has four causes, and they are indistinguishable by looking at
# the panel: the overlay never applied, it applied but bound no driver, the
# driver bound but nothing draws to it, or the controller is not the one the
# overlay drives. Each section below separates one of those from the rest.
#
#   sudo ./xl1-screen-diag.sh
B=/boot/firmware; [ -d $B ] || B=/boot
echo "===== 1. what the managed block asked for ====="
sed -n '/>>> XL1 screen/,/<<< XL1 screen/p' $B/config.txt
echo "===== 2. is KMS actually out of the way? ====="
grep -nE '^\s*#?\s*dtoverlay=vc4|^\s*display_auto_detect' $B/config.txt
echo "===== 3. cmdline (want fbcon=map:10) ====="
tr ' ' '\n' < $B/cmdline.txt | grep -E 'fbcon|video' || echo "  no fbcon/video options"
echo "===== 4. did the SPI bus come up? ====="
ls -l /dev/spidev* 2>&1
echo "===== 5. did the device tree get the panel node? ====="
ls /proc/device-tree/soc/spi@7e204000/ 2>&1 | head
echo "--- spidev/panel children ---"
for d in /proc/device-tree/soc/spi@7e204000/*/; do
  [ -e "$d/compatible" ] && printf '  %-28s %s\n' "$(basename $d)" "$(tr '\0' ' ' < $d/compatible)"
done 2>/dev/null
echo "===== 6. framebuffers ====="
ls -l /dev/fb* 2>&1
echo "===== 7. did any driver bind or complain? ====="
sudo dmesg | grep -iE 'fbtft|fb_ili|fb_st|ili9|st77|mhs|spi0|graphics|fb[01]' | tail -25
echo "===== 8. modules loaded ====="
lsmod | grep -iE 'fbtft|fb_|spi|panel' || echo "  none"
echo "===== 9. overlay blob present and sane? ====="
ls -l $B/overlays/mhs35b.dtbo $B/overlays/mhs35.dtbo $B/overlays/tft35a.dtbo 2>&1
echo "--- what the blob says it drives ---"
strings $B/overlays/mhs35b.dtbo 2>/dev/null | grep -iE 'ilitek|ili9|sitronix|st77|compatible|fb_' | sort -u | head
echo "===== 10. console service ====="
systemctl is-enabled xl1-screen 2>&1; systemctl is-active xl1-screen 2>&1
