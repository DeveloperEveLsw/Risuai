# Local library commands and original module management

The original module page now creates, edits, enables, imports and deletes modules through the entity runtime. Editing uses a private draft and the revision captured when the editor opens. Confirmed resource changes propagate to other devices; an obsolete draft is rejected without overwriting newer data. This extends the local character/chat milestone and keeps all 15 completion requirements intact. Production was not accessed or changed and no remote push occurred.

## State and command contracts

The new commands manage `module`, `preset`, `persona` and `plugin` resource rows. This document records the module/catalog milestone. Subsequent [preset/persona selection integration](library-selection-runtime.md) connects those original screens and the preset import/export path. Plugin management and complete asset/card/archive fidelity remain unfinished.

| Command                   | Contract                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save-library-resource`   | Requires kind, resource ID, object payload with matching ID, aggregate `expectedRevision` and `expectedEpoch`. Creates or replaces one resource and appends a new stable ID to the current collection membership in the same transaction. Independent creations compose against the latest server order. |
| `delete-library-resource` | Requires resource revision/epoch. Retains resource/field tombstones, removes collection membership and updates dependent selection. Module deletion also removes the ID from global `enabledModules`. The last preset/persona cannot be deleted.                                                         |
| `reorder-library`         | Requires a complete permutation and the own revision/epoch of the settings collection-order field. Preset/persona selection follows the previously selected stable ID rather than the old array position.                                                                                                |

All three use the existing durable request/payload-matching admission, immutable receipts, IndexedDB outbox and journal projection acknowledgement. Failure rolls back the resource, related settings changes, journal events and receipt together. Missing guards and changed identities are rejected. Whole-draft editing uses the revision of the actual loaded body, so a newer catalog header cannot accidentally authorize an older body.

Collection membership/order currently lives in stable ID arrays in settings; these are not fully normalized association tables. Existing per-resource JSON bodies retain unknown data. Field clocks advance through the existing explicit field machinery. The transactional helpers read inside the outer command transaction rather than invoking another transaction-owning API.

## Original module UI

`ModuleSettings.svelte` opens the library explicitly, creates a draft without inserting it into confirmed DBState, and snapshots an existing module before editing. Its original nested lorebook/regex/trigger controls edit that draft. Creation/editing waits for server confirmation before leaving the editor. A concurrent edit is reported and the rejected intent can be cancelled through the existing runtime status controls; its private draft never replaces canonical data.

The original global-enable control uses the effective settings getter and a small `enabledModules` field intent. It can show a pending selection independently of confirmed DBState. Deletion captures its resource revision before the original confirmation dialog and atomically updates the server collection/global enable state. Module-to-character conversion uses canonical character creation in entity mode. The ordinary browser path retains its previous storage behavior.

The original `importModule` decoder now installs its decoded module through the library command. It accepts an optional provided file for fixture coverage; the UI still uses the original file picker. Imported modules receive a new ID, preserving upstream import-as-copy behavior. MCP configuration ingestion uses the same installation boundary. This does not prove native MCP execution or server asset storage.

The real browser scenario supplies a new synthetic JSON file to the original decoder, preserves its unknown field, globally enables it through the original UI and verifies that its output regex changes the native worker's saved reply. Binary RisuM/CharX assets, original export/file-picker acceptance and full card/archive fidelity remain required. Existing binary decoders still have browser asset dependencies.

## Loading, replay and caches

Inactive module bodies remain unread during ordinary bootstrap and library browsing. Opening the module page reads a bounded catalog page, with 50 summaries by default, rather than hydrating every resource body. Search and further pages use server catalog queries. Actual module bodies are fetched for editing/export/conversion or active ID/namespace references. The module page keeps rows keyed by stable ID; see [catalog contracts and measurements](library-catalog-runtime.md).

A body read returns payload, own field versions, incarnation epoch and cursor in one deferred WAL snapshot. Editing captures the loaded body's aggregate guard and uses an isolated draft. List headers never authorize an older draft. Closing the module library invalidates late page/edit responses and releases inactive body caches. Active definitions stay loaded; reconnect refreshes visible summaries and active resources. Namespace resolution preserves the upstream ID-or-exact-namespace matching contract and guards delayed results against newer module changes.

Resource projection invalidates the original browser module cache through an explicit host callback. Native workers continue using their private captured configuration. Module deletion does not retroactively cancel an already accepted job; ordinary job cancellation remains explicit. Cross-character/chat references, collection read/write dependency contracts and full lifetime policy still need acceptance.

The catalog table is normalized summary metadata maintained with the authoritative resource write in the same transaction. Existing resource JSON bodies and membership arrays preserve their current contracts. Full DOM virtualization, bounded large-field event references and other library UI/initial-body paths remain unfinished. Native execution still captures full resource definitions; the catalog optimization is a browser library path, not a claim of fully lazy engine reads.

## Evidence

`server/entity/library.test.cjs` exercises independent creates, immutable replay, stale drafts, atomic delete/membership/global enable changes, resource recreation/epochs, preset/persona stable selection across reorder/delete, permutation/CAS guards, last-resource rollback and invalid identities/guards.

`src/ts/runtime/risuReadModel.test.ts` verifies compact catalogs, pagination/search generations, lazy draft fidelity, offline additions on resnapshot, deleted/closed-view body fencing, exact namespace matching, delayed namespace resolution and obsolete-event replay. The extended `server/browser/lifecycleUi.test.cjs` runs the actual original app in two disposable browser contexts, verifies private drafts and an actual rejected concurrent edit/cancel, runs the original JSON import decoder, enables the imported module, observes its native output processing and deletes both modules across devices. Existing welcome/character/chat/full-copy/trash/restore/tab-exit/settings/toggle scenarios remain covered.

Providers and data are new synthetic loopback fixtures. No real cards, stories, prompts, provider credentials or installed scripts were read. Chromium is the test client; the server engine runs in native Node workers. See `local-validation.json` for exact commands, artifact/source hashes, counts and scope. The documented local launcher remains `pnpm dev:entity`.

Current validation: 301 application tests pass with 3 skipped, 78 entity tests, 18 native worker tests, 12 HTTP tests and 20 reported browser tests, totaling 429 reported passes. The browser count includes its protocol suite parent and three full UI scenarios. Type checking reports zero errors/warnings, native and both web modes build, and all 158 selected declarations pass the extraction audit. Existing warnings remain; small synthetic desktop feedback timings are not representative performance evidence.

Remaining work includes plugin UI management, complete persona assets/import/export, other manual/nested settings/character editors, group/folder ordering, assets and faithful import/export, full library virtualization and large-change bounds, persistent display-side effects, full dependency contracts, remaining native capabilities/lifetimes/continue-reroll behavior, changed HTML descendants/assets, offline/authority policy, physical mobile/representative latency/long-task acceptance and the final configured trial/report. Preset/persona controls have a later scoped integration described above. No completion or deployment decision is claimed by this milestone.
