// Race dataset builder shared by the live race service and one-off analysis.
// Input is observer events (cand / head / tx), recent finalized chain rows, and our nodes'
// build-log timings. Output is the race.json the /xl1/race/ page reads. Pure: no I/O here.

// Known producers per network. A name is shown only for operators who agreed to be named;
// anyone else is still counted, under the first 8 characters of their address.
export const PRODUCERS_BY_NET = {
  sequence: {
  ca08120874f071739d932b24da41cc13299123b3: { name: 'LewSales-pi3', owner: 'LewSales' },
  '2152e6aec996742fb6e52ae1aad87bd44f2ccc91': { name: 'LewSales-2', owner: 'LewSales' },
  a6567633ac83a7017f3a2ef20fbbed890a2adae9: { name: 'Jim-pi4', owner: 'Jim' },
  '30251291ac55017d90a3c892ab5604bdacf9bcde': { name: 'Jim-pi4-2', owner: 'Jim' },
  fb4c535221f91c1811bd42f70b6ec305aa658551: { name: 'FreeCryptoA', owner: 'FreeCryptoA' },
  '8a499c81cb6a8106933f66a6cfdd6ea6439575e3': { name: 'System owned 8a49', owner: 'system' },
  '7ac8355c0ed1b6404da1ce7fe87a23394bab8056': { name: 'System owned 7ac8', owner: 'system' },
  '81b835c16e6da6152b4d9ebd7e55162f762767a1': { name: 'System owned 81b8', owner: 'system' },
  },
  mainnet: {
    ca08120874f071739d932b24da41cc13299123b3: { name: 'Oxyon-pi', owner: 'Oxyon' },
    // The Windows host's two mainnet containers (cc91 since 2026-10-08; 653e named 2026-10-17).
    '2152e6aec996742fb6e52ae1aad87bd44f2ccc91': { name: 'Oxyon-windows', owner: 'Oxyon' },
    a9304753eade52dd22b1a6fc519b571a4dc2653e: { name: 'Oxyon-windows-2', owner: 'Oxyon' },
    fb4c535221f91c1811bd42f70b6ec305aa658551: { name: 'FreeCryptoA', owner: 'FreeCryptoA' },
    '30251291ac55017d90a3c892ab5604bdacf9bcde': { name: 'Jim-pi4-2', owner: 'Jim' },
  },
}
export const PRODUCERS = PRODUCERS_BY_NET.sequence
/** name-for-address on one network; an unknown address is its first 8 characters. */
export function makeNameOf(net = 'sequence') {
  const map = PRODUCERS_BY_NET[net] ?? {}
  const byPrefix = Object.fromEntries(Object.entries(map).map(([a, v]) => [a.slice(0, 8), v.name]))
  return a => byPrefix[(a || '').slice(0, 8)] || (a || '?').slice(0, 8)
}
export const nameOf = makeNameOf('sequence')
const q = (a, p) => { if (!a.length) return null; a = [...a].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]) }

/** Parse "Generated time payload in Nms" / "Building block N" log lines into per-height timings. */
export function parseBuildLog(text) {
  const out = new Map(); let lastTp = null
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\s.*?(Generated time payload in (\d+)ms|Building block (\d+)\s*$)/)
    if (!m) continue
    const t = Date.parse(m[1])
    if (Number.isNaN(t)) continue
    if (m[3]) lastTp = { t, ms: +m[3] }
    else if (m[4] && !out.has(+m[4])) out.set(+m[4], { buildLog: t, timePayloadMs: lastTp && t - lastTp.t < 2000 ? lastTp.ms : null })
  }
  return out
}

/**
 * @param events  observer events ({k:'cand'|'head'|'tx', ...})
 * @param chain   finalized blocks [{n, p (producer name), t (epoch)}], ascending, ideally >= 2000 and >= 24 h
 * @param builds  { 'LewSales-pi3': Map(height -> {buildLog, timePayloadMs}), 'LewSales-2': Map(...) }
 * @param opts    { waterfallHeights: how many latest heights to ship with per-producer rows,
 *                  net: 'sequence' | 'mainnet' (default sequence) }
 */
