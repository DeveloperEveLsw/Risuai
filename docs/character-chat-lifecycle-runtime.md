# Character and chat lifecycle in the local entity runtime

The existing Risu UI now supports an empty database's first setup, character creation and basic editing, new chats, complete server-side chat copies, chat deletion and character trash/restore/permanent deletion through durable commands. This milestone does not finish the practical user trial or any of the 15 requirements by itself. Production was not accessed or changed; no real saves, stories, prompts or provider credentials were inspected or imported, and no remote push occurred.

## Running the development application

From this checkout, run:

```sh
RISU_RUNTIME_DATABASE=.local-runtime/character-chat-demo.sqlite pnpm dev:entity
```

The command builds the native entry and starts a separate state/engine process plus the original Vite UI at `http://127.0.0.1:5174`. The API defaults to port 6174; `RISU_RUNTIME_PORT=0` selects a free local API port. Both listeners bind to loopback. Use a new filename to keep development data separate. Ctrl+C stops this development launcher. This is a development walkthrough, not the final configured trial or a deployment procedure.

On a genuinely empty database, the service atomically installs the original upstream default settings and separate preset/persona/module/plugin/global-variable resources. Settings retain stable resource references instead of embedding those collections. Initialization never overwrites existing settings or intentionally deleted global settings. The original welcome wizard saves user changes and its final setup as field intents. Opening a page or receiving a remote projection does not save defaults back to the server. Canonical persona/preset references replace browser-generated defaults only when those references exist; older settings without references keep upstream fallback behavior.

The original add-character dialog can create a character from scratch. The basic editor connects character name, description, first greeting, background HTML, virtual script and current chat note. The original model settings controls can configure the already integrated provider paths. This does not imply that every character field, embedded editor, provider or resource management screen works in entity mode.

## Canonical commands and acknowledgement

Every lifecycle command uses the existing request-ID/payload-matching admission and journal protocol. The browser persists one intent in IndexedDB before submission. The action resolves after its receipt cursor has been projected; it does not select a character/chat that has only been queued locally. A lost acknowledgement reconciles the same ID. Closing the browser leaves the durable intent available for recovery.

