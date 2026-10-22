// XL1 race service: keeps a read-only watch on the block race and serves race.json locally,
// for the "XL1 Race Publisher" task to push to xl1-status-data (read by winlew.co/xl1/race/).
//
//   node race-service.mjs            run (the "XL1 Race Service" task starts it at logon)
//   node race-service.mjs --once     observe for OBSERVE_ONCE_MS, write race.json, exit (testing)
//
// Never contacts a producer's process. It reads:
//   - the public candidate pool and pending transactions (XYO RPC, read-only methods)
//   - the published head and recent finalized blocks (the public REST CDN)
//   - optionally, our nodes' own build logs (RACE_BUILDLOGS=windows: docker logs here,
//     journalctl on the Pi over ssh; =none: arrival order only)
// Settings (environment): RACE_NETWORK sequence|mainnet, RACE_PORT 8099, RACE_STATE_DIR,
// RACE_WINDOW_H 6, RACE_POOL_MS 500, RACE_HEAD_MS 500, RACE_TX_MS 1000, RACE_REBUILD_MS 120000,
// RACE_WATERFALL 40, RACE_BUILDLOGS windows|none, RACE_PI_SSH xl1pi@xl1pi,
// RACE_WIN_CONTAINER xl1-node-preset-1, and a guard for when it runs beside a producer:
// RACE_GUARD_URL (that producer's dashboard /api/public) + RACE_GUARD_P95_MS (2500): while the
// producer's 95th-percentile cycle is above it, the observer stops polling for 10 minutes.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildDataset, makeNameOf, parseBuildLog } from './race-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = (k, d) => (process.env[k] ?? d)
const STATE = env('RACE_STATE_DIR', path.resolve(HERE, '..', '..', 'state', 'race'))
fs.mkdirSync(STATE, { recursive: true })
const NET = env('RACE_NETWORK', 'sequence')
if (!['sequence', 'mainnet'].includes(NET)) throw new Error(`RACE_NETWORK must be sequence or mainnet, not ${NET}`)
const nameOf = makeNameOf(NET)
const BUILDLOGS = env('RACE_BUILDLOGS', NET === 'sequence' ? 'windows' : 'none')
const GUARD_URL = env('RACE_GUARD_URL', ''), GUARD_P95 = +env('RACE_GUARD_P95_MS', 2500)
const PORT = +env('RACE_PORT', 8099), WINDOW = +env('RACE_WINDOW_H', 6) * 3.6e6
const POOL_MS = +env('RACE_POOL_MS', 500), HEAD_MS = +env('RACE_HEAD_MS', 500), TX_MS = +env('RACE_TX_MS', 1000)
const REBUILD_MS = +env('RACE_REBUILD_MS', 120000), WATERFALL = +env('RACE_WATERFALL', 40)
const PI_SSH = env('RACE_PI_SSH', 'xl1pi@xl1pi'), WIN_CONTAINER = env('RACE_WIN_CONTAINER', 'xl1-node-preset-1')
const ONCE = process.argv.includes('--once'), ONCE_MS = +env('OBSERVE_ONCE_MS', 120000)
const ENDPOINTS = {
  sequence: { rpc: 'https://beta.api.chain.xyo.network/rpc', head: 'https://state.sequence.xyo.space/chain/head.json', blocks: 'https://blocks.sequence.xyo.space/block/number/' },
  mainnet: { rpc: 'https://api.chain.xyo.network/rpc', head: 'https://state.mainnet.xyo.space/chain/head.json', blocks: 'https://blocks.mainnet.xyo.space/block/number/' },
}
const { rpc: RPC, head: CDN_HEAD, blocks: CDN_BLOCKS } = ENDPOINTS[NET]

