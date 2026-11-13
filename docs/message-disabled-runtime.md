# Saved message disable and cutoff actions

The original power and scissors buttons now send set-message-disabled to the entity server. They capture the saved message ID, owning chat, message revision and chat epoch before asynchronous admission. The UI retains the upstream transitions: power negates the previous value (including allBefore to false), while scissors toggles allBefore and false. The legacy local branch retains those transitions.

An immediate local presentation changes the existing blue/amber separator. It does not mutate the confirmed DBState or generation input. Durable pending commands retain the desired flag, disable both actions and expose aria-busy/aria-pressed when their original popup is reopened. Blocked commands stop previewing; a rejection restores the confirmed value and remains visible/reviewable. Old pending incarnations, revisions and invalid values are excluded from the persisted preview lookup.

The original popup now clears openId when its document click closes it. Previously children was cleared while openId remained, so reopening that same menu needed another click. The actual UI fixture exercises the normal menu/portal lifecycle; it does not relocate the original actions or bypass their callbacks.

## Canonical storage and projection

The transaction validates the chat epoch, message ownership/revision, supported false/true/allBefore value and queued/running same-chat jobs. Another message or another chat remains independent. It reads only message headers, patches the disabled JSON property in SQLite, advances message/content revisions and emits one compact message-disabled event. Existing text, unknown fields, IDs, positions, metadata and history counts remain unchanged. A failure rolls back payload, chat revision, receipt and journal.

The read model patches a loaded saved message through its stable object and preserves ordinals/count. An attribute cursor rejects older pages and replayed body events, including a page for a changed message outside the loaded window. Loading that earlier page later returns fresh canonical flags. Newer snapshots and foreign chat epochs fence old deltas. No message body is resent for a flag toggle; SQLite still rewrites the affected stored JSON value, whose cost depends on that row's size.

## Original engine meaning and actual acceptance

The actual upstream native generation filter skips a message whose disabled is true. On allBefore it stops before adding that message and earlier messages, and suppresses the first greeting. False restores normal inclusion. Authored neutral provider tests run the original generation worker three times and inspect only the synthetic requests to prove these meanings.

An actual 110-message/100-loaded UI fixture opens the original popup, holds HTTP, observes immediate separator feedback while both confirmed facades remain unchanged, releases and observes two devices, repeats both original actions and reloads. A concurrent remote body edit rejects a held old flag and restores confirmed presentation. All browser tabs close after IndexedDB admission; reopening the same context replays the saved request once, retains all messages/unknown fields and survives another reload. The first fixture's incorrect assumption that popup actions were row descendants is retained separately.

All 15 original completion requirements remain active. Bookmark/member collection revisions, full-history branching/folders/reference policy, remaining editors/extensions, offline/restore/asset lifetime, physical mobile and the complete configured user trial remain unfinished. This milestone changes only local public source and synthetic data; production/private contents and remote push are outside its scope.

## Fresh local verification — 2026-10-03

The final source passed 388 application tests (the existing 3 skips), 147 backend tests and 43 tests in the sequential full browser suite: 578 fresh passes with no reused checks. Types report zero errors and warnings. Native, entity-enabled and legacy web builds, 160-declaration structural audit, modified-source/document Prettier checks and the actual disposable pnpm dev:entity CLI smoke passed. The CLI used schema 13, loaded the original empty UI, then closed both listeners and removed its temporary DB.

The 110/100 disable fixture observed local separator feedback in 26.4ms while HTTP was held; this is one synthetic desktop observation, not a percentile or mobile guarantee. Separate current-source large-display scenarios used six warm samples each: desktop feedback p95 30.1ms, settlement p95 644.5ms and maximum frame gap 100ms; page-4x CPU emulation feedback p95 50.6ms, settlement p95 1444.1ms, maximum frame gap 200ms and maximum long task 194ms. Original 56 Lua calls and 44 unaffected-row recomputations remain, without source overrides. These are not a paired disable-toggle speedup experiment or physical mobile results.

Streaming handoff passed in the full suite; a separate unchanged-source target captures its raw frame evidence because the full-suite caller supplied an unused output variable. That extra run is excluded from the 578 count. Raw logs, source hashes, fresh owned build inventories and the initial fixture/prototype history are preserved outside the repository.
