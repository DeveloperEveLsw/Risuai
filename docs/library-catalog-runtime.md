# Compact library catalogs and module definition lifetime

This is a local development milestone on the original upstream baseline. Production was not accessed, changed, restarted, deployed or pushed to. Data and providers are newly generated synthetic fixtures. All 15 requirements in `server-runtime-plan.md` remain intact; the final configured trial is unfinished.

## Storage and API

Schema v10 adds `resource_catalog` for modules, presets, personas and plugins. It stores a compact summary, sort/search key, exact namespace key, body byte count, resource revision and incarnation epoch. Whole-resource and explicit/native point writes update it in the same transaction; resource deletion cascades. Migration from v9 backfills summaries while preserving original JSON, identity, revisions, journal and live job ownership/progress. No production migration was performed.

`GET /api/runtime/libraries/:kind?limit=50&search=TEXT&after=CURSOR` returns `kind`, a consistent change cursor, bounded summary items and an opaque next cursor. Limits are 1–200. Search treats `%`, `_` and backslash literally. Sorting/paging uses normalized name followed by stable ID. Names/descriptions/namespaces in summaries are limited to 256/768/512 UTF-16 code units without retaining an incomplete surrogate. Original bodies remain unchanged. Search operates on the bounded catalog name; it does not search a very long name's omitted suffix.

`POST /api/runtime/libraries/module/resolve` accepts up to 256 identity/namespace tokens per batch. Exact full namespace matching is independent of its truncated display summary. All matching module IDs are returned, preserving the original ID-or-namespace behavior.

`GET /api/runtime/resources/:kind/:id` returns one full body with its own field revisions, epoch and change cursor from one WAL snapshot. These three read APIs use deferred read transactions and do not reserve the database writer. A second SQLite connection can obtain a write transaction while they hold their read snapshot; the entity suite verifies this behavior.

Catalog SQL reads the summary table, without selecting or parsing resource bodies. A test traces every prepared query during pagination and rejects any resource-body query. Journal resource/field changes include bounded catalog metadata so an open module list updates without loading inactive definitions.

## Browser behavior

The original module screen reads summaries into separate runtime UI state. Confirmed `DBState.modules` contains full active/explicitly opened definitions, without empty-script placeholders that could enter the engine. Initial browsing reads 50 rows; further pages are explicit. Search waits 150 ms and late responses from an older query or closed view are ignored. Rows retain their stable ID keys when another page is appended.

Editing fetches the selected body and captures that body's revision/epoch together. The private draft retains unknown fields and does not mutate confirmed DBState before saving. Export/conversion also fetch the full body. A save may refresh the one cached edited definition; it does not hydrate every listed module. Closing the view invalidates late edits and releases inactive full bodies. Active definitions remain loaded, and global/character/chat references plus exact namespace integration determine the browser's module execution set. A delayed namespace response cannot replace a newer active set.

The existing original UI regression still verifies two-device conflicting drafts/cancellation, JSON module decoding with unknown fields, durable global enable, native output regex use and atomic deletion cleanup. The new actual UI scenario adds large inactive definitions, bounded queries, search, keyed-row preservation, lazy editing, unknown-field retention, closed-view resnapshot and active definition loading in a fresh independent browser.

## Synthetic measurement

The latest actual Chromium/Vite fixture uses 63 modules with 19,656,000 bytes of synthetic definition content. Its first 50-row catalog response is 9,790 bytes; the next 13-row response is 2,574 bytes; a one-row search response is 246 bytes. Browsing those pages makes zero full module body requests. Editing fetches module 60 once initially and once after saving; enabling module 0 fetches that definition. No other inactive body is fetched.

The recorded first page takes about 171 ms, and search including the 150 ms debounce takes about 180 ms. The observer sees two long tasks with a maximum of 87 ms across the fixture. Measurements include test instrumentation and concurrent local validation load. They establish the payload reduction for this representative synthetic module-library path, not mobile/card-generation/HTML-wide performance acceptance or a promise of zero stutter. Raw measurements are retained in the browser log and validation manifest.

Validation: 301 application passes (3 existing skips), 78 entity passes, 18 native passes, 12 HTTP passes and 20 reported browser passes; 429 total. Type checking has zero errors/warnings. Native/entity-mode/ordinary web builds and the 158 selected-declaration extraction audit pass. Existing build and experimental runtime warnings remain. The documented CLI also starts a fresh schema-10 authority, shows the original welcome UI and closes both listeners using isolated synthetic storage.

## Remaining scope

Preset/persona/plugin UI commands, full import/export/assets, other manual/nested editors, group/folder ordering, full shared read/write/collection dependencies, persistent display-side effects, changed HTML descendants/assets, remaining native capabilities/lifetimes/continue-reroll variants, offline/authority policy and physical mobile acceptance remain required. Large changed values are still inline, user-requested catalog pages accumulate rendered rows, and native execution snapshots still capture complete resource definitions. Membership arrays are not fully normalized association tables. The final practical configured trial and user evaluation have not yet been delivered.
