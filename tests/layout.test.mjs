// Card order and pairing are product decisions, and they live in index.html
// rather than server.mjs, so the dashboard suite cannot reach them. They break
// silently — a new card lands wherever it was written, a pair quietly unpairs —
// and nobody notices until a screenshot looks wrong.
//
// The logic is extracted from the page and run directly. No DOM, no browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const html = readFileSync(join(here, '..', 'dashboard', 'index.html'), 'utf8')

const slice = (from, to) => {
  const a = html.indexOf(from)
  const b = html.indexOf(to)
  assert.ok(a !== -1 && b !== -1 && b > a, `could not find the ${from} block — did the render change?`)
  return html.slice(a, b)
}

const card = (title) => `<section><h2><span class="ico" aria-hidden="true">x</span>${title}</h2></section>`
const titlesOf = (item) => [...item.matchAll(/<\/span>([^<]+)/g)].map((m) => m[1].replaceAll('&amp;', '&').trim())

// Every heading the page can emit, in the order the code happens to build them.
const ALL = [
  'Producer cannot produce', 'Producer', 'Chain', 'Rewards', 'Software &amp; host', 'Trends',
  'Raspberry Pi', 'Operations', 'Candidate race', 'Latency', 'Producer standings',
  'Producer log — newest first (40 lines)',
  'Alerts', 'XL1 Network', 'Block time', 'Producer movement',
]

function layout(titles = ALL) {
  const rank = new Function('cards', slice('const CARD_ORDER = [', '  // Stable sort')
    + '; return cards.map((h) => rankOf(h))')
  const ordered = titles.map(card)
    .map((h, i) => [rank([h])[0], i, h])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, , h]) => h)
  return new Function('ordered', slice('const PAIRS = [', "$('grid').innerHTML") + '; return out')(ordered)
}

test('cards are ordered by what an operator needs, not by build order', () => {
  const order = layout().flatMap(titlesOf)
  assert.deepEqual(order, [
    'Producer cannot produce',
    'Producer',
    'Raspberry Pi',         // the process, and the machine under it
    'Alerts',               // is it healthy, and would anything say if it stopped
    'Candidate race',
    'Latency',
    'Operations',
    'Chain',
    'Trends',
    'Rewards',
    'Software & host',
    'XL1 Network',          // the chain, once every card about this node is done
    'Block time',
    'Producer movement',
    'Producer standings',   // full width, so second to last
    'Producer log — newest first (40 lines)',
  ])
})

test('the log sorts last despite starting with the word Producer', () => {
  // "Producer log" startsWith "Producer". A single ordered match list would put
  // the log in second place, which is precisely the bug this guards.
  const order = layout().flatMap(titlesOf)
  assert.equal(order.at(-1), 'Producer log — newest first (40 lines)')
  assert.equal(order.at(-2), 'Producer standings')
  assert.equal(order[1], 'Producer', 'the producer card itself must still be first after the banner')
})

test('paired cards become one grid item so the second sits below the first', () => {
  const items = layout()
  const stacked = items.filter((h) => h.startsWith('<div class="stack">')).map(titlesOf)
  assert.deepEqual(stacked, [
    ['Producer', 'Raspberry Pi'],
    ['Candidate race', 'Latency'],
    ['Chain', 'Trends'],
    ['Rewards', 'Software & host'],
  ])
  assert.equal(items.length, ALL.length - 4, 'each pair collapses two cards into one grid item')
})

test('a card missing for want of data does not leave its partner in a stack of one', () => {
  // Latency hides when the collector reports no timings. Candidate race must
  // then stand alone rather than being wrapped in a one-card stack.
  const items = layout(ALL.filter((t) => t !== 'Latency'))
  assert.equal(items.filter((h) => h.startsWith('<div class="stack">')).length, 3, 'the other three pairs survive')
  assert.ok(items.some((h) => !h.startsWith('<div') && titlesOf(h)[0] === 'Candidate race'))
})

test('cards pack into columns rather than wrapping onto a ragged row', () => {
  // A row grid is as tall as its tallest card and strands a leftover card on a
  // row of its own — five items across four columns left one card beside three
  // empty columns. Multi-column balances instead, so there is no leftover row.
  const main = html.match(/main \{[^}]*\}/)[0]
  assert.match(main, /columns:\s*320px/, 'the card area must be a balanced multi-column layout')
  // Width only, no column count: the browser fits as many as the viewport
  // allows, so a wide monitor gets five and a tablet gets two without a query.
  assert.doesNotMatch(main, /columns:\s*\d+\s/, 'a fixed column count stops the layout adapting to the screen')
  assert.doesNotMatch(main, /display:\s*grid/, 'a row grid reintroduces the stranded-card gap')
  assert.match(html, /\.wide \{ column-span: all; \}/, 'full-width cards must span the columns')
})

test('a card is unbreakable but a stack is not', () => {
  // Making the WRAPPER unbreakable handed the balancer a 1000px block it could
  // not move: one column ran to the floor while two others finished halfway up.
  // The card is what must stay whole; the pair is only a preference.
  assert.match(html, /section \{ break-inside: avoid; \}/, 'a card must never be split across a column')
  const main = html.match(/main > \* \{[^}]*\}/)[0]
  assert.doesNotMatch(main, /break-inside/, 'the stack wrapper must stay breakable or the balancer is blocked')
  // Flex and grid containers do not fragment across columns in most engines,
  // which is what made the wrapper indivisible in the first place.
  assert.doesNotMatch(html, /\.stack \{[^}]*display:\s*(flex|grid)/, 'a stack must be a plain block so it can fragment')
})
