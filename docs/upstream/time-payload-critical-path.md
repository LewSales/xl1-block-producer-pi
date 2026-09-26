# The producing path spends ~0.5 s building the time payload, one serial call after another

**Components:** `@xyo-network/xl1-cli` 5.5.0. `SimpleTimeSyncViewer` is in
`@xyo-network/xl1-sdk` 5.7.0 (`dist/node/protocol-sdk.mjs`).
`SimpleBlockRunner` is in chain-sdk (`dist/neutral/services.mjs`).
`ProducerActor` is in `packages/producer`.
**Severity:** not a fault. It is latency on the one path where latency decides
who gets paid.
**Found on:** two federated producers on sequence, a Raspberry Pi 3 B+ (arm64)
and a Windows Docker Desktop host (amd64). Both run role `producer-rest` with
`blockProductionCheckInterval` 4000.
**Status:** prepared, **not filed**.

## Why latency matters here

The finalizer ticks every 500 ms. `findBestUncle` scores candidate chains by
length, plus `PRODUCER_DIVERSITY_BONUS` for a producer other than the head's.
The sort is stable, so among equal candidates the first one listed wins. A valid
candidate wins by being in the pool before its rivals. Every millisecond between
"this producer noticed" and `mempoolRunner.submitBlocks` is a millisecond a
rival can use.

## Evidence

The producer's own `/statz` over about 39 h, `timings.timePayloadGeneration`:

| | p50 | p95 | n |
|---|---|---|---|
| Pi | 475 ms | 594 ms | 4282 |
| Windows | 578 ms | 815 ms | 4352 |

For comparison, the whole of `mempoolSubmitBlock` is 162 / 180 ms p50.
`[Slow] Generated time payload` was logged on 593 of 593 builds in 6 h on each
node.

Probed from inside both containers against the preset's
`default-evm-rpc` (`https://ethereum-sepolia-rpc.publicnode.com`):

| | p50 | p90 |
|---|---|---|
| `eth_blockNumber` then `eth_getBlockByNumber(n)` (what ships) | 324–344 ms | 430–570 ms |
| `eth_getBlockByNumber('latest')` (one call) | ~160 ms | — |

The remaining ~70–135 ms of the time payload is `blockViewer.currentBlock()`,
which re-fetches a head the block runner is already holding.

## Call path as shipped

`SimpleBlockRunner.proposeNextValidBlock(head)` runs these steps in order, each
awaited before the next:

```
chainId()                                  cached
mempoolViewer.pendingTransactions()        RPC   ~130-195 ms
getBlockRewardTransfers(nextBlock)         ~1 ms
generateTransactionFeeTransfers(...)       local
generateTimePayload()                      ~475-578 ms  <- this issue
  SimpleTimeSyncViewer.currentTimePayload()
    currentTimeAndHash('xl1')              blockViewer.currentBlock()    REST ~70-135 ms
    currentTimeAndHash('ethereum')
      currentEthereumAnchor()
        provider.getBlockNumber()          EVM RPC ~160 ms
        provider.getBlock(blockNumber)     EVM RPC ~160 ms
filterByFunded(head._hash, ...)            one batched accountBalances (5.5.0)
accountBalances([XYO_STEP_REWARD_ADDRESS]) RPC
runBuildValidateRetryLoop
  resolveSupersedes(head)                  chain params
  buildNextBlock -> validateBlock -> sign
mempoolRunner.submitBlocks([block])        RPC   ~160-180 ms
```

## Proposals, independent of one another, smallest first

### 1. Resolve the anchor in one call

`currentEthereumAnchor()` makes two round trips, first for the number and then
for the block, when one `getBlock('latest')` returns both. Freshness is the
same: the anchor is still the provider's tip at call time.

```ts
const block = await provider.getBlock('latest')
const value: [number, Hash] = [block.number, asHash(assertEx(block.hash, ...), true)]
```

**Saves:** about 160 ms p50 per candidate.
**Tests:**
- The anchor equals what the two-call path would return, under a mocked
  provider.
- A `null` block or a missing hash still throws the same errors.
- `ethereumAnchorCacheTtlMs` behaviour is unchanged.

### 2. Reuse an anchor only when it cannot go backwards

`ethereumAnchorCacheTtlMs` exists, but any TTL above 0 is unsafe as it stands.
A cached anchor can be older than the anchor in the parent block. The candidate
then fails `anchor-monotonic` in the finalizer's `timeValidPrefix`, and the
slashing module records "the anchor went backwards" as verified. The producer
already holds the parent block and its time payload, so the safe rule is
checkable locally:

```ts
// in currentTimePayload(head) / currentEthereumAnchor(parentAnchor)
const cached = this.cachedEthereumAnchor()
if (cached !== undefined && cached[0] >= parentAnchor) return cached   // same block or newer: cannot go backwards
return await this.fetchFreshAnchor()
```