| Command            | Behavior and guards                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create-character` | Creates a definition with stable ID and optionally its initial chat in one transaction. Invalid initial data rolls back both creation and receipt. Existing IDs produce an explicit identity conflict.                                     |
| `create-chat`      | Creates metadata and optional initial messages separately from history/variable maps. Optional `expectedCharacterEpoch` fences an obsolete parent identity. `prepend` inserts a new UI chat at the front; default legacy creation appends. |
| `clone-chat`       | Requires source revision/epoch and no accepted queued/running job. Copies full canonical history, ordinary variables and chat-local global overrides in one transaction; it never copies only the browser's loaded page.                   |
| `delete-chat`      | Requires revision/epoch, no accepted queued/running job and at least one remaining chat for the character. Failure rolls back all effects.                                                                                                 |
| `delete-character` | Requires revision/epoch and idle chats. Deletes all owned live rows atomically while retaining tombstones and terminal job/command history.                                                                                                |

Normal character removal writes `trashTime` through the field queue; restoration removes that field. Neither operation destroys chat history. The current device clears its selected chat and message presentation when moving a character to trash. Confirmed trash state propagates to other devices. Permanent deletion closes a selected screen before projecting deletion of its last chat, preventing the original UI from rendering a nonexistent chat. Deleting a selected chat falls back to a remaining chat without changing another device's independent selection.

Rejected ordinary lifecycle intents have a visible cancel action. Only a known rejected command can be discarded; pending or uncertain admission cannot be treated as cancelled. Existing variable/field conflict resolution remains separate.

## Copy identity and original memory references

Message IDs are unique server entities, so each copied message receives a new ID. The copy keeps unknown message/metadata fields and rewrites the upstream-defined references to those IDs: bookmarks and bookmark-name keys, `lastMemory`, SupaMemory's first-line anchor, legacy Hypa anchor IDs, HypaV2 `chatMemos`/`lastChatMemo` and HypaV3 `chatMemos`.

Summary text, bookmark labels, unknown extension fields and script-variable strings remain unchanged. Orphaned references remain orphaned; malformed legacy encoded memory is preserved with its existing upstream error behavior. An arbitrary extension can store IDs in unknown fields, which this explicit mapping cannot infer. Full card/import/export fidelity and extension-defined identity contracts remain required.

## Schema 9 and deletion lifetime

Schema 9 adds a small `trash_time` summary and chat `sort_position`. Ordinary bootstrap reads no longer parse every character body just to find trash state. Character definition, activity, own field headers and chat summaries come from a single consistent WAL read; message history stays paginated separately.

Jobs now capture `chat_epoch` and retain their command foreign key without depending on the lifetime of a live chat row. The service's transactional queued/running-job guard replaces that lifetime constraint for destructive commands. Terminal jobs remain queryable by job/request ID after deletion. Listings and browser presentation filter by the current chat incarnation, so recreating the same chat ID cannot attach its old progress/results.

The migration rebuilds the jobs table while preserving ownership, fence, lease, queue position, starting revisions, progress, result and timestamps. It preserves server identity, existing entity bodies and journal cursor, then recreates queue/ownership indices. SQLite foreign-key checking passes on synthetic migration fixtures. Earlier migration tests continue to verify their original retention assertions against current schema 9.

Character, chat, message and variable deletions retain revisions; field epochs survive deletion and recreation. Read-model guards reject late bodies/snapshots/events from an obsolete incarnation. Loaded objects are reconciled rather than rebuilding a whole database archive.

## Evidence and remaining scope

`server/entity/lifecycle.test.cjs` uses isolated synthetic databases to cover atomic creation/rollback, immutable retries, complete 125-message copies, identity/reference fidelity, trash/restore summaries, last-chat and accepted-job guards, terminal receipts, obsolete intents after recreation, default initialization and schema migration.

`server/browser/lifecycleUi.test.cjs` opens two independent disposable Chromium contexts against the actual original app and native server workers. It completes the real welcome wizard, creates and edits a synthetic character through original controls, sends through the main textarea, copies history larger than the loaded 100-message window, deletes a chat across devices, moves/restores the character and permanently deletes it while retaining its completed native job. The existing full UI scenario still verifies settings/toggles during native generation, stable message rows and generation after all tabs close. Chromium is the test client; it is not the server generation engine. Providers are loopback synthetic fixtures and HTTPS calls are blocked.

The documented `pnpm dev:entity` command was also run against a new temporary database, observed through disposable Chromium at the welcome screen and shut down with both listeners confirmed closed. See `local-validation.json` for command logs, artifact/source hashes and the exact scope of each proof.

Validation: 295 application tests pass with 3 skipped, 68 entity tests, 18 native worker tests, 12 HTTP tests and 19 reported browser tests (16 protocol scenarios, their parent and two full UI scenarios): 412 reported passes. Type checking reports zero errors/warnings; native, entity-mode and ordinary-mode builds pass. All 158 selected declarations pass the structural extraction audit. Existing build/runtime warnings remain. Synthetic desktop feedback observations are not representative performance or physical-mobile acceptance.

Remaining work includes module/preset/persona/plugin management, remaining manual/nested character/settings editors, group-specific behavior, folder/collection ordering, faithful card/archive import/export and asset handling; complete read/write/collection contracts; persistent display-side effects and browser-only capabilities; remaining native providers/memory/embedding/backends/lifetimes and continue/reroll variants; changed HTML descendant/asset preservation; offline/authority policy; actual mobile and representative latency/long-task acceptance; and the final practical trial/report. Per-entity bodies still contain JSON aggregates, and large changed fields remain inline. All 15 requirements in `server-runtime-plan.md` remain intact.
