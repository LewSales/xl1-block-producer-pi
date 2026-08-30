// XL1 producer dashboard — Raspberry Pi 3 B+
//
// Four independent sources, each isolated so one failure never blanks the page:
//   chain   — public XL1 gateway, read through the SDK viewer (never raw RPC)
//   health  — the producer container's own /livez probe on localhost
//   node    — producer container state, written by the host collector timer
//   system  — Pi vitals from /proc and /sys (temp, throttle, RAM, swap, disk)

import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer } from 'node:http'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

import { DefaultNetworks, GatewayBuilder, NetworkDataLakeUrls } from '@xyo-network/xl1-sdk'

const statfsAsync = promisify(statfs)

// `??` falls back only on undefined, but an env file line reading `FOO=` gives
// an empty string — which Docker's --env-file passes through, and which then
// wins over every default. Shipping `DASH_EXPLORER_URL=` in a template was
// enough to turn every explorer link into a relative path pointing back at the
// dashboard. So: for values where empty is meaningless, treat it as absent.
//
// Three variables are excluded on purpose, because empty is a real setting
// there and means "off": DASH_TOKEN, DASH_CLI_REGISTRY, DASH_ELIGIBILITY_IGNORE.
const envStr = (name, fallback) => {
  const v = process.env[name]
  return v === undefined || v.trim() === '' ? fallback : v.trim()
}

/** Numeric env with a floor. A NaN here is not cosmetic: it disabled the
 *  history ring's size cap entirely (`length > NaN` is always false), and a NaN
 *  interval makes setInterval fire every millisecond. */
const envNum = (name, fallback, min = 1) => {
  const n = Number(envStr(name, String(fallback)))
  if (!Number.isFinite(n) || n < min) {
    if (process.env[name]) console.warn(`xl1-dashboard: ignoring ${name}=${process.env[name]} — using ${fallback}`)
    return fallback
  }
  return n
}

const NETWORK = envStr('XL1_NETWORK', 'sequence')
const PORT = envNum('DASH_PORT', 8088)
const BIND = envStr('DASH_BIND', '0.0.0.0')
const HEALTH_URL = envStr('XL1_HEALTH_URL', 'http://127.0.0.1:9099')
const STATUS_FILE = envStr('XL1_STATUS_FILE', '/var/lib/xl1/producer-status.json')
// statfs('/') inside a container reports the overlay filesystem, not the SD
// card. Point this at a host bind-mount so the disk figure is the real one.
const DISK_PATH = envStr('DASH_DISK_PATH', '/var/lib/xl1')
// Empty is a real setting: no token required.
const TOKEN = process.env.DASH_TOKEN ?? ''
const CHAIN_POLL_MS = envNum('DASH_CHAIN_POLL_MS', 15_000, 1000)
const LOCAL_POLL_MS = envNum('DASH_LOCAL_POLL_MS', 5_000, 1000)

// The SDK preset's explorerUrl points at the beta explorer host. The public
// explorer serves each network under /xl1/<network>, which is where an operator
// actually goes to look up a block or an address.
const EXPLORER_URL = envStr('DASH_EXPLORER_URL', `https://explore.xyo.network/xl1/${NETWORK}`).replace(/\/+$/, '')
const explorerAddress = (a) => (a ? `${EXPLORER_URL}/address/${a}` : undefined)
const explorerBlock = (n) => (Number.isFinite(Number(n)) ? `${EXPLORER_URL}/block/${n}` : undefined)

// Where to look up the newest published CLI, for the "update available"
// comparison. Set empty to switch version checking off entirely.
const CLI_REGISTRY = process.env.DASH_CLI_REGISTRY ?? 'https://registry.npmjs.org/@xyo-network/xl1-cli/latest'
// Four times a day is plenty for something that changes every few weeks.
const CLI_CHECK_MS = envNum('DASH_CLI_CHECK_MS', 21_600_000, 60_000)