// ---- guard: when beside a producer, step aside if it is struggling ----
let pausedUntil = 0
async function guardLoop(until) {
  if (!GUARD_URL) return
  while (Date.now() < until) {
    try {
      const d = await (await fetch(GUARD_URL, { signal: AbortSignal.timeout(4000) })).json()
      const p95 = d?.latency?.cycleP95Ms
      if (p95 != null && p95 > GUARD_P95) {
        if (Date.now() > pausedUntil) log(`guard: producer cycle p95 ${p95} ms > ${GUARD_P95} ms, pausing polls for 10 min`)
        pausedUntil = Date.now() + 600000
      }
    } catch {}
    await sleep(60000)
  }
}
const paused = () => Date.now() < pausedUntil
const EVENTS_FILE = path.join(STATE, 'events.jsonl'), CHAIN_FILE = path.join(STATE, 'chain.json'), OUT_FILE = path.join(STATE, 'race.json'), LOG_FILE = path.join(STATE, 'service.log')

const log = m => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`) } catch {} }
// The service runs in a hidden window, so a crash printed to the console is a crash nobody
// sees. Write it here, then exit non-zero: the scheduled task's 5-minute trigger restarts it.
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { log(`fatal ${ev}: ${e?.stack ?? e}`); process.exit(1) })
process.on('exit', code => { if (code) log(`exit ${code}`) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) })).json()).result
const timeOf = p => (p || []).find(x => x.schema === 'network.xyo.time') || {}
// Independent check of each candidate's hash, from the bytes the poll already returned: SHA-256 of
// compact JSON, keys sorted at every level, top-level '_' fields removed (oxyon-evidence xyo_hash).
// true = recomputed and equal to the RPC's _hash; false = recomputed and different; null = could not.
const sortDeep = v => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v
const hashVerified = bw => { try { return createHash('sha256').update(JSON.stringify(sortDeep(Object.fromEntries(Object.entries(bw).filter(([k]) => !k.startsWith('_')))))).digest('hex') === bw._hash } catch { return null } }

// ---- state: rolling events, loaded from disk so a restart keeps the window ----
let events = []
try { events = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && e.t > Date.now() - WINDOW) } catch {}
// Dedupe sets, rebuilt from the window at every rebuild (see rebuild()). They
// were never pruned: every hash seen since start stayed until the process died.
const windowSet = k => new Set(events.filter(e => e.k === k).map(e => e.hash))
let seenCand = windowSet('cand'), seenTx = windowSet('tx')
let lastHead = null
const add = e => { events.push(e); try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n') } catch {} }
// Watchdog heartbeats (see the self-watchdog section). RACE_TEST_FREEZE=pool|head|tx freezes that loop
// after a few iterations, for tests only.
const beats = { pool: Date.now(), head: Date.now(), tx: Date.now() }, iterations = { pool: 0, head: 0, tx: 0 }
const TEST_FREEZE = env('RACE_TEST_FREEZE', '')
const beat = name => { beats[name] = Date.now(); iterations[name]++; return TEST_FREEZE === name && iterations[name] > 3 ? new Promise(() => {}) : undefined }

async function poolLoop(until) {
  while (Date.now() < until) {
    await beat('pool')
    const s = Date.now()
    if (paused()) { await sleep(POOL_MS); continue }
    try {
      const res = (await rpc('mempoolViewer_pendingBlocks', [])) || []
      const t = Date.now()
      res.forEach(([bw, p], idx) => {
        if (seenCand.has(bw._hash)) return
        seenCand.add(bw._hash)
        const tp = timeOf(p)
        const txHashes = (p || []).filter(x => x.schema === 'network.xyo.boundwitness' && x.fees).map(x => x._hash)
        add({ k: 'cand', t, block: bw.block, prod: (bw.addresses || [])[0], epoch: tp.epoch, hash: bw._hash, hv: hashVerified(bw), idx, txs: txHashes.length, txHashes })
      })
    } catch {}
    await sleep(Math.max(0, POOL_MS - (Date.now() - s)))
  }
}
async function headLoop(until) {
  while (Date.now() < until) {
    await beat('head')
    const s = Date.now()
    try {
      const [bw, p] = await (await fetch(CDN_HEAD, { signal: AbortSignal.timeout(4000) })).json()
      if (bw._hash !== lastHead) { lastHead = bw._hash; add({ k: 'head', t: Date.now(), block: bw.block, hash: bw._hash, prod: (bw.addresses || [])[0], epoch: timeOf(p).epoch }) }
    } catch {}
    await sleep(Math.max(0, HEAD_MS - (Date.now() - s)))
  }
}
async function txLoop(until) {
  while (Date.now() < until) {
    await beat('tx')
    const s = Date.now()
    if (paused()) { await sleep(TX_MS); continue }
    try {
      const res = (await rpc('mempoolViewer_pendingTransactions', [{ limit: 100 }])) || []
      const t = Date.now()
      for (const [bw] of res) if (bw && !seenTx.has(bw._hash)) { seenTx.add(bw._hash); add({ k: 'tx', t, hash: bw._hash }) }
    } catch {}
    await sleep(Math.max(0, TX_MS - (Date.now() - s)))
  }
}

// ---- finalized chain, fetched incrementally (only new blocks each rebuild) ----
let chain = []
try { chain = JSON.parse(fs.readFileSync(CHAIN_FILE, 'utf8')) } catch {}
async function refreshChain() {
  const tip = (await (await fetch(CDN_HEAD, { signal: AbortSignal.timeout(5000) })).json())[0].block
  const have = new Set(chain.map(r => r.n)), from = Math.max(tip - 2599, chain.length ? chain.at(-1).n - 5 : tip - 2599)
  const want = []; for (let n = from; n <= tip; n++) if (!have.has(n)) want.push(n)
  let i = 0
  await Promise.all([...Array(8)].map(async () => {
    while (i < want.length) {
      const n = want[i++]
      for (let a = 0; a < 3; a++) {
        try { const r = await fetch(CDN_BLOCKS + n + '.json', { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw 0; const [bw, p] = await r.json(); chain.push({ n, p: nameOf(bw.addresses[0]), t: timeOf(p).epoch }); break } catch { await sleep(300) }
      }
    }
  }))
  chain = chain.filter(r => r.n > tip - 2600 && r.t).sort((a, b) => a.n - b.n)
  try { fs.writeFileSync(CHAIN_FILE, JSON.stringify(chain)) } catch {}
}

// ---- our nodes' build logs (read-only) ----
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 60000, windowsHide: true }, (err, out, errOut) => res(err ? '' : (out || '') + (errOut || ''))))
async function readBuilds() {
  if (BUILDLOGS !== 'windows') return {}
  const hours = Math.ceil(WINDOW / 3.6e6)
  const win = await run('docker', ['logs', '-t', '--since', `${hours}h`, WIN_CONTAINER])
  const pi = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', PI_SSH, `journalctl -u xl1-producer --no-pager -o short-iso-precise --since "-${hours}h" | grep -E "Building block [0-9]+$|Generated time payload in"`])
  const filt = s => s.split('\n').filter(l => /Building block \d+\s*$|Generated time payload in/.test(l)).join('\n')
  return { 'LewSales-2': parseBuildLog(filt(win)), 'LewSales-pi3': parseBuildLog(pi) }
}

// ---- rebuild and serve ----
let latest = null, lastBuildOk = null
async function rebuild() {
  try {
    const cut = Date.now() - WINDOW
    events = events.filter(e => e.t > cut)
    // A hash older than the window cannot come back: the pool only holds
    // candidates and transactions for the current heights.
    seenCand = windowSet('cand'); seenTx = windowSet('tx')
    try { fs.writeFileSync(EVENTS_FILE, events.map(e => JSON.stringify(e)).join('\n') + '\n') } catch {}   // compact the on-disk window
    await refreshChain().catch(e => log('chain refresh failed: ' + e))
    const builds = await readBuilds().catch(() => ({}))
    const data = buildDataset(events, chain, builds, { waterfallHeights: WATERFALL, net: NET })
    data.watchdog = watchdogPublic()
    latest = JSON.stringify(data)
    fs.writeFileSync(OUT_FILE + '.tmp', latest); fs.renameSync(OUT_FILE + '.tmp', OUT_FILE)
    lastBuildOk = Date.now()
    log(`rebuilt: ${data.heightsAnalysed} heights, ${latest.length} bytes, chain ${chain.length}`)
  } catch (e) { log('rebuild failed: ' + e) }
}
if (!ONCE) {
  http.createServer((req, res) => {
    if (req.url.startsWith('/race.json') && latest) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(latest); return }
    if (req.url.startsWith('/health')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: !!latest, network: NET, lastBuild: lastBuildOk, events: events.length, chain: chain.length, paused: paused(), watchdog: watchdogPublic() })); return }
    res.writeHead(latest ? 404 : 503); res.end()
  }).listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT}`))
  try { latest = fs.readFileSync(OUT_FILE, 'utf8') } catch {}
}

