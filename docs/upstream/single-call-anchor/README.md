# Single-call EVM anchor: patch, tests, benchmark

- `ISSUE.md`: the issue text, filed as XYOracleNetwork/xl1-docker-images#11.
- `SimpleTimeSyncViewer.patch`: the change, as a diff against upstream
  `src/modules/protocol-sdk/simple/timeSync2/SimpleTimeSyncViewer.ts`. That source is recovered from
  the `@xyo-network/xl1-sdk` 5.7.0 published sourcemap.
- `proposed.mjs`: the same method in JS, on a subclass of the *published* class. Nothing in
  `node_modules` is modified.
- `anchor.test.mjs`: every behaviour case runs against both the shipped and the proposed method.
- `bench.mjs`: shipped against proposed through the real ethers 6.17.0 `JsonRpcProvider`,
  interleaved.

```bash
npm install
npm test                       # node --test anchor.test.mjs
ROUNDS=80 npm run bench        # optionally EVM=<url>
```

Nothing here is part of the producer or its image.
