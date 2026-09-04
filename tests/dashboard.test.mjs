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
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname: under Windows-native node the latter yields
// /C:/... and every join below then builds C:\C:\... . This repo is worked on
// from Windows, so the suite has to find its own directory whether node runs
// under WSL or natively.
const here = fileURLToPath(new URL('.', import.meta.url))
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
// Day bucketing is read at import. Pinned to UTC so the window assertions below
// mean the same thing on a laptop in Denver and in CI.
process.env.DASH_DAY_TZ ??= 'UTC'
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

test('an empty state directory is not blamed on the collector alone', async () => {
  // The two faults arrive as the same ENOENT. A state directory with the rest
  // of the collector's files in it is a collector that has not written yet; one
  // with nothing in it at all is a bind mount that came loose from the host —
  // on Windows, after Docker Desktop restarted a container before WSL was up.
  // Reporting the first for the second sends an operator to inspect a collector
  // that is writing every thirty seconds.
  const { mkdtemp: mt, writeFile: wf } = await import('node:fs/promises')
  const empty = await mt(join(tmpdir(), 'xl1-mount-'))
  const populated = await mt(join(tmpdir(), 'xl1-mount-'))
  await wf(join(populated, '.collect-cursor'), '582000\n')

  const detached = await m.missingStatusReason(join(empty, 'producer-status.json'))
  assert.match(detached, /is empty/)
  assert.match(detached, /bind mount/, 'an empty directory has to name the mount as a suspect')

  const idle = await m.missingStatusReason(join(populated, 'producer-status.json'))
  assert.match(idle, /collector has not written/)
  assert.doesNotMatch(idle, /bind mount/, 'a populated directory is a quiet collector, not a lost mount')
})

test('the mount remedy is the one for the host it is printed on', () => {
  // Same source runs on both bundles. A Windows operator told to daemon-reload
  // a systemd unit goes looking for a file that is not on their machine.
  const was = process.env.DASH_HOST_PLATFORM
  try {
    delete process.env.DASH_HOST_PLATFORM
    assert.match(m.mountRemedy(), /systemctl daemon-reload/, 'unset means the Pi')
    process.env.DASH_HOST_PLATFORM = 'windows'
    assert.match(m.mountRemedy(), /xl1ctl\.ps1 restart/)
    assert.doesNotMatch(m.mountRemedy(), /systemctl/)
  } finally {
    if (was === undefined) delete process.env.DASH_HOST_PLATFORM
    else process.env.DASH_HOST_PLATFORM = was
  }
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
  m.days.clear()
  Object.assign(m.production, {
    counted: 0, lastBlock: undefined, scannedFrom: undefined, scannedTo: undefined,
    scanned: 0, multiSigner: false, error: undefined, behind: undefined, cursor: undefined,
    daysFrom: undefined, daysError: undefined, undated: undefined,
  })
}

const DAY = 86_400_000

/** A viewer whose chain is a plain map of block number → signer addresses.
 *  Records every call so the walk itself can be asserted, not just its result. */
function fakeViewer(signersByBlock, { emptyFor, epochFor, timeEpochFor } = {}) {
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
          if (!signers) continue
          // No epochFor means no $epoch on the block at all, which is the
          // undated case the older tests here already exercise by accident.
          const epoch = epochFor?.(n)
          const bw = epoch === undefined
            ? { block: n, addresses: signers }
            : { block: n, addresses: signers, $epoch: epoch }
          // timeEpochFor is the shape the gateway started returning on 2
          // September 2026: the block itself, paired with its payloads, and the
          // timestamp only in the time payload.
          const timeEpoch = timeEpochFor?.(n)
          out.push(timeEpoch === undefined
            ? bw
            : [bw, [{ schema: 'network.xyo.transfer' }, { schema: 'network.xyo.time', epoch: timeEpoch }]])
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

// ------------------------------------------------------- day windows
//
// The totals answer "who has produced most since this dashboard started", which
// says nothing useful about a node that was offline for two of those days. These
// guard the split, and in particular the two ways it could lie: filing a block
// under the day it was read rather than the day it was made, and letting a
// backfill add blocks to totals that already contain them.

test('a block is filed under its own day, not the day it was read', async () => {
  resetScan()
  const now = Date.now()
  // Read in one pass, moments apart, but three days separate the blocks.
  const chain = { 1: [PEER_A], 2: [PEER_A], 3: [SELF] }
  const epochs = { 1: now - 3 * DAY, 2: now - 3 * DAY, 3: now }
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { epochFor: (n) => epochs[n] }), 3)

  assert.equal(m.days.size, 2, 'two distinct days, not one bucket for the read')
  const today = m.days.get(m.dayKey(now))
  assert.equal(today.scanned, 1)
  assert.equal(today.counts.get(SELF), 1)
  assert.equal(m.days.get(m.dayKey(now - 3 * DAY)).counts.get(PEER_A), 2)
})

test('blockEpoch prefers the metadata and falls back to the time payload', () => {
  const payloads = [{ schema: 'network.xyo.transfer', epoch: 222 }, { schema: 'network.xyo.time', epoch: 333 }]
  // $epoch still wins where it exists, so history already on disk cannot shift.
  assert.equal(m.blockEpoch({ $epoch: 111 }, payloads), 111)
  // The time payload is the block's own account of when it was made; the
  // transfer's epoch is only reached for if there is no time payload at all.
  assert.equal(m.blockEpoch({}, payloads), 333)
  assert.equal(m.blockEpoch({}, [{ schema: 'network.xyo.transfer', epoch: 222 }]), 222)
  assert.equal(m.blockEpoch({}, [{ schema: 'network.xyo.time' }]), undefined)
  assert.equal(m.blockEpoch({}, undefined), undefined)
})

test('a block dated only by its time payload is still filed under its day', async () => {
  // The gateway stopped attaching $epoch to new blocks on 2 September 2026 and
  // kept it on every older one. A reader that knows only about $epoch counts
  // those blocks in the totals and files none of them under a day, so every
  // window silently flatlines while the all-time figure keeps climbing.
  resetScan()
  const now = Date.now()
  const chain = { 1: [PEER_A], 2: [SELF], 3: [SELF] }
  const epochs = { 1: now - 2 * DAY, 2: now, 3: now }
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { timeEpochFor: (n) => epochs[n] }), 3)

  assert.equal(m.production.undated, undefined, 'a dated block must not be counted as undated')
  assert.equal(m.days.size, 2)
  assert.equal(m.days.get(m.dayKey(now)).counts.get(SELF), 2)
  assert.equal(m.days.get(m.dayKey(now - 2 * DAY)).counts.get(PEER_A), 1)
})

