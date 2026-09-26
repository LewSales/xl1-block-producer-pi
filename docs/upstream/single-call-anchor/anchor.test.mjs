// node --test anchor.test.mjs
//
// Every behaviour test runs against both the shipped class and the proposal: the proposal must
// be indistinguishable from what ships except in how many round trips it makes and in surviving
// an inconsistent load-balanced backend.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { makeViewer, ProposedTimeSyncViewer, ShippedTimeSyncViewer } from './proposed.mjs'

const HASH = n => `0x${n.toString(16).padStart(64, '0')}`
const bare = h => h.slice(2)
const HEAD = { block: 631171, _hash: 'ab'.repeat(32) }

/** A provider whose tip is `tip`; counts every call. */
function mockProvider(tip, { lagging = false } = {}) {
  const calls = []
  return {
    calls,
    async getBlockNumber() { calls.push('getBlockNumber'); return tip.n },
    async getBlock(tag) {
      calls.push(`getBlock:${tag}`)
      if (tag === 'latest') return { number: tip.n, hash: HASH(tip.n) }
      // A load-balanced backend one block behind the one that answered getBlockNumber.
      if (lagging && tag === tip.n) return null
      return { number: tag, hash: HASH(tag) }
    },
  }
}

for (const [name, Cls] of [['shipped', ShippedTimeSyncViewer], ['proposed', ProposedTimeSyncViewer]]) {
  describe(name, () => {
    test('anchor is the tip number with that block\'s own hash', async () => {
      const v = makeViewer(Cls, { provider: mockProvider({ n: 11_790_001 }), head: HEAD })
      assert.deepEqual(await v.currentEthereumAnchor(), [11_790_001, bare(HASH(11_790_001))])
    })

    test('time payload carries xl1 from the head and the anchor from one block', async () => {
      const v = makeViewer(Cls, { provider: mockProvider({ n: 42 }), head: HEAD })
      const before = Date.now()
      const p = await v.currentTimePayload()
      assert.equal(p.schema, 'network.xyo.time')
      assert.equal(p.xl1, HEAD.block)
      assert.equal(p.xl1Hash, HEAD._hash)
      assert.equal(p.ethereum, 42)
      assert.equal(p.ethereumHash, bare(HASH(42)))
      assert.ok(p.epoch >= before && p.epoch <= Date.now())
    })

    test('a null block still fails loudly, with the same message', async () => {
      const provider = { getBlockNumber: async () => 7, getBlock: async () => null }
      const v = makeViewer(Cls, { provider, head: HEAD })
      await assert.rejects(v.currentEthereumAnchor(), /Block hash not found/)
    })

    test('a block without a hash still fails loudly', async () => {
      const provider = { getBlockNumber: async () => 7, getBlock: async () => ({ number: 7, hash: null }) }
      const v = makeViewer(Cls, { provider, head: HEAD })
      await assert.rejects(v.currentEthereumAnchor(), /Block hash not found/)
    })

    test('ttl 0 (the default) reads a fresh tip on every call', async () => {
      const tip = { n: 100 }
      const v = makeViewer(Cls, { provider: mockProvider(tip), head: HEAD })
      assert.equal((await v.currentEthereumAnchor())[0], 100)
      tip.n = 101
      assert.equal((await v.currentEthereumAnchor())[0], 101, 'must never serve a stale anchor at ttl 0')
    })

    test('ttl > 0 keeps its existing caching behaviour', async () => {
      const tip = { n: 100 }
      const provider = mockProvider(tip)
      const v = makeViewer(Cls, { provider, head: HEAD, ttl: 60_000 })
      await v.currentEthereumAnchor()
      const n = provider.calls.length
      tip.n = 101
      assert.equal((await v.currentEthereumAnchor())[0], 100)
      assert.equal(provider.calls.length, n)
    })

    test('concurrent reads share one in-flight fetch', async () => {
      const provider = mockProvider({ n: 5 })
      const v = makeViewer(Cls, { provider, head: HEAD })
      const [a, b] = await Promise.all([v.currentEthereumAnchor(), v.currentEthereumAnchor()])
      assert.deepEqual(a, b)
      const expected = name === 'shipped' ? 2 : 1
      assert.equal(provider.calls.length, expected)
    })
  })
}

describe('what the proposal changes', () => {
  test('one provider round trip per anchor instead of two', async () => {
    const shipped = mockProvider({ n: 9 })
    const proposed = mockProvider({ n: 9 })
    await makeViewer(ShippedTimeSyncViewer, { provider: shipped, head: HEAD }).currentEthereumAnchor()
    await makeViewer(ProposedTimeSyncViewer, { provider: proposed, head: HEAD }).currentEthereumAnchor()
    assert.deepEqual(shipped.calls, ['getBlockNumber', 'getBlock:9'])
    assert.deepEqual(proposed.calls, ['getBlock:latest'])
  })

  test('a lagging backend behind the number read no longer fails the time payload', async () => {
    const tip = { n: 12 }
    await assert.rejects(
      makeViewer(ShippedTimeSyncViewer, { provider: mockProvider(tip, { lagging: true }), head: HEAD }).currentTimePayload(),
      /Block hash not found/,
    )
    const p = await makeViewer(ProposedTimeSyncViewer, { provider: mockProvider(tip, { lagging: true }), head: HEAD }).currentTimePayload()
    assert.equal(p.ethereum, 12)
  })
})
