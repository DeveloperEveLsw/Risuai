# Canonical character navigation and original folder controls

Phase54 follows sealed phase53 `62f0523ebd9ac3f8434444273edf49e7934e143a`. This document describes the implementation under validation. The full fifteen conditions in [the plan](server-runtime-plan.md) remain active; this milestone does not establish a configured user trial or universal performance improvement. Production, private contents and remote push remain outside this development run.

`change-character-navigation` carries a captured settings incarnation, order-field revision and independent character collection revision. Its action uses stable character/folder IDs and an explicit destination folder and before-anchor, rather than array indices or a browser-filtered replacement. The server discovers visible IDs from the indexed character summaries, then transforms the canonical settings field and commits its field event and immutable command receipt in one transaction. A character without a saved order entry is materialized only when the action mentions it.

The shared pure transformation supports moving a character within, between or out of folders; moving a top-level folder; grouping a character onto another top-level character or an existing folder; and editing a folder's name, color or image fields. It retains hidden/missing imported members, unrelated empty folders, null/opaque legacy entries, image references and unknown extension fields. Only an actually emptied source folder is removed. Ambiguous IDs/memberships, nested folders and foreign anchors are rejected. Folder edits cannot change membership or arbitrary fields.

The independent integer in `runtime_meta` increases on character creation, deletion or a change between visible and trashed status. Ordinary name/message edits do not advance it. Native whole-definition and modern field write sets use the same counter; failed final persistence rolls it back. It survives journal pruning, SQLite reopening and ID reuse. Settings deletion/recreation separately changes its resource incarnation. Permanent deletion removes only that character's known order memberships and its actually emptied folders in the same transaction, retaining unrelated unmapped members and metadata. A recreated ID cannot inherit the deleted incarnation's folder placement. Existing schema14 is retained.

Bootstrap and the public global settings snapshot expose coherent order existence/value/revision/incarnation with the collection counter and cursor. The header reads only the JSON order field; it does not hydrate character definitions. Bootstrap now uses a read transaction, so a WAL writer can commit during that pinned read without replacing the old snapshot's values with new revisions. The read model keeps canonical order separately from its visible DBState projection. Held old settings, summaries and creation events cannot overwrite accepted order/visibility or remove a later peer creation. The projection filters hidden/unmapped members and appends visible unlisted IDs without saving that filtered result.

The original `Sidebar.svelte` captures the source ID and guards at native dragstart, and captures folder ID/guards before opening a menu. It sends the semantic action through the existing durable IndexedDB outbox. The controller maintains a private pending view; confirmed DBState and the peer screen remain unchanged before admission. A stale immutable command remains explicitly blocked for review/discard. Folder expansion remains device-local. Ordinary upstream mode retains its original handlers. Stable keyed avatar IDs and scoped drop targets retain the selected chat and message DOM during sidebar movement.

Candidate evidence uses authored synthetic data only:

- Eleven entity tests cover canonical fidelity, grouping/moves/edits, malformed intent rollback, lifecycle/order/incarnation guards, immutable retries, pruning/reopening, native visibility write sets, 133 unopened definitions, a real two-connection WAL interleaving and atomic deletion membership cleanup.
- Three new read-model regressions cover canonical versus projected order, peer movement, trash/restore/deletion/recreation, body-free changes, old settings/bootstrap and delayed creation events.
- An actual Chromium fixture uses two independent contexts, the original native HTML5 dragstart and CDP drag/drop delivery for three pointer drags. It exercises original rename/color/image-reset/cancel menus, held admission, peer conflicts, selected message DOM retention and all-tab outbox replay. Only the selected character/chat is hydrated. Image file selection is implemented but its actual file-picker path is not established by this fixture.

Run targeted checks from the development checkout:

```bash
node --test server/entity/characterNavigation.test.cjs
pnpm exec vitest run src/ts/runtime/risuReadModel.test.ts
node --test server/browser/characterNavigationUi.test.cjs
pnpm check
```

The final fresh source/type/native/entity/legacy/CLI/browser gate is `python3 scripts/run_character_collection_final.py` from the analysis workspace. Its own logs, fingerprints and outputs use the character-collection prefix and preserve phase53 evidence. See `evidence/character-collection-logs` for candidate histories and final results after completion.

Limits: folders and order remain one JSON collection; unrelated folders can conflict on its revision. A pending local navigation command blocks another captured navigation action until confirmation/discard. Creation/deletion of another character also invalidates a capture. Initial summaries, visible projection and semantic order transformations still scale with collection size; this is not complete per-member relational folder storage or DOM virtualization. The native drag fixture is desktop Chromium, not touch dragging or a physical mobile acceptance test. Full image-picker/assets, group/editor/extension/offline/restore/provider compatibility, representative generation/display performance and the complete configured trial remain required.
