# Panel overlays

Compiled device-tree overlays for 3.5" SPI panels, taken from
[goodtft/LCD-show](https://github.com/goodtft/LCD-show) (GPL-2.0) and renamed to
the `.dtbo` extension the firmware looks for.

Only the blobs are reused. None of LCD-show's install scripts are — they write
`/boot/config.txt` (Bookworm reads `/boot/firmware/config.txt`), install X11
packages onto an OS with no X server, and overwrite `config.txt` wholesale.
`scripts/xl1-screen-setup.sh` does the Bookworm-correct equivalent instead.

`tft35a` and `piscreen` also ship with Raspberry Pi OS itself; the `mhs*` and
`mis35` ones do not, which is why they are vendored here.

Not sure which panel you have? Try `tft35a` first — it drives most ILI9486
3.5" boards. If the screen stays dark or shows noise, work through `mhs35`,
`mhs35b`, `mhs35ips`, `mis35`.