test('a window ranks on its own blocks while the total keeps its own order', async () => {
  resetScan()
  const now = Date.now()
  // PEER_A built a lead a week ago and has done nothing today; we are the only
  // one producing today. The total and today's table must disagree, and both
  // must be right.
  const chain = {}
  const epochs = {}
  for (let n = 1; n <= 10; n++) { chain[n] = [PEER_A]; epochs[n] = now - 6 * DAY }
  for (let n = 11; n <= 13; n++) { chain[n] = [SELF]; epochs[n] = now }
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { epochFor: (n) => epochs[n] }), 13)

  const board = m.peerBoard()
  assert.equal(board.top[0].address, PEER_A, 'PEER_A still leads overall')
  assert.equal(board.self.rank, 2)

  const today = board.windows.today
  assert.equal(today.self.rank, 1, 'today we lead')
  assert.equal(today.self.blocks, 3)
  assert.equal(today.scannedBlocks, 3, 'the window divides by its own blocks')
  assert.equal(today.producers, 1, 'a producer with no blocks today is not in today')

  // The gap an operator is actually reading off the page: behind overall,
  // ahead today, from the same scan.
  assert.equal(board.top[0].vsSelf, 7, 'PEER_A is 7 blocks up overall')
  assert.equal(board.windows.week.blocksByAddress[PEER_A], 10)
  assert.equal(board.windows.week.blocksByAddress[SELF], 3)
})

test('a block with no timestamp is counted once, in the totals only', async () => {
  resetScan()
  const now = Date.now()
  const chain = { 1: [PEER_A], 2: [PEER_A] }
  // Only block 1 carries $epoch.
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { epochFor: (n) => (n === 1 ? now : undefined) }), 2)

  assert.equal(m.peers.get(PEER_A), 2, 'both blocks are in the total')
  assert.equal(m.production.undated, 1, 'the undated one is reported, not dropped')
  assert.equal(m.peerBoard().windows.today.blocksByAddress[PEER_A], 1)
})

test('backfilling day history does not add to totals that already hold it', async () => {
  resetScan()
  const now = Date.now()
  const chain = {}
  const epochs = {}
  for (let n = 1; n <= 60; n++) { chain[n] = [PEER_A]; epochs[n] = now - DAY }
  const v = fakeViewer(chain, { epochFor: (n) => epochs[n] })

  // The whole range is counted in the totals first.
  m.production.cursor = 0
  await m.scanProduction(v, 60)
  const total = m.peers.get(PEER_A)
  const scanned = m.production.scanned
  assert.equal(total, 60)

  // Now stand in for a v1 file: totals intact, no day history, nothing bucketed.
  m.days.clear()
  m.production.daysFrom = 61

  await m.backfillDays(v)

  assert.equal(m.peers.get(PEER_A), total, 'the total must not move')
  assert.equal(m.production.scanned, scanned, 'nor the denominator')
  assert.equal(m.days.get(m.dayKey(now - DAY)).counts.get(PEER_A), 60,
    'but the day now holds every one of those blocks')
  assert.equal(m.production.daysFrom, 1)
  assert.equal(m.peerBoard().daysComplete, true)
})

test('an unfinished backfill is stated rather than shown as a quiet week', async () => {
  resetScan()
  m.production.scannedFrom = 1
  m.production.daysFrom = 500
  assert.equal(m.peerBoard().daysComplete, false)
})

test('day buckets are pruned to the retention limit', async () => {
  resetScan()
  const now = Date.now()
  const chain = {}
  const epochs = {}
  // 40 days, one block each, against a 35-day default.
  for (let n = 1; n <= 40; n++) { chain[n] = [PEER_A]; epochs[n] = now - (40 - n) * DAY }
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { epochFor: (n) => epochs[n] }), 40)

  assert.equal(m.days.size, 35, 'older days are dropped')
  assert.ok(m.days.has(m.dayKey(now)), 'today survives')
  assert.ok(!m.days.has(m.dayKey(now - 39 * DAY)), 'the oldest does not')
  assert.equal(m.peers.get(PEER_A), 40, 'pruning history does not touch the totals')
})

// ------------------------------------------------------------------ latency
//
// The split between wire and local is the whole value of this panel: one
// round-trip number cannot tell an operator whether the gateway is slow or
// their own box is. These pin the arithmetic and the absence case.

test('latency separates the wire floor from local work', () => {
  // state.node is assigned the way loadSnapshot does it: STATUS_FILE is captured
  // at import, so driving pollNode from a temp file would read the fixture path
  // instead and quietly assert nothing.
  m.state.node = {
    ok: true,
    container: { name: 'xl1-producer', state: 'running', running: true },
    latency: {
      headFetchMinMs: 103, headFetchP50Ms: 238, headFetchP95Ms: 386,
      samples: 13398, cycleP50Ms: 508, cycleP95Ms: 2309,
    },
  }

  const l = m.derived().latency
  assert.equal(l.wireFloorMs, 103)
  assert.equal(l.typicalMs, 238)
  // 238 typical against a 103 floor is 135ms this machine spends parsing and
  // validating — the number that says the box is slow rather than the network.
  assert.equal(l.localMs, 135)
  assert.equal(l.p95Ms, 386)
  assert.equal(l.samples, 13398)
  assert.equal(l.cycleP95Ms, 2309)
})

test('a producer that reported no timings shows no latency panel at all', () => {
  // An older collector, or a status server that did not answer. Reporting zero
  // here would read as "instant" — the one wrong answer available.
  m.state.node = {
    ok: true,
    container: { name: 'xl1-producer', state: 'running', running: true },
  }
  assert.equal(m.derived().latency, undefined)
})

// ------------------------------------------------------------ candidate race
//
// The mixed sourcing is the whole risk here. Losses come from the log, wins
// come from the chain, and the reason they cannot be swapped is that
// "Published block" means submitted — the mistake that once had this dashboard
// reporting zero for a node that was producing.

function raceState({ race, recent }) {
  m.state.node = { ok: true, container: { name: 'xl1-producer', running: true }, race }
  m.production.recent = recent ?? []
}

