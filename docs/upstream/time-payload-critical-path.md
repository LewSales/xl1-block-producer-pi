# Producing-path latency: five proposals, reviewed against the 5.5.0 runtime

The code traced here is what ships in `@xyo-network/xl1-cli` 5.5.0 (`dist/cli-min.mjs.map`) and
`@xyo-network/xl1-sdk` 5.7.0. The sdk's published sourcemap embeds the original TypeScript, so
`SimpleTimeSyncViewer.ts` below is upstream source, not a reconstruction.

**None of the five can be done in this wrapper repo.** Each lives in:
- `SimpleTimeSyncViewer` (xl1-sdk);
- `SimpleBlockRunner` (chain-sdk);
- or `ProducerActor` (`packages/producer`).

None of them is reachable through `providerBindings`, the only extension point the presets have.
Patching the bundle is off the table.

The tracker is https://github.com/XYOracleNetwork/xl1-docker-images/issues (see #4). The source repos
are not public.

**Filing order**
1. Proposal 1 first. Its issue text is in `single-call-anchor/ISSUE.md`, alongside the patch, tests
   and benchmark.
2. Then proposal 5, as a design discussion.
3. Proposals 2, 3 and 4 are not worth filing yet.

## How a candidate wins

The finalizer (`ChainHeadSelector.findBestHead`) re-selects every 500 ms, in this order:
1. **Allow-list admission.**
2. **`filterPacedHeartbeatCandidates`.** A transaction-less candidate qualifies only if
   `candidateEpoch - headEpoch >= heartbeatInterval`. Both epochs are *signed* time-payload epochs.
3. **`filterTimeValidUncles`.** This applies the time rules:
   - `epoch-after-parent`;
   - `epoch-not-future` (≤ observer clock + `maxClockSkewMs`, 30 s);
   - `anchor-monotonic` (`anchor >= parentAnchor`);
   - `anchor-not-ahead` (≤ observer EVM head + 2).
4. **`findBestUncle`.** Scores each candidate chain by length, plus 1000 if its producer is not the
   head's producer. A stable sort breaks ties, so the first-listed candidate wins.

The shadow and slashing layers add:
- `anchor-canonical`: the hash must be canonical after 32 EVM blocks;
- eligibility evaluated at `max(parentAnchor, anchor - freshnessBandEvmBlocks)`, where the band is
  2048.

So a stale-but-not-backwards anchor is never penalised; a backwards one is refused and reportable.

**Chain scan, blocks 629731–631171 (last ~24 h; `chainscan.mjs`)**
- 1440 blocks: 1050 carried transactions and **390 (27%) were heartbeats**. The all-time gap histogram
  shows about 46%; the mix drifts.
- `time.xl1Hash === previous` on **1441 of 1441** blocks.
- No anchor went backwards. 150 blocks reused their parent's anchor.
- Winning heartbeats landed a median of **1.07 s** after they fell due (p10 0.20 s, p90 2.4 s,
  measured as candidate epoch − parent epoch − 60 000).
- Heartbeat wins: Pi 50 and amd64 37, against 58–66 for each of the top four.
- Transaction-block wins: Pi 131, amd64 111, top 189.

## 1. Resolve the anchor in one call. **File first.**

- **Redundant?** Yes. `getBlockNumber()` followed by `getBlock(n)` is two sequential round trips for a
  pair that `getBlock('latest')` returns in one. The ethers 6.17 provider is built with
  `staticNetwork: true`, so there is no hidden `eth_chainId`. Its 250 ms perform cache only dedupes
  identical in-flight requests, and its 10 ms batch stall cannot merge calls that are awaited in turn.
- **Correctness rules.** The anchor must be ≥ the parent's anchor, not more than 2 blocks ahead of the
  observer, and canonical. `'latest'` is the same tip at call time, so every rule holds exactly as
  today. Measured freshness difference: mean −0.03 / +0.04 blocks, bounded by ±1.
  - The `xl1` and epoch fields are untouched.
  - The ttl, single-flight and error text are untouched.
  - One improvement: a load-balanced backend that is behind the number read can no longer null the
    second read. Not observed in about 39 h of logs.
- **Savings: measured.**
  - In-container, real provider construction, 80 interleaved rounds: **134 ms (amd64) and 164 ms (Pi)
    at p50**, about 160–175 ms at p90.
  - That is roughly 28–35% of today's `timePayloadGeneration` p50 of 475–578 ms.
- **Where:** upstream only (xl1-sdk `SimpleTimeSyncViewer.currentEthereumAnchor`).
- **Smallest regression test:** "exactly one provider call, `getBlock('latest')`" plus "ttl 0 returns
  successive tips". Both are in `single-call-anchor/anchor.test.mjs`; mutants fail them.

## 2. Reuse an anchor only when it cannot go backwards. **Hold.**

- **Redundant?** Partly. Sepolia ticks every ~12 s, and 10% of blocks reuse their parent's anchor, so
  some reads return what the producer already had.
