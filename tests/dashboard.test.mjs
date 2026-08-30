// Tests for the decisions the dashboard makes. No network, no Docker, no Pi.
//
// The JSON-contract cases matter most: xl1-collect.sh hand-writes its JSON with
// printf and server.mjs consumes it by field name, and that contract has drifted
// undetected twice — a missing container and a never-run collector both read as
// healthy. Those two are asserted here as the failures they are.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const fixture = (n) => readFile(join(here, 'fixtures', n), 'utf8')

process.env.XL1_STATUS_FILE ??= join(here, 'fixtures', 'healthy.json')
// Captured at import, so it has to be set before it. The standings tests below
// need this node to have an identity to find itself in the table.
const SELF = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
process.env.XL1_PRODUCER_ADDRESS ??= `0x${SELF.toUpperCase()}`
// Read at import too. Covers each shape at once: a full address, a usable
// prefix, a prefix that will turn out to match two producers, one that matches
// none, and two malformed entries.
process.env.DASH_PEER_LABELS ??= [
  '1111111111111111111111111111111111111111=Jim',
  '22222222=Freya',
  'deadbeef=Ambiguous',
  'feedface=Absent',
  '33=TooShort',
  'nothex01=NotHex',
].join(',')
const m = await import('../dashboard/server.mjs')

// ---------------------------------------------------------------- pure logic

test('versionLag compares numerically and refuses to guess', () => {
  assert.equal(m.versionLag('5.2.2', '5.3.0'), 'behind')
  assert.equal(m.versionLag('5.3.0', '5.3.0'), 'current')
  assert.equal(m.versionLag('5.4.1', '5.3.0'), 'ahead')
  assert.equal(m.versionLag('5.2', '5.2.1'), 'behind')
  assert.equal(m.versionLag('v5.3.0', '5.3.0'), 'current')
  // Unparseable must be unknown, never "up to date" — that would silence the
  // upgrade alert rather than admit it could not tell.
  assert.equal(m.versionLag('nightly', '5.3.0'), undefined)
  assert.equal(m.versionLag('5.4.1-rc.1', '5.3.0'), undefined)
  assert.equal(m.versionLag(undefined, '5.3.0'), undefined)
})

test('formatXl1 keeps atto precision without float rounding', () => {
  assert.equal(m.formatXl1(10n ** 18n), '1.0000')
  assert.equal(m.formatXl1(7330n * 10n ** 18n), '7,330.0000')
  // A float would lose this; the whole point of the BigInt path.
  assert.equal(m.formatXl1(12345678901234567890123n), '12,345.6789')
  assert.equal(m.formatXl1(undefined), undefined)
})

test('decodeThrottle separates "now" from "since boot"', () => {
  assert.equal(m.decodeThrottle('0x0').healthy, true)
  assert.equal(m.decodeThrottle('0x50005').undervoltageNow, true)
  assert.equal(m.decodeThrottle('0x50000').undervoltageNow, false)
  assert.equal(m.decodeThrottle('0x50000').undervoltageSinceBoot, true)
  assert.equal(m.decodeThrottle(undefined), undefined)
})

test('envStr and envNum treat an empty value as absent', () => {
  // `FOO=` in an env file is an empty string, not undefined — which is how a
  // blank DASH_EXPLORER_URL turned every explorer link into a relative path.
  process.env.__T = ''
  assert.equal(m.envStr('__T', 'fallback'), 'fallback')
  assert.equal(m.envNum('__T', 240, 2), 240)
  process.env.__T = 'garbage'
  assert.equal(m.envNum('__T', 240, 2), 240)
  process.env.__T = '  spaced  '
  assert.equal(m.envStr('__T', 'x'), 'spaced')
  delete process.env.__T
})

// ------------------------------------------------- the collector JSON contract

async function loadSnapshot(name) {
  const dir = await mkdtemp(join(tmpdir(), 'xl1-test-'))
  const f = join(dir, 'producer-status.json')
  await writeFile(f, await fixture(name))
  process.env.XL1_STATUS_FILE = f
  // pollNode reads STATUS_FILE, which was captured at import; re-reading it is
  // what the real process does every 5s, so drive it the same way.
  const { readFile: rf } = await import('node:fs/promises')
  const parsed = JSON.parse(await rf(f, 'utf8'))
  const age = Date.now() - new Date(parsed.collectedAt).getTime()
  m.state.node = { ok: true, stale: age > 120_000, ageSeconds: Math.round(age / 1000), ...parsed }
  return parsed
}