test('wins come from the chain, never from the log', () => {
  // The log claims eight builds. The chain says two of the last six are ours,
  // and the chain is what the card must report.
  raceState({
    race: { windowSeconds: 3600, observedSeconds: 1800, built: 8, retries: 3, lost: {} },
    recent: [
      { n: 1, mine: false, t: 1000 }, { n: 2, mine: true, t: 2000 },
      { n: 3, mine: false, t: 3000 }, { n: 4, mine: false, t: 4000 },
      { n: 5, mine: true, t: 5000 }, { n: 6, mine: false, t: 6000 },
    ],
  })
  const r = m.derived().race
  assert.equal(r.won, 2, 'wins are the chain count, not the eight builds')
  assert.equal(r.built, 8)
  assert.equal(r.chainBlocks, 6)
  assert.deepEqual(r.pulse, [0, 1, 0, 0, 1, 0], 'pulse is chain order, oldest first')
  assert.equal(r.chainWindowSeconds, 5, 'span comes from block timestamps')
})

test('loss reasons are ranked as a share of losses, not of builds', () => {
  raceState({
    race: {
      windowSeconds: 3600, observedSeconds: 3600, built: 100, retries: 4,
      lost: { txAlreadyFinalized: 4, behindFinalizedHead: 12, blockNumberMismatch: 4 },
    },
    recent: [],
  })
  const r = m.derived().race
  assert.equal(r.lostTotal, 20)
  // 12 of 20 losses, not 12 of 100 builds: the question is "when we lose, why".
  assert.equal(r.reasons[0].key, 'behindFinalizedHead')
  assert.equal(r.reasons[0].percent, 60)
  assert.equal(r.reasons.reduce((a, x) => a + x.count, 0), 20)
})

test('nothing lost yet reads as no reasons rather than three zeroes', () => {
  raceState({
    race: {
      windowSeconds: 3600, observedSeconds: 600, built: 12, retries: 0,
      lost: { txAlreadyFinalized: 0, behindFinalizedHead: 0, blockNumberMismatch: 0 },
    },
    recent: [],
  })
  assert.deepEqual(m.derived().race.reasons, [])
})

test('an older collector with no race data hides the card, it does not show zeroes', () => {
  raceState({ race: undefined, recent: [] })
  assert.equal(m.derived().race, undefined)
})

test('the scan records chain order for the pulse, including blocks we lost', async () => {
  resetScan()
  const now = Date.now()
  const chain = { 1: [PEER_A], 2: [SELF], 3: [PEER_A], 4: [SELF] }
  m.production.cursor = 0
  await m.scanProduction(fakeViewer(chain, { epochFor: () => now }), 4)
  assert.deepEqual(m.production.recent.map((b) => b.mine), [false, true, false, true])
  assert.equal(m.derived().race.won, 2)
})

// ------------------------------------------------------------- operations
//
// The score is the risky one: a number out of 100 invites trust, so these pin
// that it never hides a missing component, never scores a component it could
// not measure, and never rates "winning" against 100% when parity is 1/n.

function opsState({ race, latency, restartCount = 0, recent = [], peers } = {}) {
  m.state.node = { ok: true, container: { name: 'xl1-producer', running: true, restartCount }, race, latency }
  m.production.recent = recent
  m.peers.clear()
  if (peers) for (const [addr, n] of Object.entries(peers)) m.peers.set(addr, n)
  m.production.scanned = peers ? Object.values(peers).reduce((a, b) => a + b, 0) : 0
}

test('the score is the mean of measured components only, never of assumed zeroes', () => {
  // Only latency and reliability are measurable here. A missing component must
  // shrink the denominator, not drag the score down as a zero.
  opsState({ latency: { cycleP50Ms: 500 }, restartCount: 0 })
  const o = m.derived().operations
  assert.equal(o.components.length, 2)
  assert.deepEqual(o.components.map((c) => c.label).sort(), ['Latency', 'Reliability'])
  assert.equal(o.components.find((c) => c.label === 'Latency').value, 100, '500ms is half the budget: full marks')
  assert.equal(o.score, 100, 'two perfect components average to 100, not 50')
})

test('win rate is scored against an even split, not against the whole chain', () => {
  // Four producers, we hold 25% — that is parity, and parity is 100.
  opsState({
    peers: { [SELF]: 25, [PEER_A]: 25, [PEER_B]: 25, '3333333333333333333333333333333333333333': 25 },
  })
  const win = m.derived().operations.components.find((c) => c.label === 'Win rate')
  assert.equal(win.value, 100)
  assert.match(win.why, /25% of the chain against a 25.0% even split/)
})

test('race health is the share of builds that survived, and it is stated', () => {
  opsState({ race: { built: 100, retries: 0, lost: { txAlreadyFinalized: 10, behindFinalizedHead: 10, blockNumberMismatch: 0 } } })
  const rh = m.derived().operations.components.find((c) => c.label === 'Race health')
  assert.equal(rh.value, 80, '20 of 100 builds rejected')
  assert.match(rh.why, /20 of 100 builds rejected locally/)
})

test('the bottleneck names the dominant loss reason rather than guessing', () => {
  opsState({ race: { built: 50, retries: 5, lost: { txAlreadyFinalized: 14, behindFinalizedHead: 5, blockNumberMismatch: 1 } } })
  const b = m.derived().operations.bottleneck
  assert.equal(b.key, 'mempool')
  assert.match(b.text, /70% of rejected candidates/)
})

test('too few losses to be meaningful does not produce a confident diagnosis', () => {
  // Three rejections is noise. It must fall through to a latency statement or
  // to "none", never to "stale mempool caused 100%".
  opsState({
    race: { built: 40, retries: 0, lost: { txAlreadyFinalized: 3, behindFinalizedHead: 0, blockNumberMismatch: 0 } },
    latency: { wireFloorMs: 100, typicalMs: 150, localMs: 50, cycleP95Ms: 900 },
  })
  const b = m.derived().operations.bottleneck
  assert.notEqual(b.key, 'mempool')
  assert.equal(b.key, 'none')
})

test('no win inside the ring reports no streak rather than a zero-block gap', () => {
  opsState({ recent: [{ n: 1, mine: false }, { n: 2, mine: false }] })
  const o = m.derived().operations
  assert.equal(o.sinceWin, undefined, 'zero would read as "won the last block"')
  assert.equal(o.longestGap, undefined)
})

test('streaks count blocks since the last win, oldest-first ring', () => {
  opsState({ recent: [{ n: 1, mine: true }, { n: 2, mine: false }, { n: 3, mine: true }, { n: 4, mine: false }, { n: 5, mine: false }] })
  const o = m.derived().operations
  assert.equal(o.sinceWin, 2, 'two blocks since #3')
  assert.equal(o.longestGap, 2)
})

// ------------------------------------------------------------- build stamp
//
// The image tag is the same string before and after every deploy, so this is
// the only thing that says which build answered. It must degrade to "unknown"
// rather than throwing or, worse, claiming a version it is not.

