# Canonical display scope and deferred Lua admission

Follow-up: [bounded display admission](display-backpressure-runtime.md) corrects the specific complete-120-history queue overflow recorded below. The original observation is retained as historical evidence; larger preparation bursts and full compatibility/performance work remain unfinished.

This continues the original server generation, entity storage and multi-device goal. All 15 completion requirements remain active. The full configured trial is unfinished. Production, private content and remote repositories remain untouched.

## Corrections

The real original parser previously rendered the same stored message as `Synthetic ordinal probe 0:20` in a partial page and `Synthetic ordinal probe 20:20` after loading the complete history. Lua already used the canonical ordinal; outer CBS still used the UI index. A second actual SQLite reproduction showed that a later CBS failure could leave an earlier Lua variable write stored as `unsafe`.

Entity display now captures the stable message ID, original stored source, revision, input clock, definitions and variable versions before the first asset await. Original CBS and regex/trigger adapters use that private context. A canonical array facade maps loaded message bodies to their complete dense ordinals. Length and known rows are real; reading an unloaded body fails explicitly instead of treating it as a missing array hole. Array/row persistent mutations are rejected pending their server intent capability. Frozen body indexes are shared; row proxies and failure owners remain private and lazy. Mutable external inputs retain a captured body snapshot.

The original Lua worker calculation produces a draft. Its proposed chat-variable edits are visible to subsequent original CBS within the private display context, but do not enter IDB/server admission yet. Only successful completion of the remaining original asset, inlay, style, Markdown and sanitization stages commits that draft. Admission remains idempotent for a coalesced draft; owner close rejects a late commit. This does not roll back Lua VM globals, browser inlay writes or plugin side effects.

Exact concurrent presentations coalesce before digest/queue allocation using the complete captured scope and presentation inputs. Sequential invocations still execute the original stateful Lua. This is not a rendered-output cache or permission to skip unchanged rows. Existing worker time and wire budgets remain.

Original optimistic global/local-global values are captured separately for presentation. Original per-key Svelte dependencies are retained, while worker variables/revisions remain confirmed; copying the entire overlay map does not subscribe every row to every pending input. When a history snapshot includes a later journal sequence, completing replay retries both front CBS and display processing even if the final event only reports job completion. Lazy derived snapshots also have a private fresh-body fallback: it pins the already fenced body and never re-labels an old body with new headers.

Active module trigger access previously annotated original DBState in place, causing Svelte unsafe-state-mutation errors when invoked inside display derivation. Display capture applies the same low-level-access annotation to private module trigger copies. Entity asset name mappings, dimensions, visibility and source character/persona icons also read the captured definitions/settings. Legacy adapters retain the existing global asset path.

## Actual checks

The authored neutral browser fixture uses the original UI, real controller/CBS/parser, Lua Worker, IDB admission, HTTP service and SQLite. It checks canonical 20:20 in partial and complete history and canonical value 20 on another device. A delayed original asset URL capability holds the real parser prefix while a second browser loads history: the source UI row moves from 1 to 21, but its admitted command retains message m-26/revision 1 and stores canonical ordinal 21, observed on the other device. The uploaded image is real; the test delays the capability return, not network speed or an actual mobile OS.

A fresh partial device then processes a stored failure source. Original Lua first proposes a variable write; original CBS requests an unloaded previous user message and fails. The variable remains absent in actual SQLite. The prior unsafe stored value is preserved in immutable workspace reproduction evidence.

No-Lua display still prepares canonical scopes for outer CBS/regex. The previous zero-capture assertion is superseded: 50 neutral rows share their pinned body (two preparations for initial display plus a confirmed toggle), create zero Lua Workers, update through original CBS while the real SQLite command is held and the canonical variable is still absent, then retain all CBS/regex results and canonical toggle admission, and preserve character/module Lua navigation and enable/disable behavior. Capture calls themselves are not free; current performance is measured separately.

```bash
pnpm check
pnpm test
node --test server/browser/displayPipelineUi.test.cjs
node --test server/browser/displayCaptureUi.test.cjs
```

The final stage regression has 517 passing checks: application 354, entity storage 98, native engine 18, HTTP 16 and browser 31. Three existing application tests are skipped; no browser tests are skipped. Type checking has zero errors/warnings. Native and both optimized entity/legacy web builds pass; the native artifact remains byte-identical through the later browser-only corrections. The original algorithm audit reports 158 preserved algorithms among 160 audited declarations (two existing declared policy variations). The documented CLI starts the original welcome UI with an isolated empty schema-12 database and shuts down both listeners cleanly.

Current-source warm measurements retain all 56 Lua computations and 44 independent row recomputations per observation, with one body preparation. Six observations per scenario give p95 feedback/settled/frame gap of 73.9/646.5/49.9 ms on desktop and 44.7/1428.6/266.6 ms under page CPU 4x emulation. These are correctness-stage observations, not a paired speed comparison, physical-mobile result or proof of equal worker throttling. The throttled scenario still has visible display/frame cost.

## Remaining limits

- Loading complete 120-message history can overlap original display stages and exceed the existing 128-invocation Lua queue limit. The actual fixture records this visible error; it is not resolved by the correctness corrections. Exact duplicate coalescing does not remove legitimately distinct executions. Queue/backpressure and rendering lifetime work remain required.
- Outer CBS/regex persistent variables, scripted display triggers, direct character/history writes, display plugins and dynamic embedding currently require explicit pinned transaction capabilities and are rejected. This is an interim boundary, not complete extension compatibility or a reduction of the original goal.
- Canonical partial-history access does not fetch every unseen body automatically. Complete-history capability policy remains required.
- CSS decode/sanitizer global reads, translation and asynchronous DOM/render ownership still need complete scope/lifetime coverage. Successful provisional markup admission is not proof that the exact DOM remains mounted.
- All-row Lua execution, private scope transfers, large single-row markup and real mobile lifecycle/performance remain unfinished. The test's capability gate is not physical-network or mobile evidence.
- Native provider/memory/editor/import/export/restore/offline/shared-dependency and configured user-trial requirements remain in the overall goal.
