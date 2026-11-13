# Browser Lua display effects

Schema 12 now has an original-browser adapter for Lua `editDisplay` ordinary variables and JSON `setState`. This is a partial compatibility milestone; the configured user trial and all 15 requirements remain unfinished. Production was not accessed or changed.

## Responsibility and immediate presentation

`ParseMarkdown`/`processScriptFull`/`runLuaEditTrigger` retain their original processing algorithms. The entity-mode wrapper supplies a private character/chat scope to the original `createScriptingRuntime`, `createChatVariableRuntime`, `createUtilStateRuntime` and CBS factories. It copies loaded message rows, variable maps and variable revisions before asynchronous work. It does not clone the archive, binary assets or all module definitions. Selected IDs, persona helpers, Lua CBS and its expression variable readers belong to that captured scope. Navigation cannot redirect a proposal to the next chat.

Lua `setChatVar`, `setChatVarChanged` and JSON `setState` change private values with read-your-writes. Successful effects enqueue a durable command in IndexedDB; presentation waits for that local write, not an HTTP response. Canonical DBState only receives confirmed journal changes. Pending rerenders use their own proposal values without repeating persistent writes. Accepted occurrences use canonical values; a different device's first admitted proposal remains authoritative. A differing duplicate intent produces a visible runtime notice.

The original v2 display-trigger temporary variables remain temporary. This adapter covers the Lua invocation and its nested CBS calls. The surrounding browser CBS/regex/plugin display pipeline is not yet fully scoped or equipped with a complete persistent-effect/capability policy. Lua execution still runs on the browser's main thread; heavy or infinite display code is not prevented from stalling it.

## Logical occurrence and server transaction

The server key is canonical SHA-256 of character/chat IDs and incarnations, external input clock, Lua code hash, source kind/content hash, and canonical message ID/revision when applicable. Request UUIDs are separate. A supplied `displayKey` must match the derived key, even for a duplicate. The optional key allows a recovered IDB command to be identified without rehashing during every projection.

Canonical message and selected greeting identities use their original unexpanded source. `Chat.svelte` already applies CBS before `ParseMarkdown`, and asset parsing may also expand variables. Hashing those expanded strings was reproduced to create another effect after its own variable update. The adapter now uses the canonical message/greeting text, and raw pre-asset text for other views. First-message identity is explicitly distinguished from the first loaded canonical row. Provisional streaming rows without a confirmed revision can transform privately but cannot submit persistent effects.

`display_input_clocks` persists the latest external sequence for each chat, character and broad shared configuration. The active clock is their maximum. Other chats, display effects, progress, statistics and derived activity do not advance it. The clock survives journal pruning and restart. Finer declared field/resource dependencies remain necessary.

A new `apply-display-effects` requires the captured clock, both entity incarnations, canonical source revision, all read revisions and all write revisions. Reads/writes are each limited to 128 keys, with combined JSON at most 256 KiB. Reads may cover ordinary/local-global/global variables; writes are ordinary variables in this chat. The command, variable effects, durable receipt and journal commit atomically. Any conflict rolls everything back. Event origin is restored in `finally` after failures.

The first candidate owns its occurrence. Different request IDs return its receipt without applying effects again. A differing duplicate reports `matchesOriginalIntent: false`. Receipts retain the first canonical result across restart/pruning. Variable and receipt events carry `displayEffectId` and `displayInputClock`, so delayed older derived events cannot revive receipts for a newer clock.

## Hydration, conflicts and VM lifetime

`GET /api/runtime/chats/:id/display?limit=1000&after=<key>` returns the current-clock keys, entity IDs/incarnations and a consistent cursor. The browser completes paging on opening the scope, merges observed journal events after the snapshot cursor and retries changed pages. Evaluation waits until that cursor is projected; it does not fetch receipt state on every render. Journal handoff is bounded to 1,000 buffered changes. Current-clock receipt-key hydration is not yet bounded to a fixed total number of keys.

A rejected display command stays reviewable in IDB and has a visible failure. Its values stop being presentation overlays; current canonical values are shown. It does not block ordinary chat commands and is suppressed for that same occurrence in the current controller, including after explicit discard. Rejected-key memory is bounded to 512. A later external input defines a new occurrence. This is not a complete automatic conflict re-evaluation/retry policy; discarded suppression is not an additional durable receipt and reload can reevaluate an unadmitted occurrence.

VM leases belong to server/chat/incarnation/code, retain original Lua globals within that lease and serialize invocations. Only identical in-flight presentation text at the same projected read cursor coalesces. Different expanded text or a newer read scope gets its own pure calculation while sharing the same persistent-effect occurrence. There are at most eight contexts and 128 queued invocations per context; only idle contexts are evicted. A failed invocation or initializer retires its VM. A partially installed listener from a failed initializer cannot execute on the next render. Closing the controller retires active leases and closes them when they finish.

The original scripting factory now revokes all invocation access tokens in `finally` and reports caught failures through an explicit host port. The native host records those failures and its existing health guard blocks partial persistence and subsequent provider calls. Ordinary browser fallback values remain the same. The structural audit still compares all 160 declarations: 158 are unchanged after port normalization; two Lua declarations have exact, hash-pinned cleanup/error policies and separate behavioral tests. It no longer claims all 160 algorithms are identical.

Paged history never masquerades as full history: display Lua history APIs fail explicitly when earlier rows are unloaded, and no proposal is submitted. Complete compatibility for indexed/full-history display APIs remains unfinished. This implementation has no browser VM cancellation/time budget or complete nondeterministic-Lua presentation-result policy. Persistent setters run once per admitted logical occurrence; pure rendering may reevaluate, which deliberately differs from legacy setters firing on every render.

## Validation and remaining work

`browserDisplayLua.test.ts` uses real Wasmoon and original CBS factories for private variables/JSON state, coalescing, pending/suppressed effects, captured revisions, navigation, raw-source stability, errors, failed initialization, paged history, provisional streaming and bounded VM lifetime. Original scripting tests verify tokens are revoked and old IDs cannot mutate later invocations. Native-host tests retain unavailable-capability guards and add an ordinary Lua failure case.

`server/browser/displayUi.test.cjs` runs the real original UI in two disposable Chromium contexts. It checks single canonical effects, both DBStates, repeated display, reload, admission-blocked preparation, IDB replay after every tab closes, new-ID deduplication, a different-source derived-write conflict, visible rejection and explicit discard without replay. The final desktop timing is recorded in `local-validation.json`; it is one small synthetic case, not p95, a representative card test or mobile validation.

Server/HTTP tests retain shape/read/write/source/incarnation guards, rollback, receipt pagination, pruning/restart and schema-11 migration, with logical-key/origin-clock checks added. Full current regressions, type/build/audit/CLI results and source fingerprints are recorded in `local-validation.json`. The first native/app callback-port failures and browser source-identity failure are retained with the final corrections; an initial full browser run also timed out waiting for a module editor. Its isolated rerun and final full run are reported separately without weakening that assertion or claiming a proven timing root cause.

Complete outer display/plugin policy, finer dependencies, changed HTML descendants, formats/assets/restore/editors, queued/offline variants, representative latency/long tasks/mobile and the full user trial remain in the original goal.