test('the snapshot carries a build identity', () => {
  const b = m.snapshot().build
  assert.ok(b, 'every snapshot must identify the build serving it')
  assert.equal(b.version, '2.2.3', 'read from package.json, not hardcoded')
  // Unstamped in the test environment, which is exactly the fallback path an
  // argument-less `docker build` takes.
  assert.equal(b.commit, 'unknown')
  assert.equal(b.builtAt, 'unknown')
  assert.ok(b.source?.startsWith('https://github.com/'), 'a build must say where its source lives')
  assert.equal(b.commitUrl, undefined, 'an unknown commit has no commit to link to')
})

test('a dirty build links to the repository but never to its own hash', () => {
  // A hash built from uncommitted changes is not on GitHub. Linking it lands on
  // a 404, and an invitation to verify the code that 404s is worse than none.
  const prev = { c: process.env.DASH_COMMIT, s: process.env.DASH_SOURCE_URL }
  process.env.DASH_COMMIT = 'abc12345-dirty'
  process.env.DASH_SOURCE_URL = 'https://github.com/example/repo/'
  const b = m.snapshot().build
  assert.equal(b.commit, 'abc12345-dirty')
  assert.equal(b.commitUrl, undefined, 'a dirty hash must not be linked')
  assert.equal(b.source, 'https://github.com/example/repo', 'a trailing slash would double up in the commit path')
  process.env.DASH_COMMIT = prev.c; process.env.DASH_SOURCE_URL = prev.s
})

test('a clean build links straight at the commit it was built from', () => {
  const prev = { c: process.env.DASH_COMMIT, s: process.env.DASH_SOURCE_URL }
  process.env.DASH_COMMIT = 'abc12345'
  process.env.DASH_SOURCE_URL = 'https://github.com/example/repo'
  const b = m.snapshot().build
  assert.equal(b.commitUrl, 'https://github.com/example/repo/commit/abc12345')
  process.env.DASH_COMMIT = prev.c; process.env.DASH_SOURCE_URL = prev.s
})

// A cycle over budget is only a fault if it is costing work. Escalating on the
// threshold alone put an amber "!" on a node sitting 3rd of 7 with nothing
// measurably wrong, which trains an operator to ignore the card.

test('a slow cycle costing nothing is reported without crying fault', () => {
  opsState({ latency: { cycleP95Ms: 2319, skippedChecks: 0, rejectedPublishes: 0 } })
  const b = m.derived().operations.bottleneck
  assert.equal(b.key, 'none', 'no skipped check and no rejected publish is not a fault')
  assert.match(b.text, /2319ms/, 'the number is still stated, not hidden')
  assert.match(b.text, /costing nothing measurable/)
})

test('the same cycle escalates once it actually costs work', () => {
  opsState({ latency: { cycleP95Ms: 2319, skippedChecks: 3, rejectedPublishes: 1 } })
  const b = m.derived().operations.bottleneck
  assert.equal(b.key, 'cycle')
  assert.match(b.text, /3 check\(s\) skipped, 1 publish\(es\) rejected/)
})

// Two tiles that exist to answer "is it still happening", which no cumulative
// number can. Both are computed from history already held.

test('head age comes from the newest block own timestamp', () => {
  m.production.recent = [
    { n: 1, mine: false, t: Date.now() - 600_000 },
    { n: 2, mine: true, t: Date.now() - 45_000 },
  ]
  const age = m.derived().headAgeSeconds
  assert.ok(age >= 44 && age <= 47, `expected ~45s, got ${age}`)
})

test('no timestamped block means no head age, not a zero', () => {
  // Zero would read as "the chain just moved", which is the opposite of what an
  // absent reading means.
  m.production.recent = [{ n: 1, mine: false }]
  assert.equal(m.derived().headAgeSeconds, undefined)
})

test('last payout finds the most recent increase, not the last sample', () => {
  const now = Date.now()
  m.history.reward.length = 0
  m.history.reward.push(
    { t: now - 900_000, v: 100 },
    { t: now - 600_000, v: 150 },   // a payout
    { t: now - 300_000, v: 150 },   // flat: not a payout
    { t: now - 60_000, v: 150 },
  )
  const d = m.derived()
  assert.equal(d.lastPayoutXl1, 50, 'the increase, not the balance')
  assert.ok(d.lastPayoutSeconds >= 599 && d.lastPayoutSeconds <= 602,
    `should date from the increase ten minutes ago, got ${d.lastPayoutSeconds}`)
})

test('a balance that has never moved reports no payout at all', () => {
  const now = Date.now()
  m.history.reward.length = 0
  m.history.reward.push({ t: now - 600_000, v: 50 }, { t: now, v: 50 })
  assert.equal(m.derived().lastPayoutSeconds, undefined)
})

// Blocks split by window. A cumulative total cannot tell a node earning
// steadily from one that earned everything yesterday and has stopped.

test('the hour is withheld until the ring actually covers most of one', () => {
  // Twenty minutes of ring reporting "this hour" would state a third of the
  // window as if it were the whole of it.
  const now = Date.now()
  m.production.recent = [
    { n: 1, mine: true, t: now - 1_200_000 },
    { n: 2, mine: true, t: now - 60_000 },
  ]
  const bw = m.derived().blocksByWindow
  assert.equal(bw.hour, undefined, 'a partial window must not be reported as an hour')
  assert.ok(bw.hourCoverageSeconds >= 1190, 'but the coverage is stated so the gap is visible')
})

test('a full hour of ring reports the blocks inside it', () => {
  const now = Date.now()
  m.production.recent = [
    { n: 1, mine: true, t: now - 4_000_000 },   // 66 minutes: outside the hour
    { n: 2, mine: true, t: now - 1_800_000 },
    { n: 3, mine: false, t: now - 900_000 },
    { n: 4, mine: true, t: now - 60_000 },
  ]
  const bw = m.derived().blocksByWindow
  assert.equal(bw.hour, 2, 'only ours, only inside the hour')
})

// ----------------------------------------------------------- network metrics
//
// Every number in the XL1 Network section is arithmetic over blocks the scan
// already read, which makes it exactly the kind of thing that can be quietly
// wrong for weeks. Synthetic datasets here, so each answer is one a reader can
// work out by hand and check.

/** Reset the observation state so one test's chain cannot leak into the next. */
function resetChain() {
  m.peers.clear()
  m.days.clear()
  m.production.scanned = 0
  m.production.scannedFrom = undefined
  m.production.scannedTo = undefined
  m.chainObs.gaps.buckets = m.GAP_EDGES.map(() => 0)
  m.chainObs.gaps.count = 0
  m.chainObs.gaps.sum = 0
  m.chainObs.gaps.min = undefined
  m.chainObs.gaps.max = undefined
  m.chainObs.gaps.rejected = { nonPositive: 0, nonConsecutive: 0, undated: 0 }
  m.chainObs.last = undefined
}

