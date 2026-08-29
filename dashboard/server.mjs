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

const state = {
  chain: { ok: false, error: 'not polled yet' },
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
        balances[key] = { address: addr, atto: String(atto), xl1: formatXl1(atto) }
      } catch (error) {
        balances[key] = { address: addr, error: error.message?.slice(0, 200) }
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
      explorerUrl: network.explorerUrl,
      chainId: String(chainId),
      chainIdMatchesPreset: String(chainId) === network.chain,
      currentBlock: currentNum,
      finalizedBlock: finalizedNum,
      finalizationLag: currentNum - finalizedNum,
      balances,
      polledAt: new Date().toISOString(),
    }
  } catch (error) {
    state.chain = { ok: false, error: error.message?.slice(0, 300), polledAt: new Date().toISOString() }
  }
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

  const critical = !state.health.ok || (state.node.ok && state.node.container?.running === false)
  return { status: critical ? 'down' : problems.length ? 'degraded' : 'ok', problems }
}

const snapshot = () => ({ ...overall(), generatedAt: new Date().toISOString(), dashboardStartedAt: state.startedAt, ...state })

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
await Promise.all([pollChain(), pollHealth(), pollNode(), pollSystem()])

setInterval(pollChain, CHAIN_POLL_MS).unref()
setInterval(() => { pollHealth(); pollNode(); pollSystem() }, LOCAL_POLL_MS).unref()

server.listen(PORT, BIND, () => {
  console.log(`xl1-dashboard listening on http://${BIND}:${PORT} (network=${NETWORK}${TOKEN ? ', token required' : ''})`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