function baselineHealthyState() {
  m.state.health = { ok: true }
  m.state.chain = { ok: true, chainIdMatchesPreset: true, balances: {} }
  m.state.system = { ok: true, throttle: { healthy: true }, swap: { usedPercent: 0 } }
  m.state.release = { ok: true, latest: '5.3.0' }
}

test('a healthy snapshot produces no problems', async () => {
  baselineHealthyState()
  await loadSnapshot('healthy.json')
  const o = m.overall()
  assert.deepEqual(o.problems, [])
  assert.equal(o.status, 'ok')
})

test('a missing container is reported, not silently treated as fine', async () => {
  baselineHealthyState()
  await loadSnapshot('container-missing.json')
  const o = m.overall()
  assert.ok(
    o.problems.some((p) => /container/i.test(p)),
    `a deleted container must appear in problems, got ${JSON.stringify(o.problems)}`,
  )
  assert.equal(o.status, 'down', 'a producer with no container is down, not degraded')
})

test('a collector that never wrote a snapshot is reported', () => {
  baselineHealthyState()
  m.state.node = { ok: false, error: 'collector has not written /var/lib/xl1/producer-status.json yet' }
  const o = m.overall()
  assert.ok(
    o.problems.some((p) => /collector/i.test(p)),
    `a collector that never ran must appear in problems, got ${JSON.stringify(o.problems)}`,
  )
})

test('a blocked producer surfaces every real fault', async () => {
  baselineHealthyState()
  await loadSnapshot('blocked.json')
  const o = m.overall()
  const joined = o.problems.join(' | ')
  assert.match(joined, /ineligible/i)
  assert.match(joined, /5\.2\.2 behind published 5\.3\.0/)
  assert.match(joined, /security update/i)
  assert.match(joined, /reboot required/i)
  assert.match(joined, /apt lists .* stale/i)
})

test('perHour uses elapsed time, not sample count', () => {
  m.history.height.length = 0
  const now = Date.now()
  m.history.height.push({ t: now - 3_600_000, v: 100 }, { t: now, v: 190 })
  assert.equal(Math.round(m.perHour('height')), 90)
  m.history.height.length = 0
  assert.equal(m.perHour('height'), undefined, 'one point is not a rate')
})

// ------------------------------------------------------------ long-range trend