export function buildDataset(events, chain, builds, opts = {}) {
  const waterfallHeights = opts.waterfallHeights ?? 40
  const net = opts.net ?? 'sequence'
  const known = PRODUCERS_BY_NET[net] ?? {}
  const nameOf = makeNameOf(net)
  const addressOf = {}   // name -> full address, for every producer seen
  const heads = new Map(), cands = new Map(), txSeen = new Map()
  for (const e of events) {
    if (e.k === 'head' && !heads.has(e.block)) heads.set(e.block, e)
    else if (e.k === 'tx' && !txSeen.has(e.hash)) txSeen.set(e.hash, e.t)
    else if (e.k === 'cand') (cands.get(e.block) || cands.set(e.block, []).get(e.block)).push(e)
  }
  for (const e of events) if ((e.k === 'cand' || e.k === 'head') && e.prod) addressOf[nameOf(e.prod)] ??= e.prod.toLowerCase()
  for (const [a, v] of Object.entries(known)) addressOf[v.name] ??= a
  // every producer that offered a candidate counts, named or not
  const allNames = Object.keys(addressOf)
  const per = {}, P = n => (per[n] ??= { heights: 0, wins: 0, slot: { 1: 0, 2: 0, 3: 0, 4: 0 }, winAt: { 1: 0, 2: 0, 3: 0, 4: 0 }, early: 0, missing: 0, pool: [], hbReact: [], txReact: [], tp: [], afterBuild: [] })
  const rankDist = { 1: 0, 2: 0, 3: 0, 4: 0 }
  let ruleHits = 0, firstHits = 0
  const rankDistLegacy = { 1: 0, 2: 0, 3: 0, 4: 0 }; let ruleHitsLegacy = 0, firstHitsLegacy = 0
  const heights = []
  for (const [N, cs] of [...cands].sort((a, b) => a[0] - b[0])) {
    const parent = heads.get(N - 1), win = heads.get(N)
    if (!parent || !win || !parent.epoch) continue
    const due = parent.epoch + 60000
    const byEarliest = new Map(), ofProd = new Map()
    for (const c of cs) { if (!byEarliest.has(c.prod) || c.t < byEarliest.get(c.prod).t) byEarliest.set(c.prod, c); (ofProd.get(c.prod) || ofProd.set(c.prod, []).get(c.prod)).push(c) }
    // The winning producer is represented by its WINNING candidate (hash = canonical head hash), not
    // by its earliest: a producer can offer several candidates at one height and a later one can win.
    // Without a hash match it stays the earliest, and the height says so (winnerBy: 'producer').
    const winC = win.hash ? cs.find(c => c.hash === win.hash) : null
    const by = new Map(byEarliest); if (winC) by.set(winC.prod, winC)
    const rankCorrected = Boolean(winC && byEarliest.get(winC.prod) !== winC)
    const isHb = c => c.txs === 0
    const early = c => isHb(c) && c.epoch < due
    const eligible = m => [...m.values()].filter(c => !early(c) && c.prod !== parent.prod).sort((a, b) => a.t - b.t || b.idx - a.idx)
    const el = eligible(by), elLegacy = eligible(byEarliest)
    if (!el.length) continue
    const winner = nameOf(win.prod)
    const tally = (list, dist, onFirst, onRule) => {
      const r = list.findIndex(c => nameOf(c.prod) === winner) + 1
      if (r >= 1) dist[Math.min(r, 4)]++
      if (r === 1) onFirst()
      if (list.length >= 2) {
        const cut = list[1].t
        const newest = list.filter(c => c.t <= cut).reduce((a, b) => (b.t > a.t || (b.t === a.t && b.idx < a.idx)) ? b : a)
        if (nameOf(newest.prod) === winner) onRule()
      }
      return r
    }
    const wr = tally(el, rankDist, () => firstHits++, () => ruleHits++)
    const wrLegacy = tally(elLegacy, rankDistLegacy, () => firstHitsLegacy++, () => ruleHitsLegacy++)
    const heartbeat = el.every(isHb)
    let opens
    if (heartbeat) opens = due
    else { const seen = el.flatMap(c => (c.txHashes || []).map(h => txSeen.get(h))).filter(Boolean); opens = seen.length ? Math.max(Math.min(...seen), parent.t) : parent.t }
    const rows = []
    for (const name of allNames) {
      const s = P(name), c = [...by.values()].find(x => nameOf(x.prod) === name)
      if (!c) { s.missing++; continue }
      s.heights++
      const won = name === winner; if (won) s.wins++
      const isParent = c.prod === parent.prod
      if (early(c)) s.early++
      const r = el.indexOf(c) + 1
      if (r > 0) { const k = Math.min(r, 4); s.slot[k]++; if (won) s.winAt[k]++ }
      if (!early(c) && !isParent) {
        s.pool.push(c.t - c.epoch)
        if (isHb(c)) s.hbReact.push(c.t - due)
        else { const seen = (c.txHashes || []).map(h => txSeen.get(h)).filter(Boolean); if (seen.length) s.txReact.push(c.t - Math.max(Math.min(...seen), parent.t)) }
      }
      const b = builds[name]?.get(N)
      if (b && b.timePayloadMs != null && !early(c)) { s.tp.push(b.timePayloadMs); s.afterBuild.push(c.t - b.buildLog) }
      // Candidate identity: the hash XYO's RPC reported for this candidate (not recomputed here).
      // A producer that offered more candidates at this height lists the later ones in alt.
      const mine = ofProd.get(c.prod)
      const alt = mine.length > 1 ? mine.filter(x => x.hash !== c.hash).sort((a, b) => a.t - b.t).map(x => ({ h: x.hash ?? null, epoch: x.epoch, seen: x.t })) : []
      const row = { p: name, epoch: c.epoch, seen: c.t, rank: r || null, early: early(c), parentProducer: isParent, won, txs: c.txs, timePayloadMs: b?.timePayloadMs ?? null, h: c.hash ?? null }
      if (alt.length) row.alt = alt
      rows.push(row)
    }
    const height = { n: N, heartbeat, parentSeen: parent.t, opens, winner, winnerRank: wr || null, winnerBy: winC ? 'hash' : 'producer' }
    if (rankCorrected) { height.rankCorrected = true; height.winnerRankLegacy = wrLegacy || null }
    height.headSeen = win.t; height.headHash = win.hash ?? null; height.rows = rows
    heights.push(height)
  }
  const range = (a) => ({ p10: q(a, .1), p50: q(a, .5), p90: q(a, .9), n: a.length })
  const producers = Object.entries(per).map(([name, s]) => ({
    name, address: addressOf[name] ?? null, owner: Object.values(known).find(p => p.name === name)?.owner ?? null, heights: s.heights, wins: s.wins,
    winPct: +(100 * s.wins / Math.max(1, s.heights + s.missing)).toFixed(1), slot: s.slot, winAt: s.winAt, early: s.early, missing: s.missing,
    pool: range(s.pool), hbReact: range(s.hbReact), txReact: range(s.txReact),
    timePayload: { p50: q(s.tp, .5), p90: q(s.tp, .9), n: s.tp.length }, afterBuild: { p50: q(s.afterBuild, .5), p90: q(s.afterBuild, .9) },
  })).sort((a, b) => b.wins - a.wins)

  const count = rows => { const c = {}; rows.forEach(r => c[r.p] = (c[r.p] || 0) + 1); return c }
  const lastT = chain.length ? chain.at(-1).t : Date.now()
  const hourly = {}
  chain.filter(r => r.t > lastT - 24 * 3.6e6).forEach(r => { const k = Math.floor(r.t / 3.6e6); (hourly[k] ??= {})[r.p] = (hourly[k][r.p] || 0) + 1 })
  const board = {
    tip: chain.length ? chain.at(-1).n : null, tipTime: lastT,
    last1000: count(chain.slice(-1000)), last2000: count(chain.slice(-2000)),
    last3h: count(chain.filter(r => r.t > lastT - 3 * 3.6e6)), n3h: chain.filter(r => r.t > lastT - 3 * 3.6e6).length,
    hourly: Object.entries(hourly).map(([k, v]) => ({ hour: +k * 3.6e6, counts: v, total: Object.values(v).reduce((a, b) => a + b, 0) })),
  }
  const ts = events.map(e => e.t).filter(Boolean)
  return {
    schema: 1, generatedAt: Date.now(), network: net, names: addressOf,
    window: { from: ts.length ? Math.min(...ts) : null, to: ts.length ? Math.max(...ts) : null },
    heightsAnalysed: heights.length, rankDist, rule: { newestAt2nd: ruleHits, firstArrival: firstHits },
    // rankDist and rule rank the winner by its winning candidate (matched by hash); legacy keeps the
    // earlier method (each producer's earliest candidate) so published history stays comparable.
    // Observed arrival order is the order this observer saw candidates in XYO's RPC listing, not network arrival.
    rankBasis: 'winning candidate by hash, else earliest candidate per producer',
    legacy: { rankBasis: 'earliest candidate per producer', rankDist: rankDistLegacy, rule: { newestAt2nd: ruleHitsLegacy, firstArrival: firstHitsLegacy } },
    // Where the hashes in heights[].headHash and rows[].h / alt[].h come from, and what they are not.
    // coverage: when this observer last recorded a candidate. window.to also moves with heads and
    // transactions, so a stalled candidate feed is only visible here.
    candidateIds: { rows: "XYO RPC mempoolViewer_pendingBlocks _hash, as reported", head: 'block CDN head _hash, as reported', recomputedByObserver: false,
      coverage: (() => { let n = 0, lo = Infinity, hi = -Infinity; for (const e of events) if (e.k === 'cand') { n++; if (e.t < lo) lo = e.t; if (e.t > hi) hi = e.t } return { candidates: n, firstSeen: n ? lo : null, lastSeen: n ? hi : null } })() },
    producers, heights: heights.slice(-waterfallHeights), board,
  }
}
