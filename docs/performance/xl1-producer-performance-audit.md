# XL1 producer performance audit

Against `@xyo-network/xl1-cli` **5.3.1**, as shipped in the image running on
`xl1pi` (Raspberry Pi 3 Model B Plus, 4 cores, 955 MB).

Read the bundle, not the docs: the CLI ships as a single
`dist/cli-min.mjs` (10 MB) with `cli-min.mjs.map` (18 MB) beside it. Comments
survive minification, so the shipped source is readable in place.

## Head detection analysis

### There is no event-driven path. Everything is polling.

The question this audit opened with was whether the producer can be woken by an
event instead of a timer — which would buy responsiveness without raising the
RPC read rate. It cannot. There is no push transport in the product.

`FinalizedBlockStream` is the only stream-shaped abstraction, and it is a poller:

```js
var MIN_POLL_INTERVAL_MS = 5e3;
var DEFAULT_POLL_INTERVAL_MS = 1e4;
...
/** Head poll cadence shared by the hot surface and all `blocks()` iterations. */
pollIntervalMs: number().min(MIN_POLL_INTERVAL_MS).default(DEFAULT_POLL_INTERVAL_MS)
```

Its internals are `_pollTimer`, `_pollInProgress`, `_headWaiters` — a timer loop
with waiters parked on it, not a subscription. The name describes the delivery
shape (an async iterator of blocks), not the transport.

Searched the whole runtime bundle for a push transport:

| token | count | what it is |
|---|---|---|
| `WebSocket` | 174 | vendored `ethers` doc comments + the `ws` package's frame parser |
| `ws://` / `wss://` | 0 | no websocket endpoint is ever constructed |
| `EventSource`, `text/event-stream` | 0 | no SSE |
| `socket.io`, `longPoll` | 0 | — |
| `setInterval` | 23 | how the product actually works |

The `ws` and `ethers` code is reachable only through the EVM side
(`ChainContractViewer` → `default-evm-rpc`); nothing in the XL1 chain path
opens a socket.

### It would not help the producer even if it were push

Two independent reasons:

1. **It is not bound in the producer role.** `presets/roles/producer.json`
   binds ten providers; `FinalizedBlockStream` is not among them. It is wired
   for indexer- and dashboard-shaped consumers.
2. **It carries finalized blocks**, which lag the head by design, and the
   producer needs the *head* to build the next block on.

Most decisively: **head detection is no longer the gate.** Since
`blockProductionCheckInterval` went 60000 → 10000, the producer sees the head
promptly; what it waits for is a *pending transaction*, and those live about six
seconds before another producer sweeps them. So the tick rate is a mempool
sampling rate, and a head-driven wake would not sample the mempool any oftener.

### Consequence: 5000 is upstream's own floor, not an aggressive value

This changes the standing of the interval choice. 10000 was picked as the
defensible rate because it is `DEFAULT_BLOCK_PRODUCTION_CHECK_INTERVAL`, and
5000 was set aside as leaning too hard on a shared endpoint.

But 5000 is exactly `MIN_POLL_INTERVAL_MS` — the floor XYO's own stream provider
enforces on itself, and refuses to go below. Polling the same RPC at 5s is
therefore within the rate upstream sanctions in its own code, not outside it.

Measured capture rate against the ~6s mempool lifetime:

| interval | samples/min | ~capture | standing |
|---|---|---|---|
| 60000 | 1 | ~10% | image default |
| 10000 | 6 | ~46% | current; CLI code default |
| 5000 | 12 | ~71% | upstream's enforced minimum |

The remaining decision is a policy one, and it is now better informed: 5000 is
the floor, not past it. Below 5000 there is no defensible ground at all.

## Verdict for this phase

**BLOCKED — NEEDS XYO CLARIFICATION**, for event-driven production
specifically. No supported push mechanism exists in 5.3.1; asking XYO whether
one is planned is the only way forward on that axis. Polling cadence remains
the only lever, and it is already at the code default with one sanctioned step
left.

## Not yet done

