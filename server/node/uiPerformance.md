# UI and resident execution performance

The resident executor now mounts `ResidentApp.svelte`, which preserves loading
and alert handling without mounting the character catalog, chat or settings UI.
Bootstrap, Lua, plugins, canonical generation, leases and multi-device observers
still use the existing engine. Chromium remains necessary for the browser-based
plugin sandbox, DOM parsing and engine dependencies; this is not a native Node
engine migration.

Chat entries use room-scoped message IDs rather than content hashes. Pending
input is deduplicated once its canonical message is visible. Overlapping output
snapshots for the same message select the newest timestamp. `ChatBody` keeps one
HTML boundary, retains its previous presentation until new formatting resolves,
and ignores superseded completions. Identical HTML preserves radio state, focus
and image nodes. Different HTML can still replace its inner nodes.

In Node mode, incremental saves snapshot root settings and changed/new blocks.
Unchanged histories reuse the encoder's stored bytes. Canonical filtering touches
only detached characters. After adopting a modern self-contained Node snapshot,
the encoder reuses its validated blocks rather than cloning and serializing all
histories again. Legacy/split/remote formats still take the full reload path.
Initial loading, whole-database network transfer and remote proxy adoption still
process the full database. CAS,
idempotency, dirty epochs and executor fencing are preserved.

Validation on Node 24.19 and Chromium 154:

```sh
pnpm check
pnpm test
node --test server/node/*.test.cjs server/node/runtimeGenerations/*.test.cjs server/node/runtimeStartup/*.test.cjs server/node/proxyStreamJobs/*.test.cjs
RISU_BROWSER_E2E_CHROMIUM=/usr/bin/chromium RISU_BROWSER_E2E_SKIP_BUILD=1 node server/node/runtimeGenerations/browserE2E.cjs
RISU_BROWSER_E2E_CHROMIUM=/usr/bin/chromium RISU_BROWSER_E2E_SKIP_BUILD=1 node server/node/runtimeGenerations/groupContentBrowserE2E.cjs
RISU_BROWSER_E2E_CHROMIUM=/usr/bin/chromium RISU_STARTUP_BROWSER_E2E_SKIP_BUILD=1 node server/node/runtimeStartup/browserE2E.cjs
RISU_BROWSER_E2E_CHROMIUM=/usr/bin/chromium RISU_UI_PERFORMANCE_RESULT=/tmp/ui-performance.json node scripts/verify-ui-performance.mjs
```

The performance fixture compiles the real Chats source with a delayed child
render double, the real ChatBody presentation effect/template with identity
formatting, the database proxy and the save encoder with storage doubles. It
uses synthetic histories and no production data or paid provider. On a 33.4 MB /
60,000-message fixture, full snapshot median was approximately 625 ms, root-only
incremental capture 0.2 ms, and one-character capture 9.6 ms. These are timings
of the capture stage, not whole-app latency or a comparison with Risuai-Next.

Acceptance fixtures seed the current self-contained RisuSave block format to
avoid msgpackr 1.10.1's Node 24 legacy fixture encoding incompatibility. Storage
assertions check canonical DB/cache records and service workers, rather than
comparing Chromium's allocated empty database pages against a small fixture.

A native server engine should first separate storage/selection from browser
stores, preserve prompt and Lua side effects with a compatibility corpus, adapt
DOM parsing and plugin APIs, then validate cross-device persistence and cancel
contracts before replacing the resident runtime. Risuai-Next provides useful
storage/parser boundaries but currently lacks a complete generation engine.

## HTML control latency

Manual `risu-trigger` and Lua `risu-btn` controls immediately mark their clicked
DOM control pending with `aria-busy`. Cleanup restores community attributes on
success, cancellation and failure. Selection remains the canonical script result.
These actions retain admission fencing and a Stop control but show a cancel icon
instead of the response-generation spinner. Admission is reserved before the
follower persistence await so rapid clicks cannot submit duplicate callbacks.

An explicit Node persistence barrier flushes the normal save debounce and wakes
the save worker. It returns after the authoritative CAS, without waiting for
best-effort backup housekeeping. The resident uses a bounded one-second long
poll, waking immediately after durable command creation; old servers retain
bounded polling. Network and lease error behavior is preserved.

An isolated Chromium fixture with 12,000 archived messages on the active
character (12.76 MB seed) measured four consecutive manual/Lua interactions.
Mean click-to-visible-state time dropped from 3,409 ms to 1,291 ms (62%). Queue
wait dropped from 467–981 ms to 10–13 ms. Both independent desktop/phone browser
partitions adopted the canonical state, with no new interaction save conflicts.
These are four fixture samples, not a production p95 or a promise for arbitrary
card scripts. The hand-assembled fixture has one startup migration conflict in
both versions before the interaction assertions begin.

```sh
RISU_BROWSER_E2E_CHROMIUM=/usr/bin/chromium RISU_BROWSER_E2E_SKIP_BUILD=1 RISU_INTERACTION_EXPECT_PENDING=1 node server/node/runtimeGenerations/interactionBrowserE2E.cjs
```

Do not run a fixture that rebuilds `dist` alongside tests serving that directory.
Startup tests use `RISU_STARTUP_BROWSER_E2E_SKIP_BUILD=1`, a separate variable.
