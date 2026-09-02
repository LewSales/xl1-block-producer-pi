// XL1 producer dashboard — Raspberry Pi 3 B+
//
// Four independent sources, each isolated so one failure never blanks the page:
//   chain   — public XL1 gateway, read through the SDK viewer (never raw RPC)
//   health  — the producer container's own /livez probe on localhost
//   node    — producer container state, written by the host collector timer
//   system  — Pi vitals from /proc and /sys (temp, throttle, RAM, swap, disk)

import { readFile, appendFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer } from 'node:http'
import { statfs, readFileSync } from 'node:fs'
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

// Read once at import rather than per request. Falls back rather than throwing:
// a dashboard that will not start because it cannot find its own version number
// is a worse outcome than one that says "unknown".
const DASH_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

// The build stamp can also travel as a file beside server.mjs, and when it does
// it wins over the environment.
//
// This exists because of how the code is deployed. Baking the stamp into the
// image works only while the image and the code are the same thing. Once
// server.mjs and index.html are bind-mounted over the image — which is the
// difference between a 110 MB transfer and a 200 KB one — the code changes and
// the image's environment does not, so the page would confidently report the
// commit of whichever image happened to be underneath it. That is worse than no
// stamp: it is a wrong answer to "which build am I looking at", on the one
// panel built to answer exactly that.
//
// Absent file, absent field, malformed JSON: each falls through to the
// environment rather than failing, so an image-only deploy behaves as before.
const BUILD_STAMP = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL('./build.json', import.meta.url), 'utf8'))
    return (raw && typeof raw === 'object') ? raw : {}
  } catch {
    return {}
  }
})()
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
// /block/number/<n>, not /block/<n>. The explorer routes blocks by hash as well
// as by height, so the height lookup is a distinct path — and the short form
// resolves to nothing rather than erroring, which is why every "Last produced"
// link opened a blank page instead of looking obviously broken.
const explorerBlock = (n) => (Number.isFinite(Number(n)) ? `${EXPLORER_URL}/block/number/${n}` : undefined)

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
    // The collector's figure is grep -c 'published block' over the container
    // log — a string the producer never emits, so it is 0 forever and every
    // day in the chart read "0 blocks". Same defect c1fc673 fixed for the
    // headline count; this store was still reading the old source.
    //
    // Written under a new key on purpose. Rows already on disk carry blocks:0,
    // and diffing a real cumulative count against those zeros would post the
    // entire running total as a single day's production on the changeover day.
    blocks: state.node?.blocksPublished,
    cblocks: production.counted,
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
    let cur = byDay.get(day)
    if (!cur) { cur = { day }; byDay.set(day, cur) }
    // Each series tracked separately so a key that only appears partway through
    // the day is diffed against its own first reading, never against the other
    // key's. The two counters mean different things and must not be mixed.
    if (r.cblocks !== undefined) { cur.firstC ??= r.cblocks; cur.lastC = r.cblocks }
    if (r.blocks !== undefined) { cur.firstBlocks ??= r.blocks; cur.lastBlocks = r.blocks }
    if (r.reward !== undefined) { cur.firstReward ??= r.reward; cur.lastReward = r.reward }
  }
  return [...byDay.values()].map((d) => ({
    day: d.day,
    // Prefer the chain-derived counter wherever the day has one; fall back to
    // the collector's only for days recorded before it existed.
    blocks: d.lastC !== undefined
      ? Math.max(0, d.lastC - (d.firstC ?? d.lastC))
      : (d.lastBlocks ?? 0) - (d.firstBlocks ?? 0),
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
const production = {
  counted: 0,
  lastBlock: undefined,
  scannedFrom: undefined,
  scannedTo: undefined,
  // Blocks actually read, which is the only honest denominator for a share.
  // A range the gateway refused is not a range with no blocks in it, and
  // (scannedTo - scannedFrom) would quietly count those as ours-that-weren't.
  scanned: 0,
  multiSigner: false,
  error: undefined,
  // Highest block already read. Lives here rather than in a module-local so the
  // scan's entire state is one object — inspectable, resettable, persistable.
  cursor: undefined,
  // The last N blocks in chain order: { n, mine, t }. Two things need it and
  // neither can come from the log — the pulse strip, and how many blocks this
  // node actually WON in a window. "Published block" in the log means submitted,
  // not accepted; only the chain says who won, and this repo has already been
  // wrong once by trusting the log for exactly that.
  recent: [],
}

// About an hour of chain at sequence's ~58s cadence, which is the window the
// collector totals losses over. Kept small deliberately: it is persisted, and a
// pulse strip nobody can read at a glance is not worth the bytes.
const RECENT_BLOCKS = envNum('DASH_RECENT_BLOCKS', 64, 8)

// ------------------------------------------------------------ peer producers
//
// The scan below already holds every block's signer list in order to find our
// own. Tallying the other addresses at the same time costs one Map write per
// signer and answers a question the page could not otherwise ask: who else is
// producing, and how do we compare.
//
// Deliberately not a second poller. A leaderboard built from an independent
// pass would drift from the "Share of chain" figure printed beside it, and two
// numbers on one page that disagree about the same blocks are worse than one
// number — that lesson is already written into how blocks came to be counted
// from the chain instead of from the log.

const PEERS_FILE = envStr('DASH_PEERS_FILE', '/var/lib/xl1/dashboard/peers.json')
const PEERS_EVERY_MS = envNum('DASH_PEERS_EVERY_MS', 300_000, 30_000)
const PEERS_TOP = envNum('DASH_PEERS_TOP', 12, 1)
// How many blocks one poll may spend dragging the cursor forward. The gateway
// caps a read at 200, so this is a budget of calls, and it exists because a
// dashboard that was down overnight must catch up over several polls rather
// than issuing hundreds of requests in one.
const PEERS_CATCHUP = envNum('DASH_PRODUCTION_CATCHUP', 1000, 200)

// ------------------------------------------------------------- day buckets
//
// A cumulative total answers "who has produced most since this dashboard
// started", which is not the question being asked when one node was offline for
// two days and another was not. "We are 200 behind today but 700 up overall" is
// two different measurements, and only the first one says anything about how
// the node is running right now.
//
// Every BoundWitness carries `$epoch` in milliseconds, so the scan that already
// reads the signer list can bucket the block by its own day at no extra cost.
// Bucketing by arrival time instead would have been simpler and wrong: a
// dashboard catching up after an outage would file yesterday's blocks under
// today and invent a spike on every restart.
const DAYS_KEPT = envNum('DASH_PEERS_DAYS', 35, 2)
// Days are local to whoever reads the page. "Today" is a human word, and on a
// UTC container an operator in Denver would watch it roll over at 18:00. The
// container's own clock stays UTC — only the bucket key is zoned.
const DAY_TZ = envStr('DASH_DAY_TZ', 'UTC')

let dayTzError
const dayFormatter = (() => {
  const build = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  try {
    return build(DAY_TZ)
  } catch {
    // An unusable zone must not take the standings down with it, but silently
    // falling back to UTC would leave "today" wrong with nothing on the page to
    // explain why the day rolls over six hours early.
    dayTzError = `DASH_DAY_TZ="${DAY_TZ}" is not a known time zone — bucketing by UTC instead`
    return build('UTC')
  }
})()

/** epoch ms → 'YYYY-MM-DD' in DAY_TZ. en-CA is ISO order by definition. */
function dayKey(epochMs) {
  return dayFormatter.format(new Date(epochMs))
}

/** 'YYYY-MM-DD' for today, and the N keys ending today, newest first. */
function todayKey() { return dayKey(Date.now()) }
function recentKeys(n) {
  const out = []
  const now = Date.now()
  for (let i = 0; i < n; i++) out.push(dayKey(now - i * 86_400_000))
  return out
}

/** day key → { scanned, counts: Map(address → blocks) }. Same blocks as the
 *  cumulative tally, split by the day the block says it was made. */
const days = new Map()

function bucket(dayKeyStr, signers) {
  let day = days.get(dayKeyStr)
  if (!day) {
    day = { scanned: 0, counts: new Map() }
    days.set(dayKeyStr, day)
  }
  day.scanned += 1
  for (const addr of signers) day.counts.set(addr, (day.counts.get(addr) ?? 0) + 1)
}

/** Drop buckets older than DAYS_KEPT so the file cannot grow without bound.
 *  Keyed by string comparison, which is date order for ISO dates. */
function pruneDays() {
  if (days.size <= DAYS_KEPT) return
  const keep = new Set([...days.keys()].sort().slice(-DAYS_KEPT))
  for (const k of [...days.keys()]) if (!keep.has(k)) days.delete(k)
}

// Names for addresses, so the standings read as producers rather than hex.
//
//   DASH_PEER_LABELS=a1b2c3d4e5f6...=Alice,9f3ac210=Bob
//
// Prefixes are accepted because a prefix is what a block explorer actually
// gives you — every one of them truncates the address in a table, and demanding
// all forty characters would mean no label at all until someone thinks to send
// their full address. Eight hex characters is 32 bits, so within a producer set
// this size a collision is not a practical concern.
//
// But a prefix that does match two observed addresses is refused rather than
// guessed at. A leaderboard with the wrong name against a row is worse than one
// with no names on it: the hex at least invites you to check, and a name does
// not.
const PEER_LABEL_MIN = 8

function parsePeerLabels(raw) {
  const entries = []
  const rejected = []
  for (const part of String(raw ?? '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq < 1) { rejected.push(`${item} — expected address=name`); continue }
    const key = item.slice(0, eq).trim().replace(/^0x/i, '').toLowerCase()
    const name = item.slice(eq + 1).trim()
    if (!name) { rejected.push(`${item} — no name given`); continue }
    if (!/^[0-9a-f]+$/.test(key)) { rejected.push(`${item} — "${key}" is not hex`); continue }
    if (key.length > 40) { rejected.push(`${item} — "${key}" is longer than an address`); continue }
    if (key.length < PEER_LABEL_MIN) {
      rejected.push(`${item} — needs at least ${PEER_LABEL_MIN} hex characters to be unambiguous`)
      continue
    }
    entries.push({ key, name, full: key.length === 40 })
  }
  // Exact addresses resolve before prefixes, so a full address always beats a
  // prefix that happens to cover it.
  entries.sort((a, b) => Number(b.full) - Number(a.full))
  return { entries, rejected }
}

const PEER_LABELS = parsePeerLabels(process.env.DASH_PEER_LABELS)

/** Resolve labels against the addresses actually observed. Deliberately not done
 *  at parse time: whether a prefix is ambiguous is a property of the address
 *  set, and that set grows as the scan sees more of the chain. A prefix that is
 *  unique today can stop being unique tomorrow, and this notices. */
function resolveLabels(addresses) {
  const byAddress = new Map()
  const ambiguous = []
  const unmatched = []

  for (const { key, name, full } of PEER_LABELS.entries) {
    const hits = full ? addresses.filter((a) => a === key) : addresses.filter((a) => a.startsWith(key))
    if (hits.length === 0) { unmatched.push({ name, key }); continue }
    if (hits.length > 1) { ambiguous.push({ name, key, matches: hits.length }); continue }
    // Two names claiming one address is a config mistake. Keep the first and
    // say so rather than letting the last line of the variable win silently.
    if (byAddress.has(hits[0])) { ambiguous.push({ name, key, matches: 1, clash: byAddress.get(hits[0]) }); continue }
    byAddress.set(hits[0], name)
  }
  return { byAddress, ambiguous, unmatched }
}

/** address (bare lowercase hex) → blocks signed, across every range we have
 *  ever scanned. Survives restarts via PEERS_FILE; without that the standings
 *  would reset to zero every time the container bounced, which on a Restart=
 *  always unit is often enough to make the record meaningless. */
const peers = new Map()
let peersSince
let peersError
let peersLastWrite = 0

async function loadPeers() {
  try {
    const doc = JSON.parse(await readFile(PEERS_FILE, 'utf8'))
    for (const [addr, n] of Object.entries(doc.counts ?? {})) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) peers.set(addr, n)
    }
    production.scannedFrom = doc.scannedFrom
    production.scannedTo = doc.scannedTo
    production.scanned = Number(doc.scanned) || 0
    production.multiSigner = Boolean(doc.multiSigner)
    peersSince = doc.since
    // Resume where the last run stopped rather than re-scanning a fresh window.
    // Re-scanning would double-count every block in the overlap, inflating both
    // our total and everyone else's by however long the dashboard was down.
    if (Number.isFinite(Number(doc.scannedTo))) production.cursor = Number(doc.scannedTo)
    // v1 files carry no day buckets. Left empty rather than seeded from the
    // totals: there is no honest way to split a cumulative number across the
    // days it came from, and backfillDays re-reads those blocks instead.
    days.clear()
    for (const [key, day] of Object.entries(doc.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const counts = new Map()
      for (const [addr, n] of Object.entries(day?.counts ?? {})) {
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) counts.set(addr, n)
      }
      if (counts.size > 0) days.set(key, { scanned: Number(day.scanned) || 0, counts })
    }
    pruneDays()
    production.daysFrom = Number.isFinite(Number(doc.daysFrom)) ? Number(doc.daysFrom) : undefined
    production.recent = Array.isArray(doc.recent)
      ? doc.recent.filter((r) => Number.isFinite(Number(r?.n))).slice(-RECENT_BLOCKS)
      : []
    const self = PRODUCER_ADDRESS || REWARD_ADDRESS
    if (self) production.counted = peers.get(self) ?? 0
    peersError = undefined
  } catch (error) {
    peersError = error.code === 'ENOENT' ? undefined : error.message?.slice(0, 160)
  }
}

async function persistPeers(force = false) {
  if (!force && Date.now() - peersLastWrite < PEERS_EVERY_MS) return
  if (peers.size === 0) return

  peersSince ??= new Date().toISOString()
  const doc = {
    v: 2,
    since: peersSince,
    updatedAt: new Date().toISOString(),
    scannedFrom: production.scannedFrom,
    scannedTo: production.scannedTo,
    scanned: production.scanned,
    multiSigner: production.multiSigner,
    counts: Object.fromEntries([...peers.entries()].sort((a, b) => b[1] - a[1])),
    // Lowest block represented in the day buckets. Without it a restart cannot
    // tell a backfill that finished from one that never ran, and the standings
    // would re-read the same history on every boot forever.
    daysFrom: production.daysFrom,
    // Persisted so the pulse is populated on the first paint after a restart.
    // Rebuilding it from the scan alone would take an hour of chain to refill,
    // during which the strip would understate this node for no reason.
    recent: production.recent.slice(-RECENT_BLOCKS),
    days: Object.fromEntries([...days.entries()].sort().map(([key, day]) => [key, {
      scanned: day.scanned,
      counts: Object.fromEntries([...day.counts.entries()].sort((a, b) => b[1] - a[1])),
    }])),
  }

  try {
    // Written whole, then renamed. A partial write here is not a lost sample
    // like the trend store — it is a corrupt standings file that fails to parse
    // on the next boot and silently resets every total to zero.
    await writeFile(`${PEERS_FILE}.tmp`, JSON.stringify(doc))
    await rename(`${PEERS_FILE}.tmp`, PEERS_FILE)
    peersLastWrite = Date.now()
    peersError = undefined
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await mkdir(dirname(PEERS_FILE), { recursive: true })
        peersError = undefined
      } catch {
        peersError = `${dirname(PEERS_FILE)} does not exist and cannot be created`
          + ' — xl1-dashboard.service needs a rw bind mount for it (systemctl daemon-reload after updating the unit)'
      }
      return
    }
    peersError = error.code === 'EACCES' || error.code === 'EROFS'
      ? `${dirname(PEERS_FILE)} is mounted read-only — update xl1-dashboard.service and daemon-reload`
      : error.message?.slice(0, 160)
  }
}

