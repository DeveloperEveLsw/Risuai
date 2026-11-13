# Display worker transfer and byte budget

The subsequent shared-scope implementation is documented in [display-scope-cache-runtime.md](display-scope-cache-runtime.md). The comparison below records the preceding `0c4526a` transfer milestone.

This continues the original native-server generation, relational-storage and multiple-device goal. All 15 requirements remain in scope. The complete configured trial remains unfinished. Production, private content and remote repositories are untouched.

The owner previously built a complete JSON string and UTF-8 buffer for every display invocation, then sent the string to the worker. A sampled original-UI profile identified `execute`, encoding and snapshot copying on the owner thread. The already pinned scope consists of plain JSON containers and revision maps, so it can be transferred using the browser's structured clone.

`DisplayWorkerExecutor` now builds the same wire projection (one private chat/character, revision maps as entry arrays), checks its equivalent UTF-8 JSON size and posts plain values. The worker performs the original JSON stringify/parse normalization before executing Lua. Undefined fields, array nulls, non-finite numbers and restored chat/character/map aliases therefore keep the prior adapter projection. Actual original Lua/CBS, per-lease globals/order, proposal tracking, IDB admission and server receipts remain.

This moves explicit whole-scope JSON construction/normalization out of the owner. Structured-clone copying, scope preparation, the size traversal and cold primitive encoding still run on the owner. It does not move all transfer cost off that thread, cache a snapshot, skip Lua computations or guarantee a zero-stutter application.

## Exact byte policy and lifetime

`DisplayWireBudget` counts the same bytes as native `TextEncoder(JSON.stringify(wire))` for the admitted plain JSON graph. It includes keys, escapes, commas, repeated aliases and JSON normalization. Arrays with undefined entries count nulls; undefined object fields are omitted; maps in the wire projection retain the prior JSON behavior. Unsupported containers or cycles fail visibly. The 16 MiB boundary is checked before posting or executing Lua.

Only immutable string-encoding lengths are cached. Every container and revision is read afresh on each check; alias memoization exists only within that one traversal. This cannot reuse stale variables or a cursor-only scope. Each executor retains at most 1,024 strings and 8 MiB of logical UTF-16 character bytes, then clears them on termination. Those bounds exclude VM/Map/native allocator overhead and do not establish a browser heap quota. Large/cold strings may still require encoding again.

Pinned snapshot copying uses ordinary property assignment to avoid per-property descriptor allocation. The `__proto__` JSON key remains a separately defined own property; it cannot alter the private object prototype. Nested values and version maps remain copied before the first asynchronous boundary.

The existing initialization/invocation/output/proposal limits and owner/image cancellation policies in [the worker document](display-worker-runtime.md) still apply. Worker normalization now occurs inside the invocation budget. No automatic replay or UI-thread Lua fallback is introduced.

## Evidence and reproduction

Four tests compare byte counts against native JSON/UTF-8, including 1,000 seeded arbitrary JSON trees, Unicode and lone surrogates, escapes, undefined/non-finite values, repeated aliases, exact boundaries, cycles, mutable values and bounded cache eviction/close. The original Lua tests retain all concurrent/cursor/owner/proposal checks and now verify a nested `__proto__` key remains private.

The real worker/UI test additionally sends 3 MiB of NUL characters, whose escaped scope exceeds 16 MiB, and proves that Lua never starts or admits a partial proposal. Existing infinite-loop/owner-close, output bounds, original CBS/lore/hash/image/global APIs and two-device/tab-exit receipt tests remain required. The optimized UI worker is rebuilt and checked separately.

The performance comparison uses the exact prior two adapter sources from `ff4d146` through an isolated Vite override, with a witness that both declared modules were actually loaded. The same current benchmark/helper, original UI, synthetic data and 30 warm observations per scenario are used on each side. It retains all 56 Lua calculations and 44 independently recomputed rows. This is an adapter comparison, not a complete previous-checkout reconstruction. An earlier comparison without the load witness and exploratory sampled profiles are preserved separately.

```bash
# JSON map: relative source path -> exact prior source text from git show.
RISU_DISPLAY_PERF_SOURCE_OVERRIDES=/tmp/risu-display-scope-source-overrides.json \
  RISU_DISPLAY_PERF_SAMPLES=30 \
  node --test server/browser/displayPerformance.test.cjs
RISU_DISPLAY_PERF_SAMPLES=30 node --test server/browser/displayPerformance.test.cjs
pnpm exec vitest run src/ts/runtime/displayWireBudget.test.ts \
  src/ts/runtime/browserDisplayLua.test.ts
```

The measured page-CPU4x final-settle p95 decreased from 1,473 ms to 1,138 ms; frame-gap p95 changed from 217 ms to 200 ms and all 30 long tasks remained. Desktop settle p95 decreased from 646 ms to 586 ms while click median increased from 29 ms to 63 ms. The result is mixed rather than a universal improvement. Page-target CPU4x does not establish equal worker throttling. Actual mobile OS, network, cold assets and broader workloads remain unverified.

Next work must reduce repeated Lua-enabled history preparation and broad display invalidation. Reusing scopes needs evidence for nested local mutations, revision-only updates, pagination, module/preset/model/trigger metadata, pending overlays and navigation/epoch changes. Changed HTML/DOM/assets, complete extension/editor/format/restore/provider/offline/mobile policies and the configured user trial remain in scope. No requirement is completed solely by this transfer optimization.
