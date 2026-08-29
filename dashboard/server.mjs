// XL1 producer dashboard — Raspberry Pi 3 B+
//
// Four independent sources, each isolated so one failure never blanks the page:
//   chain   — public XL1 gateway, read through the SDK viewer (never raw RPC)
//   health  — the producer container's own /livez probe on localhost
//   node    — producer container state, written by the host collector timer
//   system  — Pi vitals from /proc and /sys (temp, throttle, RAM, swap, disk)

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import os from 'node:os'

import { DefaultNetworks, GatewayBuilder, NetworkDataLakeUrls } from '@xyo-network/xl1-sdk'

const statfsAsync = promisify(statfs)

const NETWORK = process.env.XL1_NETWORK ?? 'sequence'
const PORT = Number(process.env.DASH_PORT ?? 8088)
const BIND = process.env.DASH_BIND ?? '0.0.0.0'
const HEALTH_URL = process.env.XL1_HEALTH_URL ?? 'http://127.0.0.1:9099'
const STATUS_FILE = process.env.XL1_STATUS_FILE ?? '/var/lib/xl1/producer-status.json'
// statfs('/') inside a container reports the overlay filesystem, not the SD
// card. Point this at a host bind-mount so the disk figure is the real one.
const DISK_PATH = process.env.DASH_DISK_PATH ?? '/var/lib/xl1'
const TOKEN = process.env.DASH_TOKEN ?? ''
const CHAIN_POLL_MS = Number(process.env.DASH_CHAIN_POLL_MS ?? 15_000)
const LOCAL_POLL_MS = Number(process.env.DASH_LOCAL_POLL_MS ?? 5_000)

// The SDK preset's explorerUrl points at the beta explorer host. The public
// explorer serves each network under /xl1/<network>, which is where an operator
// actually goes to look up a block or an address.
const EXPLORER_URL = (process.env.DASH_EXPLORER_URL ?? `https://explore.xyo.network/xl1/${NETWORK}`).replace(/\/+$/, '')
const explorerAddress = (a) => (a ? `${EXPLORER_URL}/address/${a}` : undefined)

// Where to look up the newest published CLI, for the "update available"
// comparison. Set empty to switch version checking off entirely.
const CLI_REGISTRY = process.env.DASH_CLI_REGISTRY ?? 'https://registry.npmjs.org/@xyo-network/xl1-cli/latest'
// Four times a day is plenty for something that changes every few weeks.
const CLI_CHECK_MS = Number(process.env.DASH_CLI_CHECK_MS ?? 21_600_000)

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
const HISTORY_POINTS = Number(process.env.DASH_HISTORY_POINTS ?? 240)

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

    sample('height', currentNum)
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

    sample('blocks', parsed.blocksPublished)
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
    healthy: !flag(0) && !flag(2),
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
      throttle: decodeThrottle(throttleRaw),
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

    sample('tempC', state.system.cpuTempC)
    sample('memPct', state.system.memory.usedPercent)
  } catch (error) {
    state.system = { ok: false, error: error.message?.slice(0, 200) }
  }
}

// ------------------------------------------------------------------- assembly

function overall() {
  const problems = []
  if (!state.health.ok) problems.push('producer health probe failing')
  if (state.node.ok && state.node.container?.running === false) problems.push('producer container not running')
  if (state.node.ok && state.node.stale) problems.push('collector data stale')
  if (!state.chain.ok) problems.push('chain unreachable')
  if (state.system.ok && state.system.throttle && !state.system.throttle.healthy) problems.push('Pi undervoltage/throttling')
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

  const critical = !state.health.ok || (state.node.ok && state.node.container?.running === false)
  return { status: critical ? 'down' : problems.length ? 'degraded' : 'ok', problems }
}

/** Figures worth showing that are not a reading of anything — each is a
 *  relationship between two readings the page would otherwise make the reader
 *  work out by eye. */
function derived() {
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
    rewardPerDay: rewardRate !== undefined ? Number((rewardRate * 24).toFixed(2)) : undefined,
    // What share of the chain's blocks this node signed while we watched.
    sharePercent: (chainRate > 0 && nodeRate !== undefined)
      ? Number(((nodeRate / chainRate) * 100).toFixed(3)) : undefined,
    observedSeconds: history.height.length > 1
      ? Math.round((history.height.at(-1).t - history.height[0].t) / 1000) : 0,
    samples: history.height.length,
    rewardEqualsProducer: Boolean(b?.reward && b?.producer && b.reward.address === b.producer.address),
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

// Prime every source before listening so the first page load is never empty.
await Promise.all([pollChain(), pollHealth(), pollNode(), pollSystem(), pollRelease()])

setInterval(pollChain, CHAIN_POLL_MS).unref()
setInterval(() => { pollHealth(); pollNode(); pollSystem() }, LOCAL_POLL_MS).unref()
setInterval(pollRelease, CLI_CHECK_MS).unref()

server.listen(PORT, BIND, () => {
  console.log(`xl1-dashboard listening on http://${BIND}:${PORT} (network=${NETWORK}${TOKEN ? ', token required' : ''})`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