// Not every complaint the node makes applies to every network. Sequence is
// federated: producers are authorized by an allowlist, and staking is not part
// of how it decides who may produce — so a stake complaint there is the node
// reciting a rule this network does not enforce. Still shown, because the node
// did say it and hiding output is worse than explaining it, but not counted as
// a fault and not worth waking anyone for.
const IGNORED_BY_NETWORK = { sequence: ['insufficient-stake', 'no-intent', 'unseasoned', 'self-bond'] }
const ELIGIBILITY_IGNORED = (process.env.DASH_ELIGIBILITY_IGNORE ?? '')
  .split(',').map((x) => x.trim()).filter(Boolean)
const ignoredKeys = new Set(ELIGIBILITY_IGNORED.length ? ELIGIBILITY_IGNORED : (IGNORED_BY_NETWORK[NETWORK] ?? []))

// XL1 balances are keyed by bare lowercase hex — a 0x prefix is rejected by the
// gateway, and the env examples ship the 0x form, so normalize every address.
const bareHex = (a) => (a ?? '').trim().replace(/^0x/i, '').toLowerCase()

const REWARD_ADDRESS = bareHex(process.env.XL1_REWARD_ADDRESS)
const PRODUCER_ADDRESS = bareHex(process.env.XL1_PRODUCER_ADDRESS)

const ATTO = 10n ** 18n

