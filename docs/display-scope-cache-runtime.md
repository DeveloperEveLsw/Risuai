# Shared frozen display scopes

The original native-server generation, relational storage and multi-device goal remains active. All 15 completion requirements are retained. The complete configured trial remains unfinished; production and private content are untouched.

Each display invocation previously copied the same loaded history, definitions and settings before any asynchronous boundary. The browser now owns one lazy Svelte-derived body. Its preparation deeply reads and pins the source JSON, then freezes the private containers. All rows can share that immutable body until a source dependency changes. This changes preparation, not the original Lua/CBS algorithm or number/order of calculations.

## Values and headers

The controller's synchronous capture borrows projected JSON and produces fresh source/header information. Consumers must pin before awaiting. The original display adapter obtains the derived body synchronously, then forks private chat/local-global/global variable dictionaries, character/chat/database aliases, trigger records and version maps for that invocation. Source content, message identity/revision, persistent/partial-history policy, ledger metadata and CBS model/trigger environment are obtained anew.

The browser worker still structured-clones and performs full original JSON normalization privately before running Lua. Shared history/definition containers stay frozen on the owner. This shallow fork is specifically for that worker boundary; an executor that mutates arbitrary captured JSON needs full private normalization. Existing in-process test contexts retain their separate private captures.

Deep Svelte source reads track local nested writes, additions, removal and collection changes. Every completed canonical projection also advances a separate scope revision, so plain revision/epoch maps and equal JSON values cannot hide a projection. Display receipt/pending revisions, readiness and history-page state are explicit dependencies. This notification is conservative and may also invalidate the body for unrelated projections.

A guard compares server/chat/character identity, epochs, input clock, projected cursor and partial-history policy with the current synchronous header. A mismatch rebuilds immediately even if a caller omitted a notification; continued mismatch fails visibly. Per-invocation source, revision maps and environment remain fresh even when the body is reused. Reuse does not depend only on a cursor.

One body is retained per cache and released immediately on closure; submitted invocations keep their own pinned references. The existing 200,000-node/128-depth preparation budget and 16 MiB wire guard remain. This is not a hard heap quota, and copying large mutable dictionaries, initial pinning/freezing, size traversal, structured clone and cold strings can still cost owner time.

## Verification and limits

The actual client-compiled Svelte fixture prepares one body for 50 captures. It proves old pinned values remain intact, per-invocation pending variables/version maps do not mix, and nested messages/variables/modules/presets, module disable/enable, partial history, plain projection notifications, fresh model/trigger metadata, unannounced clock/epoch changes, own `__proto__`, navigation/reorder and closure behave as specified. It is a neutral fixture, not proof of all existing editors or extension-defined mutations.

The actual original UI retains no-Lua capture avoidance, character/module Lua effects, two devices, persistent IDB/server receipts, rejected proposal review/discard, reload and all-tab-exit replay. Existing direct and optimized worker tests retain loop/output/scope limits and prohibit partial late writes. Original partial-history absolute indices, full outer CBS/regex/plugin dependency policy, projection/ledger consistency and changed HTML/assets still require work.

A controlled diagnostic at `075c55e` loaded the actual manager with a blocking synthetic executor and reproduced incorrect concurrent local-value/trigger-environment merges. Its historical raw evidence remains in `evidence/display-reuse-logs/risu-display-reuse-coalescing.json` in the parent workspace. Subsequent original Lua/CBS reproductions and the local presentation identity correction are documented in [concurrent scope identity](display-scope-identity-runtime.md), including actual worker checks. The historical diagnostic does not execute Lua or establish a whole-UI reproduction.

The witnessed performance comparison supplies the exact prior scripting/controller adapters from `0c4526a` through isolated Vite overrides. Both declared sources must actually load. The same current benchmark/helper/fixture runs 30 warm observations per scenario, retaining all 56 Lua calculations and 44 independent row recalculations. Each current toggle prepares exactly one body. This is an adapter comparison, not a complete previous checkout reconstruction.

| Metric                   | Prior adapters | Current    |
| ------------------------ | -------------- | ---------- |
| Desktop click p95        | 72.6 ms        | 44.8 ms    |
| Desktop settle p95       | 579.2 ms       | 534.2 ms   |
| Desktop frame gap p95    | 33.4 ms        | 16.8 ms    |
| Desktop long tasks       | 1              | 0          |
| Page CPU4x click p95     | 35.9 ms        | 32.9 ms    |
| Page CPU4x settle p95    | 1,150.9 ms     | 1,006.9 ms |
| Page CPU4x frame gap p95 | 200 ms         | 116.7 ms   |
| Page CPU4x long tasks    | 30             | 30         |

The slow-page frame gaps and long tasks remain. Page CPU4x does not prove equal worker throttling; actual mobile OS, network, cold/large assets and universal latency remain unverified. A passing build retains existing CSS/chunk/plugin warnings. These results do not complete the full trial or all 15 requirements.

```bash
RISU_DISPLAY_REUSE_OUTPUT=/tmp/display-scope.json \
  node --test server/browser/displayScopeCache.test.cjs
# JSON map contains exact prior relative-path source text from git show.
RISU_DISPLAY_PERF_SOURCE_OVERRIDES=/tmp/risu-display-reuse-source-overrides.json \
  RISU_DISPLAY_PERF_SAMPLES=30 \
  node --test server/browser/displayPerformance.test.cjs
RISU_DISPLAY_PERF_SAMPLES=30 node --test server/browser/displayPerformance.test.cjs
```

Next: complete ledger/projection/absolute partial-history metadata, changed HTML/DOM/assets and remaining extension/editor/format/restore/provider/offline/physical-mobile/trial requirements. Reduce remaining size/transfer cost and broad invalidation without caching mutable JSON or silently skipping stateful Lua.