Per-segment timing of the candidate pipeline (Phases 1, 8, 9, 12), the
`produceBlock` budget overrun (~2.5s against a 1000ms budget on this hardware),
and the RPC call graph. Live instrumentation would require forking the bundle;
the sourcemap makes static tracing possible instead.

## Producer hot path — measured, not estimated

**The instrumentation already exists.** `ProducerActor` wraps every stage in
`stats.time(name, op)` and keeps count/min/max/total/last per stage, and the
runtime publishes the snapshot over HTTP. No forking, no `[PERF]` logging, no
sourcemap patching was needed — Phase 1 of the sprint was already built.

The status server on `XL1_HEALTH_CHECK_PORT` (9099 here) serves five routes:

| route | returns |
|---|---|
| `/healthz` | `{"status":"started"}` |
| `/livez` | `{"status":"live"}` |
| `/readyz` | `{"status":"ready"}` |
| `/status` | per-component lifecycle for all providers |
| `/statz` | **the full producer timing + counter snapshot** |

Measured on `xl1pi`, CLI 5.3.1, at `blockProductionCheckInterval: 5000`,
293 s after a clean restart:

```
segment                          n     min     avg     max    last
blockProduction                  41     296    1287   26335     413
headFetch                        54     144     320     689     328
mempoolPendingBlocksFetch        13     151     246     992     204
mempoolPendingTransactionsFetch  41     144     185     247     238
mempoolSubmitBlock                7     179     220     246     246
productionCycle                  53     307    1405   26958     751
```

```
blockProductionChecks 54   blockProductionAttempts 42   idleAttempts 34
blocksProduced 7   blocksPublished 7   rejectedPublishes 0
concurrentChecksSkipped 0   candidateRecoveries 1   failedChecks 1
```

### The 1000 ms budget is not being blown in steady state

The single 26958 ms `productionCycle` is the **first cycle after restart** — it
is the only budget-overrun line in the log for the whole run. Removing that one
sample:

- `productionCycle` → **~914 ms average over 52 cycles** — inside the 1000 ms budget
- `blockProduction` → **~661 ms average over 40 cycles**

So the "~2.5 s against a 1000 ms budget" figure on record is not what this
configuration does. It described the old 60000 ms cadence and its degraded
long-uptime state. What remains is one cold-start overrun per restart.

### Where the time actually goes: RPC round trips, not the Pi

Every instrumented stage is a network call, and each one has a floor of
144-151 ms — that is the round-trip cost to the sequence RPC, and it is the same
floor for all three fetch types:

| stage | avg | fires |
|---|---|---|
| `headFetch` | 320 ms | every check |
| `mempoolPendingTransactionsFetch` | 185 ms | every attempt |
| `mempoolPendingBlocksFetch` | 246 ms | ~25% of cycles (candidate-dropped probe) |
| `mempoolSubmitBlock` | 220 ms | only when publishing (7 of 54) |

`headFetch` alone — one round trip, made on every single check — is **a third of
the entire cycle budget**. Local computation is the remainder and it is not the
constraint: the Pi 3 B+ sat at `concurrentChecksSkipped: 0`, meaning no tick ever
arrived while the previous one was still running.

**This first reading was wrong, and measurement reversed it — see "The stage
names mislead" below.** The stages are named after network calls, but only about
a third of the time inside them is network.

### Early read on the 5000 ms change

7 blocks published in 293 s — one per ~42 s against a ~53 s block interval —
with zero rejected publishes and 34 of 42 attempts idle. Too short a window to
call a share improvement, but the machine is comfortably keeping up.

## 23-minute steady-state window at 5000 ms

```
blockProductionChecks 271   blockProductionAttempts 226   idleAttempts 197
blocksProduced 29   blocksPublished 29   rejectedPublishes 0
concurrentChecksSkipped 0   candidateRecoveries 1   failedChecks 1

segment                          n     min     avg     max
blockProduction                 226     233     689   26335
headFetch                       271     109     299     920
mempoolPendingBlocksFetch        46     121     195     992
mempoolPendingTransactionsFetch 226     112     178     400
mempoolSubmitBlock               29     134     240    1172
productionCycle                 271     251     933   26958
```