/** Scan only what is new. The first pass looks back a window; afterwards it
 *  reads the blocks that appeared since, so the cost does not grow with uptime.
 *  Walks forward in chunks and advances the cursor only over blocks it actually
 *  read — an earlier version asked for the newest 200 and then jumped the
 *  cursor to the head, which after any real outage booked the skipped middle as
 *  scanned and lost those blocks from every total for good. */
async function scanProduction(viewer, currentNum) {
  const self = PRODUCER_ADDRESS || REWARD_ADDRESS
  if (!Number.isFinite(currentNum)) return

  const WINDOW = Number(envNum('DASH_PRODUCTION_WINDOW', 120, 10))
  let from = production.cursor === undefined
    ? Math.max(0, currentNum - WINDOW + 1)
    : production.cursor + 1
  if (from > currentNum) return

  production.scannedFrom ??= from
  peersSince ??= new Date().toISOString()
  let budget = PEERS_CATCHUP

  try {
    while (from <= currentNum && budget > 0) {
      // blocksByNumber reads newest-first from a chosen top, which is what
      // makes a range in the middle reachable at all.
      const top = Math.min(currentNum, from + 199)
      const limit = top - from + 1
      const blocks = await viewer.block.blocksByNumber(top, limit)

      if (!blocks?.length) {
        // An empty answer is far more likely to be the gateway declining than a
        // genuinely empty range. Advancing past it would mark those blocks
        // scanned forever, so stop and retry the same range next poll.
        production.error = `gateway returned no blocks for ${from}-${top}`
        break
      }

      for (const entry of blocks) {
        const bw = Array.isArray(entry) ? entry[0] : entry
        const n = Number(bw?.block)
        if (!Number.isFinite(n) || n < from || n > top) continue

        const signers = new Set((bw?.addresses ?? [])
          .map((a) => String(a).replace(/^0x/i, '').toLowerCase())
          .filter(Boolean))
        if (signers.size === 0) continue
        if (signers.size > 1) production.multiSigner = true

        production.scanned += 1
        for (const addr of signers) peers.set(addr, (peers.get(addr) ?? 0) + 1)

        // $epoch is the block's own millisecond timestamp. A block without one
        // is counted in the totals and left out of every day window rather than
        // filed under an invented date; the count is surfaced so a chain that
        // stopped carrying $epoch shows up as undated blocks instead of as days
        // that quietly stop adding up.
        const epoch = Number(bw?.$epoch)
        if (Number.isFinite(epoch) && epoch > 0) {
          bucket(dayKey(epoch), signers)
          if (production.daysFrom === undefined || n < production.daysFrom) production.daysFrom = n
        } else {
          production.undated = (production.undated ?? 0) + 1
        }

        production.recent.push({ n, mine: Boolean(self && signers.has(self)), t: epoch || undefined })

        // Our own figure comes out of the same pass, over the same definition
        // of "produced", so the headline and the table can never disagree.
        if (self && signers.has(self)) {
          production.counted += 1
          if (production.lastBlock === undefined || n > production.lastBlock) production.lastBlock = n
        }
      }

      // blocksByNumber answers newest-first, so pushing in iteration order would
      // build the pulse strip backwards — it reads oldest-left, like the chain.
      // Sorted after the batch rather than per block: 64 entries, once a poll.
      production.recent.sort((a, b) => a.n - b.n)
      if (production.recent.length > RECENT_BLOCKS) {
        production.recent.splice(0, production.recent.length - RECENT_BLOCKS)
      }

      production.cursor = top
      production.scannedTo = top
      from = top + 1
      budget -= limit
      if (!production.error) production.error = undefined
    }
    if (from > currentNum) production.error = undefined
    pruneDays()
    production.behind = Math.max(0, currentNum - (production.scannedTo ?? currentNum))
  } catch (error) {
    // Leave the cursor alone so the same range is retried rather than skipped.
    production.error = error.message?.slice(0, 160)
  }
}

