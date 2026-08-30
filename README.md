# XL1 Block Producer — Raspberry Pi 3 B+

> **An independent community project by LewSales.** Not affiliated with,
> endorsed by, or supported by XYO Network. It runs the official
> [`xl1-docker-images`](https://github.com/XYOracleNetwork/xl1-docker-images)
> producer unmodified; everything around it — the dashboard, alerting, preflight
> and operator tooling — is mine. Bugs here are mine too: open an issue on this
> repo, not with XYO.

A provisioning bundle for running an XL1 federated block producer on the Sequence
(beta) network, with a local status dashboard.

Derived from Jim's `XYO_Block_Producer_RPi4.doc`, retargeted from a Pi 4 to a
Pi 3 B+. See [What changed from Jim's runbook](#what-changed-from-jims-runbook)
for the differences and why each one exists.

---

## What's in here

| Path | Purpose |
|---|---|
| `preflight.sh` | Read-only readiness check. **Run this first** — it catches a 32-bit OS before you spend 40 minutes. |
| `provision.sh` | One-shot, idempotent setup. Run once with `sudo`. |
| `scripts/xl1ctl` | Day-to-day control: status, start/stop, logs, backup, doctor. |
| `scripts/xl1-screen` | Console dashboard for a directly attached display. |
| `scripts/xl1-screen-setup.sh` | Brings up a 3.5" SPI panel on Bookworm and puts the dashboard on it. |
| `overlays/` | Device-tree blobs for panels the stock firmware does not ship. |
| `windows/` | Double-clickable `.cmd` launchers that drive the Pi over SSH. |
| `xl1-local-arm64.tar.gz` | The producer image, cross-built for arm64. |
| `xl1-dashboard-arm64.tar.gz` | The dashboard image, cross-built for arm64. |
| `sequence-producer.env.template` | Producer secrets → `/etc/xl1/sequence-producer.env` (mode 0600). |
| `dashboard.env.template` | Dashboard config → `/etc/xl1/dashboard.env`. |
| `systemd/` | Producer, dashboard, and collector units. |
| `scripts/xl1-collect.sh` | Host-side collector feeding the dashboard. |
| `scripts/xl1-alert.sh` | Watches the dashboard's own status and notifies on changes. |
| `alert.env.template` | Alert channels → `/etc/xl1/alert.env` (mode 0600). |
| `build-images.sh` | Cross-builds both arm64 images on a workstation. Emits `SHA256SUMS`. |
| `tests/` | The full check suite. `./tests/run.sh` runs everything CI runs. |
| `dashboard/` | Dashboard source, for rebuilding after edits. |

Both images are **prebuilt**. The Pi never compiles anything.

---

## Step 0 — Write the OS to the SD card

This wipes the card. The 58 GB card currently holds a Raspbian Stretch install
from November 2018; all of it goes, including the ext4 root filesystem Windows
does not show you.

Use **Raspberry Pi Imager** on Windows:

1. Choose device: **Raspberry Pi 3**
2. Choose OS: **Raspberry Pi OS Lite (64-bit)** — Bookworm
   *64-bit is required.* `provision.sh` refuses to run on a 32-bit OS, because
   the images in this bundle are arm64. Lite (no desktop) matters on 1 GB of RAM.
3. Choose storage: the **58 GB USB card reader** — verify the size before writing
4. Click the gear / **Edit Settings** and set:
   - hostname — e.g. `xl1pi`
   - username and password
   - **Enable SSH** (password or key)
   - Wi-Fi credentials, if not using Ethernet

Ethernet is worth preferring on a 3 B+: its NIC shares the USB 2.0 bus, and
Wi-Fi on this model is noticeably less stable under sustained load.

## Step 1 — Copy this bundle onto the card

After Imager finishes, the card remounts as a `bootfs` volume (drive `D:` again).
Copy the whole `xl1-pi` folder to the root of it, then eject.

If the bundle does not fit on the boot partition, boot the Pi first and copy it
over the network instead:

```bash
scp -r xl1-pi <user>@xl1pi.local:~/
```

## Step 2 — Boot and provision

```bash
ssh <user>@xl1pi.local

# if you copied to the boot partition:
sudo cp -r /boot/firmware/xl1-pi ~/ && cd ~/xl1-pi
# otherwise:
cd ~/xl1-pi

./preflight.sh        # read-only; ~30s. Fix anything it marks FAIL.
sudo ./provision.sh
```

`preflight.sh` changes nothing and exits non-zero if the Pi is not ready. It is
worth the thirty seconds: the most common way to lose an evening here is writing
the 32-bit OS image, and preflight says so immediately instead of letting
provisioning get most of the way through first.

Expect **20–40 minutes**, nearly all of it `apt` and the Docker install. The
script is idempotent — if it fails partway, fix the cause and run it again.

It will: size swap, cut the GPU split, install Docker + UFW + Tailscale, set the
firewall, load both images, install the units, and start the dashboard and
collector. The producer stays stopped until you give it credentials.

## Step 3 — Credentials

Copy your producer env over SSH after the Pi is up, rather than putting it on
the SD card:

```bash
# from your workstation, pointing at your working env file
scp sequence-producer.env <user>@xl1pi.local:~/

# on the Pi
sudo install -m 600 -o root -g root ~/sequence-producer.env /etc/xl1/sequence-producer.env
shred -u ~/sequence-producer.env

sudo systemctl enable --now xl1-producer
sudo journalctl -u xl1-producer -f
```

Then set `XL1_REWARD_ADDRESS` in `/etc/xl1/dashboard.env` to the same value, so
the balance panel works, and `sudo systemctl restart xl1-dashboard`.

A seed phrase written to the boot partition sits in cleartext on a FAT
filesystem that any machine can read from a card reader, and `shred` cannot
reliably erase it from SD storage afterwards. `provision.sh` *will* pick up a
`sequence-producer.env` placed next to it and install it with mode 0600 — that
path exists if you want it — but SSH is the better default for a key with a real
balance behind it.

### Signing address vs. reward address — check this before you wait on support

Your env file names one address. Your node signs with a different one, and the
two are easy to conflate:

| | Where it comes from | What it controls |
|---|---|---|
| **Signing address** | Derived from `XL1_MNEMONIC` at `accountPath 0` — the path `presets/roles/producer.json` pins for the producer actor. Never written down anywhere. | **Authorization.** This is the address that must be on the allowed-producer list. |
| **Reward address** | `XL1_REWARD_ADDRESS`, set explicitly by you. | Where block rewards are paid. Has no bearing on authorization. |

**A producer is authorized by the key it signs with, not by the address it names
for rewards.** If the signing address is not listed, the node runs healthy,
reports live, submits candidate blocks — and none of them are ever accepted.
`Published block: …` in the log means "candidate submitted", not "accepted".
That failure mode looks exactly like success from the logs alone.

The configuration you want is for `XL1_MNEMONIC` to derive, at `accountPath 0`,
the same address you put in `XL1_REWARD_ADDRESS` — an allowlisted one. Then the
node signs as the listed address and pays itself.

So confirm which address your mnemonic actually derives before concluding you
are blocked on an allowlist entry. If you keep several seeds, it is easy to have
the listed address in hand and the wrong seed in the env file; one of the others
may already be listed:

```bash
node -e "
const { generateXyoBaseWalletFromPhrase } = await import('@xyo-network/xl1-sdk/protocol-sdk')
const w = await generateXyoBaseWalletFromPhrase(process.env.XL1_MNEMONIC)
for (let i = 0; i < 8; i++) console.log(i, (await w.derivePath(String(i))).address.toLowerCase())
" --input-type=module
```

Whichever seed you sign with, `XL1_REWARD_ADDRESS` is independent — rewards land
in the wallet you name there either way.

The dashboard shows both balances side by side. A climbing **reward** balance is
the only real confirmation that blocks are being accepted.

### Worth checking in your env file

The upstream example carries a commented `XL1_EVM_RPC_URL` line. Two things to
watch there:

- If you filled it in with a provider URL, it probably has an **API key in it**.
  That key sits in a plaintext file in a project directory — easy to commit or
  share by accident. Prefer leaving the line commented and letting the preset
  default apply.
- The Sequence preset expects **Sepolia** (`0xaa36a7`). Pointing this at
  eth-mainnet is a mismatch, and it is an easy one to copy in from a Pi 4 setup
  or another project.

## Step 4 — Tailscale

```bash
sudo tailscale up
```

Follow the printed URL. The dashboard is then reachable at
`http://xl1pi:8088` from any device on your tailnet. UFW already allows the
dashboard port on `tailscale0` and on your LAN subnet, and nowhere else.

---

## The dashboard

`http://<pi>:8088` — auto-refreshes every 5 seconds.

| Panel | Shows |
|---|---|
| **Producer cannot produce** | Only when it applies: the node's own stated reason it is ineligible |
| **Producer** | `/livez`, container state, uptime, restarts, **blocks produced — counted from the chain, not from the log — share of chain blocks, last produced block linked to the explorer**, log errors, eligibility |
| **Chain** | Current block, finalized head, lag, chain ID vs. preset, height sparkline, block time and chain rate |
| **Rewards** | Reward and producer balances, both linked into the explorer, plus per-hour, per-day and share-of-chain tiles |
| **Software & host** | `xl1-cli` version vs. the published release, pending host updates, security updates, apt list age |
| **Raspberry Pi** | CPU temp sparkline, RAM, swap, disk, load, and **undervoltage / throttling flags** |
| **Trends** | Blocks and XL1 per day over a rolling 30 days — survives restarts |
| **Producer log** | Last 40 lines, **newest first** |

`GET /api/status` returns the same data as JSON. Set `DASH_TOKEN` in
`/etc/xl1/dashboard.env` to require `?token=…` or an `Authorization: Bearer`
header on both; `/healthz` stays open for the container probe.

Watch the **undervoltage** flag. A Pi 3 B+ on an underpowered supply throttles
silently, and it is the most common cause of a node that "randomly" falls
behind. Use a 5 V / 2.5 A supply.

### How it reads the chain

The dashboard talks to the chain through the XL1 SDK's `GatewayBuilder` and
`connection.viewer.*` — never raw JSON-RPC, which the XL1 guidance prohibits
because the method surface is not a stable contract.

One thing worth knowing if you edit it: **balance lookups take bare lowercase
hex and reject the `0x` form**, even though the upstream env examples write
reward addresses with `0x`. The dashboard strips the prefix for you.

---

## Alerting

Nothing here alerts until you configure a channel. `sudo nano /etc/xl1/alert.env`,
then `sudo systemctl enable --now xl1-alert.timer`.

```bash
sudo xl1-alert.sh --status    # what is wrong right now; sends nothing
sudo xl1-alert.sh --test      # prove the channel works
```

It reads the dashboard's own `/api/status` rather than re-deriving anything, so
the panel and your phone can never disagree. It fires on **transitions**, not on
conditions — an unresolved problem repeats once every six hours and is otherwise
silent — and reports recoveries as well as failures.

| Channel | Setting | Notes |
|---|---|---|
| Phone push | `XL1_ALERT_NTFY_TOPIC` | [ntfy](https://ntfy.sh) — no account. Use a long random topic; anyone who knows it can read your alerts. |
| Discord / Slack | `XL1_ALERT_WEBHOOK` | One payload satisfies both. |
| Email | `XL1_ALERT_EMAIL` | Needs `mail` or `sendmail` on the host. Stock Raspberry Pi OS has neither. |
| **Dead man** | `XL1_ALERT_DEADMAN_URL` | **The important one.** See below. |

### Why the dead man's switch is the one that matters

Every other channel reports problems the Pi is alive to observe. A Pi that loses
power, corrupts its SD card, or hangs sends nothing — and nothing is exactly
what a healthy Pi sends. The failure you most want to hear about is the one this
machine can never report about itself.

Point `XL1_ALERT_DEADMAN_URL` at a service that alarms when pings *stop*:
[healthchecks.io](https://healthchecks.io) (free, email/SMS/push) or a Push
monitor in a self-hosted Uptime Kuma. Set its period to a few minutes with about
ten minutes of grace. A node reporting DOWN pings `<url>/fail` instead, so a
definite failure alarms immediately rather than waiting out the grace period.

A run that could not read the status document deliberately sends **no** ping.

---

## When a healthy node produces nothing

This is the failure this bundle was built around, because every ordinary signal
reads green: the container runs, `/livez` passes, the chain is reachable, there
are no errors — and no block the node builds is ever accepted.

The node does say why, on stderr. The collector scans a 20-minute window of its
log for the protocol's own phrasing and the dashboard shows it, loudly, in its
own panel. A window rather than the whole history, because a complaint resolved
two days ago is not a current fault.

Whether a complaint *counts* depends on the network. Sequence is federated:
producers are authorized by an allowlist and staking is not how it decides who
may produce, so a stake complaint there is the node reciting a rule this network
does not enforce. Those are shown greyed and marked "not enforced on sequence",
kept off the problem list, and never alerted. Override per deployment with
`DASH_ELIGIBILITY_IGNORE` in `/etc/xl1/dashboard.env` — a comma-separated list
of keys (`insufficient-stake`, `no-intent`, `unseasoned`, `self-bond`,
`not-allowed`, `too-slow`, `no-balance`).

Two that are never ignored, because they are real on every network:

- **`not-allowed`** — the signing address is not on the allowlist. `xl1ctl addr`
  tells you which address that is.
- **`too-slow`** — blocks rejected as `behind-finalized-head`. The node is
  building slower than the chain finalizes, so each candidate is stale before it
  is submitted. On a Pi 3 B+ this is a hardware ceiling, not a setting.

---

## History that survives a restart

The sparklines are an in-memory ring: minutes of detail, gone when the container
restarts. The **Trends** panel is the other half — one sample every five minutes,
kept for thirty days in `/var/lib/xl1/dashboard/trend.jsonl`, bucketed into
blocks and XL1 **per day**.

Per day means the difference across each day, not the reading at the end of it:
both underlying figures are cumulative totals, and charting a total produces a
line that only ever goes up.

This needs the writable bind mount in `xl1-dashboard.service` and a
`/var/lib/xl1/dashboard` owned by uid 1000. `provision.sh` creates it. On an
install that predates it the panel says so rather than drawing an empty chart —
a flat line and a missing one look identical, and only one of them means
something is wrong.

Tunable in `dashboard.env`: `DASH_TREND_RETAIN_DAYS`, `DASH_TREND_EVERY_MS`,
`DASH_TREND_FILE`.

---

## Keeping it current

The **Software & host** panel watches two layers that rot quietly.

`xl1-cli` in the running container is compared against the published release
every six hours. The version is cached against the container's **image ID**, so
an upgrade shows immediately rather than at the end of a cache window.

Host packages are reported with the **age of the apt lists beside the count**.
`apt` answers against its last refresh, so a host unrefreshed for months reports
zero updates confidently and wrongly — which reads as good news and is the worst
answer the check can give. Past a week the age is escalated to a problem in its
own right.

To upgrade the CLI, rebuild the images on a workstation and reload:

```bash
XL1_CLI_VERSION=5.3.0 ./build-images.sh    # on an amd64 machine, not the Pi
```

Then either cut a release and `sudo xl1ctl update --release` on the Pi, or copy
the tarballs across and `sudo xl1ctl update /path/to/bundle`.

---

## Moving the producer to another machine

A Pi 3 B+ builds a block in roughly seventeen seconds against a one-second
budget. The chain finalizes past each candidate before it is submitted, which
the log reports as `behind-finalized-head`, and no setting changes it. If your
node is healthy, staked, allowlisted and still landing nothing, this is why.

**To a Pi 4 or 5** — no rebuild. The arm64 images already run there; copy the
bundle across and `sudo ./provision.sh`.

**To an x86 machine** — the images are arm64 only. `build-images.sh` hardcodes
`linux/arm64` and `provision.sh` refuses any other architecture, so both need
adjusting first. Worth it for a permanent home; overkill to test a hypothesis.

> **Never run two producers on one mnemonic.** Stop and disable the old unit
> *before* starting the new host:
>
> ```bash
> sudo systemctl disable --now xl1-producer     # on the old machine, first
> ```

Move the credentials with the tool rather than by hand, so the file modes and
ownership come across intact:

```bash
sudo xl1ctl backup ~/xl1-backup.tar.gz.enc     # old machine
# copy it across, then on the new one:
sudo xl1ctl restore ~/xl1-backup.tar.gz.enc
sudo xl1ctl addr                               # same signing address? then it worked
```

The old Pi still earns its keep as the monitoring host — it runs the dashboard
and alerter comfortably, and putting the watcher on a different machine from the
producer is what makes the dead man's switch meaningful.

---

## Operating notes

**Being allowlisted is separate from running.** A producer that is not on the
network's allowed-producer list still runs healthy and still submits candidate
blocks — they are simply never accepted. `Published block: …` in the log means
"candidate submitted", not "accepted". The dashboard's blocks-submitted counter
reads that same line, so treat it as submissions, not earnings. The reward
balance is the number that tells you whether blocks are actually landing.

**Producer economics.** At step 0 the block reward is 500 XL1 and the producer
share is 10%, so roughly 50 XL1 per accepted block. Continued authorization
requires a stake declaration.

**Port 30303** is opened and mapped to match Jim's runbook. The federated
producer preset submits over outbound JSON-RPC to the public gateway and binds
`BlockRunner` to memory, so it is not clear this port is used at all in this
role. It is harmless to leave open; close it if you want a tighter surface.

### Everyday commands

`xl1ctl` wraps the systemd and Docker incantations:

```bash
xl1ctl status        # running? what block? what balance?
xl1ctl logs -f       # follow the producer log
xl1ctl addr          # which address the node actually signs as
xl1ctl doctor        # diagnose a producer that is not working
xl1ctl dashboard     # print the dashboard URLs
sudo xl1ctl restart

sudo xl1ctl update --release     # fetch the latest release, verify it, reload
sudo xl1ctl backup               # encrypted copy of /etc/xl1
```

`update --release` downloads the image tarballs as root, checks them against the
release's `SHA256SUMS`, and refuses to load on a mismatch. Fetching them by hand
into a root-owned bundle directory fails with a permission error, after which a
plain `xl1ctl update` reloads the images already there and reports success —
which is how an upgrade can appear to land twice without changing anything.

`update`, `backup` and `restore` take paths and therefore still ask for a
password; the read-only and service-control verbs do not.

`xl1ctl addr` is the one to reach for when blocks are submitted but never
accepted. It derives the signing address out of the mnemonic and tells you
whether it matches the reward address — the thing nothing else in the running
system will show you.

### When the producer gives up entirely

`xl1-producer.service` caps restarts at five failures in 300 seconds. Past that
systemd stops trying **permanently** and the unit sits in `failed` — correct for
SD-card longevity, but it will not recover on its own and nothing says so:

```bash
sudo systemctl reset-failed xl1-producer
sudo systemctl start xl1-producer
```

### Backups

```bash
sudo xl1ctl backup                    # encrypted tarball of /etc/xl1
sudo xl1ctl restore FILE
```

The archive contains your seed phrase, encrypted with a passphrase you choose.
Lose the passphrase and the backup is unrecoverable. Copy it off the Pi — an SD
card is not a backup. `windows/Fetch backup to this PC.cmd` does both steps.

### Driving it from Windows

The launchers read `windows/_config.cmd`, which is created from
`_config.cmd.template` the first time you run one. It holds your Pi's address
and login, so it is deliberately **not** tracked — edit it freely and `git pull`
will not fight you for it.


`windows/` holds double-clickable launchers that SSH in and run one command
each — preflight, provision, start/stop, live logs, dashboard, backup. Edit
`windows/_config.cmd` if the Pi is not at `xl1pi.local`. Provisioning grants
your user passwordless `sudo` for `xl1ctl` alone, so the shortcuts work in one
click; see `windows/README.txt`.

---

## What changed from Jim's runbook

Jim's document targets a Pi 4 on Debian 12. Every deviation below is a
consequence of the 3 B+ having 1 GB of RAM and a slower CPU.

| Jim's step | Here | Why |
|---|---|---|
| `pnpm install` + `pnpm xy build` + `build-image.sh` **on the Pi** | Both images cross-built on your workstation, shipped as tarballs | The image build runs `npm install -g @xyo-network/xl1-cli`. On a 1 GB Pi 3 that is slow enough to become its own failure mode. Your laptop does it in ~80 s. |
| 4 GB swap, default swappiness | 4 GB swap, `vm.swappiness=10` | At the default 60, a 1 GB Pi pages hot objects onto the SD card — that both stalls the node and wears the card. Swap here is an OOM backstop, not working memory. |
| — | `gpu_mem=16` in `config.txt` | Returns ~48 MB to the system. Meaningful at 1 GB, irrelevant at 4–8 GB. |
| — | `--memory 768m` on the producer, `NODE_OPTIONS=--max-old-space-size=512` | Without an explicit heap ceiling a GC spike pushes the box into swap. |
| `docker run` by hand in a shell | systemd units | Survives reboots and power cuts, which is the normal failure mode for a Pi. |
| — | `time-sync.target` dependency | A Pi has no RTC. The producer signs against chain time, so starting before NTP settles produces confusing failures rather than obvious ones. |
| — | Docker log rotation (`max-size=10m`) | Unbounded logs fill the SD card and take the node down weeks later. |
| `ufw allow 30303` | Same, plus dashboard restricted to LAN + `tailscale0` | The box holds a producer mnemonic; nothing new is exposed to the open internet. |
| — | Dashboard + collector | The requested addition. |

The dashboard deliberately has **no access to the Docker socket**. A read-only
socket mount still grants full control of the daemon, which is not something to
hand a network-listening service on a box holding a wallet seed. Instead
`xl1-collect.sh` runs as root on a 30-second timer and writes a plain JSON file
that the dashboard reads read-only.

---

## A screen on the Pi

`xl1-screen` draws the dashboard straight to the console — no X, no browser.
It reads the same `/api/status` the web dashboard serves, so the two never
disagree. It costs roughly 10 MB; Chromium with an X server would cost 350–450 MB
on a 1 GB board that is also producing blocks, which is not a trade worth making.

On an HDMI monitor it needs no setup at all:

```bash
xl1-screen            # draws on whatever TTY you run it from
```

### 3.5" SPI panel

```bash
sudo ./scripts/xl1-screen-setup.sh --probe          # which panel is this?
sudo ./scripts/xl1-screen-setup.sh --panel tft35a
sudo reboot
```

**Start with `--probe` unless you know the board.** Every 3.5" SPI panel in this
class is physically identical and shows the same white screen when driven by the
wrong controller, and the silkscreen is often unreadable or under a heatsink.
The probe enables SPI for the current boot, loads each candidate overlay at
runtime, and writes noise to whatever framebuffer appears — static means that
controller is right. It writes nothing to `config.txt`.

It refuses to run if a panel overlay is already applied from `config.txt`: that
overlay owns `spi0.0` for the life of the boot, so every candidate would collide
and report a kernel failure, which looks like a dozen dead panels rather than
one occupied bus. `--revert`, then reboot, then probe.

Panels: start with the **stock** overlays — `piscreen`, `piscreen2r`,
`pitft35-resistive` — then the bundled vendor blobs `tft35a`, `mhs35`, `mhs35b`,
`mhs35ips`, `mis35`.

> On a Trixie image the vendor blobs are rejected by the kernel outright
> (`Failed to apply overlay`). They cannot drive anything, so a probe that tries
> them first burns its early candidates on ones that never had a chance. A 3.5"
> ILI9486 board that no vendor overlay would touch here runs correctly on the
> stock **`piscreen`**. Add `--rotate 270` if it comes up upside down. Undo everything
with `--revert`, which also gives tty1 its login prompt back.

**A white screen means the controller was never spoken to** — backlight on, no
data — so power and ribbon are fine. A *black* screen is progress: initialised,
nothing drawn. Those need opposite fixes, which is why `xl1-screen-diag.sh`
separates them.

### Touch

If the panel has a touchscreen, `xl1-screen-setup.sh` installs and enables
`xl1-touch` automatically — it detects one rather than assuming, and where there
is none the panel behaves exactly as it did before.

| Gesture | Does |
|---|---|
| Short tap | next page |
| Hold (0.7s) | back to the overview |

Four pages: **overview**, **producer log** (newest first, as many lines as the
screen fits), **chain & rewards**, **host**. Dots in the header show where you
are.

Deliberately keyed on how long a press lasts, not where it lands. The panel
reports touch in its own raw coordinate space, unrotated, while the display is
rotated by the overlay — mapping one to the other needs a calibration step that
every rotation change invalidates and that fails silently rather than obviously.
Duration needs no calibration and works whichever way up the panel is mounted.

`xl1-touch --calibrate` prints raw coordinates if you want to build zones later.

The layout is built for **60×20 characters**, which is what a 480×320 panel
gives at an 8×16 console font.

### Why not the vendor's LCD-show

If you have goodtft's `LCD-show`, do not run it here. It was written for
32-bit Raspbian and does four things that break a Bookworm 64-bit producer:

| What it does | Why it breaks |
|---|---|
| Writes `/boot/config.txt` | Bookworm reads `/boot/firmware/config.txt`. The writes land nowhere and the panel silently never appears. |
| Overwrites `config.txt` from a Debian-11 template | Discards `gpu_mem=16` and your Imager settings. |
| Installs `xserver-xorg-input-evdev`, writes `xorg.conf.d` | RPi OS Lite has no X server, and `fbturbo` was dropped from Bookworm. |
| Copies `/etc/inittab` | systemd has ignored that file since Debian 8. |

`xl1-screen-setup.sh` does the Bookworm-correct equivalent: it appends a marked
block to the real `config.txt` and removes exactly that block on revert, backs up
both boot files first, stands down `vc4-kms-v3d` (which otherwise keeps the
console off an `fbtft` panel) and restores it on revert, and never reboots
without telling you.

The compiled overlay blobs are the one genuinely useful thing in that tarball,
so those are vendored under `overlays/`.

---

## Rebuilding after edits

On your workstation, not on the Pi:

```bash
cd dashboard
docker build --platform linux/arm64 -t xl1-dashboard:local-arm64 .
docker save xl1-dashboard:local-arm64 | gzip -1 > ../xl1-dashboard-arm64.tar.gz
scp ../xl1-dashboard-arm64.tar.gz <user>@xl1pi.local:~/
```

Then on the Pi:

```bash
gunzip -c ~/xl1-dashboard-arm64.tar.gz | docker load
docker tag xl1-dashboard:local-arm64 xl1-dashboard:local
sudo systemctl restart xl1-dashboard
```

To move the producer to a newer CLI release, rebuild from the upstream repo with
`XL1_CLI_VERSION=<version> PLATFORM=linux/arm64 ./scripts/build-image.sh`, then
save, copy, load, and `docker tag … xl1:local` the same way.

---

## Troubleshooting

**`provision.sh` says the OS reports `armhf`.** You wrote the 32-bit image.
Re-image with Raspberry Pi OS Lite **64-bit**.

**Dashboard loads, Producer panel says "Not responding".** Expected until you
add credentials and start the producer. Check `systemctl status xl1-producer`.

**Producer panel says "collector has not written … yet".** The timer runs 45 s
after boot, then every 30 s. `systemctl status xl1-collect.timer`.

**Chain panel unreachable but the Pi has internet.** UFW allows all outbound by
default; check DNS first with `curl -sS https://beta.api.chain.xyo.network/rpc`.

**Reward balance shows a lookup error.** The address is malformed. It must be 40
hex characters; a `0x` prefix is fine and gets stripped.

**Node restarts in a loop.** Almost always the mnemonic. `journalctl -u
xl1-producer -n 100`. If you see OOM kills instead, lower
`--max-old-space-size` to 384 in `/etc/systemd/system/xl1-producer.service`.

**Undervoltage warnings.** Replace the power supply with a 5 V / 2.5 A unit.
Do not run the Pi from a hub or a phone charger.
