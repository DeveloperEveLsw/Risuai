# Shared immutable assets in the local runtime

The local server now owns image and binary asset storage. Original browser `saveAsset`, `readImage`, `loadAsset` and `getFileSrc` use the entity bridge in server mode. Persona image selection and original persona/character PNG import/export use those paths. This is an integration milestone toward the configured user trial; all 15 completion requirements remain in scope and production remains untouched.

## Storage and admission

Schema 11 adds an `assets` metadata table. Binary data is outside DBState and SQLite JSON bodies. Each asset has a SHA-256 digest, extension, byte length, MIME and creation time. Its public reference is `assets/runtime/<digest>.<extension>`. Metadata is immutable and registration is idempotent. Two identical uploads reuse the blob; different extension references can share the same underlying bytes.

The blob directory is `<database file>.assets/<serverId>/`, with `<digest>.blob` files. The server streams an upload to a unique temporary file while hashing bounded network chunks, limits it to 64 MiB, syncs the file, publishes a hard link without replacing existing content and syncs the directory. Only then does it transactionally register SQLite metadata and return success. Cancellation/error removes temporary data. A crash after file publication but before metadata admission can leave an unreferenced blob; the same content can be uploaded again safely. A reference is attached by a separate durable entity command after upload acknowledgement.

The currently conservative lifetime policy retains unreferenced assets. Automatic garbage collection would require accounting for resource, message, script and job references, including dynamically constructed asset names; it is not implemented. Copy or back up the database and its asset directory together. Complete restore/export/authority policy remains required. Missing blobs and incorrect byte lengths report a storage error. This does not claim detection of all same-length disk corruption.

Schema-10 migration adds the table without changing authority identity, canonical resources, cursor or jobs. Older migration regression fixtures now expect schema 11 while retaining their original preservation assertions. No production migration occurred.

## API and browser cache

| Endpoint                                          | Contract                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/runtime/assets?extension=png`          | Raw `application/octet-stream` body; current `Risu-Runtime-Id` header required. Returns immutable metadata/path after durable storage. Bounded to 64 MiB; empty/invalid input is rejected. |
| `GET /api/runtime/assets/:id?authority=SERVER_ID` | Current authority is required in the URL, including ordinary image/CSS requests that cannot supply custom headers. Serves the original bytes, conditional ETag and byte ranges.            |

The original host/origin restrictions remain in force. Asset IDs and extensions are validated; filenames are derived from hashes rather than upload names. PNG/JPEG/GIF/WebP/AVIF signatures and supported passive media extensions determine MIME. Other content is served as an attachment with `application/octet-stream` and `nosniff`. This loopback development API does not replace production authentication.

Media URLs are stable and private-cacheable for a year with `immutable`; conditional requests return 304 and byte ranges return 206. The authority in the URL separates caches across different databases. Original image display no longer allocates a new object URL for each shared asset read or registers the bytes in browser-local service-worker storage. Export/raw reads still fetch bytes explicitly. Asset transfers have a separate 120-second deadline from ordinary 15-second metadata requests; this is not resumable upload or complete offline media caching.

Unknown/non-ASCII filename extensions use a safe `bin` storage suffix while retaining the original caller's metadata. Explicit mutable custom asset IDs report a missing alias capability instead of silently overwriting immutable content. Complete alias compatibility and older browser-local asset migration remain required.

## Persona and character integration

`set-persona-image` attaches an already admitted asset to the selected persona and global user icon in one transaction. It verifies the original stable persona ID, selection-field clocks, resource revision/incarnation and icon field clocks captured before the file picker/upload. A later selection or competing icon/definition change rejects the entire attachment. The resource ID and other definition fields survive. This command uses the existing durable outbox/receipt/journal path; pending image attachment holds dependent selection and generation admission.

Original persona PNG export snapshots displayed fields before asynchronous image work and uses the original canvas/reencode/PNG-chunk encoder. Import uses the original persona chunk decoder and reencoder, saves the shared image and creates a new stable persona definition. Optional provided-file/return-file paths support synthetic acceptance; the regular UI still uses its original picker/download path.

Original character JSON/off-spec/PNG/CharX decode installation boundaries now create a canonical character/chat through the existing server command rather than pushing into confirmed browser DBState. The binary import attempt counter uses additive durable `record-import` commands, preserving upstream counting timing and immutable retry behavior. JSON counting remains unchanged. Original CharX/JPEG and legacy/current module packages now have synthetic multi-asset acceptance and media-format propagation; see [archive contracts](archive-runtime.md). This does not prove complete archive/history/restore, file-picker or every asset variant.

The actual browser fixture uploads and decodes a new 32-by-24 PNG on two devices, checks the original persona background uses the shared URL, exports/imports a persona PNG and roundtrips a synthetic v2 character PNG through the original v3 PNG writer/decoder. It verifies new identities, image references, original neutral content and unknown card extensions. Imported card toggles exposed a real Svelte state/effect feedback loop: the toggle setting now uses a derived value, so an object-valued imported setting cannot repeatedly wrap/write its own state. The fixture requires no uncaught browser errors and checks the original chat input remains interactive afterward.

The native worker supplies a shared-asset byte-reader port with cancellation support. DOM `Image`, inlay transformations, generated images, full multimodal/provider paths and plugin/Python image capabilities still require a complete server host. The byte port is not a claim that every native image script works.

## Evidence and remaining work

`server/entity/assets.test.cjs` checks immutable metadata, bounds, absence from ordinary bootstrap/journal, schema-10 preservation and exactly-once import statistics. `server/entity/librarySelection.test.cjs` checks durable-asset attachment and selection/resource/icon guards. `server/runtime/assets.test.cjs` checks binary fidelity, deduplication, restart, authority/origin/extension validation, caching, ranges, passive unknown content, aborted/oversized cleanup, independent metadata service and missing-file reporting. `server/browser/librarySelectionUi.test.cjs` exercises the original app paths described above and retains preset/offline/conflict/deletion regressions.

See `local-validation.json` for exact commands, artifact/source hashes and retained logs. Remaining work includes complete card/archive/module asset formats and file-picker acceptance, asset lifetime/restore/alias/offline policy, full native capabilities, manual/nested editors and plugin management, declared shared dependencies, display-side persistent effects, changed HTML descendants, cache/continue-reroll semantics and representative mobile/performance acceptance. The final practical trial/report remains required; this milestone does not complete the goal.