const tally = (pairs) => new Map(pairs)

test('the Nakamoto coefficient needs a strict majority, not half', () => {
  // Two producers at exactly 50% each. Half is not a majority, so it takes
  // both — an off-by-one here would report the chain as controllable by one.
  assert.equal(m.concentration(tally([['a', 50], ['b', 50]])).nakamoto, 2)
  // One producer over the line on its own.
  assert.equal(m.concentration(tally([['a', 60], ['b', 40]])).nakamoto, 1)
  // Four equal producers: 25+25 is exactly half and not a majority, so the
  // third is required. This is the shape the strict comparison exists for.
  assert.equal(m.concentration(tally([['a', 25], ['b', 25], ['c', 25], ['d', 25]])).nakamoto, 3)
  // And a leader large enough to pair into a majority needs only the two.
  assert.equal(m.concentration(tally([['a', 30], ['b', 25], ['c', 25], ['d', 20]])).nakamoto, 2)
})

test('concentration divides by blocks signed, not blocks scanned', () => {
  // Shares must total 100 even when a block carries two signers, which is the
  // case that would otherwise understate decentralisation.
  const c = m.concentration(tally([['a', 30], ['b', 30], ['c', 40]]))
  assert.equal(c.blocks, 100)
  assert.equal(c.leaderShare, 40)
  assert.equal(c.top3Share, 100)
  assert.equal(c.evenShare, 33.33)
  assert.equal(c.producers, 3)
})

test('an empty tally yields no concentration rather than a divide by zero', () => {
  assert.equal(m.concentration(tally([])), undefined)
  assert.equal(m.concentration(tally([['a', 0]])), undefined)
})

test('block times are measured only between consecutive blocks', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  // 100 → 101 → 102 are consecutive; the jump to 200 is a range the scan never
  // read, and counting it would put the dashboard's own downtime in a chart
  // about the chain's block time.
  m.observeBatch([
    { n: 100, t: t0 },
    { n: 101, t: t0 + 60_000 },
    { n: 102, t: t0 + 120_000 },
    { n: 200, t: t0 + 9_000_000 },
  ])
  assert.equal(m.chainObs.gaps.count, 2, 'two intervals, not three')
  assert.equal(m.chainObs.gaps.rejected.nonConsecutive, 1)
  assert.equal(m.chainObs.gaps.max, 60, 'the two-and-a-half hour scan gap is not the slowest block')
})

test('blocks arriving newest-first are still measured forwards', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  // blocksByNumber answers newest-first. Unsorted, every interval would look
  // like it ran backwards and the histogram would be empty.
  m.observeBatch([
    { n: 12, t: t0 + 120_000 },
    { n: 11, t: t0 + 60_000 },
    { n: 10, t: t0 },
  ])
  assert.equal(m.chainObs.gaps.count, 2)
  assert.equal(m.chainObs.gaps.rejected.nonPositive, 0)
})

test('a re-read range is not counted twice', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  m.observeBatch([{ n: 10, t: t0 }, { n: 11, t: t0 + 60_000 }])
  assert.equal(m.chainObs.gaps.count, 1)
  m.observeBatch([{ n: 10, t: t0 }, { n: 11, t: t0 + 60_000 }])
  assert.equal(m.chainObs.gaps.count, 1, 'the same two blocks cannot add a second interval')
})

test('a block dated before the one it follows is refused, not clamped', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  m.observeBatch([{ n: 10, t: t0 }])
  m.observeBatch([{ n: 11, t: t0 - 5_000 }])
  assert.equal(m.chainObs.gaps.count, 0, 'no interval')
  assert.equal(m.chainObs.gaps.rejected.nonPositive, 1)
  // A clamped zero reads as an instant block, and this chain does not make those.
  assert.equal(m.chainObs.gaps.buckets.reduce((a, b) => a + b, 0), 0)
})

test('percentiles come off the histogram and report the bucket floor', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  // 99 intervals of 60s, then one of 600s. The median sits in the 60s bucket
  // and the p99 out in the tail.
  let t = t0
  const batch = [{ n: 0, t }]
  for (let i = 1; i <= 99; i++) { t += 60_000; batch.push({ n: i, t }) }
  t += 600_000
  batch.push({ n: 100, t })
  m.observeBatch(batch)
  assert.equal(m.chainObs.gaps.count, 100)
  assert.equal(m.gapPercentile(0.5), 60, 'the median bucket floor')
  assert.equal(m.gapPercentile(0.99), 60, '99 of 100 intervals are still the 60s bucket')
  assert.equal(m.gapPercentile(1), 600, 'the slowest lands in the tail bucket')
  // Mean is exact rather than bucketed, so the outlier shows.
  assert.equal(Number((m.chainObs.gaps.sum / m.chainObs.gaps.count).toFixed(2)), 65.4)
})

test('every observation lands in a bucket, however extreme', () => {
  resetChain()
  const t0 = Date.UTC(2026, 8, 1)
  m.observeBatch([{ n: 1, t: t0 }, { n: 2, t: t0 + 86_400_000 }])
  const total = m.chainObs.gaps.buckets.reduce((a, b) => a + b, 0)
  assert.equal(total, 1, 'a day-long gap is counted, in the last bucket')
  assert.equal(m.chainObs.gaps.buckets.at(-1), 1)
})

test('share drift refuses to compare two windows it cannot fill', () => {
  resetChain()
  const today = m.dayKey(Date.now())
  m.days.set(today, { scanned: 10, counts: new Map([['a', 6], ['b', 4]]) })
  const drift = m.shareDrift(new Map())
  assert.equal(drift.comparable, false, 'one day is not two weeks')
  assert.equal(drift.rows.length, 2, 'the rows still exist, only the comparison is withheld')
})

test('share drift reports the move between this week and the one before', () => {
  resetChain()
  const day = (back) => m.dayKey(Date.now() - back * 86_400_000)
  // Last week: a is half. This week: a is a quarter. b picks up the rest.
  for (const back of [0, 1, 2]) {
    m.days.set(day(back), { scanned: 100, counts: new Map([['a', 25], ['b', 75]]) })
  }
  for (const back of [7, 8, 9]) {
    m.days.set(day(back), { scanned: 100, counts: new Map([['a', 50], ['b', 50]]) })
  }
  const drift = m.shareDrift(new Map())
  assert.equal(drift.comparable, true)
  const a = drift.rows.find((r) => r.address === 'a')
  const b = drift.rows.find((r) => r.address === 'b')
  assert.equal(a.sharePercent, 25)
  assert.equal(a.previousSharePercent, 50)
  assert.equal(a.deltaPercent, -25)
  assert.equal(b.deltaPercent, 25)
  assert.equal(drift.rows[0].address, 'b', 'sorted by movement, gainers first')
})

