// Card grouping, the KPI row, mobile order, and the header's status derivation
// are product decisions that live in index.html rather than server.mjs, so the
// dashboard suite cannot reach them. They break silently -- a new card lands
// in the wrong group, a mobile --mo value drifts -- and nobody notices until a
// screenshot looks wrong.
//
// render() is extracted from the page and run against a tiny in-memory DOM
// stub (a plain object per element id -- render() only ever assigns to a
// property or calls .getElementById, it never queries the tree back, so that
// is enough). No jsdom, no browser, no dependency.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const html = readFileSync(join(here, '..', 'dashboard', 'index.html'), 'utf8')

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
assert.ok(scriptMatch, 'index.html must have its script inline — did the <script> tag move?')
const script = scriptMatch[1]
const renderBoundary = script.indexOf('async function tick()')
assert.ok(renderBoundary > 0, 'could not find the tick() boundary — did render() get renamed?')
// Only the declarations up to render(): tick()/setInterval/fetch never run.
const renderSource = script.slice(0, renderBoundary)

function loadRender() {
  const els = {}
  const el = (id) => (els[id] ??= { hidden: true, className: '', textContent: '', innerHTML: '', title: '', href: '' })
  const document = { getElementById: el, hidden: false, addEventListener: () => {} }
  const sandbox = { document, console, Date, Math, Number, String, Array, Object, URL, location: { search: '' } }
  vm.createContext(sandbox)
  vm.runInContext(renderSource + '\nglobalThis.__render = render', sandbox)
  return { render: sandbox.__render, els }
}

const renderTo = (fixture) => {
  const { render, els } = loadRender()
  render(fixture)
  return els
}

