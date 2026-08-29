# XL1 Block Producer — Raspberry Pi 3 B+

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
| `windows/` | Double-clickable `.cmd` launchers that drive the Pi over SSH. |
| `xl1-local-arm64.tar.gz` | The producer image, cross-built for arm64. |
| `xl1-dashboard-arm64.tar.gz` | The dashboard image, cross-built for arm64. |
| `sequence-producer.env.template` | Producer secrets → `/etc/xl1/sequence-producer.env` (mode 0600). |
| `dashboard.env.template` | Dashboard config → `/etc/xl1/dashboard.env`. |
| `systemd/` | Producer, dashboard, and collector units. |
| `scripts/xl1-collect.sh` | Host-side collector feeding the dashboard. |
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
| **Producer** | `/livez` result, container state, uptime, restart count, blocks submitted, log error count |
| **Chain** | Current block, finalized head, finalization lag, chain ID vs. the preset |
| **Rewards** | Reward-address balance in XL1, and the change since the dashboard started |
| **Raspberry Pi** | CPU temp, RAM, swap, disk, and **undervoltage / throttling flags** |
| **Producer log** | Last 40 lines |

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
```

`xl1ctl addr` is the one to reach for when blocks are submitted but never
accepted. It derives the signing address out of the mnemonic and tells you
whether it matches the reward address — the thing nothing else in the running
system will show you.

### Backups

```bash
sudo xl1ctl backup                    # encrypted tarball of /etc/xl1
sudo xl1ctl restore FILE
```

The archive contains your seed phrase, encrypted with a passphrase you choose.
Lose the passphrase and the backup is unrecoverable. Copy it off the Pi — an SD
card is not a backup. `windows/Fetch backup to this PC.cmd` does both steps.

### Driving it from Windows

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
