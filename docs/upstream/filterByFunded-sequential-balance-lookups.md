# `SimpleBlockRunner.filterByFunded` makes one sequential RPC per distinct sender

**Component:** `@xyo-network/xl1-cli` 5.3.1 (`dist/cli-min.mjs`), `SimpleBlockRunner`
**Severity:** not user-visible on sequence today; scales badly with transaction volume
**Found on:** a federated producer on sequence, Raspberry Pi 3 B+ (arm64), node v24.14.1

## Summary

`filterByFunded` runs on every produced block, because `proposeNextValidBlock`
defaults `validateBalances` to `true`. It loops over the block's transactions and
`await`s a balance lookup **inside** the loop, one round trip per distinct
sender, serially. A per-invocation cache deduplicates repeated senders, so the
cost is O(distinct senders) rather than O(transactions) — but those lookups are
sequential, and `accountBalances` already accepts an array.

Every sender in a candidate block is known before the loop begins and the
lookups are independent of one another, so a single batched call could replace
all of them.

## As shipped

```js
async filterByFunded(head, txs, transfers, validateBalances = false) {
  const fundedTransfers = []
  const fundedTransactions = []
  const committedOutflow = new Map()
  const balanceCache = new Map()
  for (const tx of txs) {
    const transfer = transfers.find((candidate) => candidate.from === tx[0].from)
    if (!transfer) continue
    if (!validateBalances) { fundedTransfers.push(transfer); fundedTransactions.push(tx); continue }
    const { from } = transfer
    let balance = balanceCache.get(from)
    if (balance === void 0) {
      // one full round trip, awaited, per distinct sender
      balance = (await this.accountBalanceViewer.accountBalances([from]))[String(from)] ?? AttoXL1(0n)
      balanceCache.set(from, balance)
    }
    const projectedOutflow = (committedOutflow.get(from) ?? 0n) + this.computeTransactionOutflow(tx)
    if (balance >= projectedOutflow) { committedOutflow.set(from, projectedOutflow); ... }
  }
}
```

Enabled by default:

```js
async proposeNextValidBlock(head, validateBalances, force = false) {
  const shouldValidateBalances = validateBalances ?? this.params.validateBalances ?? true
```

And the viewer method is already plural:

```js
accountBalances(addresses)
```

## Why it matters

Measured against `https://beta.api.chain.xyo.network/rpc` from the producer
container: a warm `accountBalances` round trip costs **110-220 ms**. The producer's
own instrumentation puts `produceBlock` on a **1000 ms budget**, and its
"execution exceeded budget" warning only fires at **10x**, so a routine overrun is
silent.

Sequence currently carries about **2 transfers per block**, so the loop makes two
round trips and costs roughly 300-400 ms of a ~2 s producing cycle. That is why
this is invisible today.

The shape is the concern rather than the present magnitude:

| distinct senders in a block | time in this loop alone |
|---|---|
| 2 (sequence today) | ~0.3-0.4 s |
| 10 | ~1.5-2 s |
| 20 | **~3-4 s** |

At 20 distinct senders the loop alone is three to four times the whole
`produceBlock` budget, and nothing in the logs would say so until it crossed 10x.
On a chain where block production is a race, a producer that slows down in
proportion to how busy the chain is will lose candidates exactly when volume is
highest.

## Suggested fix

Collect the distinct senders first and make one call:

```js
const senders = [...new Set(
  txs.map((tx) => transfers.find((c) => c.from === tx[0].from)?.from).filter(Boolean),
)]
const balances = senders.length > 0 ? await this.accountBalanceViewer.accountBalances(senders) : {}
// then the existing loop, reading from `balances` with no await inside
```

This turns N sequential round trips into one and leaves the cumulative-outflow
logic untouched. `Promise.all` over the individual calls would also remove the
serialisation, but a single batched request is strictly cheaper for the gateway.

Incidentally, `transfers.find(...)` inside the loop makes the pairing O(n²); a
`Map` keyed by `from` would fix that at the same time. That one is CPU-cheap and
well below the RPC cost, so it is a tidy-up rather than a problem.

## Two related observations

Both of these sit on the producing path and appear in no `ProducerTimingNames`
entry, so they are absent from `/statz` and invisible to operators:

- `generateTimePayload()` → `timeSyncViewer.currentTimePayload()`. It warns above
  100 ms and we observe it at 104-1253 ms, on essentially **every** build — the
  `[Slow] Generated time payload` line appeared 455 times in 456 builds over six
  hours.
- `getBlockRewardTransfers()` → the reward diviner's `divine()`.

Adding both to the timing set would make the producing cycle add up; at present
the instrumented stages account for well under the measured total.

## How this was found

Profiling why a Pi 3 B+ producer was winning a small share of blocks. Ruled out
first, by measurement: cryptography is not the cost (secp256k1 sign 3.10 ms,
sha256 of 1 KB 0.043 ms on that hardware — reaching the ~1.8 s a producing cycle
spends beyond an idle one would take ~580 signatures), identity derivation is
cached, the reward diviner is memoised, and `chainId()` short-circuits on the
configured `chain.id`.

Happy to test a patched build against sequence and report timings if that is
useful.
