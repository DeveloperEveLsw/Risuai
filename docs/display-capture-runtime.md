# Display capture fast path and concurrent presentation scope

Current follow-up: [canonical display scope and deferred Lua admission](display-pipeline-runtime.md) requires captured history for outer CBS/regex even without Lua. The zero-capture statements and comparison below describe the earlier adapter milestone. Current no-Lua acceptance checks shared body preparations and zero Lua Workers; the Lua adapter still avoids Lua initialization without active Lua.

This milestone continues the original server-generation, entity-storage and multiple-device goal. All 15 requirements remain in scope. The complete configured trial remains unfinished. Production, private data and remote repositories are untouched.

The entity display adapter now checks the original character triggers and active module triggers for first-effect Lua before preparing the private display scope. With no Lua it returns the presentation directly to the original CBS/regex/asset pipeline. It does not copy loaded history/settings, capture variable revisions, hash an occurrence or create a Lua worker. A character with Lua takes the existing worker path. A character without its own Lua still takes that path when an active module supplies Lua. Module activation remains live rather than cached as a boolean.

Only the entity `editdisplay` string adapter has this fast path. Other script modes, server generation and the legacy adapter retain their existing behavior. There is no rendered-output cache: outer CBS, regex, plugin and asset processing still run, and Lua-enabled rows still prepare a full pinned scope.

## Concurrent correctness

The original Lua listener receives `meta.index`; the capability scope also distinguishes complete/partial history and persistent/provisional presentation. The previous in-flight key only used server identity, durable display occurrence, projected cursor and presentation text. It could share a result even when those three fields differed.

Three regressions were reproduced with the actual original Wasmoon runtime before changing the key:

| Concurrent difference             | Previous result                         | Required result                              |
| --------------------------------- | --------------------------------------- | -------------------------------------------- |
| Loaded row index 0 and 1          | Both listeners receive 0                | Each retains its own index                   |
| Complete and partial history      | Partial request borrows complete result | Partial history reports its capability error |
| Provisional then persistent scope | No proposal admitted                    | Persistent scope creates one proposal        |

The in-flight key now includes row index, `hasEarlier` and `persistent`. Exact concurrent duplicates still coalesce, VM execution remains serialized, pinned values/revisions remain paired, and server receipt identity is unchanged. This is a presentation-key correction, not a new durable occurrence policy. Two persistent proposals for one occurrence still meet the same server deduplication rule. The tests preserve the existing duplicate, projected-cursor, owner-close and tainted-VM assertions.

This key is not a complete dependency fingerprint or a cursor-only scope cache. Fine-grained local revisions, optimistic metadata and arbitrary scripts need further work before scopes/results can safely be reused. Broad Svelte dependencies and repeated preparation of Lua-enabled history are still outstanding.

## Actual UI reproduction

`displayCaptureUi.test.cjs` runs the original UI, real SQLite/IDB transport, original CBS/regex and real Lua workers with neutral synthetic data. The no-Lua screen has 50 messages and 3,200 nested unused settings. It verifies the original toggle and canonical global value, all visible CBS/regex results, zero calls to `captureDisplay`, navigation to character and module Lua with canonical variable admission, module disable/re-enable and return to no-Lua rendering.

An optional baseline mode serves the exact previous `scriptings.ts` through an isolated Vite load override. It does not rewrite checked-out source. The manager and other files stay current, so it is specifically an adapter comparison, not a full previous-commit speed benchmark.

```bash
git show 578419395a6acc6e48d1295eda1fc1f6c0863a94:src/ts/process/scriptings.ts \
  > /tmp/risu-display-capture-baseline-scriptings.ts
RISU_DISPLAY_CAPTURE_BASELINE_FILE=/tmp/risu-display-capture-baseline-scriptings.ts \
  node --test server/browser/displayCaptureUi.test.cjs
node --test server/browser/displayCaptureUi.test.cjs
pnpm exec vitest run src/ts/runtime/browserDisplayLua.test.ts
```

The recorded adapter reproduction made 154 unnecessary captures before the change, versus zero after it. Single-toggle observations are diagnostic desktop samples, not p50/p95, a universal speedup or a real-mobile result. The successful three-case regression run follows a retained run with exactly those three failures. Original scripts, assertions and execution budgets were retained.

Remaining work includes repeated Lua-enabled capture/history serialization, broad display invalidation, changed HTML/DOM/asset preservation, outer CBS/regex/plugin policies and the original editors/formats/restore/provider/offline/mobile/full trial requirements. The worker budget and image/inlay cancellation limitations in [the worker policy](display-worker-runtime.md) still apply.
