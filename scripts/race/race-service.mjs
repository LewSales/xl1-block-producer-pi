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

// ---- state: rolling events, loaded from disk so a restart keeps the window ----
let events = []
try { events = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && e.t > Date.now() - WINDOW) } catch {}
const seenCand = new Set(events.filter(e => e.k === 'cand').map(e => e.hash)), seenTx = new Set(events.filter(e => e.k === 'tx').map(e => e.hash))
let lastHead = null
const add = e => { events.push(e); try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n') } catch {} }

async function poolLoop(until) {
  while (Date.now() < until) {
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
        add({ k: 'cand', t, block: bw.block, prod: (bw.addresses || [])[0], epoch: tp.epoch, hash: bw._hash, idx, txs: txHashes.length, txHashes })
      })
    } catch {}
    await sleep(Math.max(0, POOL_MS - (Date.now() - s)))
  }
}
async function headLoop(until) {
  while (Date.now() < until) {
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
    try { fs.writeFileSync(EVENTS_FILE, events.map(e => JSON.stringify(e)).join('\n') + '\n') } catch {}   // compact the on-disk window
    await refreshChain().catch(e => log('chain refresh failed: ' + e))
    const builds = await readBuilds().catch(() => ({}))
    const data = buildDataset(events, chain, builds, { waterfallHeights: WATERFALL, net: NET })
    latest = JSON.stringify(data)
    fs.writeFileSync(OUT_FILE + '.tmp', latest); fs.renameSync(OUT_FILE + '.tmp', OUT_FILE)
    lastBuildOk = Date.now()
    log(`rebuilt: ${data.heightsAnalysed} heights, ${latest.length} bytes, chain ${chain.length}`)
  } catch (e) { log('rebuild failed: ' + e) }
}
if (!ONCE) {
  http.createServer((req, res) => {
    if (req.url.startsWith('/race.json') && latest) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(latest); return }
    if (req.url.startsWith('/health')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: !!latest, network: NET, lastBuild: lastBuildOk, events: events.length, chain: chain.length, paused: paused() })); return }
    res.writeHead(latest ? 404 : 503); res.end()
  }).listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT}`))
  try { latest = fs.readFileSync(OUT_FILE, 'utf8') } catch {}
}

const until = ONCE ? Date.now() + ONCE_MS : Infinity
log(`start${ONCE ? ' (once)' : ''} on ${NET}: ${events.length} events restored, chain ${chain.length}`)
const loops = Promise.all([poolLoop(until), headLoop(until), txLoop(until), guardLoop(until)])
if (ONCE) { await loops; await rebuild(); console.log(fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-2).join('\n')) }
else { await sleep(15000); await rebuild(); setInterval(rebuild, REBUILD_MS) }