A refresh can run off the hot path, for example on a timer or right after each
successful submit, so that the guard usually hits. The guard, not the timer, is
what keeps it safe. Staleness must also stay inside the chain's
`freshnessBandEvmBlocks`, which `evaluationPoint` already takes into account.

**Saves:** up to about 330 ms p50 per candidate whenever the guard hits.
**Tests:**
- A parent anchor ahead of the cache forces a fresh fetch.
- An expired TTL forces a fresh fetch.
- Property test: over random interleavings of provider tips and parent anchors,
  the emitted anchor is never below the parent's.
- A cache hit makes no provider call.

### 3. Build the time payload from the head in hand

`currentTimePayload()` calls `blockViewer.currentBlock()` for `xl1` and
`xl1Hash`, both commented "this is for the previous block". The runner already
holds that block as `head`. Re-fetching costs a REST round trip (70–135 ms). It
also opens a race: if the head advances between `headFetch` and
`generateTimePayload`, the payload names a newer block than the candidate's
`previous`. No validator in 5.5.0 checks `xl1Hash` against `previous`, so this
is silent today.

```ts
generateTimePayload(head) -> timeSyncViewer.currentTimePayload({ xl1: head.block, xl1Hash: head._hash })
```

**Saves:** 70–135 ms p50 per candidate and removes the mismatch window.
**Tests:**
- The payload's `xl1` and `xl1Hash` equal the `head` argument even when the
  viewer's current block has moved.
- Callers that pass no head keep the current behaviour.

### 4. Overlap the independent awaits in `proposeNextValidBlock`

None of these read another's result:

- `generateTimePayload()`
- `filterByFunded(...)`
- the step-reward `accountBalances`
- `resolveSupersedes(head)`

```ts
const [timePayload, [initialFundedTransactions, initialFundedTransfers], stepRewardBalances, supersedes] =
  await Promise.all([
    this.generateTimePayload(head),
    this.filterByFunded(head._hash, nextBlockTransactions, transactionTransfers, shouldValidateBalances),
    this.accountBalanceViewer.accountBalances([XYO_STEP_REWARD_ADDRESS]),
    this.resolveSupersedes(head),
  ])
```

`epoch` is still stamped inside the time payload at call time. The finalizer's
`epoch-after-parent` and heartbeat-spacing rules read that value, so moving
the call earlier cannot make a heartbeat qualify sooner than it should.

**Saves:** the shorter legs collapse into the longest, about 100–300 ms p50,
depending on how many of 1–3 have landed.
**Tests:**
- Candidates are byte-identical to the serial path under deterministic mocks.
- A rejection in any leg still reaches the existing
  `Error proposing next valid block` path.

### 5. Arm a check for the moment a heartbeat falls due

About **46%** of sequence blocks are heartbeats. In the block-gap histogram
from a chain scan, 22020 of 48320 gaps fall in the 60–65 s bucket. A heartbeat
is due at a time the producer already knows: `headEpoch(head) +
heartbeatInterval`, and `headEpoch` is cached per head. With a fixed poll every
producer notices it `uniform(0, interval)` late, about 2 s on average at 4000 ms,
and the winner is decided by where each producer's timer phase happens to fall.

In `ProducerActor`, when a head is recorded:

```ts
const due = epoch + heartbeatInterval
clearTimeout(this._heartbeatTimer)
this._heartbeatTimer = setTimeout(() => void this.produceBlock(), Math.max(0, due - Date.now() + 25))
```

- `produceBlock()`'s mutex and `concurrentChecksSkipped` already guard against
  overlapping the poll.
- It is one extra check per head, only when a heartbeat is actually pending.
  The steady poll rate does not change, so there is no added load on the RPC.
- The small offset keeps `Date.now() - epoch > heartbeatInterval` strictly true
  and absorbs millisecond timer jitter. It stays well inside the finalizer's
  `maxClockSkewMs`.

**Saves:** about half the poll interval of detection lag on roughly half of
all blocks.
**Tests:**
- With fake timers, the one-shot fires at `epoch + interval + ε` and builds a
  heartbeat.
- A head change before it fires cancels and re-arms it.
- A transaction-carrying head never triggers a heartbeat early.
- The timer is cleared in `stopHandler`.

## Expected effect and how to judge it

- 1–4 together: about 300–450 ms less per candidate at p50, more at p90.
- 5: about 2 s mean detection lag removed on heartbeat heights.

None of this changes validation or the poll floor. Measure accepted share
(Δ chain-counted blocks ÷ Δ height) over equal windows of at least 72 h, before
and after, next to each competitor's share from the same scan. Supporting signals:

- `timePayloadGeneration` p50 falls;
- win rate on heights whose parent gap was 60 s or more rises.

With about 6700 heights per 72 h at roughly 12% share, a difference below about
1.1 percentage points is noise.