/** Fill day buckets for blocks the totals already contain.
 *
 *  Upgrading from a v1 file leaves the standings with two days of totals and no
 *  history to split them by, so the windows would read zero while the total read
 *  three thousand. This walks the already-counted range backwards, bucketing
 *  only — it never touches `peers` or `production.scanned`, because those blocks
 *  are counted there already and adding them twice is exactly the failure the
 *  cursor logic exists to prevent.
 *
 *  Runs after the forward scan and shares its per-poll budget, so catching up on
 *  the head always wins over reconstructing the past. */
async function backfillDays(viewer) {
  if (production.scannedFrom === undefined || production.daysFrom === undefined) return
  let to = production.daysFrom - 1
  if (to < production.scannedFrom) return

  let budget = PEERS_CATCHUP
  try {
    while (to >= production.scannedFrom && budget > 0) {
      const from = Math.max(production.scannedFrom, to - 199)
      const limit = to - from + 1
      const blocks = await viewer.block.blocksByNumber(to, limit)
      if (!blocks?.length) {
        // Same reasoning as the forward scan: an empty answer is the gateway
        // declining, and moving daysFrom past it would mark those days filled.
        production.daysError = `gateway returned no blocks for ${from}-${to}`
        break
      }

      for (const entry of blocks) {
        const bw = Array.isArray(entry) ? entry[0] : entry
        const n = Number(bw?.block)
        if (!Number.isFinite(n) || n < from || n > to) continue
        const epoch = Number(bw?.$epoch)
        if (!Number.isFinite(epoch) || epoch <= 0) continue
        const signers = new Set((bw?.addresses ?? [])
          .map((a) => String(a).replace(/^0x/i, '').toLowerCase())
          .filter(Boolean))
        if (signers.size === 0) continue
        bucket(dayKey(epoch), signers)
      }

      production.daysFrom = from
      to = from - 1
      budget -= limit
      production.daysError = undefined
    }
    pruneDays()
  } catch (error) {
    production.daysError = error.message?.slice(0, 160)
  }
}

