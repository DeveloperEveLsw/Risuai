# Body-free chat folder navigation

Previously the server stored `metadata.folderId` but omitted it from chat summaries. The read model created unopened chats with no folder, so the original SideChatList misplaced them until their full metadata was selected. Summaries now include only the folder field's presence/value and existing field revision/epoch headers. Message bodies, notes, memory, lorebooks and other metadata remain outside this listing.

## Coherent reads and projection

The standalone `listChats` endpoint reads the row values and their field revisions in one read-only SQLite transaction. `getCharacter` already owns a transaction and uses the raw internal summary helper. A real second WAL connection committing between the row query and revision query cannot attach a new revision to an old folder value. No schema change is required; schema14 remains current.

The read model materializes the chat before applying the folder through the existing field projection guards, then remembers the remaining headers. Revision, cursor and entity epoch reject stale values and old incarnations. Summary navigation does not advance the full metadata cursor: selecting that chat still requests its ordinary bounded snapshot. Missing, explicit null, empty and unknown values remain distinct in the server header.

In server mode the original unassigned section also displays a chat referencing an absent folder. Its canonical reference and unknown metadata stay unchanged. The client does not silently delete or replace imported references.

## Current acceptance

- Two backend cases cover exact presence/value, small body-free output despite large metadata/message markers, generic field deletion and a real interleaved WAL commit.
- Three new read-model cases cover unopened folder hydration without full metadata, delayed old summaries after a newer peer projection, and deletion/recreation with stable ID reuse.
- The actual original two-browser UI checks initial folder placement, an unopened metadata cursor of -1 and zero body rows, only selected-chat initial snapshot reads, a held older character response after peer movement, normal selected-chat loading, orphan visibility without rewriting, field removal and a real page reload.
- Exact parent backend and actual UI controls reproduce missing navigation and the mixed old-value/new-revision problem. Parent sidebar restoration hides the orphan. Replacing guarded navigation projection with direct assignment fails the delayed-summary case. Sources are restored byte for byte. Invalid initial synthetic-message shapes and the initial broad DOM selector are retained separately and excluded as controls.

The targeted UI's two initial snapshot requests are both for `a?limit=100`; unopened `b` retains zero messages and metadata cursor -1. Selecting `b` later reads its normal 100-row page and restores its note and unknown extension fields. Synthetic `a`, `b` and `c-chat` contain 110/180/140 messages.

Complete current acceptance runs from the analysis workspace:

```sh
python3 scripts/run_chat_summary_final.py
```

The gate requires 411 app passes plus 3 existing skips, 170 backend passes and 50 browser passes: 631 fresh passes, types0/0, native/entity/legacy builds, 160-entry engine audit, an isolated actual CLI and 324 source fingerprints. It retains the original warm performance fixture and its 56 Lua calculations/44 unaffected rows; measurements are current observations, not a claimed speed comparison for this change. Detailed evidence is `evidence/chat-summary-logs` and `evidence/chat-summary-validation.json`.

This completes the tested folder read contract. Manual folder create/rename/color/fold/delete/move and collection ordering still need durable original-UI command integration. Listing still scales with chat count and the SQLite worker reads the JSON folder field; it does not establish fully bounded initial resources or complete archive fidelity. Wider editors/group/extensions, offline/restore, physical mobile and a configured user trial remain. All15 requirements stay active; production/private contents/remote push are outside this local milestone.