// A single title/label extractor covering both KPI tiles (<div class="k">) and
// card headings (<h2>...icon span...title). Order matters below, not shape.
// --mo: sought anywhere inside the style attribute, not assumed to be its only
// property -- the visual refinement pass added --c/--k accent variables into
// the same attribute, and this must not care what order they land in.
const kpiRe = /<div class="kpi" style="[^"]*--mo:(\d+)[^"]*">\s*<div class="k">(?:\s*<span[^>]*>[^<]*<\/span>)?\s*([^<]+)</g
const cardRe = /<section[^>]*style="[^"]*--mo:(\d+)[^"]*"[^>]*>\s*<h2[^>]*>(?:\s*<span[^>]*>[^<]*<\/span>)?\s*([^<]+)/g
function mobileOrder(fragment) {
  const items = []
  for (const m of fragment.matchAll(kpiRe)) items.push([Number(m[1]), m[2].trim()])
  for (const m of fragment.matchAll(cardRe)) items.push([Number(m[1]), m[2].replaceAll('&amp;', '&').trim()])
  return items.sort((a, b) => a[0] - b[0]).map(([, title]) => title)
}

// Group membership: which <section class="group"> a card's heading falls
// inside. Parsed from the rendered string, not the source -- this is what a
// browser actually receives.
const groupRe = /<section class="group"><h2 class="group-heading">(?:\s*<span[^>]*>[^<]*<\/span>)?\s*([^<]+)<\/h2><div class="group-grid">([\s\S]*?)<\/div><\/section>/g
const cardTitleRe = /<h2[^>]*>(?:\s*<span[^>]*>[^<]*<\/span>)?\s*([^<]+)/g
function groupsOf(gridHtml) {
  const out = {}
  for (const m of gridHtml.matchAll(groupRe)) {
    out[m[1]] = [...m[2].matchAll(cardTitleRe)].map((t) => t[1].replaceAll('&amp;', '&').trim())
  }
  return out
}

// A fixture rich enough that every card in the file renders at once -- the
// equivalent of the old suite's flat `ALL` title list, but as real input
// rather than a fabricated heading.
const FULL = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  dashboardStartedAt: new Date().toISOString(),
  problems: [],
  build: { version: '9.9.9', commit: 'abc12345', builtAt: new Date().toISOString(), source: 'https://github.com/x/y', commitUrl: 'https://github.com/x/y/commit/abc12345', brandName: 'Test', brandUrl: 'https://example.com', upstreamName: 'XYO', upstreamUrl: 'https://xyo.network' },
  chain: {
    ok: true, network: 'sequence', networkName: 'Sequence', explorerUrl: 'https://x', chainId: '0123456789abcdef', chainIdMatchesPreset: true,
    currentBlock: 12345, finalizedBlock: 12340, finalizationLag: 5,
    balances: {
      reward: { address: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', xl1: '1,000.0000', url: 'https://x/a', sinceStart: { xl1: '50.0000' } },
      producer: { address: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', xl1: '1,000.0000', url: 'https://x/a' },
    },
  },
  release: { ok: true, latest: '5.3.2', installed: '5.3.2', lag: 'current' },
  health: { ok: true, endpoint: 'http://x/livez' },
  node: {
    ok: true, stale: false, ageSeconds: 5, eligibilityIgnored: false,
    container: { running: true, state: 'running', uptime: '3h', restartCount: 0, image: 'xl1:local' },
    eligibility: { blocked: false, window: '20m' },
    os: { updates: 0, securityUpdates: 0, updatesAgeHours: 2, rebootRequired: false },
    errorCount: 0, blocksPublished: 12, lastPublishedBlock: 12300, cliVersion: '5.3.2', runSeconds: 10800,
    recentLog: Array.from({ length: 40 }, (_, i) => `line ${i}`),
  },
  system: { ok: true, platform: 'pi', hostname: 'xl1pi', uptimeSeconds: 100000, cpuCount: 4, cpuTempC: 55, loadAverage: [0.5, 0.4, 0.3], memory: { totalBytes: 1e9, availableBytes: 5e8, usedPercent: 50 }, swap: { totalBytes: 0 }, disk: { totalBytes: 1e10, freeBytes: 5e9, usedPercent: 50 } },
  alerts: { ok: true, installed: true, running: true, active: [], armed: { channels: ['ntfy'], deadman: true }, lastRunAgeSeconds: 10, malformed: 0 },
  derived: {
    producedObserved: 42, producedSince: 12000, producedSharePercent: 4.2, lastBlock: 12300, lastBlockUrl: 'https://x/b', blocksSinceLast: 3,
    blocksPerHourNode: 6, rewardPerHour: 30, rewardPerDay: 720, lastPayoutSeconds: 600, lastPayoutXl1: 50,
    secondsPerBlock: 53, blocksPerHourChain: 68, observedSeconds: 3600, samples: 68, headAgeSeconds: 12,
    blocksByWindow: { hour: 1, day24h: 18, day24hComplete: true, today: 5, total: 500 },
    rewardEqualsProducer: true,
    race: { built: 20, chainBlocks: 68, retries: 2, lostTotal: 3, observedSeconds: 3600, won: 5, pulse: [1, 0, 1, 0, 0], chainWindowSeconds: 3600, reasons: [{ key: 'a', label: 'Behind finalized head', count: 2, percent: 66.7 }, { key: 'b', label: 'Retried', count: 1, percent: 33.3 }] },
    latency: { wireFloorMs: 40, typicalMs: 60, p95Ms: 120, localMs: 20, cycleP50Ms: 300, cycleP95Ms: 700, samples: 500 },
    operations: { score: 82, components: [{ label: 'Latency', value: 90, why: 'x' }], sinceWin: 12, longestGap: 40, ringBlocks: 500, competition: { producers: 8, leaderShare: 30, topThreeShare: 60, ourShare: 4.2, medianShare: 3, vsMedian: 1.2, vsLeader: -25.8 }, bottleneck: { key: 'none', text: 'nothing measured is slow' }, stages: { headFetch: 40, blockProduction: 200 } },
    lastPayoutSeconds: 600,
  },
  peers: {
    producers: 8, scannedBlocks: 1000, scannedFrom: 11300, scannedTo: 12300, since: new Date().toISOString(),
    selfRank: 4, self: { address: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blocks: 42, sharePercent: 4.2, rank: 4, isSelf: true },
    top: [
      { address: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'Leader', blocks: 300, sharePercent: 30, rank: 1, isSelf: false, url: 'https://x/c' },
      { address: 'cccccccccccccccccccccccccccccccccccccccc', blocks: 200, sharePercent: 20, rank: 2, isSelf: false },
      { address: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blocks: 42, sharePercent: 4.2, rank: 4, isSelf: true },
    ],
    windows: { today: { self: { rank: 4, blocks: 2 }, leader: { blocks: 10 }, top: [{ blocks: 10 }, { blocks: 8 }], producers: 8 }, week: { self: { rank: 4, blocks: 15 }, leader: { blocks: 60 }, top: [{ blocks: 60 }], producers: 8 } },
    dayTz: 'UTC', daysKept: 30,
  },
  network: {
    observed: { blocks: 1000, fromBlock: 11300, toBlock: 12300, daysKept: 30 },
    concentration: { producers: 8, blocks: 1000, leaderShare: 30, top3Share: 60, nakamoto: 2, nakamoto67: 4, evenShare: 12.5 },
    blockTime: { samples: 900, meanSeconds: 53, medianSeconds: 52, p95Seconds: 70, p99Seconds: 90, minSeconds: 30, maxSeconds: 120, edges: Array.from({ length: 10 }, (_, i) => 20 + i * 10), buckets: [1, 5, 20, 200, 400, 200, 50, 15, 8, 1], rejected: { nonConsecutive: 0, nonPositive: 0 } },
    drift: { comparable: true, rows: [{ address: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'Leader', blocks: 300, previousBlocks: 250, sharePercent: 30, previousSharePercent: 27, deltaPercent: 3 }] },
    churn: { quietAfterDays: 7, seenToday: 6, seenThisWeek: 8, comparable: true, arrived: [], quiet: [], daysStored: 14 },
    selfShare: 4.2,
  },
  continuity: {
    producingPercent: 88, observedHours: 72, producingHours: 63, missedHours: 9, longestMissedHours: 3, unobservedHours: 0,
    hours: Array.from({ length: 72 }, (_, i) => ({ t: Date.now() - i * 3600000, observed: true, wins: i % 5, chainBlocks: 60 })),
  },
  trend: { daily: Array.from({ length: 5 }, (_, i) => ({ day: `d${i}`, blocks: 5 + i, earned: 250 + i * 10 })), points: 500, retainDays: 30 },
  price: { configured: true, ok: true, currency: 'usd', value: 0.5, change24h: 2.5, id: 'xl1', notional: 500 },
  fleet: {
    reachable: 2, total: 2, combinedBlocks: 100, combinedFrom: 2, combinedSharePercent: 8.4, pollSeconds: 30,
    nodes: [{ label: 'windows', isSelf: true, ok: true, status: 'ok', blocksTotal: 42, sharePercent: 4.2, rank: 4, producers: 8, alerterRunning: true, version: '5.3.2' },
      { label: 'rbpi3', ok: true, status: 'ok', blocksTotal: 58, sharePercent: 5.8, rank: 3, producers: 8, alerterRunning: true, version: '5.3.2' }],
  },
  history: { height: [100, 105, 110, 118, 130], reward: [0, 50, 50, 100, 150], tempC: [50, 52, 51, 55, 54] },
}

test('every card sorts into exactly one of the four topic groups', () => {
  const els = renderTo(FULL)
  const groups = groupsOf(els.grid.innerHTML)
  assert.deepEqual(Object.keys(groups), ['Producer performance', 'Network health', 'Production performance', 'Analytics'],
    'the four groups must appear in this order, and only these four')
  assert.deepEqual(groups['Producer performance'], ['Producer', 'Rewards', 'What it is worth', 'Trends'])
  assert.deepEqual(groups['Network health'], ['Chain', 'Alerts', 'XL1 Network', 'Producer standings'])
  assert.deepEqual(groups['Production performance'], ['Operations', 'Candidate race', 'Latency', 'Software & host'])
  assert.deepEqual(groups['Analytics'], ['Block time', 'Continuity', 'Producer movement', 'Fleet', 'Raspberry Pi'])
})

test('the ineligibility banner and the log sit outside every group', () => {
  const withBanner = { ...FULL, node: { ...FULL.node, eligibility: { blocked: true, reason: 'insufficient stake', window: '20m' }, eligibilityIgnored: false } }
  const grid = renderTo(withBanner).grid.innerHTML
  assert.match(grid, /^<section class="card-full"[^>]*>\s*<h2><span[^>]*>[^<]*<\/span>Producer cannot produce<\/h2>/,
    'the banner must be the very first thing in the grid, before the KPI row and every group')
  assert.ok(grid.indexOf('Producer cannot produce') < grid.indexOf('kpi-row'), 'banner precedes the KPI row')
  const lastGroupEnd = grid.lastIndexOf('</section></section>') // group wrapper close, then its last card
  assert.ok(grid.indexOf('Producer log') > grid.lastIndexOf('class="group"'),
    'the log renders after every group section, not inside one')
})

test('mobile order matches the sequence the brief specifies, KPIs and cards alike', () => {
  const grid = renderTo(FULL).grid.innerHTML
  assert.deepEqual(mobileOrder(grid), [
    'Blocks won', 'Network rank', 'Last 24h', 'Observed share', 'Current block',
    'Chain',
    'Producer', 'Rewards', 'What it is worth', 'Trends',
    'XL1 Network', 'Alerts',
    'Operations', 'Candidate race', 'Latency', 'Software & host',
    'Block time', 'Producer movement', 'Fleet', 'Raspberry Pi', 'Continuity',
    'Producer standings',
  ])
})

test('a card missing for want of data just disappears -- it does not strand its group', () => {
  const noLatencyOrRace = { ...FULL, derived: { ...FULL.derived, latency: undefined, race: undefined } }
  const groups = groupsOf(renderTo(noLatencyOrRace).grid.innerHTML)
  assert.deepEqual(groups['Production performance'], ['Operations', 'Software & host'],
    'the group renders with whatever it has; a missing card leaves no gap, no error, no empty stack')
})

test('the standings table marks this node with a YOU badge, not just a tinted row', () => {
  const grid = renderTo(FULL).grid.innerHTML
  const standings = grid.slice(grid.indexOf('Producer standings'))
  assert.match(standings, /class="peer-name">Leader<\/span>[\s\S]*?<tr class="self">/,
    'the leader row renders before the self row in this fixture')
  assert.match(standings, /<tr class="self">[\s\S]{0,400}you-badge">YOU</,
    'the self row must carry the YOU badge')
})

test('the KPI row falls back to honest empty states rather than a blank or a zero', () => {
  const bare = {
    status: 'ok', generatedAt: new Date().toISOString(), dashboardStartedAt: new Date().toISOString(), problems: [],
    chain: { ok: false, error: 'timeout' }, health: { ok: false }, node: { ok: false, error: 'no snapshot' },
    derived: {}, peers: {}, network: {}, system: {}, alerts: {}, release: {}, price: {}, history: {}, trend: {},
  }
  const grid = renderTo(bare).grid.innerHTML
  const kpiRow = grid.slice(grid.indexOf('kpi-row'), grid.indexOf('kpi-row') + 2000)
  assert.match(kpiRow, /Blocks won[\s\S]{0,80}>—</, 'no observation yet reads as a dash, not 0')
  assert.match(kpiRow, /Network rank[\s\S]{0,80}>—</)
  assert.match(kpiRow, /Current block[\s\S]{0,120}class="v bad">Unreachable</, 'an unreachable chain says so on the KPI itself')
})

test('the header status derives four states, not just the server’s raw three', () => {
  // headerState is not exported, so it is re-extracted the same way render()
  // is: pulled out of the script and evaluated directly. No DOM needed here.
  const m = script.match(/const HEADER_STALE_MS[\s\S]*?function headerState\([\s\S]*?\n}/)
  assert.ok(m, 'HEADER_STALE_MS/headerState() must exist for the header to show more than the raw ok/degraded/down')
  const headerState = new Function(m[0] + '; return headerState')()
  assert.equal(headerState({ status: 'ok', generatedAt: new Date().toISOString() }, false), 'online')
  assert.equal(headerState({ status: 'degraded', generatedAt: new Date().toISOString() }, false), 'degraded')
  assert.equal(headerState({ status: 'down', generatedAt: new Date().toISOString() }, false), 'offline')
  assert.equal(headerState({ status: 'ok', generatedAt: new Date().toISOString() }, true), 'offline', 'a fetch failure always wins')
  assert.equal(headerState({ status: 'ok', generatedAt: new Date(Date.now() - 120000).toISOString() }, false), 'stale',
    'stale telemetry overrides an otherwise-ok status')
  assert.equal(headerState({ status: 'ok', node: { stale: true }, generatedAt: new Date().toISOString() }, false), 'stale',
    'node.stale overrides an otherwise-fresh generatedAt')
})

test('the masonry column layout is gone, and so is the pairing it existed for', () => {
  assert.doesNotMatch(html, /columns:\s*320px/, 'the old multi-column masonry must not survive the redesign')
  assert.doesNotMatch(html, /\.stack\s*>/, 'card pairing/stacking is retired, not reworked')
  assert.doesNotMatch(html, /\.wide\s*\{/, 'the old full-width class name is gone (card-full replaces it)')
  assert.match(html, /\.card-full\s*\{/, 'full-width cards use the new grid span class')
  assert.match(html, /\.group-grid\s*\{[^}]*display:\s*grid/, 'each topic group is its own CSS grid')
})

test('mobile promotes rows and groups with display:contents rather than a second render path', () => {
  const mobile = html.slice(html.indexOf('@media (max-width: 767px)'), html.indexOf('@media (max-width: 767px)') + 400)
  assert.match(mobile, /\.kpi-row,\s*\.group,\s*\.group-grid\s*\{\s*display:\s*contents/,
    'no second render path: mobile order comes from promoting the same markup, not rebuilding it')
  assert.match(mobile, /order:\s*var\(--mo\)/)
})
