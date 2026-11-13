# Durable original chat folder controls and ordering

The original SideChatList now admits folder creation, rename, color and fold edits through the existing durable field outbox. Folder deletion and chat/folder pointer drags use semantic server commands. Immediate private pending views are separate from confirmed DBState; SQLite confirmation and replay update the shared read model on each device.

## Server contract

`remove-chat-folder` captures character identity/epoch and the chatFolders field revision before confirmation. One transaction removes that folder and discovers all current matching memberships from canonical rows. It clears those references without depending on which chats the browser has opened or the public 128-field batch limit. A peer's earlier move to another folder is retained. Other metadata, message bodies, unknown folder properties and unrelated orphan references remain intact. The response is a small count, with ordinary field events carrying the changed values.

`reorder-chat-navigation` captures the same owner/folder guards and an independent navigation revision. It validates exact chat and folder permutations, unique same-character memberships and their field/epoch guards. Memberships, folder order, positions, durable receipt and change events commit together. Late member conflicts roll back the entire command. Reordering does not change chat message revisions or invalidate an unrelated content edit.

Schema14 remains current. Existing integer runtime_meta rows hold a namespaced counter per character; missing counters begin at zero. Creation, deletion and changed chat order advance it, and pruning or identity reuse does not reset it. This extends the existing metadata contract without a schema migration. Compact order events contain stable IDs, positions and incarnation headers, never message bodies. Character responses read their navigation header in the existing coherent transaction.

The read model rejects older ordering headers and events, preserves the selected stable chat ID and its message objects, and leaves unopened metadata/body state unloaded. A held older character response or chat-creation event cannot overwrite newer positions. Character and chat incarnation guards prevent previous lifetimes from retargeting recreated entities.

## Original UI behavior

Rename, fold and color retain the original controls. Rename's pencil stops propagation so opening its input does not also fold the folder. Color and delete capture the owner and folder revision before waiting for their dialogs. A peer rename during delete confirmation produces an explicit revision conflict and retains the folder.

Sortable captures stable owner/member guards at drag start. At drop it reads stable IDs, restores Sortable's external DOM edit before Svelte projection using siblings excluding the moved node, and admits the copied order and optional moved membership. It does not splice confirmed chat/folder arrays. Keyed rows and selected-ID projection retain selection. Pending deletion/movement/order appears locally while another browser and confirmed DBState retain their last committed values. Existing durable outbox/status resolution covers rejected commands and replay after every tab closes. Orphan references remain visible without silently clearing them on an unrelated reorder.

## Evidence and reproduction

Run from the analysis workspace:

```sh
python3 scripts/check_chat_navigation_negatives.py
python3 scripts/run_chat_navigation_final.py
```

Seven backend cases cover atomicity, invalid permutations/foreign members, independent message edits, stale collection and incarnation guards, more than128 canonical members, idempotent replay/payload matching, and schema14 reopen/pruning. Four read-model additions cover held old character headers, prepend creation, recreated ownership and a held old creation event.

The actual Chromium UI uses two independent browser contexts and real pointer events for both chat and folder drags. It exercises original create/rename/color/fold, held admission with private pending state, selected identity and unopened body reads, canceled deletion, 131 additional unopened folder members, a peer movement during confirmation, a stale confirmation conflict, closing every tab before admission acknowledgement and exact-once replay on reopening. A wrapper observes exact DOM folder order and membership immediately before the actual durable method runs, without replacing its behavior. Only selected `a?limit=100` snapshots are requested; inactive bodies stay unread. Repeating the replayed immutable request returns the saved result without advancing the journal.

Five controlled source changes must fail: removing navigation CAS, accepting held old character order, accepting old creation positions, restoring direct facade mutation for the original create action, and restoring the old DOM index that still counted the moved node. The last case reproduces an incorrect same-container earlier move before private projection. Each source is restored exactly. Initial color-settling, broad request-observer and nonexistent receipt-method errors are preserved separately as fixture failures, excluded from acceptance controls.

The fresh gate requires 415 application passes (3 existing skips), 177 backend passes and 51 reported browser passes: 643 fresh passes. It also checks types0/0, native/entity/legacy builds, the 160-declaration engine audit, an isolated actual CLI and 329 source fingerprints. Browser checks run sequentially after CLI cleanup. Details are in evidence/chat-navigation-logs and evidence/chat-navigation-validation.json. Current warm observations retain original Lua work and stable unaffected descendants; they do not establish a speed comparison for folder edits or physical mobile behavior.

## Remaining full-goal work

Chat summaries and drag permutations still scale with chat count. Bulk folder removal runs atomically in the DB worker and emits a field event per affected member. Folders remain a JSON field with one collection revision; unrelated edits to different folders can conflict. A color dialog overlapping a newly confirmed own field edit can also require retry. This does not prove fully normalized nested storage or every cross-control dependency.

Character-list collection dragging, remaining editors/group/extensions, complete restore/offline/capability policy, physical mobile and the configured user trial remain required. All15 completion conditions remain active. This work uses public source and authored synthetic fixtures only; production access/change, private content inspection and remote push are outside this local milestone.