/** The standings, newest tally first. Shares divide by blocks actually read,
 *  never by the height range, so an outage shrinks the sample rather than
 *  silently deflating everyone's percentage. */
function peerBoard() {
  const self = PRODUCER_ADDRESS || REWARD_ADDRESS
  const scanned = production.scanned || 0
  const { byAddress: labels, ambiguous, unmatched } = resolveLabels([...peers.keys()])

  /** One ranked table over one tally. Every window is built by this, so a row
   *  means the same thing whichever column it is read from. */
  const rank = (counts, denominator) => {
    const rows = [...counts.entries()]
      .map(([address, blocks]) => ({
        address,
        blocks,
        sharePercent: denominator > 0 ? Number(((blocks / denominator) * 100).toFixed(2)) : undefined,
        isSelf: Boolean(self) && address === self,
        label: labels.get(address),
        url: explorerAddress(address),
      }))
      // Ties broken by address so the order does not jitter between polls.
      .sort((a, b) => b.blocks - a.blocks || a.address.localeCompare(b.address))
    rows.forEach((r, i) => { r.rank = i + 1 })
    // The gap to this node, which is the number actually being asked for when
    // one producer is chasing another. Positive means they are ahead of us.
    const mineHere = rows.find((r) => r.isSelf)
    if (mineHere) for (const r of rows) r.vsSelf = r.blocks - mineHere.blocks
    return rows
  }

  /** Sum a set of day buckets into one tally. */
  const over = (keys) => {
    const counts = new Map()
    let denominator = 0
    let covered = 0
    for (const key of keys) {
      const day = days.get(key)
      if (!day) continue
      covered += 1
      denominator += day.scanned
      for (const [addr, n] of day.counts) counts.set(addr, (counts.get(addr) ?? 0) + n)
    }
    return { counts, denominator, covered }
  }

  /** A window as the page consumes it: ranked rows plus what they rest on. */
  const windowOf = (keys) => {
    const { counts, denominator, covered } = over(keys)
    const rows = rank(counts, denominator)
    const mineHere = rows.find((r) => r.isSelf)
    return {
      days: keys.length,
      daysWithData: covered,
      from: keys.at(-1),
      to: keys[0],
      scannedBlocks: denominator,
      producers: rows.length,
      selfRank: mineHere?.rank,
      self: mineHere,
      leader: rows[0],
      top: rows.slice(0, PEERS_TOP),
      // Every address in the window, not just the visible top. The page lists
      // rows in total order and reads each one's window figure out of this, so
      // a producer ranked 3rd overall and 1st today still shows both numbers.
      blocksByAddress: Object.fromEntries(rows.map((r) => [r.address, r.blocks])),
    }
  }

  const rows = rank(peers, scanned)
  const mine = rows.find((r) => r.isSelf)

  return {
    producers: rows.length,
    scannedBlocks: scanned,
    scannedFrom: production.scannedFrom,
    scannedTo: production.scannedTo,
    since: peersSince,
    // Shares sum past 100% when blocks carry more than one signer. Said out
    // loud rather than normalised away, because the page would otherwise look
    // arithmetically broken to anyone who added the column up.
    multiSigner: production.multiSigner,
    selfRank: mine?.rank,
    self: mine,
    top: rows.slice(0, PEERS_TOP),
    // Windows over the same blocks as the total above, split by the day each
    // block reports. A producer that was offline for two days is behind on the
    // total and level for today, and only one of those is news.
    windows: {
      today: windowOf([todayKey()]),
      week: windowOf(recentKeys(7)),
    },
    dayTz: DAY_TZ,
    dayTzError,
    daysKept: DAYS_KEPT,
    daysStored: days.size,
    // How far back the day buckets reach, against how far the totals do. While
    // a backfill is still running these differ, and a week window that is quietly
    // missing its oldest days would otherwise read as a producer having a quiet
    // week.
    daysFrom: production.daysFrom,
    daysComplete: production.daysFrom !== undefined
      && production.scannedFrom !== undefined
      && production.daysFrom <= production.scannedFrom,
    daysError: production.daysError,
    undated: production.undated,
    // Labels that could not be applied. Surfaced rather than dropped: a name
    // silently missing from the table looks identical to a producer who has
    // stopped, and the operator would go looking at the wrong thing.
    labels: {
      applied: labels.size,
      configured: PEER_LABELS.entries.length,
      ambiguous,
      unmatched,
      rejected: PEER_LABELS.rejected,
    },
    error: peersError,
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
    await backfillDays(viewer)

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

    // Blocks this node produced, split by window. A single cumulative count
    // cannot distinguish a node that earned steadily from one that earned it all
    // yesterday and has done nothing since.
    //
    // Each window comes from the source that can answer it honestly. The hour is
    // the recent-blocks ring, which is chain truth but only reaches back as far
    // as it reaches — so the span it actually covers is reported beside it and
    // the number is withheld until it covers most of an hour. Today and the week
    // come from the day buckets, which are the same blocks the standings count.
    blocksByWindow: (() => {
      const ring = (production.recent ?? []).filter((b) => Number.isFinite(b.t))
      const board = peerBoard()
      const hourAgo = Date.now() - 3_600_000
      const inHour = ring.filter((b) => b.t >= hourAgo)
      const coverage = ring.length > 1
        ? Math.round((Date.now() - Math.max(ring[0].t, hourAgo)) / 1000) : 0
      // A rolling 24 hours, from the trend store rather than the day buckets.
      //
      // "Today" is a calendar day and collapses at local midnight: at 00:10 it
      // reads 2 while the rolling hour beside it reads 12, which looks broken
      // and is merely two different windows. A producer restart does the same
      // thing to anything counted in-process. This number does neither — cblocks
      // is chain-derived and cumulative, sampled every five minutes and kept for
      // thirty days, so it survives a restart of the producer, the dashboard, or
      // both, and it never resets at a wall-clock boundary.
      const day = (() => {
        if (trend.length < 2) return {}
        const cutoff = Date.now() - 86_400_000
        const withC = trend.filter((r) => Number.isFinite(r.cblocks))
        if (withC.length < 2) return {}
        // The oldest sample still inside the window, or the oldest we have.
        const first = withC.find((r) => r.t >= cutoff) ?? withC[0]
        const last = withC.at(-1)
        const spanSeconds = Math.round((last.t - first.t) / 1000)
        const delta = last.cblocks - first.cblocks
        return {
          // Negative means the underlying counter was reset — peers.json lost or
          // rebuilt — and a negative block count is nonsense, so say nothing.
          day24h: delta >= 0 ? delta : undefined,
          day24hSpanSeconds: spanSeconds,
          // Below about twenty hours this is a partial window wearing a
          // twenty-four hour label, so the page says how much it actually covers.
          day24hComplete: spanSeconds >= 72_000,
        }
      })()

      return {
        // Withheld rather than understated: a ring covering twenty minutes would
        // report a third of the hour's blocks as if it were the hour's total.
        hour: coverage >= 3000 ? inHour.filter((b) => b.mine).length : undefined,
        hourCoverageSeconds: coverage,
        today: board.windows?.today?.self?.blocks ?? 0,
        week: board.windows?.week?.self?.blocks ?? 0,
        total: board.self?.blocks,
        ...day,
      }
    })(),

    // Age of the newest block seen, from the block's own $epoch. The chain
    // height alone cannot say whether the chain is moving — a stalled chain and
    // a healthy one show the same number until you watch it for a while.
    headAgeSeconds: (() => {
      const last = (production.recent ?? []).filter((b) => Number.isFinite(b.t)).at(-1)
      return last ? Math.max(0, Math.round((Date.now() - last.t) / 1000)) : undefined
    })(),

    // When the reward balance last moved, and by how much. The balance says how
    // much has been earned; this says whether it is still being earned, which a
    // cumulative figure can never show — a node that stopped an hour ago reads
    // identically to one still winning.
    ...(() => {
      const r = history.reward ?? []
      for (let i = r.length - 1; i > 0; i--) {
        const delta = Number(r[i].v) - Number(r[i - 1].v)
        if (Number.isFinite(delta) && delta > 0) {
          return {
            lastPayoutSeconds: Math.max(0, Math.round((Date.now() - r[i].t) / 1000)),
            lastPayoutXl1: Number(delta.toFixed(4)),
          }
        }
      }
      return {}
    })(),

    // Operator summaries, all of them arithmetic over data already in this
    // payload. No new request, no new telemetry, no work in the producer.
    operations: (() => {
      const race = state.node?.race
      const lat = state.node?.latency
      const board = peerBoard()
      const ring = production.recent ?? []

      // -- efficiency score ------------------------------------------------
      //
      // Transparent by construction: every component is published beside the
      // total, and the total is the mean of whichever components could be
      // computed. A score whose parts are hidden is a vanity number, and a
      // score that silently treats a missing part as zero is worse than none.
      //
      // Thresholds are stated here rather than tuned to flatter this node:
      //  - latency: the producer's own produceBlock budget is 1000ms. A cycle
      //    at or under half the budget is full marks; at twice the budget, zero.
      //  - race health: the share of builds that were NOT rejected locally.
      //  - win rate: measured against an even split of the chain, not against
      //    100% — with seven producers, parity is 1/7 and that is what 100 means.
      //  - reliability: restarts and errors seen in the collector's window.
      const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))
      const components = []

      if (Number.isFinite(lat?.cycleP50Ms)) {
        components.push(['Latency', clamp(100 * (2000 - lat.cycleP50Ms) / 1500), `cycle p50 ${lat.cycleP50Ms}ms vs a 1000ms budget`])
      }
      if (Number.isFinite(race?.built) && race.built > 0) {
        const lost = Object.values(race.lost ?? {}).reduce((a, b) => a + b, 0)
        components.push(['Race health', clamp(100 * (1 - lost / race.built)), `${lost} of ${race.built} builds rejected locally`])
      }
      const producers = board.producers || 0
      const ourShare = board.self?.sharePercent
      if (producers > 0 && Number.isFinite(ourShare)) {
        const fair = 100 / producers
        components.push(['Win rate', clamp(100 * (ourShare / fair)), `${ourShare}% of the chain against a ${fair.toFixed(1)}% even split`])
      }
      const restarts = Number(state.node?.container?.restartCount)
      if (Number.isFinite(restarts)) {
        components.push(['Reliability', clamp(100 - restarts * 10), restarts === 0 ? 'no container restarts' : `${restarts} container restart(s)`])
      }

      const score = components.length > 0
        ? Math.round(components.reduce((a, [, v]) => a + v, 0) / components.length)
        : undefined

      // -- streaks, from the persisted ring --------------------------------
      const sinceWin = (() => {
        for (let i = ring.length - 1, gap = 0; i >= 0; i--, gap++) if (ring[i].mine) return gap
        return undefined   // no win inside the ring at all — not "zero"
      })()
      let longestGap
      if (ring.some((b) => b.mine)) {
        let run = 0
        longestGap = 0
        for (const b of ring) {
          if (b.mine) { longestGap = Math.max(longestGap, run); run = 0 } else run++
        }
        longestGap = Math.max(longestGap, run)
      }

      // -- network competition ---------------------------------------------
      const shares = (board.top ?? []).map((r) => r.sharePercent).filter(Number.isFinite).sort((a, b) => b - a)
      const median = shares.length > 0 ? shares[Math.floor(shares.length / 2)] : undefined
      const competition = shares.length > 0 ? {
        producers,
        leaderShare: shares[0],
        topThreeShare: Number(shares.slice(0, 3).reduce((a, b) => a + b, 0).toFixed(2)),
        ourShare,
        medianShare: median,
        vsMedian: Number.isFinite(ourShare) && Number.isFinite(median)
          ? Number((ourShare - median).toFixed(2)) : undefined,
        vsLeader: Number.isFinite(ourShare) ? Number((ourShare - shares[0]).toFixed(2)) : undefined,
      } : undefined

      // -- bottleneck: one statement, derived, never guessed ----------------
      const bottleneck = (() => {
        const lost = race?.lost ?? {}
        const lostTotal = Object.values(lost).reduce((a, b) => a + b, 0)
        if (lostTotal >= 5) {
          const pct = (n) => Math.round((n / lostTotal) * 100)
          if (pct(lost.txAlreadyFinalized ?? 0) >= 50) {
            return { key: 'mempool', text: `Stale mempool data caused ${pct(lost.txAlreadyFinalized)}% of rejected candidates.` }
          }
          if (pct(lost.behindFinalizedHead ?? 0) >= 50) {
            return { key: 'competition', text: `Head advanced first on ${pct(lost.behindFinalizedHead)}% of rejections — we are being outrun, not failing.` }
          }
        }
        if (Number.isFinite(lat?.localMs) && Number.isFinite(lat?.wireFloorMs) && lat.localMs > lat.wireFloorMs) {
          return { key: 'local', text: `Local work dominates: ${lat.localMs}ms of a ${lat.typicalMs}ms head fetch is this machine, not the network.` }
        }
        // A cycle over budget only matters if it is costing something, and the
        // producer publishes exactly that: a check skipped because the previous
        // one was still running, or a publish the chain refused. With both at
        // zero this is a characteristic of the hardware, not a fault — the
        // producer's own log agrees, warning only at 10x. Saying "bottleneck"
        // in amber over a node sitting 3rd of 7 trains an operator to ignore
        // the card, which costs more than the milliseconds do.
        //
        // p95 also mixes two populations: ~88% of checks are idle at a few
        // hundred ms, and the tail is producing cycles, which are inherently
        // longer. That is stated rather than smoothed away.
        if (Number.isFinite(lat?.cycleP95Ms) && lat.cycleP95Ms > 2000) {
          const skipped = Number(state.node?.latency?.skippedChecks)
          const rejected = Number(state.node?.latency?.rejectedPublishes)
          const strained = (Number.isFinite(skipped) && skipped > 0) || (Number.isFinite(rejected) && rejected > 0)
          return strained
            ? {
              key: 'cycle',
              text: `Cycle p95 is ${lat.cycleP95Ms}ms against a 1000ms budget, and it is costing work: `
                + `${skipped || 0} check(s) skipped, ${rejected || 0} publish(es) rejected.`,
            }
            : {
              key: 'none',
              text: `Cycle p95 is ${lat.cycleP95Ms}ms against a 1000ms budget — the producing tail, not the typical `
                + `cycle. No check skipped and no publish rejected, so it is costing nothing measurable.`,
            }
        }
        if (!race && !lat) return { key: 'unknown', text: 'Insufficient data.' }
        return { key: 'none', text: 'No local performance constraint detected.' }
      })()

      return {
        score,
        components: components.map(([label, value, why]) => ({ label, value, why })),
        sinceWin,
        longestGap,
        ringBlocks: ring.length || undefined,
        competition,
        bottleneck,
        // Stage timings are p50s of separate, NESTED distributions — cycle
        // contains headFetch and blockProduction, and blockProduction contains
        // the mempool calls. They deliberately are not rendered as a waterfall
        // summing to 100%, because they do not sum and saying they do would
        // invent a decomposition the instrumentation cannot support.
        stages: lat?.stages ?? state.node?.latency?.stages,
      }
    })(),

    // The candidate race: why blocks are being lost, and how often.
    //
    // Deliberately mixed-source, and the sources are not interchangeable.
    // Losses and retries come from the producer's log, which is the only place
    // that says WHY a candidate died. Wins come from the chain scan, because a
    // log line saying "Published block" means submitted, not accepted — the
    // distinction this repo already got wrong once, when a dashboard reported
    // zero blocks for a node producing several every ten minutes.
    //
    // The two windows differ and are reported separately rather than blended:
    // the log window is whatever the collector totalled, the chain window is
    // however far the recent-blocks ring reaches back.
    race: (() => {
      const r = state.node?.race
      const lost = r?.lost ?? {}
      const reasons = [
        ['behindFinalizedHead', 'head advanced first', lost.behindFinalizedHead],
        ['txAlreadyFinalized', 'tx already finalized', lost.txAlreadyFinalized],
        ['blockNumberMismatch', 'built on another head', lost.blockNumberMismatch],
      ].filter(([, , n]) => Number.isFinite(n))
      const lostTotal = reasons.reduce((a, [, , n]) => a + n, 0)

      // Wins over the ring, which is chain truth. Reported with the span it
      // covers so it is never mistaken for the log window's hour.
      const ring = production.recent ?? []
      const timed = ring.filter((b) => Number.isFinite(b.t))
      const chainWindowSeconds = timed.length > 1
        ? Math.round((timed.at(-1).t - timed[0].t) / 1000) : undefined

      if (!r && ring.length === 0) return undefined
      return {
        windowSeconds: r?.windowSeconds,
        observedSeconds: r?.observedSeconds,
        built: r?.built,
        retries: r?.retries,
        lostTotal: reasons.length > 0 ? lostTotal : undefined,
        // Share of losses, not of builds: this answers "when we lose, why",
        // which is the question. Omitted entirely rather than shown as 0% each
        // when nothing has been lost yet.
        reasons: lostTotal > 0
          ? reasons
            .map(([key, label, n]) => ({ key, label, count: n, percent: Math.round((n / lostTotal) * 100) }))
            .sort((a, b) => b.count - a.count)
          : [],
        won: ring.length > 0 ? ring.filter((b) => b.mine).length : undefined,
        chainBlocks: ring.length || undefined,
        chainWindowSeconds,
        // The strip itself: chain order, oldest first, one entry per block.
        pulse: ring.map((b) => (b.mine ? 1 : 0)),
      }
    })(),

    // Latency, split into the two things an operator is actually guessing
    // between. headFetch runs on every check, so its min is the wire floor to
    // the gateway and its p50 includes the local work of parsing and validating
    // the answer. Their difference is this box's own contribution — the number
    // that says "the network is slow" or "this machine is slow" rather than
    // leaving both on the table.
    //
    // Measured by the producer itself and read off its health port, so nothing
    // here costs a chain request.
    latency: (() => {
      const l = state.node?.latency
      if (!l || l.headFetchP50Ms === undefined) return undefined
      const wire = l.headFetchMinMs
      const typical = l.headFetchP50Ms
      return {
        wireFloorMs: wire,
        typicalMs: typical,
        p95Ms: l.headFetchP95Ms,
        localMs: (typeof wire === 'number' && typeof typical === 'number')
          ? Math.round(typical - wire) : undefined,
        cycleP50Ms: l.cycleP50Ms,
        cycleP95Ms: l.cycleP95Ms,
        samples: l.samples,
      }
    })(),
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
    // Share of the chain's blocks this node signed. The denominator is blocks
    // actually read, not the height range: after an outage those differ, and
    // dividing by the range would report a share the node never had.
    producedSharePercent: production.scanned > 0
      ? Number(((production.counted / production.scanned) * 100).toFixed(2))
      : undefined,
    producedScanned: production.scanned,
    // Blocks the scan has not caught up on yet. Nonzero here is why a share may
    // look stale, and an operator should be able to see that rather than guess.
    productionBehind: production.behind,
  }
}

