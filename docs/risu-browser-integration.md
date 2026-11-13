# Risu browser integration, in development

The existing Risu application now has an opt-in entity runtime path. It remains a development milestone: all 15 requirements in `server-runtime-plan.md` remain in scope. A fresh, cost-free synthetic structural trial is available through [local-user-trial.md](local-user-trial.md); full practical acceptance remains unfinished. Production was not accessed or changed.

## Launch

```sh
pnpm dev:entity
```

The command builds the native engine, starts the API in a separate process, and serves the existing Risu UI at `http://127.0.0.1:5174`. The API defaults to port 6174 and `.local-runtime/entity.sqlite`. Both listeners bind to loopback. `RISU_RUNTIME_PORT`, `RISU_RUNTIME_DATABASE` and `RISU_RUNTIME_CONCURRENCY` configure the isolated backend. Occupied ports fail without stopping another service.

This does not import an existing save or create a production connection. An empty database now receives original defaults and can complete the original welcome wizard, create/edit a basic character and configure the integrated model controls. Other setup/import/settings/resource screens remain unfinished. Use the automated synthetic scenarios below to reproduce the verified flows. The hosted service remains available for ordinary use while the complete trial is developed.

```sh
pnpm test:runtime-browser
```

This builds the native engine and runs both the transport acceptance suite and the actual Risu UI scenario in disposable browser profiles/databases. `RISU_BROWSER_CHROMIUM` can specify the installed Chromium executable. The UI scenario seeds only newly created synthetic fixtures and uses a loopback streaming provider. HTTPS browser requests are blocked in that scenario; no real cards, stories, prompts, provider credentials or deployed data are opened. Browser Chromium here is the test client, not the server generation engine.

## Current boundaries

- `storage/databaseState.svelte.ts` owns the original Svelte state object without importing the browser host. Existing `stores.svelte.ts` consumers still use that same object.
- `RisuReadModel` normalizes original settings defaults, projects character summaries, loads one character definition and chat metadata, and reads only the selected message page. Older messages are requested explicitly. Changing chats evicts the previous message bodies. Active modules/global scalar variables are hydrated separately; resource order/persona selection and all library screens still need complete entity handling.
- Revision/cursor checks protect loaded messages, variables, metadata and resource/statistics projection. Reconciliation patches existing Svelte proxies and preserves message/array references. Unknown JSON fields are retained as own data, including keys named like prototype properties.
- `BrowserRuntimeController` pins the server database identity by origin, uses the durable IndexedDB outbox/SSE client, restores relevant active jobs and their commands, and separates pending input/progress from confirmed message records. Navigation enables controls only after the read model, job hydration and message presentation have finished. Terminal reads hydrate canonical writes before clearing progress. Streamed/final presentation uses the same message ID and reactive object.
- The entity bootstrap skips the original whole-save decoder, cold-storage migration, account/drive save flow and whole-database autosave watcher. Navigation reads server data and can leave a generating chat. The ordinary local mode remains available without `VITE_RISU_ENTITY_RUNTIME=TRUE`.
- The actual textarea routes send/continue/reroll admission to server jobs. Lua and named manual HTML buttons use native extension jobs; named triggers apply their returned chat in the private execution context before committing. Saved message edits use individual commands. Continue/reroll variants and identity semantics still require further acceptance.
- Message rows use keyed Svelte rendering by persistent ID. Content, index, reload pointers and streaming finalization update props without changing that key. The inner ChatBody no longer uses a key to destroy itself when the message count changes, and async parsing updates one retained output branch with stale-result suppression. HTML that actually changes can still replace child assets/controls; preserving those nodes requires further work.
- Browser Lua loads the installed Wasmoon WASM through a bundled same-origin URL. The scripting factory accepts a host constructor; native jobs keep the installed Node Wasmoon resolver. The selected upstream algorithms still pass the extraction audit; that audit alone does not prove host lifetime/capability compatibility.

