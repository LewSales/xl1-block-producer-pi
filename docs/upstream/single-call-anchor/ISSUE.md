# `SimpleTimeSyncViewer` resolves the EVM anchor in two sequential round trips; one does it

**File at:** https://github.com/XYOracleNetwork/xl1-docker-images/issues. That is the same tracker as
#4 (`filterByFunded`). **Not filed yet.**

---

**Component:** `@xyo-network/xl1-sdk` 5.7.0 (as bundled in `@xyo-network/xl1-cli` 5.5.0),
`src/modules/protocol-sdk/simple/timeSync2/SimpleTimeSyncViewer.ts`, `currentEthereumAnchor()`
**Found on:** two federated producers on sequence (Raspberry Pi 3 B+ arm64, and amd64 Docker Desktop),
both running role `producer-rest` at `blockProductionCheckInterval` 4000.

## Summary

Every candidate block needs a time payload, and every time payload needs an EVM anchor: the tip's
number and hash. `currentEthereumAnchor()` makes two calls, one after the other:

```ts
const blockNumber = (await provider.getBlockNumber()) ?? 0
const block = await provider.getBlock(blockNumber)
```

`getBlock('latest')` returns the same tip's number and hash in one response. On the producing path
that sequential second round trip is pure latency, and the path is a race: the finalizer re-selects
every 500 ms and, among equally scored candidates, takes the first one listed.

## Evidence

`/statz` `timings.timePayloadGeneration`, over about 39 h on each node:

| | p50 | p95 |
|---|---|---|
| Pi | 475 ms | 594 ms |
| amd64 | 578 ms | 815 ms |

For comparison, the whole of `mempoolSubmitBlock` is 162 / 180 ms p50. `[Slow] Generated time payload`
is logged on every build.

The `xl1` half of the payload costs almost nothing on `producer-rest`: `RestBlockViewer.currentBlock()`
is served from its 1 s head cache, which `headFetch` filled a moment earlier. The time is in the anchor.

**Benchmark.** 80 interleaved rounds per node, run inside each running producer container (Node 26,
same network path). Both variants use ethers 6.17.0 `JsonRpcProvider` built exactly as xl1-sdk builds
the EVM connection: chainId 11155111, `{ polling: true, staticNetwork: true }`, against the preset's
`default-evm-rpc` (publicnode Sepolia).

| | shipped (2 calls) p50 / p90 | proposed (1 call) p50 / p90 | saved p50 |
|---|---|---|---|
| amd64 | 273 / 320 ms | 139 / 161 ms | **134 ms** |
| Pi | 337 / 411 ms | 173 / 237 ms | **164 ms** |

- Neither variant had an error.
- **Freshness is unchanged.** The proposed height minus the shipped height, read in the same round,
  had a mean of −0.03 blocks on amd64 and +0.04 on the Pi, and was never more than 1 either way. The
  ±1 is whichever call happened to run after the next Sepolia block.

## Proposed change

```diff
     const provider = assertEx(this.ethProvider, () => 'Ethereum provider not configured')
     const promise = (async (): Promise<[number, Hash]> => {
-      const blockNumber = (await provider.getBlockNumber()) ?? 0
-      const block = await provider.getBlock(blockNumber)
-      const blockHash = asHash(assertEx(block?.hash, () => 'Block hash not found'), true)
-      const value: [number, Hash] = [blockNumber, blockHash]
+      // One round trip for the tip's number and hash together. Asking for the number and then
+      // the block by that number costs a second sequential round trip on every time payload, and
+      // behind a load-balanced RPC the two reads can land on backends at different heights (the
+      // second then returns null). 'latest' is the same tip the number read returned, so the
+      // anchor is exactly as fresh; it only arrives in one response instead of two.
+      const block = assertEx(await provider.getBlock('latest'), () => 'Block hash not found')
+      const blockHash = asHash(assertEx(block.hash, () => 'Block hash not found'), true)
+      const value: [number, Hash] = [block.number, blockHash]
       const ttl = this.options.ethereumAnchorCacheTtlMs
       if (ttl > 0) this.ethereumAnchor = { expiresAt: Date.now() + ttl, value }
       return value
```

**Unchanged:**
- the `ethereumAnchorCacheTtlMs` semantics, where the default of 0 means a fresh read every time;
- the single-flight `ethereumAnchorPromise`;
- the error text;
- `currentTime('ethereum')`;
- the `xl1` and `epoch` fields.

The anchor is still the provider's tip at call time. So `anchor-monotonic`, `anchor-not-ahead` and
`anchor-canonical` are affected no differently than today.

**One behavioural difference.** Behind a load-balanced EVM RPC, `getBlockNumber()` and `getBlock(n)`
can reach different backends. If the second backend is behind the first, it returns `null`. The time
payload then throws, and that production check fails. The single call cannot split that way. We have
*not* seen this failure in about 39 h of logs on either node, so this is a robustness note, not a
reported fault.

## Tests

The file is `anchor.test.mjs`, run with `node --test`. The suite runs every behaviour case against both
the published class and the patched method, and both pass. The harness is attached; the upstream spec
would express the same cases.

1. The anchor is `[tip.number, tip.hash]` with the hash normalised by `asHash`.
2. `currentTimePayload()` carries `xl1`/`xl1Hash` from the head, and `ethereum`/`ethereumHash` from
   one block.
3. A `null` block, or a block without a hash, still rejects with `Block hash not found`.
4. At ttl 0, successive calls return successive tips. This is the guard against serving a stale anchor.
5. At ttl > 0, caching is unchanged.
6. Concurrent calls share one in-flight fetch.
7. Specific to the proposal: exactly one provider call, `getBlock('latest')`.
8. Specific to the proposal: a backend lagging behind the number read does not fail the time payload.

**Mutation check.** Reverting to the two-call form fails 3 cases. Swapping `'latest'` for `'safe'`
fails 7.

## Expected effect

About 130–165 ms p50 (about 160–175 ms p90) off every candidate's time payload, on every producer that
binds an `EvmChainViewer` and uses the local `SimpleTimeSyncViewer`. That is the default for
`producer-rest`. It does not change validation, the poll interval, or anything a finalizer checks.
