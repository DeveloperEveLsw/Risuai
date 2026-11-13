# Durable original group member editing

The original editor changes member IDs, speaking probabilities and activity flags as three separate array mutations. Adding a member may also append its greeting before membership is saved. These operations lacked an entity-runtime command contract, so confirmed DBState could change without a durable synchronized result.

The original controls now capture the group, member and position, submit a durable command and show a separate pending view immediately. Confirmed DBState changes through the server feed. Same-member conflicts restore confirmed values and leave a reviewable rejected command in the original runtime panel. Other-member editing continues while that command is blocked. Generation admission waits for unresolved member configuration; immediate drafts also guard the original send action.

The outbox treats unresolved member commands conservatively as configuration: a blocked member change must be cancelled/reviewed before new generation admission, including another chat. Already admitted independent server jobs retain their existing execution contract. Narrowing this admission barrier to proven dependencies is remaining work.

## Storage and concurrency

Schema15 adds `group_members(group_id, member_id, revision, occurrences, sort_position, slots_json)`. A stable member ID has one version across its legacy duplicate occurrences. Removal retains a version with no slots. A pure position shift does not increase another member's content version; an independent group-order guard rejects commands addressing old positions. Group deletion/recreation resets rows, while the incarnation guard rejects old commands.

Portable `characters`, `characterTalks` and `characterActive` arrays remain in the original definition. They and the relation update in one SQL transaction for imported creation, generic fields, legacy/native definitions and member commands. This is an interoperable revision/index relation, **not complete normalization of every group value**. Commands still parse the definition and rewrite changed arrays; cost grows with group size. Full headers contain present members. A single-member HTTP read returns no definition/chat body and recovers the retained removal version for re-add.

Different-member commands merge by checking their member/order/incarnation versions and editing the latest definition inside the transaction. Activity and probability of the same member deliberately share one guard, so concurrent changes to them conflict visibly instead of silently overwriting.

Schema14 migration preserves the exact definition string, unknown fields, duplicates, orphan references and malformed arrays without journal changes. Inconsistent array lengths require explicit repair before editing. Member IDs lack a character foreign key to preserve imported orphans; the group foreign key cascades its own rows. Older schema14 code rejects schema15. A future downgrade needs a preserved pre-migration DB snapshot rather than the old executable on this migrated DB.

## Greeting and dialog ownership

Capture the group and active chat before the selector or confirmation opens. Navigating to another group cannot redirect the command. Member addition and optional raw first-message append share one durable idempotent transaction. The server checks group order/member versions, group/chat incarnations, chat revision, source incarnation and first-message revision. Foreign, changed or running chats reject greetings. Append failures roll back arrays, relation versions, events and admission. Removing a member keeps old messages, matching the original behavior. Individual member chat bodies are not read. Ordered-mode toggles in both original screens use the existing field contract.

## Validation

Actual original controls run in development and in the built authenticated app, each with two independent Chromium storage contexts and authored synthetic cards. Held HTTP admission establishes feedback before canonical storage. Tests merge another member's peer change, reject a same-member change, continue unrelated editing, navigate during greeting confirmation, check the pinned original chat, remove/re-add without another greeting and save ordered mode. They close every tab with a locally durable remove pending and reopen the same contexts. Replay preserves the immutable request ID, emits one membership event and advances the retained member version to4. Successful runs report zero runtime exceptions.

The lifecycle check caught a candidate startup failure: pending work was projected against a body-free group summary lacking activity/probability arrays. Projection now waits for a loaded definition and refreshes at selection. The first HTTP/native acceptance also caught a missing DB-worker allowlist entry for the new read. Direct store tests alone did not expose these failures. Failing and corrected logs are retained.

Nine entity tests cover member CAS, rollback after append failure, stale/locked/foreign greetings, removal/re-add, legacy duplicate occurrences, migration and native definition guards. Two read-model tests cover held older definitions, shifted positions, tombstones and group reincarnation. A real native process consumes durable activity/ordered settings, speaks only as the enabled member and preserves synthetic individual archives.

Final gates and exact source/log hashes: [group-member-validation.json](group-member-validation.json), root `evidence/local-group-members-20261004.json` and `evidence/local-group-members-logs/`. Concurrent browser checks timed out on initial loading/persona confirmation; those controls passed sequentially. Test-fixture corrections include an awaited peer projection, the runtime panel's Korean cancel label and a null body during page navigation. These corrections and candidate failures are distinguished in the receipt.

## Local trial and limits

Subsequent work covers the original first-reroll boundary, original group continue and upstream HTML-button policy: [group-reroll-runtime.md](group-reroll-runtime.md). The limits below record this earlier member-editor milestone; reply variants and compound recovery remain unfinished.

Use the isolated launch procedure in [server-runtime-plan.md](server-runtime-plan.md) with a disposable synthetic DB. In two browser profiles, edit different members, then deliberately edit the same member concurrently. Check immediate checkbox/bar feedback, confirmed peer values and the rejected command. Add with/without a greeting, navigate while confirming, reload and reopen the same profile after closing tabs with a pending change. Ordered mode should persist and affect a synthetic native generation.

No production access, migration, deployment, remote push or actual provider call occurred. Group HTML/button member context, continue/reroll, automode, empty/inactive groups, multi-member recovery and complete definition read dependencies remain unfinished. Arbitrary extensions, complete collection normalization, bounded large-group costs, physical mobile lifecycle and representative latency/long-task acceptance remain required. Pre-persistence feedback was verified; universal zero-stutter or sub-frame latency was not. The active goal retains all original15 completion requirements.
