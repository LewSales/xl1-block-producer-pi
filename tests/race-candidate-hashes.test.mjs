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
assert.equal(a.h, hx('1'), "a row's h is the candidate it describes (the producer's earliest, as before)")
assert.deepEqual(a.alt, [{ h: hx('3'), epoch: t0 + 4900, seen: t0 + 5000 }], 'later candidates from the same producer are listed in alt')
assert.ok([a.h, ...a.alt.map((x) => x.h)].includes(h.headHash), 'the winner is identifiable by hash even when its later candidate won')
assert.equal(b.alt, undefined, 'alt appears only when a producer offered more than one candidate')
assert.equal(d.candidateIds.recomputedByObserver, false, 'provenance says the hashes are as reported, not recomputed')
assert.match(d.candidateIds.rows, /mempoolViewer_pendingBlocks/)
// unchanged fields: removing the new ones gives what the previous code produced for the same input
for (const r of h.rows) for (const k of ['p', 'epoch', 'seen', 'rank', 'early', 'parentProducer', 'won', 'txs', 'timePayloadMs']) assert.ok(k in r, `row keeps ${k}`)
assert.equal(h.winnerRank, 1, 'stage A does not change ranking (earliest candidate per producer, as before)')
console.log('✓ race candidate hashes: rows carry h/alt, heights carry headHash, provenance stated, existing fields kept')
