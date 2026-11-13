# Bounded display Lua admission

This continues the original server generation, entity storage and multi-device goal. All 15 completion requirements remain active. The full configured trial is unfinished. Production and private content remain untouched.

## Reproduction and correction

The previous original-UI fixture recorded a Lua invocation queue error while loading complete 120-message history. A separate authored neutral unit reproduction holds the first scheduling yield and submits two distinct 120-row waves to the actual original Wasmoon Lua runtime. Only 128 of 240 calculations returned transformed output; the remaining 112 failed with the invocation queue limit. A different chat still executed independently. This unit fixture uses real Lua, but is not itself a browser Worker or mobile test.

The preparation turn now ends after its invocation reserves a Lua slot. When an existing lease has 128 queued/executing invocations, its next preparation waits for a slot; later captures wait in the already bounded preparation queue. A completed invocation or owner close releases that capacity wait. This preserves capture/digest order, original stateful Lua globals and independent chat execution. It does not raise the 128-invocation, 128-preparation-per-chat, eight-context, 1024-total-preparation or 16 MiB scope limits. The inflight diagnostic includes a calculation waiting for capacity; 129 inflight entries does not mean 129 admitted Lua invocations.

Actual original Lua now produces all 240 outputs with counters 1 through 240; the next sequential call returns 241. The different chat returns its independent counter 1. Owner close releases pending capacity waits without executing their effects or submitting commands. An oversized distinct 280-call burst still explicitly rejects 24 preparations under the unchanged limit; 256 admitted calculations retain their order. No obsolete or distinct stateful calculation is silently skipped to obtain these results.

The real original UI/controller/parser/CBS/Lua Worker/IDB/HTTP/SQLite fixture now has empty runtime errors on both devices when complete 120-message history loads. The prior canonical20, delayed uploaded-asset source1-to21 with message m-26/revision1, other-device21 and later-CBS-failure non-admission checks still pass.

## Validation scope

Current checks comprise 357 application tests plus 31 distinct successful browser checks. Three existing application tests are skipped. The original broad browser run had 30 passes and one optimized-bundle startup failure because the disposable build command omitted the same test/private-use initialization flag used in the previous milestone. Rebuilding with both flags below and rerunning that single case resolves it; the original failed log is preserved and is not relabeled as a fully green broad run.

```bash
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build --outDir /tmp/risu-display-backpressure-built
RISU_DISPLAY_WORKER_BUILD_PATH=/tmp/risu-display-backpressure-built node --test server/browser/displayWorkerBuildUi.test.cjs
pnpm check
pnpm test
```

The 98 entity, 18 native and 16 HTTP checks are reused from the immediately preceding milestone: every other tested source file and the native artifact remain identical. Total effective validation is 520 checks (388 fresh, 132 unchanged-backend checks), rather than a claim of 520 fresh runs. The prior empty welcome CLI smoke is also reused because that startup/termination path is unchanged. Type checking has zero errors/warnings; optimized entity/legacy builds and the 160-declaration original algorithm audit pass. Changed files and the generated validation manifest are formatted before committing.

Six warm observations per scenario retain all 56 Lua computations and 44 independent row recomputations. Current p95 feedback/settled/frame gap is 83.1/614.2/50.1 ms on desktop and 48.5/1416.8/250 ms under page CPU 4x emulation. Long tasks total one (max 56 ms) and six (max 247 ms) respectively. These observations do not provide a paired speed comparison, physical-mobile result or proof of equal worker throttling. Full-row rendering cost remains visible.

## Remaining work

- Larger distinct bursts can still exceed the bounded preparation queue. Capture creation/serialization and all-row processing need further lifetime and byte-budget policy; this is not an unbounded memory/throughput guarantee.
- Outer CBS/regex/trigger persistent proposals and broader plugin/history/embedding capabilities remain unfinished. The current interim rejection policy is not a reduction of the overall compatibility goal.
- CSS/sanitizer/translation reads, DOM/asset lifetime, large markup/scopes, real mobile/offline behavior and the configured practical trial remain unfinished.
- All original provider/memory/editor/import/export/restore/shared-dependency requirements continue in scope.

Immutable reproduction and current logs live in the workspace evidence/display-backpressure-logs directory. The historical pipeline milestone remains in docs/display-pipeline-runtime.md.
