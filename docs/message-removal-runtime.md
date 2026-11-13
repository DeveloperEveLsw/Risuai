# Durable removal from the original chat UI

The original Chat component's single/range removal now uses the entity command boundary. It captures the saved message ID, owning chat, message revision, chat revision and chat epoch before opening any confirmation dialog. Changing the selected chat while the dialog is open does not change its target. A concurrent edit or chat mutation rejects the old command rather than deleting a newer history.

The browser keeps the confirmed facade and presentation until canonical removal is projected. A separate pending state disables the affected trash button and exposes aria-busy. Durable IndexedDB admission, request/payload matching, server receipts and the existing visible blocked-command controls handle retries and failures. Shift-click still removes the selected message and everything after it; the original confirmation and instant-removal choices keep their meanings. The legacy local branch keeps its previous storage path.

## Server transaction and partial history

remove-message accepts mode one or from. Ownership, message/chat revisions, chat epoch and queued/running jobs are checked in the same command transaction. Accepted work in the same chat must finish or be cancelled before destructive removal. Another chat remains independent.

Range removal uses the canonical position in the server's complete message table. It does not trust the loaded page's index. It reads only removed ID/revision headers, records monotonic tombstones, deletes the rows, advances the chat revision once and emits one compact messages-removed event containing the position, mode, count, chat revision and epoch. Remaining bodies, positions, IDs, unknown fields and chat metadata are preserved. A failure rolls back tombstones, rows, receipt and journal together.

The read model adjusts loaded dense ordinals/counts once, rejects older snapshots and message events across the removal cursor, and skips an old removal event already covered by a newer snapshot. Surviving message objects are retained. If a range removes the entire loaded tail while older messages survive, the model fetches a bounded current tail before finishing projection. No complete archive-body download is required.

## Synthetic acceptance and limits

The actual original UI fixture uses independent browser contexts and 110 authored messages with an initial page of 100. It holds the command HTTP request to check coherent pending presentation, observes both devices, reloads, races confirmation against a remote edit, cancels a dialog, changes chats during confirmation and removes the loaded range. The original scroll helper exposes the first loaded row before its real trash button is clicked. Both devices refill the eight surviving older messages through one tail read each, and the original canonical display-history error does not occur.

Server tests cover file persistence/deduplication, a 1,200-row range with one small journal event, stale ownership/revisions/epoch, queued/running work and transaction rollback. Read-model tests cover stale pages/events, survivor identity, bounded tail refill and a restored same-ID occurrence covered by a newer snapshot. The restoration fixture uses the existing internal canonical mutator; it does not assert support for a public restoration API.

Removal work and tombstones still scale with the number of deleted headers. Snapshots currently include all deleted-message headers; large tombstone-history payloads remain a separate performance task. Bookmark/memory/external-reference cleanup retains the original removal semantics and is not a complete archive/restore contract. Physical mobile, offline startup, all remaining editors, extension compatibility and the complete configured user trial remain unfinished. All 15 original completion requirements remain active.

Current validation freshly runs 385 application checks with three existing skips, 142 backend checks and 42 reported browser checks with no skips: 569 passing results, no backend reuse. Types report zero errors/warnings; native/entity/legacy builds, the 160-declaration structural audit and modified-range formatting pass. An actual disposable CLI launch serves schema-13 health and the empty original UI, then both listeners and its temporary database are verified cleaned up. The clean optimized output trees have separate inventories. See docs/local-validation.json for source fingerprints and raw logs. This local milestone does not authorize production access or deployment.