The Svelte rendering decisions follow the primary documentation for [keyed each blocks](https://svelte.dev/docs/svelte/each#Keyed-each-blocks) and [await blocks](https://svelte.dev/docs/svelte/await). The DOM claims above are limited to the implemented boundaries and the real browser observations below.

Custom variable toggles now have immediate pending overlays, durable per-key admission, per-chat global overrides and actual conflict controls. See [variable-runtime.md](variable-runtime.md) for contracts and limits.

## Verified actual UI scenario

`server/browser/risuUi.test.cjs` launches the full existing application through Vite, not a replacement chat screen. It uses its character navigation, HTML controls and textarea.

1. Two independent browser contexts select a synthetic character. The unselected chat's synthetic archive marker is absent from their DBState.
   The original custom toggle is also exercised with admission unavailable, both conflict-resolution buttons, per-chat pin/unpin and rollback after IndexedDB closes.
2. One device clicks a Lua HTML button; its committed variable is visible in the other device's first-message display. A named manual trigger clicked there is visible on the first device.
3. A textarea submission reaches the native streaming provider. The assistant row's actual DOM object remains connected and identical when the reply is committed. This checks row lifetime, not every descendant image/control or all cards.
4. A second generation reaches the provider/progress stage. Every observing tab is actually closed before the provider completes. The native worker persists the reply; a fresh tab restores both replies with no additional provider call or duplicate message ID.
5. A third provider call remains gated in another chat while its original custom toggle confirms on the server and appears on a new independent browser. The job is still running at both observations; completing it preserves that selection and makes exactly one third provider call.

## Original field controls

Schema-v8 field commands now back the original jailbreak, memory and local-toggle-mode controls and common data-driven setting wrappers. Values display through a separate pending getter map; confirmed DBState changes only through server projection. IndexedDB allocates field revisions/predecessors across tabs, retains heads and separates entity incarnations. Rejected chains support both existing conflict buttons. See [entity-fields.md](entity-fields.md).

The full UI scenario additionally clicks all three sidebar scopes during the third gated generation, verifies another independent browser sees their confirmation before completion and checks final persistence. Offline cases cover immediate selection, canonical-state separation, field reapply/discard, the original accessibility checkbox, conditional quote input with array preservation, and the original animation slider's actual CSS effect and rollback after closing settings. Closing IndexedDB restores the field selection without server admission. Late full projections cannot undo a newer scoped field read. Ordinary field events now patch only changed values; the actual two-browser scenario observes zero full settings/character/chat body or chat-list reads during those confirmations, with large synthetic unused fields in all three entities. Newly referenced resources and new resource incarnations are loaded separately when necessary.

Text/font/CSS, size and animation use reactive browser presentation effects reading the pending settings view. The ordinary browser path keeps its existing storage behavior. This covers the common wrappers and named sidebar controls; other direct bindings, persistent display-script writes and representative performance remain unfinished.

## Original model setup and native memory

The original model settings page now reads pending field values and submits explicit intents for its 97 direct bindings, including endpoint/key/model/format and nested fields. Dependent model resets are grouped atomically; observer/default hydration does not save data. Legacy nested regex/order editors receive isolated field drafts. Provider dashboard availability is key-scoped local UI state. Actual two-device acceptance verifies configuration, a six-field key reset, nested regex preservation and no remote hydration echo. A fourth native generation consumes the UI-configured endpoint/key/model while the original SupaMemory option remains enabled. See [model-settings-runtime.md](model-settings-runtime.md) for exact scope and native memory limitations.

## Remaining work

The original module library now uses isolated edit drafts, captured revision guards, durable creation/edit/deletion and immediate global-enable field intents. The original JSON import decoder installs a new resource ID, whose output regex is consumed by actual native generation in the two-browser scenario. Remote updates, rejected stale drafts and deletion/global enable cleanup are covered. Opened libraries recover offline additions and invalidate browser module caches. See [library resource integration](library-resource-runtime.md); other resource UIs, binary assets/import/export and lean library catalogs remain unfinished.

Original first setup, character creation/basic fields, new chats, full server-side chat copies, chat deletion and character trash/restore/permanent deletion now use durable entity commands. Two-device acceptance runs from a fresh database through the actual welcome wizard and original controls, then verifies native generation, a copy larger than the browser page, deletion/restore and retained terminal job history. Lifecycle epochs prevent obsolete reads/progress from attaching to recreated IDs. See [character/chat lifecycle](character-chat-lifecycle-runtime.md) for exact contracts, reference rewriting and limits.

Remaining entity/manual/nested editing, module/preset/persona/plugin management, group behavior, faithful import/export and resource/folder ordering; cross-control dependencies; persistent display-side effect policy; complete read/write-intent and collection dependencies beyond the implemented snapshot/write guards; continue/reroll variants; Lua/cache lifetimes; remaining providers/memory/assets/MCP/plugin/Python capabilities; offline startup and authority restore policy; descendant DOM/assets preservation; actual mobile/representative latency measurements; and a practical user trial/report remain required. The desktop scenarios and transport tests do not prove those requirements. No deployment or remote push is authorized by this milestone.