**`productionCycle` averages 837 ms excluding the cold-start sample** — inside
the 1000 ms budget, and lower than the 923 ms measured at 7 minutes as
start-up effects wash out. Zero budget-overrun lines in the 21-minute window;
the single 26958 ms cycle remains the first one after restart.

### The rate increase did not provoke the endpoint

This was the one real risk in halving the interval.

- `failedChecks` **1 of 271 (0.37%)** — a single `mempoolViewer_pendingBlocks`
  502 at 06:02:15, never repeated. Not a rate-limit pattern.
- `rejectedPublishes` 0, `concurrentChecksSkipped` 0.

Measured RPC load at 5000 ms, all four call sites combined:

| call | per minute |
|---|---|
| `headFetch` | 11.8 |
| `mempoolViewer_pendingTransactions` | 9.8 |
| `mempoolViewer_pendingBlocks` | 2.0 |
| `mempoolRunner_submitBlocks` | 1.3 |
| **total** | **~25/min (0.41/s)** |

That is the honest number to quote if XYO ever asks what this node costs them.

One robustness note: the 502 escaped as far as
`Error in timer 'xl1-producer:BlockProductionTimer'`, aborting the whole
production check rather than just the probe that failed. A transient upstream
error costs a full cycle.

### What now bounds production

**87% of attempts (197 of 226) found no pending transaction.** Sampling twelve
times a minute does not create transactions to include. The gate is transaction
availability on sequence, not our sampling rate — which puts a ceiling on what
any further interval reduction could buy, and is the reason 5000 is the last
useful step rather than the start of a series.

29 published, 0 rejected, 1.26/min against a ~53 s block interval. A share
comparison needs a longer window than this and is not claimed here.

## Connection reuse: already working (Phase 5 closed)

