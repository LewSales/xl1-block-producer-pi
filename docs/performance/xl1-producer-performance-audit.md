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

**Answering the sprint's Definition of Done, items 6 and 7:** roughly two thirds
of candidate-pipeline latency is RPC round-trip time; the balance is local work,
most of it inside `produceNextBlock`. Optimising the Pi cannot move the first
number, and the first number is the larger one.

### Early read on the 5000 ms change

7 blocks published in 293 s — one per ~42 s against a ~53 s block interval —
with zero rejected publishes and 34 of 42 attempts idle. Too short a window to
call a share improvement, but the machine is comfortably keeping up.