/** AttoXL1 → human XL1, keeping full integer precision (no float rounding). */
function formatXl1(atto, decimals = 4) {
  if (atto === undefined || atto === null) return undefined
  let v
  try { v = BigInt(atto) } catch { return undefined }
  const neg = v < 0n
  if (neg) v = -v
  const whole = v / ATTO
  const frac = (v % ATTO).toString().padStart(18, '0').slice(0, decimals)
  const grouped = whole.toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${decimals > 0 ? `.${frac}` : ''}`
}

// ---------------------------------------------------------------- chain source

const network = DefaultNetworks.find((n) => n.id === NETWORK)
if (!network) throw new Error(`Unknown XL1 network "${NETWORK}"`)

let gatewayPromise
/** Cache the promise, not the value, so concurrent first callers share one build. */
function getGateway() {
  gatewayPromise ??= new GatewayBuilder()
    .name(NETWORK)
    .rpcUrl(`${network.url}/rpc`)
    .dataLakeEndpoint(NetworkDataLakeUrls[NETWORK])
    .build()
  return gatewayPromise
}

// ------------------------------------------------------------------- history
//
// A ring of recent samples so the page can show movement instead of a single
// instant — a balance that is climbing reads completely differently from the
// same number standing still.
//
// In memory by deliberate choice. The container is read-only and this is a
// convenience, not a record: it starts empty after a restart, and the page says
// so rather than drawing a flat line that looks like nothing is happening.
const HISTORY_POINTS = envNum('DASH_HISTORY_POINTS', 240, 2)

// Long-range history, written to disk so it survives a restart.
//
// The in-memory ring above is minutes of detail; this is weeks of shape. They
// answer different questions — "is it moving right now" versus "did it earn
// anything last Tuesday" — and the ring cannot answer the second at any size,
// because the container restarts and it starts empty.
//
// One row per five minutes for thirty days is ~8,600 lines, a few hundred KB.
const TREND_FILE = envStr('DASH_TREND_FILE', '/var/lib/xl1/dashboard/trend.jsonl')
const TREND_EVERY_MS = envNum('DASH_TREND_EVERY_MS', 300_000, 60_000)
const TREND_RETAIN_DAYS = envNum('DASH_TREND_RETAIN_DAYS', 30, 1)

/** Rows already on disk, newest last. Empty when the store is unwritable, which
 *  is reported rather than hidden — a flat chart and an absent one look the
 *  same, and only one of them means something is wrong. */
let trend = []
let trendError
let trendLastWrite = 0

async function loadTrend() {
  try {
    const raw = await readFile(TREND_FILE, 'utf8')
    const cutoff = Date.now() - TREND_RETAIN_DAYS * 86_400_000
    trend = raw.split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r.t === 'number' && r.t >= cutoff)
    trendError = undefined
  } catch (error) {
    trend = []
    // ENOENT on first run is normal, not a fault worth reporting.
    trendError = error.code === 'ENOENT' ? undefined : error.message?.slice(0, 160)
  }
}

/** Append one row, and compact when the file has drifted past retention.
 *  Failure here must never take the dashboard down — it is a nice-to-have
 *  sitting on a bind mount an older install will not have. */
async function persistTrend() {
  if (Date.now() - trendLastWrite < TREND_EVERY_MS) return
  const row = {
    t: Date.now(),
    height: state.chain?.currentBlock,
    reward: history.reward.at(-1)?.v,
    blocks: state.node?.blocksPublished,
    tempC: state.system?.cpuTempC,
  }
  if (row.height === undefined && row.reward === undefined) return

  try {
    await appendFile(TREND_FILE, `${JSON.stringify(row)}\n`)
    trend.push(row)
    trendLastWrite = row.t

    const cutoff = row.t - TREND_RETAIN_DAYS * 86_400_000
    if (trend.length && trend[0].t < cutoff) {
      trend = trend.filter((r) => r.t >= cutoff)
      await writeFile(TREND_FILE, trend.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }
    trendError = undefined
  } catch (error) {
    // First run has no directory. Create it and let the next cycle write —
    // reporting "no such file" for a store that has simply never been written
    // is an error message where an empty state belongs.
    if (error.code === 'ENOENT') {
      try {
        await mkdir(dirname(TREND_FILE), { recursive: true })
        trendError = undefined
        return
      } catch {
        trendError = `${dirname(TREND_FILE)} does not exist and cannot be created`
          + ' — xl1-dashboard.service needs a rw bind mount for it (systemctl daemon-reload after updating the unit)'
        return
      }
    }
    trendError = error.code === 'EACCES' || error.code === 'EROFS'
      ? `${dirname(TREND_FILE)} is mounted read-only — update xl1-dashboard.service and daemon-reload`
      : error.message?.slice(0, 160)
  }
}

/** Collapse rows into per-day buckets: blocks produced and XL1 earned each day.
 *  Differences between consecutive readings, not the readings themselves —
 *  both underlying figures are cumulative totals. */
function trendDaily() {
  if (trend.length < 2) return []
  const byDay = new Map()
  for (const r of trend) {
    const day = new Date(r.t).toISOString().slice(0, 10)
    const cur = byDay.get(day)
    if (!cur) byDay.set(day, { day, firstBlocks: r.blocks, lastBlocks: r.blocks, firstReward: r.reward, lastReward: r.reward })
    else {
      if (r.blocks !== undefined) { cur.firstBlocks ??= r.blocks; cur.lastBlocks = r.blocks }
      if (r.reward !== undefined) { cur.firstReward ??= r.reward; cur.lastReward = r.reward }
    }
  }
  return [...byDay.values()].map((d) => ({
    day: d.day,
    blocks: (d.lastBlocks ?? 0) - (d.firstBlocks ?? 0),
    // A restart resets nothing here (both are chain-side or cumulative), but a
    // negative would mean the counter was reset — report 0 rather than nonsense.
    earned: Math.max(0, Number(((d.lastReward ?? 0) - (d.firstReward ?? 0)).toFixed(4))),
  })).sort((a, b) => a.day.localeCompare(b.day))
}

const history = { height: [], reward: [], blocks: [], tempC: [], memPct: [] }

function sample(series, value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return
  const s = history[series]
  s.push({ t: Date.now(), v: Number(value) })
  if (s.length > HISTORY_POINTS) s.shift()
}

/** Rate of change per hour across a series, or undefined if too little data.
 *  Uses the real elapsed time rather than the sample count, so a restarted
 *  dashboard or a stalled poller cannot inflate the figure. */
function perHour(series) {
  const s = history[series]
  if (!s || s.length < 2) return undefined
  const first = s[0], last = s[s.length - 1]
  const hours = (last.t - first.t) / 3_600_000
  if (hours <= 0) return undefined
  return (last.v - first.v) / hours
}

const state = {
  chain: { ok: false, error: 'not polled yet' },
  release: { ok: false, error: 'not polled yet' },
  health: { ok: false, error: 'not polled yet' },
  node: { ok: false, error: 'not polled yet' },
  system: { ok: false, error: 'not polled yet' },
  startedAt: new Date().toISOString(),
}

let baselineBalance // first balance we saw, to show earned-since-start

// Blocks this node actually produced, counted from the chain.
//
// This used to be grepped out of the container log for "published block" — a
// string the producer never emits. The result was a dashboard reporting zero
// blocks about a node that was producing several every ten minutes, and a
// fortnight of wrong conclusions built on top of that number.
//
// A block is a BoundWitness and its producer is a signer, so the chain itself
// answers the question. This agrees with the block explorer by construction,
// which the log grep never could.
const production = { counted: 0, lastBlock: undefined, scannedFrom: undefined, error: undefined }
let productionCursor

/** Scan only what is new. The first pass looks back a window; afterwards it
 *  reads the handful of blocks that appeared since, so the cost does not grow
 *  with uptime. */
async function scanProduction(viewer, currentNum) {
  const addr = PRODUCER_ADDRESS || REWARD_ADDRESS
  if (!addr || !Number.isFinite(currentNum)) return

  const WINDOW = Number(envNum('DASH_PRODUCTION_WINDOW', 120, 10))
  const from = productionCursor === undefined ? Math.max(0, currentNum - WINDOW + 1) : productionCursor + 1
  if (currentNum < from) return

  const limit = Math.min(currentNum - from + 1, 200)
  try {
    // Newest-first, per the SDK's documented direction.
    const blocks = await viewer.block.blocksByNumber(currentNum, limit)
    for (const entry of blocks ?? []) {
      const bw = Array.isArray(entry) ? entry[0] : entry
      const n = Number(bw?.block)
      if (!Number.isFinite(n) || n < from) continue
      const signers = (bw?.addresses ?? []).map((a) => String(a).replace(/^0x/i, '').toLowerCase())
      if (signers.includes(addr)) {
        production.counted += 1
        if (production.lastBlock === undefined || n > production.lastBlock) production.lastBlock = n
      }
    }
    production.scannedFrom ??= from
    production.error = undefined
    productionCursor = currentNum
  } catch (error) {
    // Leave the cursor alone so the same range is retried rather than skipped.
    production.error = error.message?.slice(0, 160)
  }
}

async function pollChain() {
  try {
    const gateway = await getGateway()
    const viewer = gateway.connection.viewer
    if (!viewer) throw new Error('gateway has no viewer attached')

    const [current, finalized, chainId] = await Promise.all([
      viewer.block.currentBlockNumber(),
      viewer.finalization.headNumber(),
      viewer.block.chainId(),
    ])

    const currentNum = Number(current)
    const finalizedNum = Number(finalized)

    const balances = {}
    for (const [key, addr] of [['reward', REWARD_ADDRESS], ['producer', PRODUCER_ADDRESS]]) {
      if (!addr) continue
      try {
        const atto = await viewer.account.balance.accountBalance(addr)
        balances[key] = { address: addr, atto: String(atto), xl1: formatXl1(atto), url: explorerAddress(addr) }
      } catch (error) {
        balances[key] = { address: addr, error: error.message?.slice(0, 200), url: explorerAddress(addr) }
      }
    }

    if (balances.reward?.atto !== undefined) {
      baselineBalance ??= { atto: BigInt(balances.reward.atto), at: new Date().toISOString() }
      const delta = BigInt(balances.reward.atto) - baselineBalance.atto
      balances.reward.sinceStart = { atto: String(delta), xl1: formatXl1(delta), since: baselineBalance.at }
    }

    state.chain = {
      ok: true,
      network: NETWORK,
      networkName: network.name,
      explorerUrl: EXPLORER_URL,
      chainId: String(chainId),
      chainIdMatchesPreset: String(chainId) === network.chain,
      currentBlock: currentNum,
      finalizedBlock: finalizedNum,
      finalizationLag: currentNum - finalizedNum,
      balances,
      polledAt: new Date().toISOString(),
    }

    await scanProduction(viewer, currentNum)

    sample('height', currentNum)
    sample('blocks', production.counted)
    if (balances.reward?.atto !== undefined) {
      // atto → XL1 as a float: fine for a trend line, never for a displayed
      // balance, which stays integer-exact above.
      sample('reward', Number(BigInt(balances.reward.atto) / 10n ** 12n) / 1e6)
    }
  } catch (error) {
    state.chain = { ok: false, error: error.message?.slice(0, 300), polledAt: new Date().toISOString() }
  }
}

// -------------------------------------------------------------- release source

/** Newest published xl1-cli, for comparison against what the container runs.
 *
 * A node that is up, healthy and four releases behind reads as perfectly fine
 * on every other signal here. Failure is non-fatal by construction: an
 * unreachable registry costs the comparison and nothing else.
 */
async function pollRelease() {
  if (!CLI_REGISTRY) { state.release = { ok: false, disabled: true }; return }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(CLI_REGISTRY, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`registry returned ${res.status}`)
    const body = await res.json()
    const latest = typeof body?.version === 'string' ? body.version : undefined
    if (!latest) throw new Error('registry response had no version')
    state.release = { ok: true, latest, polledAt: new Date().toISOString() }
  } catch (error) {
    state.release = {
      ok: false,
      error: error.name === 'AbortError' ? 'timeout' : error.message?.slice(0, 200),
      polledAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Compare two dotted versions numerically. Undefined on anything unparseable —
 *  a malformed version must not be reported as "up to date". */
function versionLag(installed, latest) {
  if (!installed || !latest) return undefined
  const parse = (v) => String(v).trim().replace(/^v/, '').split('.').map(Number)
  const a = parse(installed), b = parse(latest)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return undefined
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d !== 0) return d > 0 ? 'behind' : 'ahead'
  }
  return 'current'
}

// --------------------------------------------------------------- health source

async function probe(path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const started = Date.now()
    const res = await fetch(`${HEALTH_URL}${path}`, { signal: controller.signal })
    return { path, status: res.status, ok: res.ok, latencyMs: Date.now() - started }
  } catch (error) {
    return { path, ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message?.slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

async function pollHealth() {
  const probes = await Promise.all([probe('/livez'), probe('/readyz'), probe('/healthz')])
  const live = probes.find((p) => p.path === '/livez')
  state.health = {
    ok: Boolean(live?.ok),
    endpoint: HEALTH_URL,
    probes,
    polledAt: new Date().toISOString(),
  }
}

// ----------------------------------------------------------------- node source

async function pollNode() {
  try {
    const raw = await readFile(STATUS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const age = Date.now() - new Date(parsed.collectedAt).getTime()
    state.node = {
      ok: true,
      stale: age > 120_000,
      ageSeconds: Math.round(age / 1000),
      ...parsed,
    }
    // Classify here rather than in the collector: whether a complaint matters is
    // a property of the network, and the collector does not know which one this
    // is. It reports what the node said; this decides what that means.
    const key = parsed.eligibility?.key
    state.node.eligibilityIgnored = Boolean(parsed.eligibility?.blocked && key && ignoredKeys.has(key))
    if (state.node.eligibilityIgnored) {
      state.node.eligibilityNote = `not enforced on ${NETWORK}`
    }

  } catch (error) {
    state.node = {
      ok: false,
      error: error.code === 'ENOENT'
        ? `collector has not written ${STATUS_FILE} yet`
        : error.message?.slice(0, 200),
    }
  }
}

// --------------------------------------------------------------- system source

async function readFirstLine(path) {
  try { return (await readFile(path, 'utf8')).trim() } catch { return undefined }
}

/** Decode the Pi's throttle bitmask — undervoltage is the top cause of flaky Pi nodes. */
function decodeThrottle(hex) {
  if (!hex) return undefined
  const bits = BigInt(hex)
  const flag = (n) => (bits >> BigInt(n)) & 1n ? true : false
  return {
    raw: `0x${bits.toString(16)}`,
    undervoltageNow: flag(0),
    frequencyCappedNow: flag(1),
    throttledNow: flag(2),
    softTempLimitNow: flag(3),
    undervoltageSinceBoot: flag(16),
    frequencyCappedSinceBoot: flag(17),
    throttledSinceBoot: flag(18),
    softTempLimitSinceBoot: flag(19),
    // Bit 3 means the ARM clock is being reduced for heat right now — on a
    // 3 B+ that is 1.4 GHz down to 1.2 GHz. Excluding it called a CPU that is
    // actively running slow "stable", which is precisely the reading an
    // operator wondering why blocks build slowly needs to see.
    healthy: !flag(0) && !flag(2) && !flag(3),
  }
}

async function pollSystem() {
  try {
    const [tempRaw, throttleRaw, meminfo] = await Promise.all([
      readFirstLine('/sys/class/thermal/thermal_zone0/temp'),
      readFirstLine('/sys/devices/platform/soc/soc:firmware/get_throttled'),
      readFile('/proc/meminfo', 'utf8').catch(() => ''),
    ])

    const mem = Object.fromEntries(
      meminfo.split('\n').filter(Boolean).map((line) => {
        const [k, v] = line.split(':')
        return [k.trim(), Number.parseInt(v, 10) * 1024]
      }),
    )

    let disk
    try {
      const fs = await statfsAsync(DISK_PATH)
      disk = {
        totalBytes: fs.blocks * fs.bsize,
        freeBytes: fs.bavail * fs.bsize,
        usedPercent: Math.round((1 - fs.bavail / fs.blocks) * 100),
      }
    } catch { /* non-fatal */ }

    const memTotal = mem.MemTotal ?? 0
    const memAvailable = mem.MemAvailable ?? 0
    const swapTotal = mem.SwapTotal ?? 0
    const swapFree = mem.SwapFree ?? 0

    state.system = {
      ok: true,
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
      cpuCount: os.cpus().length,
      cpuTempC: tempRaw ? Number((Number(tempRaw) / 1000).toFixed(1)) : undefined,
      // That sysfs path does not exist on every kernel — on the Pi 3 B+ running
      // Trixie it does not — and the container can run neither vcgencmd nor
      // reach /dev/vcio. The collector reads it on the host and passes it here,
      // so the panel stops saying "unknown" about the one figure that has cost
      // this node the most time.
      throttle: decodeThrottle(throttleRaw || state.node?.throttleRaw),
      memory: {
        totalBytes: memTotal,
        availableBytes: memAvailable,
        usedPercent: memTotal ? Math.round((1 - memAvailable / memTotal) * 100) : undefined,
      },
      swap: {
        totalBytes: swapTotal,
        usedBytes: swapTotal - swapFree,
        usedPercent: swapTotal ? Math.round((1 - swapFree / swapTotal) * 100) : 0,
      },
      disk,
      polledAt: new Date().toISOString(),
    }

    // On Windows, containers run inside a Linux VM, so /proc and os.* describe
    // that VM and not the machine an operator is looking at. The collector runs
    // natively there and supplies the real figures — same division of labour as
    // the throttle reading on the Pi, for the same reason.
    const hostMetrics = state.node?.host
    if (hostMetrics?.platform === 'windows') {
      state.system = {
        ...state.system,
        hostname: hostMetrics.hostname ?? state.system.hostname,
        platform: 'windows',
        uptimeSeconds: hostMetrics.uptimeSeconds ?? state.system.uptimeSeconds,
        cpuCount: hostMetrics.cpuCount ?? state.system.cpuCount,
        cpuPercent: hostMetrics.cpuPercent,
        // A Windows host has no load average and no SoC throttle register.
        // Absent, not zero — a zero would read as a measurement.
        loadAverage: undefined,
        cpuTempC: undefined,
        throttle: undefined,
        memory: hostMetrics.memory ?? state.system.memory,
        disk: hostMetrics.disk ?? state.system.disk,
      }
    }

    sample('tempC', state.system.cpuTempC)
    sample('memPct', state.system.memory?.usedPercent)
  } catch (error) {
    state.system = { ok: false, error: error.message?.slice(0, 200) }
  }
}

// ------------------------------------------------------------------- assembly

function overall() {
  const problems = []
  if (!state.health.ok) problems.push('producer health probe failing')

  // A deleted container is a first-class state, not a missing field. The
  // collector reports it as `container: null` with an error string, and
  // `container?.running === false` is `undefined === false` — so this read as
  // healthy on its own signal, and the error text was never rendered anywhere.
  if (state.node.ok && state.node.container === null) {
    problems.push(`producer container not found: ${state.node.error ?? 'no container'}`)
  }
  if (state.node.ok && state.node.container?.running === false) problems.push('producer container not running')

  // Stale data and no data are different failures, and only the first was
  // reported. A collector that has never written a snapshot leaves node.ok
  // false and node.stale undefined, which said nothing at all.
  if (!state.node.ok) problems.push(`collector not reporting: ${state.node.error ?? 'unknown'}`)
  if (state.node.ok && state.node.stale) problems.push('collector data stale')
  if (!state.chain.ok) problems.push('chain unreachable')
  if (state.system.ok && state.system.throttle) {
    const t = state.system.throttle
    if (t.undervoltageNow) problems.push('Pi undervolting right now')
    if (t.throttledNow) problems.push('Pi hard-throttled right now')
    // Named separately from undervoltage: it is a different cause with a
    // different fix, and lumping them under one message sends people to buy a
    // power supply for a cooling problem.
    if (t.softTempLimitNow) problems.push('CPU clock reduced for heat — add cooling')
  }
  if (state.system.ok && state.system.swap?.usedPercent > 60) problems.push('heavy swap use')
  if (state.chain.ok && state.chain.chainIdMatchesPreset === false) problems.push('chain id differs from preset')

  // A node can be up, healthy and unable to produce a single block. Nothing
  // else on this page distinguishes that from working.
  if (state.node.ok && state.node.eligibility?.blocked && !state.node.eligibilityIgnored) {
    problems.push(`producer ineligible: ${state.node.eligibility.reason}`)
  }

  const lag = versionLag(state.node?.cliVersion, state.release?.latest)
  if (lag === 'behind') problems.push(`xl1-cli ${state.node.cliVersion} behind published ${state.release.latest}`)

  const osInfo = state.node?.os
  if (osInfo) {
    if (osInfo.securityUpdates > 0) problems.push(`${osInfo.securityUpdates} host security update(s) pending`)
    if (osInfo.rebootRequired) problems.push('host reboot required')
    // A zero read off month-old lists is the worst answer this can give, so the
    // staleness is escalated rather than shown quietly beside the count.
    if (osInfo.aptAgeHours > 168) problems.push(`apt lists ${Math.round(osInfo.aptAgeHours / 24)}d stale — update count is not trustworthy`)
  }

  const critical = !state.health.ok
    || (state.node.ok && state.node.container?.running === false)
    || (state.node.ok && state.node.container === null)
  return { status: critical ? 'down' : problems.length ? 'degraded' : 'ok', problems }
}

/** Figures worth showing that are not a reading of anything — each is a
 *  relationship between two readings the page would otherwise make the reader
 *  work out by eye. */
function derived() {
  const observedSeconds = history.height.length > 1
    ? Math.round((history.height.at(-1).t - history.height[0].t) / 1000) : 0
  const chainRate = perHour('height')
  const rewardRate = perHour('reward')
  const nodeRate = perHour('blocks')
  const b = state.chain?.balances

  return {
    // Seconds per block across the observed window. The headline number on this
    // page is a block height; how fast it moves is what says the chain is alive.
    secondsPerBlock: chainRate > 0 ? Number((3600 / chainRate).toFixed(2)) : undefined,
    blocksPerHourChain: chainRate !== undefined ? Math.round(chainRate) : undefined,
    blocksPerHourNode: nodeRate !== undefined ? Number(nodeRate.toFixed(2)) : undefined,
    // Extrapolated, and labelled as such on the page: an hour of observation is
    // not a day of earnings, and presenting it as one would be a lie by rounding.
    rewardPerHour: rewardRate !== undefined ? Number(rewardRate.toFixed(4)) : undefined,
    // A rate measured over minutes says nothing about a day. 15 minutes is the
    // floor at which the number stops being an artefact of when you looked.
    rewardPerDay: (rewardRate !== undefined && observedSeconds >= 900)
      ? Number((rewardRate * 24).toFixed(2)) : undefined,
    // What share of the chain's blocks this node signed while we watched.
    sharePercent: (chainRate > 0 && nodeRate !== undefined)
      ? Number(((nodeRate / chainRate) * 100).toFixed(3)) : undefined,
    observedSeconds,
    samples: history.height.length,
    rewardEqualsProducer: Boolean(b?.reward && b?.producer && b.reward.address === b.producer.address),

    // The last block this node actually landed, and how far the chain has moved
    // since. "Blocks submitted: 3" is a number taken on faith; a height is
    // something an operator can open and see.
    // The chain is the authority. The collector's log-derived figure stays as a
    // fallback for a node whose address is not configured, but it is not what
    // this reports when the chain can answer.
    lastBlock: production.lastBlock ?? state.node?.lastPublishedBlock,
    lastBlockUrl: explorerBlock(production.lastBlock ?? state.node?.lastPublishedBlock),
    lastBlockAt: state.node?.lastPublishedAt,
    blocksSinceLast: (state.chain?.currentBlock !== undefined && (production.lastBlock ?? state.node?.lastPublishedBlock) !== undefined)
      ? state.chain.currentBlock - Number(production.lastBlock ?? state.node.lastPublishedBlock)
      : undefined,
    producedObserved: production.counted,
    producedSince: production.scannedFrom,
    productionError: production.error,
    // Share of the chain's blocks this node signed over the observed range.
    producedSharePercent: (production.scannedFrom !== undefined && state.chain?.currentBlock !== undefined)
      ? (() => {
          const span = state.chain.currentBlock - production.scannedFrom + 1
          return span > 0 ? Number(((production.counted / span) * 100).toFixed(2)) : undefined
        })()
      : undefined,
  }
}

const snapshot = () => ({
  ...overall(),
  generatedAt: new Date().toISOString(),
  dashboardStartedAt: state.startedAt,
  ...state,
  release: { ...state.release, installed: state.node?.cliVersion, lag: versionLag(state.node?.cliVersion, state.release?.latest) },
  derived: derived(),
  history,
  trend: { daily: trendDaily(), points: trend.length, retainDays: TREND_RETAIN_DAYS, error: trendError },
})

// ---------------------------------------------------------------------- server

const PAGE = await readFile(new URL('./index.html', import.meta.url), 'utf8')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }

  if (TOKEN) {
    const supplied = url.searchParams.get('token') ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (supplied !== TOKEN) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
      return
    }
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(snapshot(), null, 2))
    return
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})

// Exported so the decisions on this page can be tested without a network, a
// Docker daemon, or a Pi. `overall` and `pollNode` in particular encode the
// contract with xl1-collect.sh, which is where two silent failures have already
// hidden.
export { formatXl1, versionLag, decodeThrottle, perHour, overall, derived, envStr, envNum, pollNode, snapshot, state, history, trendDaily, loadTrend }

// Only run as a server when executed directly, not when imported by a test.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  // A crash here is otherwise invisible: Restart=always brings the container
  // back in 10s, so the only trace is history resetting and "since dashboard
  // start" silently rebasing.
  process.on('unhandledRejection', (err) => {
    console.error('xl1-dashboard: unhandled rejection —', err)
  })
  process.on('uncaughtException', (err) => {
    console.error('xl1-dashboard: uncaught exception —', err)
  })

  // Prime every source before listening so the first page load is never empty.
  await loadTrend()
  await Promise.all([pollChain(), pollHealth(), pollNode(), pollSystem(), pollRelease()])
  if (trendError) console.warn(`xl1-dashboard: long-range history unavailable — ${trendError}`)

  // Each poller catches internally, but a rejection escaping one of them would
  // take the process down, so none of these promises may go unwatched.
  const guard = (fn, name) => () => { Promise.resolve(fn()).catch((e) => console.error(`xl1-dashboard: ${name} failed —`, e)) }

  setInterval(guard(pollChain, 'pollChain'), CHAIN_POLL_MS).unref()
  // Checked often, written rarely — persistTrend decides for itself whether
  // enough time has passed, so the cadence lives in one place.
  setInterval(guard(persistTrend, 'persistTrend'), 60_000).unref()
  setInterval(() => { guard(pollHealth, 'pollHealth')(); guard(pollNode, 'pollNode')(); guard(pollSystem, 'pollSystem')() }, LOCAL_POLL_MS).unref()
  setInterval(guard(pollRelease, 'pollRelease'), CLI_CHECK_MS).unref()

  server.listen(PORT, BIND, () => {
    console.log(`xl1-dashboard listening on http://${BIND}:${PORT} (network=${NETWORK}${TOKEN ? ', token required' : ''})`)
  })

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      // close() alone waits for keep-alive sockets, and the page holds one open
      // by polling — so it never returned and every stop burned the full
      // 15s docker timeout before SIGKILL.
      server.closeAllConnections?.()
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}