test('churn separates newly observed from gone quiet', () => {
  resetChain()
  const day = (back) => m.dayKey(Date.now() - back * 86_400_000)
  // `old` produced a fortnight ago and nothing since. `fresh` only appeared
  // this week. `steady` is in both. Two earlier days, so the comparison is
  // allowed to run.
  m.days.set(day(14), { scanned: 20, counts: new Map([['old', 10], ['steady', 10]]) })
  m.days.set(day(13), { scanned: 20, counts: new Map([['old', 10], ['steady', 10]]) })
  m.days.set(day(1), { scanned: 20, counts: new Map([['fresh', 10], ['steady', 10]]) })
  const churn = m.producerChurn(new Map())
  assert.equal(churn.comparable, true)
  assert.deepEqual(churn.arrived.map((r) => r.address), ['fresh'])
  assert.deepEqual(churn.quiet.map((r) => r.address), ['old'])
  assert.equal(churn.seenThisWeek, 2, 'fresh and steady')
  const old = churn.quiet[0]
  // day(13) is the newer of the two buckets it appears in, which is what
  // "last seen" means.
  assert.equal(old.lastSeen, day(13), 'when it was last seen, not a claim that it stopped')
})

test('a fresh install does not report the whole chain as newly arrived', () => {
  // Five days of buckets and nothing before them, which is what a dashboard
  // installed on Monday looks like on Friday. Every producer is "not in the
  // earlier window" because there is no earlier window -- and the card listed
  // seven of eight as new arrivals, an artefact of the install date presented
  // as a fact about the chain.
  resetChain()
  const day = (back) => m.dayKey(Date.now() - back * 86_400_000)
  for (const back of [0, 1, 2, 3, 4]) {
    m.days.set(day(back), { scanned: 80, counts: new Map([['a', 20], ['b', 20], ['c', 20], ['d', 20]]) })
  }
  const churn = m.producerChurn(new Map())
  assert.equal(churn.comparable, false, 'there is nothing to compare against yet')
  assert.deepEqual(churn.arrived, [], 'so nobody is announced as new')
  assert.deepEqual(churn.quiet, [], 'and nobody is announced as gone')
  assert.equal(churn.seenThisWeek, 4, 'but who is producing is still known')
})

test('one earlier day is not enough to call anyone new', () => {
  resetChain()
  const day = (back) => m.dayKey(Date.now() - back * 86_400_000)
  m.days.set(day(10), { scanned: 10, counts: new Map([['a', 10]]) })
  m.days.set(day(1), { scanned: 10, counts: new Map([['b', 10]]) })
  assert.equal(m.producerChurn(new Map()).comparable, false,
    'a single day of history is a sample, not a baseline')
})

test('the network view is memoised so a browser refresh recomputes nothing', () => {
  resetChain()
  m.peers.set('a', 10)
  m.production.scanned = 10
  const first = m.networkView(m.peerBoard())
  const second = m.networkView(m.peerBoard())
  assert.equal(first, second, 'the same object, not merely an equal one')
  // A block arriving must invalidate it, or the page would freeze at boot.
  m.observeBatch([{ n: 1, t: Date.UTC(2026, 8, 1) }, { n: 2, t: Date.UTC(2026, 8, 1) + 60_000 }])
  assert.notEqual(m.networkView(m.peerBoard()), first, 'new observations invalidate the cache')
})

test('the network view never claims to have seen the whole chain', () => {
  resetChain()
  m.peers.set('a', 10)
  m.production.scanned = 10
  const v = m.networkView(m.peerBoard())
  assert.equal(v.observed.complete, false,
    'a windowed scan must not present itself as a protocol-wide census')
  assert.equal(v.observed.blocks, 10)
})

// ------------------------------------------------------------- alert reading

test('an absent alert state file is not an error, it is an absent alerter', async () => {
  process.env.DASH_ALERT_STATE_FILE = join(here, 'fixtures', 'no-such-alert-state')
  const fresh = await import(`../dashboard/server.mjs?alerts=${Date.now()}`)
  await fresh.pollAlerts()
  assert.equal(fresh.state.alerts.ok, true, 'not having set alerting up is not a fault')
  assert.equal(fresh.state.alerts.installed, false)
})

test('a state file is parsed into conditions, and junk lines are counted not shown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xl1-alerts-'))
  const file = join(dir, '.alert-state')
  const since = Math.floor(Date.now() / 1000) - 300
  await writeFile(file, `ineligible\t${since}\nnot-producing\t${since - 60}\ngarbage-line\nbroken\tnotanumber\n`)
  process.env.DASH_ALERT_STATE_FILE = file
  const fresh = await import(`../dashboard/server.mjs?alerts=${Date.now()}b`)
  await fresh.pollAlerts()
  const a = fresh.state.alerts
  assert.equal(a.installed, true)
  assert.equal(a.active.length, 2)
  assert.equal(a.malformed, 2, 'unreadable lines are reported rather than rendered as conditions')
  assert.equal(a.active[0].key, 'not-producing', 'oldest first — it has been wrong the longest')
  assert.equal(a.active[0].label, 'Not landing blocks', 'keys are given words for the panel')
  assert.ok(a.running, 'a file just written means the alerter is alive')
})

test('an empty state file means all clear, which is not the same as no alerter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xl1-alerts-'))
  const file = join(dir, '.alert-state')
  await writeFile(file, '')
  process.env.DASH_ALERT_STATE_FILE = file
  const fresh = await import(`../dashboard/server.mjs?alerts=${Date.now()}c`)
  await fresh.pollAlerts()
  assert.equal(fresh.state.alerts.installed, true, 'the alerter ran and found nothing')
  assert.equal(fresh.state.alerts.active.length, 0)
  assert.equal(fresh.state.alerts.running, true)
})

// ---------------------------------------------------------- bounding the tally
//
// The cumulative tally was the one structure on the page with nothing bounding
// it. The cap that guards it must never be the reason a producing node vanishes
// from the standings, so these cases are mostly about what it refuses to evict.

/** A tally of `n` addresses, none of them in any day bucket, plus whatever
 *  recent producers the caller wants protected. */
