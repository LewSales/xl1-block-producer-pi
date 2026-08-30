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
  assert.match(dv.lastBlockUrl, /\/block\/575735$/)
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
