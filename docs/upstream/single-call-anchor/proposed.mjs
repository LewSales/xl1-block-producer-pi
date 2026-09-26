// JS equivalent of the upstream-src/SimpleTimeSyncViewer.ts patch, applied to a subclass of the
// class as published in @xyo-network/xl1-sdk 5.7.0. Nothing in node_modules is modified: the
// shipped class is exercised as-is, and the proposal differs from it only in this one method.
import { asHash, assertEx } from '@ariestools/sdk'
import { SimpleTimeSyncViewer } from '@xyo-network/xl1-sdk/protocol-sdk'

export { SimpleTimeSyncViewer as ShippedTimeSyncViewer }

export class ProposedTimeSyncViewer extends SimpleTimeSyncViewer {
  async currentEthereumAnchor() {
    const cached = this.cachedEthereumAnchor()
    if (cached !== undefined) return cached
    if (this.ethereumAnchorPromise !== undefined) return await this.ethereumAnchorPromise

    const provider = assertEx(this.ethProvider, () => 'Ethereum provider not configured')
    const promise = (async () => {
      const block = assertEx(await provider.getBlock('latest'), () => 'Block hash not found')
      const blockHash = asHash(assertEx(block.hash, () => 'Block hash not found'), true)
      const value = [block.number, blockHash]
      const ttl = this.options.ethereumAnchorCacheTtlMs
      if (ttl > 0) this.ethereumAnchor = { expiresAt: Date.now() + ttl, value }
      return value
    })()
    this.ethereumAnchorPromise = promise
    try {
      return await promise
    } finally {
      if (this.ethereumAnchorPromise === promise) this.ethereumAnchorPromise = undefined
    }
  }
}

/**
 * A viewer instance without the provider locator: the fields createHandler() would have set are
 * assigned directly, so only the time-payload logic under test runs.
 */
export function makeViewer(Cls, { provider, head, ttl = 0 }) {
  const v = Object.create(Cls.prototype)
  v._ethProvider = provider
  v._options = { ethereumAnchorCacheTtlMs: ttl }
  v._blockViewer = { currentBlock: async () => [head, []] }
  v.ethereumAnchor = undefined
  v.ethereumAnchorPromise = undefined
  return v
}