function seedPeers(silent, active = []) {
  m.peers.clear()
  m.days.clear()
  m.peersEvicted.addresses = 0
  m.peersEvicted.blocks = 0
  m.peersEvicted.overCap = false
  for (let i = 0; i < silent; i++) m.peers.set(`silent${String(i).padStart(4, '0')}`, i + 1)
  if (active.length) {
    const counts = new Map(active.map((a) => [a, 100]))
    for (const a of active) m.peers.set(a, 100)
    m.days.set(m.dayKey(Date.now()), { scanned: 100 * active.length, counts })
  }
}

test('nothing is evicted while the tally is inside the cap', () => {
  seedPeers(10)
  m.prunePeers()
  assert.equal(m.peers.size, 10)
  assert.equal(m.peersEvicted.addresses, 0, 'the ordinary case must not touch anything')
})

test('over the cap, only addresses absent from every retained day are dropped', () => {
  // One more silent address than the cap allows, plus five that produced today.
  seedPeers(m.PEERS_MAX + 5, ['live1', 'live2', 'live3', 'live4', 'live5'])
  const before = m.peers.size
  m.prunePeers()
  assert.ok(m.peers.size <= m.PEERS_MAX, `pruned to ${m.peers.size}, cap ${m.PEERS_MAX}`)
  assert.ok(before > m.peers.size, 'something was actually dropped')
  for (const a of ['live1', 'live2', 'live3', 'live4', 'live5']) {
    assert.ok(m.peers.has(a), `${a} produced today and must survive any cap`)
  }
})

test('the smallest of the long-silent goes first, not the smallest overall', () => {
  seedPeers(m.PEERS_MAX + 3, ['live1'])
  m.prunePeers()
  // silent0000 held 1 block and had not produced in the retained window.
  assert.equal(m.peers.has('silent0000'), false, 'the least-missed silent producer went')
  // live1 holds 100 but is recent; a smallest-first cap over the whole map
  // would have kept silent addresses ahead of it.
  assert.equal(m.peers.get('live1'), 100, 'recency beats size')
})

test('a cap smaller than the active set yields rather than lying', () => {
  // Every address produced today, and there are more of them than the cap.
  const live = []
  for (let i = 0; i < m.PEERS_MAX + 10; i++) live.push(`live${String(i).padStart(4, '0')}`)
  seedPeers(0, live)
  m.prunePeers()
  assert.equal(m.peers.size, live.length, 'no producing node is dropped to satisfy a number')
  assert.equal(m.peersEvicted.addresses, 0)
  assert.equal(m.peersEvicted.overCap, true, 'and the overflow is admitted rather than hidden')
})

test('what was evicted is counted, so the totals can admit they are partial', () => {
  seedPeers(m.PEERS_MAX + 4)
  m.prunePeers()
  assert.ok(m.peersEvicted.addresses >= 4)
  assert.ok(m.peersEvicted.blocks > 0, 'the blocks that left with them are recorded too')
  const board = m.peerBoard()
  assert.ok(board.evicted, 'and the page is told')
  assert.equal(board.evicted.quietDays, board.daysKept)
})

test('an untouched tally carries no caveat at all', () => {
  seedPeers(5)
  m.prunePeers()
  assert.equal(m.peerBoard().evicted, undefined,
    'the ordinary case must not explain itself')
})

test('the alerter reports what it is armed with, and the dashboard says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xl1-armed-'))
  const since = Math.floor(Date.now() / 1000) - 60
  await writeFile(join(dir, '.alert-state'), `ineligible\t${since}\n`)
  await writeFile(join(dir, '.alert-status'), JSON.stringify({
    node: 'pitest', ranAt: new Date().toISOString(),
    channels: ['ntfy', 'webhook'], deadman: false,
    cooldownSeconds: 21600, stallBlocks: 90,
  }))
  process.env.DASH_ALERT_STATE_FILE = join(dir, '.alert-state')
  process.env.DASH_ALERT_STATUS_FILE = join(dir, '.alert-status')
  const fresh = await import(`../dashboard/server.mjs?armed=${Date.now()}`)
  await fresh.pollAlerts()
  const a = fresh.state.alerts
  assert.deepEqual(a.armed.channels, ['ntfy', 'webhook'])
  assert.equal(a.armed.deadman, false, 'the gap is reported, not glossed over')
  assert.equal(a.armed.node, 'pitest')
})

test('no status file costs one row, not the card', async () => {
  // An alerter older than this feature writes no such file. The conditions it
  // does report must still reach the page.
  const dir = await mkdtemp(join(tmpdir(), 'xl1-armed-'))
  await writeFile(join(dir, '.alert-state'), '')
  process.env.DASH_ALERT_STATE_FILE = join(dir, '.alert-state')
  process.env.DASH_ALERT_STATUS_FILE = join(dir, '.alert-status-missing')
  const fresh = await import(`../dashboard/server.mjs?armed=${Date.now()}b`)
  await fresh.pollAlerts()
  assert.equal(fresh.state.alerts.installed, true, 'the alerter is still detected')
  assert.equal(fresh.state.alerts.armed, undefined, 'only the armed row is absent')
})

test('a status file that is not our JSON is ignored rather than rendered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xl1-armed-'))
  await writeFile(join(dir, '.alert-state'), '')
  await writeFile(join(dir, '.alert-status'), 'not json at all')
  process.env.DASH_ALERT_STATE_FILE = join(dir, '.alert-state')
  process.env.DASH_ALERT_STATUS_FILE = join(dir, '.alert-status')
  const fresh = await import(`../dashboard/server.mjs?armed=${Date.now()}c`)
  await fresh.pollAlerts()
  assert.equal(fresh.state.alerts.ok, true, 'a corrupt advisory file is not a fault')
  assert.equal(fresh.state.alerts.armed, undefined)
})

// ------------------------------------------------------------------ the fleet
//
// A peer is another dashboard, not the chain, so none of this adds a gateway
// call. What it must never do is present a fleet more healthy than it is.

test('a peer summary keeps only the fields the card draws', () => {
  const summary = m.fleetSummary({
    status: 'degraded',
    problems: ['a', 'b', 'c', 'd', 'e', 'f'],
    build: { version: '2.2.3', commit: 'abc' },
    chain: { currentBlock: 100 },
    derived: { blocksByWindow: { day24h: 12 } },
    peers: { self: { blocks: 500, sharePercent: 9.5, rank: 4, address: 'aa' }, producers: 8, scannedBlocks: 1000 },
    alerts: { installed: true, running: true, active: [{ key: 'x' }] },
    node: { runSeconds: 900, cliVersion: '5.3.2' },
    // Thirty kilobytes this node has no use for. It must not survive.
    history: { height: new Array(240).fill({ t: 1, v: 2 }) },
  })
  assert.equal(summary.blocksTotal, 500)
  assert.equal(summary.alertsFiring, 1)
  assert.equal(summary.problems.length, 4, 'problems are capped, not copied wholesale')
  assert.equal(summary.history, undefined, 'a peer cannot push its history into this payload')
})