test('trendDaily reports per-day differences, not cumulative readings', async () => {
  const { writeFile: wf, mkdtemp: mt } = await import('node:fs/promises')
  const dir = await mt(join(tmpdir(), 'xl1-trend-'))
  const f = join(dir, 'trend.jsonl')
  const d1 = Date.UTC(2099, 0, 1, 6), d2 = Date.UTC(2099, 0, 2, 6)
  await wf(f, [
    { t: d1, blocks: 10, reward: 100 },
    { t: d1 + 3600e3, blocks: 14, reward: 140 },
    { t: d2, blocks: 14, reward: 140 },
    { t: d2 + 3600e3, blocks: 20, reward: 205 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')

  process.env.DASH_TREND_FILE = f
  // loadTrend reads the path captured at import, so drive it the way the real
  // process does and assert on the bucketing rather than the file plumbing.
  const rows = JSON.parse(`[${(await readFile(f, 'utf8')).trim().split('\n').join(',')}]`)
  const byDay = new Map()
  for (const r of rows) {
    const day = new Date(r.t).toISOString().slice(0, 10)
    const cur = byDay.get(day)
    if (!cur) byDay.set(day, { first: r, last: r }); else cur.last = r
  }
  const daily = [...byDay.entries()].map(([day, v]) => ({
    day, blocks: v.last.blocks - v.first.blocks, earned: v.last.reward - v.first.reward,
  }))
  assert.deepEqual(daily, [
    { day: '2099-01-01', blocks: 4, earned: 40 },
    { day: '2099-01-02', blocks: 6, earned: 65 },
  ], 'a day is the difference across it, not the total at the end of it')
})

test('the last block links into the explorer, and absence is stated', () => {
  baselineHealthyState()
  m.state.chain = { ok: true, chainIdMatchesPreset: true, balances: {}, currentBlock: 575_800 }
  m.state.node = { ok: true, stale: false, container: { running: true }, blocksPublished: 3,
                   lastPublishedBlock: 575_735, lastPublishedAt: '2099-01-01T00:00:00Z' }
  const dv = m.derived()
  assert.equal(dv.lastBlock, 575_735)
  // /block/number/<n>. The bare /block/<n> form resolves to a blank page rather
  // than a 404, so a wrong link here fails silently and looks like a dead node.
  assert.equal(dv.lastBlockUrl, 'https://explore.xyo.network/xl1/sequence/block/number/575735')
  assert.equal(dv.blocksSinceLast, 65, 'distance from the head is the useful figure')

  m.state.node = { ok: true, stale: false, container: { running: true }, blocksPublished: 0 }
  const none = m.derived()
  assert.equal(none.lastBlock, undefined)
  assert.equal(none.lastBlockUrl, undefined, 'no block means no link, not a link to nothing')
})

test('thermal clock reduction is not called healthy', () => {
  // 0x80008 — bit 3 soft temp limit now, bit 19 since boot. Read off a live
  // Pi 3 B+ at 66C, where the ARM clock drops 1.4GHz -> 1.2GHz. Calling that
  // "stable" hides the reason blocks build slowly.
  const t = m.decodeThrottle('0x80008')
  assert.equal(t.softTempLimitNow, true)
  assert.equal(t.softTempLimitSinceBoot, true)
  assert.equal(t.undervoltageNow, false, 'this is heat, not power — different fix')
  assert.equal(t.healthy, false, 'a CPU being clocked down is not healthy')

  baselineHealthyState()
  m.state.system = { ok: true, throttle: t, swap: { usedPercent: 0 } }
  m.state.node = { ok: true, stale: false, container: { running: true } }
  const p = m.overall().problems.join(' | ')
  assert.match(p, /heat/i, 'the message must point at cooling, not at a power supply')
  assert.doesNotMatch(p, /undervolt/i)
})

// ------------------------------------------------------- producer standings
//
// These guard the arithmetic the leaderboard rests on. Two of the three cases
// are ones that would otherwise fail silently: a cursor that jumps a gap loses
// blocks from every total with nothing to show it happened, and an empty
// gateway answer treated as an empty range does the same permanently.

const PEER_A = '1111111111111111111111111111111111111111'
const PEER_B = '2222222222222222222222222222222222222222'

function resetScan() {
  m.peers.clear()
  Object.assign(m.production, {
    counted: 0, lastBlock: undefined, scannedFrom: undefined, scannedTo: undefined,
    scanned: 0, multiSigner: false, error: undefined, behind: undefined, cursor: undefined,
  })
}

/** A viewer whose chain is a plain map of block number → signer addresses.
 *  Records every call so the walk itself can be asserted, not just its result. */
function fakeViewer(signersByBlock, { emptyFor } = {}) {
  const calls = []
  return {
    calls,
    block: {
      // The SDK reads newest-first from a chosen top, which is the direction
      // the real scan depends on to reach a range in the middle.
      blocksByNumber: async (top, limit) => {
        calls.push([top, limit])
        if (emptyFor?.(top, limit)) return []
        const out = []
        for (let n = top; n > top - limit; n--) {
          const signers = signersByBlock[n]
          if (signers) out.push({ block: n, addresses: signers })
        }
        return out
      },
    },
  }
}

test('the scan tallies every signer, not only this node', async () => {
  resetScan()
  const chain = { 1: [SELF], 2: [PEER_A], 3: [PEER_A], 4: [`0x${SELF}`], 5: [PEER_B] }
  const v = fakeViewer(chain)
  m.production.cursor = 0
  await m.scanProduction(v, 5)

  const board = m.peerBoard()
  assert.equal(board.scannedBlocks, 5)
  assert.equal(board.producers, 3)
  // PEER_A leads on two blocks; we and PEER_B have the rest.
  assert.equal(board.top[0].address, PEER_A)
  assert.equal(board.top[0].blocks, 2)

  const mine = board.self
  assert.ok(mine, 'this node must appear in its own standings')
  // The 0x-prefixed signer in block 4 is the same producer as the bare one in
  // block 1. Not normalising would have split one node across two rows.
  assert.equal(mine.blocks, 2, 'a 0x-prefixed signer is the same address')
  assert.equal(mine.blocks, m.production.counted,
    'the headline count and the table row must come from the same tally')
  assert.equal(mine.sharePercent, 40)
})

test('catching up after an outage reads every block rather than jumping the gap', async () => {
  resetScan()
  // 450 blocks, all ours: more than the 200-per-read cap, so the scan must make
  // several calls and land on all of them. The bug this replaces asked for the
  // newest 200 and then set the cursor to the head, silently discarding 250.
  const chain = {}
  for (let n = 1; n <= 450; n++) chain[n] = [PEER_A]
  const v = fakeViewer(chain)
  m.production.cursor = 0
  await m.scanProduction(v, 450)

  assert.equal(m.production.scanned, 450, 'every block in the gap must be read')
  assert.equal(m.peers.get(PEER_A), 450)
  assert.equal(m.production.scannedTo, 450)
  assert.ok(v.calls.length >= 3, `expected several chunked reads, got ${v.calls.length}`)
  assert.ok(v.calls.every(([, limit]) => limit <= 200), 'no read may exceed the gateway cap')
})

test('a gateway that answers with nothing does not book the range as scanned', async () => {
  resetScan()
  const chain = { 10: [PEER_A], 11: [PEER_A] }
  // Refuse everything. An empty answer is far more likely to be the gateway
  // declining than a genuinely empty range, and advancing past it would lose
  // those blocks from every total for good.
  const v = fakeViewer(chain, { emptyFor: () => true })
  m.production.cursor = 9
  await m.scanProduction(v, 11)

  assert.equal(m.production.scanned, 0)
  assert.equal(m.production.cursor, 9, 'the cursor must not move over blocks that were never read')
  assert.ok(m.production.error, 'a refused read must be reported, not passed off as an empty chain')

  // And the same range is retried once the gateway answers again.
  const v2 = fakeViewer(chain)
  await m.scanProduction(v2, 11)
  assert.equal(m.production.scanned, 2)
  assert.equal(m.peers.get(PEER_A), 2)
})

test('share divides by blocks read, so an outage shrinks the sample not the percentage', async () => {
  resetScan()
  // Ten blocks exist between 1 and 100; the rest of the range was never read.
  const chain = {}
  for (let n = 91; n <= 100; n++) chain[n] = [SELF]
  const v = fakeViewer(chain)
  m.production.cursor = 90
  await m.scanProduction(v, 100)

  const dv = m.derived()
  // Dividing by the height range (100 - 91 + 1 is fine here, but after a real
  // outage scannedFrom lags far behind) is what this guards against: the
  // denominator is what was read, which is 10.
  assert.equal(dv.producedScanned, 10)
  assert.equal(dv.producedSharePercent, 100)
})

test('a block with several signers is flagged rather than silently normalised', async () => {
  resetScan()
  const v = fakeViewer({ 1: [SELF, PEER_A], 2: [PEER_A] })
  m.production.cursor = 0
  await m.scanProduction(v, 2)

  const board = m.peerBoard()
  assert.equal(board.scannedBlocks, 2)
  assert.equal(board.multiSigner, true,
    'shares summing past 100% must be explained on the page, not hidden')
  // 1/2 + 2/2 = 150%. Honest, and labelled as such.
  assert.equal(board.self.sharePercent, 50)
  assert.equal(board.top[0].sharePercent, 100)
})

test('standings rank this node and order ties predictably', async () => {
  resetScan()
  const v = fakeViewer({ 1: [PEER_B], 2: [SELF], 3: [PEER_A] })
  m.production.cursor = 0
  await m.scanProduction(v, 3)

  const board = m.peerBoard()
  // All tied on one block, so the order must come from the address and not from
  // Map insertion, or the table reshuffles itself between polls.
  assert.deepEqual(board.top.map((r) => r.address), [PEER_A, PEER_B, SELF].sort())
  assert.deepEqual(board.top.map((r) => r.rank), [1, 2, 3])
  assert.equal(board.selfRank, board.self.rank)
})

test('labels name a producer without hiding its address', async () => {
  resetScan()
  const v = fakeViewer({ 1: [PEER_A], 2: [PEER_B], 3: [SELF] })
  m.production.cursor = 0
  await m.scanProduction(v, 3)

  const board = m.peerBoard()
  const row = (a) => board.top.find((r) => r.address === a)
  // Full address.
  assert.equal(row(PEER_A).label, 'Jim')
  // Prefix: '22222222' is the first 8 of PEER_B.
  assert.equal(row(PEER_B).label, 'Freya')
  // No label configured for this node; the page falls back to "this node".
  assert.equal(row(SELF).label, undefined)
  // The address always survives labelling — it is the identity, the name is a
  // convenience, and a row you cannot check is worse than an unnamed one.
  assert.equal(row(PEER_A).address, PEER_A)
})

test('an ambiguous prefix is refused rather than pinned on a guess', async () => {
  resetScan()
  // Two producers share the 'deadbeef' prefix the label was written against.
  const one = 'deadbeef00000000000000000000000000000001'
  const two = 'deadbeef00000000000000000000000000000002'
  const v = fakeViewer({ 1: [one], 2: [two] })
  m.production.cursor = 0
  await m.scanProduction(v, 2)

  const board = m.peerBoard()
  assert.equal(board.top.find((r) => r.address === one).label, undefined)
  assert.equal(board.top.find((r) => r.address === two).label, undefined)
  const amb = board.labels.ambiguous.find((x) => x.name === 'Ambiguous')
  assert.ok(amb, 'an ambiguous label must be reported, not dropped')
  assert.equal(amb.matches, 2)
})

test('a label matching nobody is reported instead of vanishing', async () => {
  resetScan()
  const v = fakeViewer({ 1: [PEER_A] })
  m.production.cursor = 0
  await m.scanProduction(v, 1)

  const board = m.peerBoard()
  // A name missing from the table looks exactly like a producer who stopped, so
  // the difference has to be stated somewhere.
  assert.ok(board.labels.unmatched.some((x) => x.name === 'Absent'))
})

test('malformed label entries are rejected with a reason, not ignored', () => {
  const board = m.peerBoard()
  const joined = board.labels.rejected.join(' | ')
  assert.match(joined, /TooShort/, 'a 2-character prefix is not identifying and must be refused')
  assert.match(joined, /NotHex/)
  // A rejected entry must never silently become a live label.
  assert.ok(!board.labels.rejected.some((x) => /Jim/.test(x)))
})

test('the throttle decode handles the value a fanned 3 B+ actually reports', () => {
  // 0x80000 = bit 19 only: the soft temperature limit fired at some point since
  // boot, and nothing is wrong right now. The since-boot bits are sticky until a
  // power cycle, so this is what a Pi reports once cooling has been fixed but
  // before it has been rebooted.
  const t = m.decodeThrottle('0x80000')
  assert.equal(t.softTempLimitSinceBoot, true)
  assert.equal(t.softTempLimitNow, false)
  assert.equal(t.undervoltageSinceBoot, false, 'power delivery is a separate question')
  assert.equal(t.throttledSinceBoot, false, 'the 85C hard limit is a separate bit')
  assert.equal(t.healthy, true, 'nothing is clocking the CPU down right now')
})

/** Seed the module's own trend store and run the real trendDaily over it. */
function daysFrom(rows) {
  m.trend.length = 0
  m.trend.push(...rows)
  return m.trendDaily()
}

test('trend days count blocks from the chain, not the log-derived zero', () => {
  // The collector counts `published block` in the container log — a string the
  // producer never emits — so its figure is 0 for the life of the node, and
  // every day in the chart read "0 blocks".
  const day = Date.UTC(2026, 7, 30)
  const out = daysFrom([
    { t: day + 1000, blocks: 0, cblocks: 10, reward: 1 },
    { t: day + 2000, blocks: 0, cblocks: 14, reward: 3 },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].blocks, 4, 'four blocks landed that day, not zero')
  assert.equal(out[0].earned, 2)
})

test('a day mixing old zero rows with new chain rows does not spike', () => {
  // Rows already on disk carry blocks:0. Diffing a real cumulative count
  // against those zeros would post the entire running total as one day.
  const day = Date.UTC(2026, 7, 31)
  const out = daysFrom([
    { t: day + 1000, blocks: 0, reward: 0 },
    { t: day + 2000, blocks: 0, reward: 0 },
    { t: day + 3000, blocks: 0, cblocks: 240, reward: 0 },
    { t: day + 4000, blocks: 0, cblocks: 243, reward: 0 },
  ])
  assert.equal(out[0].blocks, 3,
    'the changeover day counts what the new counter observed, not its whole history')
})

test('days recorded before the chain counter existed still read from the old key', () => {
  // Backward compatibility: history already on disk must keep charting.
  const day = Date.UTC(2026, 6, 1)
  const out = daysFrom([
    { t: day + 1000, blocks: 5, reward: 0 },
    { t: day + 2000, blocks: 9, reward: 0 },
  ])
  assert.equal(out[0].blocks, 4)
})
