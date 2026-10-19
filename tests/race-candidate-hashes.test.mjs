// Candidate hashes in race rows (Sprint 006 stage A). SYNTHETIC events; run: node tests/race-candidate-hashes.test.mjs
import assert from 'node:assert/strict'
import { buildDataset } from '../scripts/race/race-lib.mjs'

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), hx = (c) => c.repeat(64)
const t0 = 1_800_000_000_000
const events = [
  { k: 'head', t: t0, block: 9, hash: hx('9'), prod: C, epoch: t0 - 500 },
  // height 10: A offers two candidates (the later one wins), B offers one
  { k: 'cand', t: t0 + 1000, block: 10, prod: A, epoch: t0 + 900, hash: hx('1'), idx: 0, txs: 1, txHashes: [] },
  { k: 'cand', t: t0 + 1200, block: 10, prod: B, epoch: t0 + 1100, hash: hx('2'), idx: 0, txs: 1, txHashes: [] },
  { k: 'cand', t: t0 + 5000, block: 10, prod: A, epoch: t0 + 4900, hash: hx('3'), idx: 0, txs: 1, txHashes: [] },
  { k: 'head', t: t0 + 9000, block: 10, hash: hx('3'), prod: A, epoch: t0 + 4900 },
]
const d = buildDataset(events, [], {}, { waterfallHeights: 40, net: 'sequence' })
const h = d.heights.find((x) => x.n === 10)
assert.equal(h.headHash, hx('3'), 'each height carries the canonical head hash')
const a = h.rows.find((r) => r.p === h.winner), b = h.rows.find((r) => r.h === hx('2'))
assert.equal(a.h, hx('3'), "the winning producer's row describes its WINNING candidate (matched by hash), not its earliest")
assert.deepEqual(a.alt, [{ h: hx('1'), hv: null, epoch: t0 + 900, seen: t0 + 1000 }], "the producer's other candidates are listed in alt")
assert.ok([a.h, ...a.alt.map((x) => x.h)].includes(h.headHash), 'the winner is identifiable by hash even when its later candidate won')
assert.equal(b.alt, undefined, 'alt appears only when a producer offered more than one candidate')
assert.equal(d.candidateIds.recomputedByObserver, true, 'this version recomputes each hash (per candidate in hv)')
assert.equal(h.rows.find((r) => r.h === hx('2')).hv, null, 'events without hv (older collection) publish hv: null, never true')
assert.match(d.candidateIds.rows, /mempoolViewer_pendingBlocks/)
assert.deepEqual(d.candidateIds.coverage, { candidates: 3, firstSeen: t0 + 1000, lastSeen: t0 + 5000 }, 'coverage says when candidates were last recorded (window.to also moves with heads)')
assert.deepEqual(buildDataset(events.filter((e) => e.k !== 'cand'), [], {}, { net: 'sequence' }).candidateIds.coverage, { candidates: 0, firstSeen: null, lastSeen: null }, 'no candidates recorded is stated, not hidden')
// unchanged fields: removing the new ones gives what the previous code produced for the same input
for (const r of h.rows) for (const k of ['p', 'epoch', 'seen', 'rank', 'early', 'parentProducer', 'won', 'txs', 'timePayloadMs']) assert.ok(k in r, `row keeps ${k}`)
assert.equal(h.winnerBy, 'hash', 'the winner was identified by hash')
assert.equal(h.winnerRank, 2, 'ranked by its winning candidate (seen after B)')
assert.equal(h.rankCorrected, true); assert.equal(h.winnerRankLegacy, 1, 'the previous method (earliest per producer) is kept alongside')
assert.deepEqual(d.legacy.rankDist, { 1: 1, 2: 0, 3: 0, 4: 0 }); assert.deepEqual(d.rankDist, { 1: 0, 2: 1, 3: 0, 4: 0 })
assert.match(d.rankBasis, /winning candidate by hash/)
// without a head hash the winner cannot be matched by hash: stays earliest, and says so
const noHash = buildDataset(events.map((e) => (e.k === 'head' ? { ...e, hash: undefined } : e)), [], {}, { net: 'sequence' }).heights.find((x) => x.n === 10)
assert.equal(noHash.winnerBy, 'producer'); assert.equal(noHash.rankCorrected, undefined); assert.equal(noHash.winnerRank, 1)
console.log('✓ race candidate hashes: h/alt/headHash, provenance, coverage; winner ranked by its winning candidate, legacy kept')