// ---- self-watchdog (observer only) ----
// Both real failures (Windows Sequence 2026-10-18, WinLEW Mainnet 2026-10-21) were a collection loop
// parked on an await that never settled, while the process stayed up and kept publishing. Each loop
// marks every iteration; a loop that has not iterated for RACE_WATCHDOG_STALL_MS, on RACE_WATCHDOG_CONFIRM
// consecutive checks, is stalled. A quiet mempool or a failing network still iterates, so neither is a
// stall. Recovery = diagnostics, then this process exits, and this host's own supervisor (Windows task,
// pm2, systemd) starts it again. It controls nothing else: no docker, pm2, systemctl or kill calls.
// Bounded: a cooldown, at most RACE_WATCHDOG_MAX exits per rolling window, then a latch ('recovery-failed'):
// no more exits until every loop has kept iterating, check after check, for RACE_WATCHDOG_VERIFY_MS (e.g. after
// a person fixes the cause). Switching the mode to passive or off does not clear it. State persists in
// STATE/watchdog.json so limits and the latch survive restarts.
// RACE_WATCHDOG=recover (default) | passive (detect and log only) | off. A file STATE/watchdog.mode holding one
// of those words overrides it at every check: a manual switch that needs no restart. Env 'off' is a hard
// off: no checks run, so the mode file cannot turn it back on.
const wdNum = (k, d, min = 1) => { const raw = String(env(k, '')).trim(); const v = raw === '' ? d : Number(raw); return Number.isFinite(v) && v >= min ? v : d }
const WD = {
  mode: env('RACE_WATCHDOG', 'recover'), stallMs: wdNum('RACE_WATCHDOG_STALL_MS', 300000), checkMs: Math.max(1000, wdNum('RACE_WATCHDOG_CHECK_MS', 60000)),
  confirm: wdNum('RACE_WATCHDOG_CONFIRM', 2), max: wdNum('RACE_WATCHDOG_MAX', 3), windowMs: wdNum('RACE_WATCHDOG_WINDOW_MS', 3600000),
  cooldownMs: wdNum('RACE_WATCHDOG_COOLDOWN_MS', 900000, 0), verifyMs: wdNum('RACE_WATCHDOG_VERIFY_MS', 300000), probeMs: wdNum('RACE_WATCHDOG_PROBE_MS', 8000), keepDiag: 10,
}
const WD_FILE = path.join(STATE, 'watchdog.json'), DIAG_DIR = path.join(STATE, 'watchdog-diag'), MODE_FILE = path.join(STATE, 'watchdog.mode')
const currentMode = () => { try { const m = fs.readFileSync(MODE_FILE, 'utf8').trim(); if (['off', 'passive', 'recover'].includes(m)) return m } catch {} return WD.mode }
const startedAt = Date.now()
const wdRead = () => { try { const v = JSON.parse(fs.readFileSync(WD_FILE, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
const wdWrite = () => { try { fs.writeFileSync(WD_FILE + '.tmp', JSON.stringify(wd)); fs.renameSync(WD_FILE + '.tmp', WD_FILE) } catch {} }
const wd = wdRead()
wd.exits = Array.isArray(wd.exits) ? wd.exits : []; wd.history = Array.isArray(wd.history) ? wd.history : []
wd.latched = wd.latched === true || wd.status === 'recovery-failed'
wd.status = wd.latched ? 'recovery-failed' : 'monitoring'; wd.mode = WD.mode === 'off' ? 'off' : currentMode()
// Sustained health: every loop must have iterated since the previous check, continuously, before the latch clears.
let healthySince = null, lastIterations = { ...iterations }
const strikes = { pool: 0, head: 0, tx: 0 }
const record = (kind, extra = {}) => { wd.history.push({ at: new Date().toISOString(), kind, ...extra }); wd.history = wd.history.slice(-50) }
// One bounded probe of what the stalled loop reads: an upstream outage is not fixed by restarting.
// Promise.race with a plain timer, so the probe always settles even if fetch itself would not. Only an
// explicit answer (an HTTP error, a refused connection, a DNS failure) counts as an outage. A probe that
// times out may be this process's own network stack wedged, which is what a restart fixes, so it does not
// block recovery (the limits above still apply).
async function upstreamOk(loops) {
  if (env('RACE_TEST_UPSTREAM_DOWN', '') === '1') return { ok: false, reason: 'test: upstream down' }
  const url = loops.includes('head') ? CDN_HEAD : RPC
  const ac = new AbortController(), t0 = Date.now()
  const req = (url === RPC ? fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mempoolViewer_pendingBlocks', params: [] }), signal: ac.signal }) : fetch(url, { signal: ac.signal }))
    .then(r => ({ ok: r.ok, status: r.status, ms: Date.now() - t0 }), e => ({ ok: false, reason: String(e?.name ?? e), ms: Date.now() - t0 }))
  const timer = new Promise(r => setTimeout(() => { r({ ok: true, timedOut: true, reason: `no answer in ${WD.probeMs / 1000} s: treated as a local hang`, ms: Date.now() - t0 }); ac.abort() }, WD.probeMs))
  return Promise.race([req, timer])
}
function writeDiag(loops) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true })
    const last = k => { const e = events.findLast?.(x => x.k === k) ?? [...events].reverse().find(x => x.k === k); return e ? new Date(e.t).toISOString() : null }
    const m = process.memoryUsage()
    const d = { at: new Date().toISOString(), network: NET, pid: process.pid, uptimeS: Math.round(process.uptime()), loops, beats: Object.fromEntries(Object.entries(beats).map(([k, v]) => [k, { ageS: Math.round((Date.now() - v) / 1000), iterations: iterations[k] }])),
      events: events.length, lastEvent: { cand: last('cand'), head: last('head'), tx: last('tx') }, rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576),
      resOptionsSet: Boolean(process.env.RES_OPTIONS), nodeOptionsSet: Boolean(process.env.NODE_OPTIONS), lastBuildOk }
    const f = `watchdog-${d.at.replace(/[:.]/g, '')}.json`
    fs.writeFileSync(path.join(DIAG_DIR, f), JSON.stringify(d, null, 1))
    const all = fs.readdirSync(DIAG_DIR).filter(x => x.startsWith('watchdog-')).sort(); for (const x of all.slice(0, Math.max(0, all.length - WD.keepDiag))) fs.unlinkSync(path.join(DIAG_DIR, x))
    return f
  } catch (e) { return `diagnostics failed: ${e}` }
}
let checking = false
async function watchdogCheck() {
  if (checking) return
  checking = true
  try { await watchdogStep() } finally { checking = false }
}
async function watchdogStep() {
  const now = Date.now(), mode = currentMode()
  wd.mode = mode
  const progressed = Object.keys(iterations).every(k => iterations[k] > lastIterations[k])
  lastIterations = { ...iterations }
  if (mode === 'off') { wd.status = 'off'; wdWrite(); return }
  wd.loops = Object.fromEntries(Object.keys(beats).map(k => [k, { ageS: Math.round((now - beats[k]) / 1000), iterations: iterations[k] }]))
  // After a recovery exit, the next process confirms the outcome once it has run for verifyMs.
  if (wd.pendingVerify && now - startedAt > WD.verifyMs) {
    const fresh = Object.values(beats).every(b => now - b < WD.stallMs), cand = events.some(e => (e.k === 'cand' || e.k === 'head') && e.t > startedAt)
    const was = wd.pendingVerify.loops
    wd.lastResult = fresh && cand ? 'recovered' : 'not-recovered'; record(wd.lastResult, { loops: was, activitySinceStart: cand }); delete wd.pendingVerify
    log(`watchdog: restart after the ${was.join(',')} stall: ${wd.lastResult}`)
  }
  const stalled = Object.keys(beats).filter(k => now - beats[k] > WD.stallMs)
  for (const k of Object.keys(strikes)) strikes[k] = stalled.includes(k) ? strikes[k] + 1 : 0
  const confirmed = stalled.filter(k => strikes[k] >= WD.confirm)
  healthySince = !stalled.length && progressed ? healthySince ?? now : null
  if (wd.latched && healthySince !== null && now - healthySince >= WD.verifyMs) {
    wd.latched = false; record('recovery-failed-cleared', { healthyForS: Math.round((now - healthySince) / 1000) }); log('watchdog: every loop iterating steadily again; automatic recovery re-enabled')
  }
  if (!confirmed.length) { wd.status = wd.latched ? 'recovery-failed' : 'monitoring'; wdWrite(); return }
  wd.lastStallAt = new Date(now).toISOString()
  if (mode !== 'recover') { if (wd.latched) { wd.status = 'recovery-failed'; wdWrite(); return } if (wd.status !== 'stalled-passive') { record('stall-detected', { loops: confirmed, mode }); log(`watchdog (passive): ${confirmed.join(',')} stalled`) } wd.status = 'stalled-passive'; wdWrite(); return }
  wd.exits = (wd.exits ?? []).filter(t => now - t < WD.windowMs)
  if (wd.latched || wd.exits.length >= WD.max) { if (!wd.latched) { wd.latched = true; record('limit-reached', { loops: confirmed, exitsInWindow: wd.exits.length }); log(`watchdog: ${wd.exits.length} recoveries in ${WD.windowMs / 60000} min; stopping automatic recovery, observer needs attention`) } wd.status = 'recovery-failed'; wdWrite(); return }
  const last = wd.exits.at(-1)
  if (last && now - last < WD.cooldownMs) { wd.status = 'cooldown'; wd.cooldownUntil = new Date(last + WD.cooldownMs).toISOString(); wdWrite(); return }
  const up = await upstreamOk(confirmed)
  if (!up.ok) { if (wd.status !== 'upstream-unavailable') record('upstream-unavailable', { loops: confirmed, probe: up }); wd.status = 'upstream-unavailable'; wdWrite(); return }
  const diag = writeDiag(confirmed)
  wd.exits.push(now); wd.pendingVerify = { since: now, loops: confirmed }; wd.status = 'restarting'; wd.lastRecoveryAt = new Date(now).toISOString()
  record('recovery-exit', { loops: confirmed, diag, probe: up }); wdWrite()
  log(`watchdog: ${confirmed.join(',')} loop(s) stalled ${Math.round((now - Math.min(...confirmed.map(k => beats[k]))) / 1000)} s; upstream ${up.timedOut ? 'probe timed out' : 'ok'} (${up.ms} ms); diagnostics ${diag}; exiting for this host's supervisor to restart the observer`)
  setTimeout(() => process.exit(75), 200)
}
// What the public feed and /health may show: state only, no paths, hosts or file names.
const watchdogPublic = () => ({ mode: wd.mode ?? WD.mode, status: wd.status, lastStallAt: wd.lastStallAt ?? null, lastRecoveryAt: wd.lastRecoveryAt ?? null, lastResult: wd.lastResult ?? null,
  recoveriesInWindow: (wd.exits ?? []).filter(t => Date.now() - t < WD.windowMs).length, maxInWindow: WD.max, cooldownUntil: wd.status === 'cooldown' ? wd.cooldownUntil : null })

const until = ONCE ? Date.now() + ONCE_MS : Infinity
log(`start${ONCE ? ' (once)' : ''} on ${NET}: ${events.length} events restored, chain ${chain.length}`)
const loops = Promise.all([poolLoop(until), headLoop(until), txLoop(until), guardLoop(until)])
if (ONCE) { await loops; await rebuild(); console.log(fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-2).join('\n')) }
else {
  if (WD.mode !== 'off') { setInterval(() => watchdogCheck().catch(e => log('watchdog check failed: ' + e)), WD.checkMs); log(`watchdog ${currentMode()}: stall ${WD.stallMs / 1000} s x${WD.confirm}, max ${WD.max}/${WD.windowMs / 60000} min, cooldown ${WD.cooldownMs / 60000} min`) }
  await sleep(15000); await rebuild(); setInterval(rebuild, REBUILD_MS)
}