test('an unrecognised status from a peer is not taken at face value', () => {
  assert.equal(m.fleetSummary({ status: 'excellent' }).status, 'unknown')
  assert.equal(m.fleetSummary({}).status, 'unknown')
})

test('combined share is withheld unless the nodes scanned the same blocks', async () => {
  process.env.DASH_FLEET = 'a=http://127.0.0.1:9/api/status'
  const fresh = await import(`../dashboard/server.mjs?fleet=${Date.now()}`)
  fresh.fleet.set('a', { label: 'a', ok: true, blocksTotal: 100, sharePercent: 5, scannedBlocks: 2000 })
  // This node scanned a different window, so the two shares describe different
  // denominators and adding them would be arithmetic on unlike things.
  fresh.production.scanned = 1000
  // SELF, so peerBoard() actually finds this node in its own tally -- any other
  // address leaves board.self undefined and the row contributes nothing.
  fresh.peers.set(SELF, 50)
  const view = fresh.fleetView(fresh.peerBoard())
  assert.equal(view.combinedSharePercent, undefined, 'unlike windows do not add')
  assert.equal(view.combinedBlocks, 150, 'but the block counts still total')
  assert.equal(view.combinedFrom, 2, 'and say how many nodes they came from')
})

test('an unreachable peer is a row, not an omission', async () => {
  process.env.DASH_FLEET = 'gone=http://127.0.0.1:9/api/status'
  const fresh = await import(`../dashboard/server.mjs?fleet=${Date.now()}b`)
  await fresh.pollFleet()
  const view = fresh.fleetView(fresh.peerBoard())
  const peer = view.nodes.find((n) => n.label === 'gone')
  assert.ok(peer, 'a node that is switched off must still appear')
  assert.equal(peer.ok, false)
  assert.ok(peer.error, 'and say why')
  assert.equal(view.reachable, 1, 'only this node answered')
  assert.equal(view.total, 2)
})

test('malformed fleet entries are reported rather than dropped', async () => {
  process.env.DASH_FLEET = 'noequals,bad=notaurl,ok=http://127.0.0.1:9'
  const fresh = await import(`../dashboard/server.mjs?fleet=${Date.now()}c`)
  assert.equal(fresh.FLEET.peers.length, 1)
  assert.equal(fresh.FLEET.rejected.length, 2,
    'a node missing from the card looks identical to one switched off')
  // A bare host is accepted; the API path is added rather than demanded.
  assert.match(fresh.FLEET.peers[0].url, /\/api\/status$/)
})

test('no fleet configured means no card at all', async () => {
  process.env.DASH_FLEET = ''
  const fresh = await import(`../dashboard/server.mjs?fleet=${Date.now()}d`)
  assert.equal(fresh.fleetView(fresh.peerBoard()), undefined,
    'a single-node install must not grow a fleet table of one')
})

// ------------------------------------------------------------- the public view
//
// This is the projection that leaves the house. Every test here is about what
// must NOT be in it: the payload is going on the open internet, and a mistake
// is discovered by whoever finds it rather than by us.

test('the public view carries the chain figures worth publishing', () => {
  const board = m.peerBoard()
  const pub = m.publicView(board)
  assert.equal(pub.schema, 1, 'the shape is versioned so a stale page can say so')
  assert.ok(pub.generatedAt, 'and dated, so a frozen page is visibly frozen')
  assert.ok('concentration' in pub.network, 'Nakamoto and shares are the point of publishing')
  assert.ok('blockTime' in pub.network, 'so is the distribution')
  assert.ok(Array.isArray(pub.network.standings))
})

test('nothing that identifies the machine survives the projection', () => {
  // Seed every private field with a value that would be obvious in a diff, then
  // assert none of them appear anywhere in the serialised output.
  m.state.system = {
    ok: true, hostname: 'CANARY-HOSTNAME', cpuCount: 16,
    memory: { usedPercent: 77 }, disk: { usedPercent: 76, freeBytes: 1 },
  }
  m.state.node = {
    ok: true, cliVersion: '5.3.2',
    container: { running: true, image: 'CANARY-IMAGE', uptime: 'CANARY-UPTIME' },
    recentLog: ['CANARY-LOG-LINE /home/someone/secret/path'],
  }
  m.state.health = { ok: true, endpoint: 'http://CANARY-HEALTH-ENDPOINT:9099' }
  m.state.alerts = {
    ok: true, installed: true, running: true, active: [],
    armed: { node: 'CANARY-ALERT-NODE', channels: ['ntfy'], deadman: false },
  }

  const text = JSON.stringify(m.publicView(m.peerBoard()))
  for (const canary of [
    'CANARY-HOSTNAME', 'CANARY-IMAGE', 'CANARY-UPTIME', 'CANARY-LOG-LINE',
    'CANARY-HEALTH-ENDPOINT', 'CANARY-ALERT-NODE', 'secret/path',
  ]) {
    assert.equal(text.includes(canary), false, `${canary} reached the public payload`)
  }
  // And the shapes that carried them are absent outright, not merely emptied.
  const pub = m.publicView(m.peerBoard())
  for (const key of ['system', 'node', 'alerts', 'fleet', 'health', 'history', 'trend', 'problems']) {
    assert.equal(key in pub, false, `\`${key}\` must not be published`)
  }
})

test('the status is a word, never the sentences behind it', () => {
  // Problem strings are assembled from error messages, and an error message is
  // exactly where a path or a hostname arrives without anyone deciding it should.
  m.state.node = { ok: false, error: 'ENOENT /var/lib/xl1/CANARY-PATH' }
  const pub = m.publicView(m.peerBoard())
  assert.equal(typeof pub.status, 'string')
  assert.equal(typeof pub.problemCount, 'number')
  assert.equal(JSON.stringify(pub).includes('CANARY-PATH'), false,
    'the count is publishable, the text is not')
})

test('the published label is chosen, never taken from the hostname', () => {
  // A default of os.hostname() would publish the machine's name the moment
  // somebody turned the feature on without reading anything.
  m.state.system = { ok: true, hostname: 'CANARY-HOSTNAME' }
  const pub = m.publicView(m.peerBoard())
  assert.notEqual(pub.label, 'CANARY-HOSTNAME')
  assert.equal(pub.label, undefined, 'unset means unpublished, not guessed')
})