Sampled the container's own `/proc/net/tcp{,6}` once a second for 40 s
(no root needed — `docker exec cat`, since the container's netns is its own):

- **13-15 established TLS connections at every tick**, never fewer.
- 4 connections survived all 40 ticks; most survived 20-39. Only 2 were short-lived.

That is a healthy keep-alive pool with slow turnover, not a connection per call.
An earlier count of "21 distinct connections in 45 s" was pool churn misread as
churn per request. **There is no keep-alive fix available here.**

## The stage names mislead: most of the cycle is local, not network

Measured the true network cost from *inside the same container*, same endpoint,
same real method (`blockViewer_currentBlock`, 3677-byte response):

| | latency |
|---|---|
| cold connection (full TLS handshake) | 462 ms |
| warm connection, n=17 | min 97, **p50 106**, p90 162, max 170, mean 122 ms |

Against the producer's own instrumentation for the same call:

| | min | mean |
|---|---|---|
| bare warm HTTP round trip | 97 ms | 122 ms |
| `headFetch` (`/statz`, n=271) | 109 ms | **299 ms** |

The **minimum matches** — 109 ms against a 97-106 ms warm round trip — which
confirms the pool is warm and that the floor is network-bound. But the **mean is
2.4x** the network cost. That excess is local: JSON deserialization of the block,
bound-witness hash and signature validation, zod schema parsing, and event-loop
queuing — all on a Pi 3 B+ core.

Recomposing the 837 ms cycle: about 2.3 RPC calls per cycle at roughly 110 ms of
real network each is **~250 ms, or roughly 30%**. The remaining ~70% is local
computation inside stages that are *named* after network calls.

**This inverts the earlier conclusion.** Optimising the host is not pointless —
it is where most of the cycle actually goes. The hardware caveat stands only in
the sense that the node still finishes inside its budget
(`concurrentChecksSkipped: 0`), so this is headroom, not a live problem.

The next place to look is therefore Phase 9 (the cryptographic hot path), not
Phase 4 or 5: specifically whether incoming block validation re-verifies
signatures the producer does not need re-verified, and whether identity
derivation is repeated per cycle.

## Cryptographic profile (Phase 9) — closed, nothing to fix

Measured on the Pi 3 B+ itself (node v24.14.1, arm64):

| operation | cost |
|---|---|
| sha256 of 1 KB | **0.043 ms** |
| secp256k1 sign | **3.10 ms** |
| JSON round-trip, small object | ~0.01 ms |

A produced block carries a handful of signatures. Reaching the ~1.8 s that a
producing cycle spends beyond an idle one would take **~580 signatures**.
Cryptography is not the cost.

The other Phase 9 questions resolve the same way, from source:

- **Identity derivation is not repeated.** `SimpleBlockRunner` assigns `_account`
  once in its create handler and caches `_address` and `_rewardAddress` beside it.
  `ProducerActor` takes `account: input.wallet` at construction and computes
  `_metricAttributes` once.
- **Signer objects are not recreated.** The reward diviner that appears to build
  an account per block (`account: "random"`) is memoized with `??=`.
- **`chainId()` does not hit the network here.** Its base implementation is
  `(await this.headBlock()).chain`, but a configured `chain.id` short-circuits it,
  and `presets/networks/sequence.json` sets one. Arithmetic confirms it: an extra
  head fetch could not fit inside a `blockProduction` p50 of 267 ms when
  `mempoolPendingTransactionsFetch` alone is 132 ms.

## The real cost: one sequential RPC per distinct sender

`SimpleBlockRunner.filterByFunded` — which runs on every produced block, since
`validateBalances` defaults to `true`:

```js
for (const tx of txs) {
  ...
  let balance = balanceCache.get(from);
  if (balance === void 0) {
    const accountBalances = await this.accountBalanceViewer.accountBalances([from]);
    balance = accountBalances[String(from)] ?? AttoXL1(0n);
    balanceCache.set(from, balance);
  }
  ...
}
```

The loop is sequential and `await`s inside. Each **distinct sender** costs a full
round trip — 110-220 ms measured here. The per-invocation `balanceCache` already
deduplicates repeated senders, so the cost is O(distinct senders), not
O(transactions).

**`accountBalances` takes an array.** Every address in the block is known before
the loop begins, and the lookups are independent of one another. One batched call
would replace N sequential round trips. This is the clearest optimisation the
audit found, and it is upstream code.

Two further uninstrumented network calls sit on the same producing path:

- `generateTimePayload()` → `timeSyncViewer.currentTimePayload()`, which warns
  above 100 ms and was observed at **147 ms**.
- `getBlockRewardTransfers()` → the reward diviner's `divine()`.

Neither appears in `ProducerTimingNames`, so neither shows up in `/statz`.

### Why this is invisible today and matters tomorrow

Sequence currently carries about 2 transfers per block, so the loop makes ~2
round trips and costs ~300-400 ms of the ~2 s producing cycle. The shape is the
problem, not today's magnitude: **cost grows linearly with distinct senders per
block, sequentially, at ~150-220 ms each.** A block with 20 senders would spend
3-4 seconds in `filterByFunded` alone, well past the 1000 ms `produceBlock`
budget, on a path with no batching and no concurrency.

### On the budget, corrected again

`p50`/`p95` are in the snapshot and I had not been reading them. Over 6.75 hours
(4853 checks, 445 blocks produced, 88% idle attempts):

```
segment                            n    min    p50    p95   mean    max
blockProduction                  3803    215    267   2076    510  26335
headFetch                        4853    104    219    253    242   3940
mempoolPendingBlocksFetch        1064    114    133    202    159   3870
mempoolPendingTransactionsFetch  3799    102    132    197    165   5954
mempoolSubmitBlock                445    128    159    230    179   1172
productionCycle                  4853    216    450   2050    693  26958
```

The earlier "837 ms, inside the 1000 ms budget" was a mean dominated by idle
cycles. Split properly: **idle cycles ~450 ms (inside budget), producing cycles
~2050 ms at p95 — about 2x over.** That matches the ~2.5 s figure recorded
before this work and never contradicted it; the average simply hid it.

Only one budget line has ever been logged because the warning fires at **10x**
("exceeded 10x budget: 26958ms > 1000ms"), so a routine 2x overrun is silent.