- **Correctness rules.** Reuse is safe only if the cached height is ≥ the parent block's
  `time.ethereum`, stays inside `freshnessBandEvmBlocks`, and stays canonical.
  - A plain TTL (`ethereumAnchorCacheTtlMs` > 0) violates the first rule whenever the parent was built
    after our cache was filled. That is why the knob must stay at 0.
  - The guard needs the parent's time payload. `ProducerActor` keeps only `head` (the bound witness)
    from `currentBlock()` and passes that to the runner, so the guard means a signature change through
    `produceNextBlock` / `currentTimePayload`.
- **Savings: estimate only.** Once proposal 1 lands, at most about 140–170 ms per cache hit, with an
  unknown hit rate.
- **Where:** upstream (xl1-sdk and chain-sdk). This is an API change.
- **Smallest regression test:** a property test that, over random interleavings of provider tips and
  parent anchors, the emitted anchor is never below the parent's.

## 3. Build the time payload from the head in hand. **Retracted as a latency item.**

- **Redundant?** Not on `producer-rest`. `RestBlockViewer.currentBlock()` has a 1000 ms head cache
  (`CURRENT_BLOCK_CACHE_TTL_MS`), and `headFetch` filled it about 150–250 ms earlier in the same
  cycle, so the time payload's read is normally a cache hit.
  - On role `producer`, `TimeSyncViewer` is `JsonRpcTimeSyncViewer`. The remote server builds the
    payload, so the proposal does not apply there.
- **Correctness rules.** `xl1`/`xl1Hash` name the parent. A mismatch is possible only when more than
  about 1 s passes between `headFetch` and the time payload (pendingTransactions max was 18–30 s,
  p95 about 230–320 ms).
  - No 5.5.0 validator checks `xl1Hash` against `previous`.
  - None of the 1441 finalized blocks shows a mismatch.
- **Savings:** about 0 on `producer-rest` (measured by construction). The earlier 70–135 ms claim was
  wrong.
- **Where:** upstream. At best a hardening change; not worth an issue on the evidence.
- **Smallest regression test:** with the viewer's current block advanced past `head`, the payload
  still names `head`.

## 4. Overlap the independent awaits in `proposeNextValidBlock`. **Hold until proposal 1 lands.**

- **Independent?** Yes. None of these reads another's result:
  - `generateTimePayload()`, which reads the head cache and the EVM;
  - `filterByFunded` (one batched `accountBalances(senders, {head})`, only when there are
    transactions);
  - the step-reward `accountBalances([XYO_STEP_REWARD_ADDRESS])`, which is unqualified;
  - `resolveSupersedes` (chain params).
- **Correctness rules.**
  - The epoch is stamped inside the time payload at call time; starting that call earlier only makes
    it earlier, never later than the build.
  - A heartbeat still qualifies only on signed spacing.
  - `Promise.all` must keep today's error path, with any failing leg reaching
    `Error proposing next valid block`.
- **Savings: estimate.** They collapse to the longest leg, but the balance reads are not timed by
  `/statz`, so the gain cannot be sized. Add timing for them first, off-path and asynchronous.
- **Where:** upstream (chain-sdk `SimpleBlockRunner`).
- **Smallest regression test:** under deterministic mocks, candidates are byte-identical to the serial
  path, and a rejecting leg still fails the attempt.

## 5. Arm a one-shot check for when a heartbeat falls due. **Second to file, as a design discussion.**

- **Redundant or independent?** It adds work rather than removing it: one extra `produceBlock()` per
  head, only while a heartbeat is pending.
  - The due moment is known in advance: `headEpoch(head) + heartbeatInterval`, and `headEpoch` is
    already cached per head.
  - With a fixed poll, detection lag is uniform(0, interval): a mean of 2.0 s at 4000 ms and 2.5 s at
    5000 ms.
- **Correctness rules.**
  - The producer's `heartbeatRequired` is `Date.now() - epoch > heartbeatInterval`, strictly
    greater.
  - The finalizer requires `candidateEpoch - headEpoch >= heartbeatInterval` on signed epochs, and the
    candidate's epoch is stamped after that check. Firing at `due + ε` is therefore always accepted.
  - The producer's `heartbeatInterval` must equal the finalizer's; ours is 60000, matching the
    observed spacing.
  - The existing mutex covers overlap with the poll.
  - A head change must cancel and re-arm the timer, and `stopHandler` must clear it.
- **Savings: estimate.** Winning heartbeats land a median of 1.07 s after due; our lag is uniform(0, 4)
  s plus about 0.5 s of build and submit. A due-time trigger would put ours at about ε + build.
  - That is the largest *competitive* effect of the five, on 27–46% of blocks. It is also the least
    proven: the win-rate change cannot be known without a trial.
- **Side observation for the issue.** `maxClockSkewMs` (30 s) lets a producer whose clock runs fast
  qualify a heartbeat early in real time.
  - Nothing in the scan shows a rival doing this: the minimum lags are 9–108 ms for everyone.
  - Signed gaps cannot reveal skew, though, and the incentive exists.
- **Where:** upstream (`ProducerActor`).
- **Smallest regression test:** with fake timers, the one-shot fires at `epoch + interval + ε` and
  builds a heartbeat, and a head change before it fires cancels and re-arms.