const snapshot = () => ({
  ...overall(),
  generatedAt: new Date().toISOString(),
  dashboardStartedAt: state.startedAt,
  // Which build of this dashboard is answering. The image tag is the same
  // string before and after every deploy, so without this a redeploy can only
  // be confirmed by watching some number change and hoping it was ours.
  // Read from the environment the image baked in — no filesystem, no cost.
  build: (() => {
    const commit = BUILD_STAMP.commit ?? envStr('DASH_COMMIT', 'unknown')
    // Where this build's source lives. Configurable because the same file runs
    // two dashboards from two repositories, and the footer had the Pi's URL
    // hardcoded — so the Windows page has been pointing at the wrong source.
    const source = envStr('DASH_SOURCE_URL', 'https://github.com/LewSales/xl1-block-producer-pi')
      .replace(/\/+$/, '')
    // A dirty build is not on GitHub. Linking its hash would land on a 404, and
    // an invitation to "verify the code" that 404s is worse than no link — so
    // the commit link only exists when the tree it was built from was clean.
    const clean = commit !== 'unknown' && !commit.endsWith('-dirty')
    return {
      version: BUILD_STAMP.version ?? DASH_VERSION,
      commit,
      builtAt: BUILD_STAMP.builtAt ?? envStr('DASH_BUILT_AT', 'unknown'),
      source,
      commitUrl: clean ? `${source}/commit/${commit}` : undefined,
      // Who wrote each half. Configurable rather than hardcoded so a fork does
      // not end up crediting someone else's brand for its own dashboard.
      brandName: envStr('DASH_BRAND_NAME', 'WinLEW'),
      brandUrl: envStr('DASH_BRAND_URL', 'https://winlew.co'),
      upstreamName: envStr('DASH_UPSTREAM_NAME', 'XYO Network'),
      upstreamUrl: envStr('DASH_UPSTREAM_URL', 'https://xyo.network'),
    }
  })(),
  ...state,
  release: { ...state.release, installed: state.node?.cliVersion, lag: versionLag(state.node?.cliVersion, state.release?.latest) },
  derived: derived(),
  peers: peerBoard(),
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
export { formatXl1, versionLag, decodeThrottle, perHour, overall, derived, envStr, envNum, pollNode, snapshot, state, history, trendDaily, loadTrend, trend, peerBoard, loadPeers, persistPeers, scanProduction, backfillDays, peers, production, days, dayKey, recentKeys }

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
  // Before pollChain: the first scan reads the resumed cursor, and starting it
  // from a fresh window instead would re-count every block in the overlap.
  await loadPeers()
  if (peersError) console.warn(`xl1-dashboard: producer standings unavailable — ${peersError}`)
  await Promise.all([pollChain(), pollHealth(), pollNode(), pollSystem(), pollRelease()])
  if (trendError) console.warn(`xl1-dashboard: long-range history unavailable — ${trendError}`)

  // Each poller catches internally, but a rejection escaping one of them would
  // take the process down, so none of these promises may go unwatched.
  const guard = (fn, name) => () => { Promise.resolve(fn()).catch((e) => console.error(`xl1-dashboard: ${name} failed —`, e)) }

  setInterval(guard(pollChain, 'pollChain'), CHAIN_POLL_MS).unref()
  // Checked often, written rarely — persistTrend decides for itself whether
  // enough time has passed, so the cadence lives in one place.
  setInterval(guard(persistTrend, 'persistTrend'), 60_000).unref()
  setInterval(guard(persistPeers, 'persistPeers'), 60_000).unref()
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
      // Flush first: a restart is exactly when the last few minutes of tallying
      // would otherwise be dropped, and deploys are frequent enough for that to
      // add up to a visibly wrong record.
      persistPeers(true).catch(() => {}).finally(() => {
        server.close(() => process.exit(0))
      })
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}
