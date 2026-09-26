// Read-only analysis of a rangescan.mjs file.
//   node analyze-interval.mjs scan.json segments.json
// rows: [height, producer8, epoch, ethAnchor, txCount]
import fs from 'node:fs'

const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).sort((a, b) => a[0] - b[0])
const segments = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) // [{name, from, to (ISO), cli, claimed}]
const PI = 'ca081208', WIN = '2152e6ae'
const CANDIDATES = [3900, 4000, 5000, 10000]

// --- which producers are active around each height (won anything within +-90 blocks) ---
const ACTIVE_RADIUS = 90
const byHeight = new Map(rows.map(r => [r[0], r]))
const idx = rows.map(r => r[0])
function activeSet(k) {
  const s = new Set()
  for (let j = Math.max(0, k - ACTIVE_RADIUS); j <= Math.min(rows.length - 1, k + ACTIVE_RADIUS); j++) s.add(rows[j][1])
  return s
}

// --- interval inference: ticks every I ms on a fixed setInterval, so the gap between two of a
// producer's block epochs a few minutes apart is a multiple of I plus build jitter. Validated on
// the verified-4000 run: R(4000)=0.97-0.98, R(5000)~0.2, R(3900)<0.1.
const CANDIDATES_ALL = [3900, 4000, 5000, 10000, 15000]
function inferInterval(epochs) {
  const out = {}; let n = 0
  for (const I of CANDIDATES_ALL) {
    let c = 0, s = 0; n = 0
    for (let i = 1; i < epochs.length; i++) {
      const d = epochs[i] - epochs[i - 1]
      if (d > 1200e3) continue
      n++; const a = 2 * Math.PI * (d % I) / I; c += Math.cos(a); s += Math.sin(a)
    }
    out[I] = n ? +(Math.hypot(c, s) / n).toFixed(2) : null
  }
  if (n < 10) return { n }
  // Multiples alias (a 5000 cadence also locks at 10000), so take the smallest candidate whose
  // concentration is within 0.1 of the best.
  const best = Math.max(...Object.values(out))
  const inferred = CANDIDATES_ALL.find(I => out[I] >= best - 0.1)
  return { n, R: out, inferred }
}

const q = (a, p) => { if (!a.length) return null; a = [...a].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] }
const pct = (n, d) => d ? +(100 * n / d).toFixed(2) : null

const results = []
for (const seg of segments) {
  const t0 = Date.parse(seg.from), t1 = Date.parse(seg.to)
  // Skip the first 5 minutes after a start: container boot and warm-up are not the interval's doing.
  const warm = t0 + 5 * 60e3
  const piEpochs = [], stats = { heights: 0, eligible: 0, won: 0, hbEligible: 0, hbWon: 0, txEligible: 0, txWon: 0,
    winActiveEligible: 0, winActiveWon: 0, winIdleEligible: 0, winIdleWon: 0, producers: [], winWins: 0, hbLagWins: [] }
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k], p = rows[k - 1]
    if (r[2] === null || p[2] === null || r[0] !== p[0] + 1) continue
    if (r[2] < warm || r[2] >= t1) continue
    stats.heights++
    if (r[1] === WIN) stats.winWins++
    if (r[1] === PI) piEpochs.push(r[2])
    // Eligible: the Pi could have won this height. After a Pi block the diversity bonus hands the
    // next height to any other producer with a valid candidate, so those heights are excluded.
    if (p[1] === PI) continue
    const act = activeSet(k)
    const heartbeat = r[4] === 0
    const won = r[1] === PI
    stats.eligible++; if (won) stats.won++
    if (heartbeat) { stats.hbEligible++; if (won) { stats.hbWon++; stats.hbLagWins.push(r[2] - p[2] - 60000) } }
    else { stats.txEligible++; if (won) stats.txWon++ }
    if (act.has(WIN)) { stats.winActiveEligible++; if (won) stats.winActiveWon++ } else { stats.winIdleEligible++; if (won) stats.winIdleWon++ }
    stats.producers.push(act.size)
  }
  const inf = inferInterval(piEpochs)
  results.push({
    segment: seg.name, cli: seg.cli, claimed: seg.claimed, hours: +((Math.min(t1, Date.now()) - warm) / 3.6e6).toFixed(1),
    inferredInterval: inf.inferred ?? null, phaseR: inf.R ?? null,
    heights: stats.heights, eligible: stats.eligible, piWon: stats.won, sharePctOfEligible: pct(stats.won, stats.eligible),
    heartbeatPct: pct(stats.hbEligible, stats.eligible),
    hbShare: pct(stats.hbWon, stats.hbEligible), txShare: pct(stats.txWon, stats.txEligible),
    shareWinActive: pct(stats.winActiveWon, stats.winActiveEligible), eligibleWinActive: stats.winActiveEligible,
    shareWinIdle: pct(stats.winIdleWon, stats.winIdleEligible), eligibleWinIdle: stats.winIdleEligible,
    activeProducersMedian: q(stats.producers, 0.5), winShareOfHeights: pct(stats.winWins, stats.heights),
    piHbLagP50: q(stats.hbLagWins, 0.5),
  })
}
console.log(JSON.stringify(results, null, 1))
