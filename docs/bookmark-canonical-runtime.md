# Canonical bookmark members and bounded reads

Schema 14 adds chat_bookmarks as a member revision/order index while retaining the original bookmarks and bookmarkNames JSON as the portable representation. A member revision includes its occurrence count and name presence/value. Deleted members retain their revision; another member's insertion/removal or an ordering shift does not invalidate its name edit. Chat incarnation, saved-message revision and member revision guard explicit add/rename/remove commands, which use the existing durable receipt transaction. Accepted queued/running same-chat work rejects a competing manual bookmark mutation.

The original remove-first occurrence behavior is retained for duplicate IDs. Compact events carry the affected member's remaining positions and name, without other members or message bodies. Unknown JSON, orphan names, dangling/foreign portable references and malformed collections remain stored; malformed collection shapes reject manual edits explicitly. Names and IDs such as `__proto__` use own-property-safe copies. SQLite metadata rewriting still scales with the metadata's size, and duplicate position/name event size depends on the affected member.

## Interoperability and projection

The member index changes through ordinary field commands, whole-chat/native metadata writes, modern native metadata field writes, creation/import and full cloning. Unchanged field references skip the member scan. Schema13 migration builds the index without rewriting metadata, changing existing revisions or publishing journal entries. Cloning uses existing known-reference remapping; unknown extension strings remain untouched. Deletion/recreation retains the existing chat epoch guard.

The confirmed read model projects compact member changes through independently versioned collection fields. Saved message objects, ordinals/count and the loaded history window stay unchanged. Old snapshots/events and foreign epochs cannot undo newer confirmed names. Nonadjacent duplicate positions and whole portable collection deletion are covered.

GET /chats/:id/bookmarks/:messageId returns a body-free member/message header. GET /chats/:id/bookmarks?limit=50 reads up to 100 entries per page, joining actual saved messages across the complete canonical history while retaining portable bookmark order. Tokens pin chat, epoch, collection revision and content revision; a changed page must reload. Only selected entries' bodies are decoded. Count/order SQL work and byte volume still depend on data size; this is a count-bounded API, not a constant-cost archive query. Dangling/foreign members are retained in portable storage and omitted from the live-message list, matching the original message lookup behavior.

## Scope of browser acceptance and next required work

The new protocol fixture uses two actual original UI contexts, the existing public enqueue bridge, real IndexedDB/HTTP/SQLite and canonical member events. It checks held-command facades, metadata projection without snapshot/body fetches, a bounded HTTP read for an earlier unseen member, original confirmed bookmark coloring, conflict retention/discard, reload and once-only replay after every tab closes. It does not invoke the original manual bookmark callbacks or claim their connection.

The original Chat toggleBookmark and BookmarkList add/name/delete callbacks still directly mutate DBState. The list still resolves only loaded messages. They must be connected to these commands with captured owner/revisions before name input, private pending feedback, outside-page preview provenance and bounded jump/pagination before the full user trial. Full-history boundary branching/folders/reference policy and all15 original completion requirements also remain active. This server/read-model contract does not complete the bookmark feature or the whole goal.

Only public development source and authored neutral fixtures are used. Production access, private-content import, deployment and remote push remain outside this work.

## Current-source validation

Fresh sequential acceptance passed 391 application tests, 157 backend tests and 44 browser tests (592 total; three pre-existing application skips, zero backend/browser skips). Type checking reports zero errors/warnings. Native, entity and legacy builds, all 160 structural engine comparisons, formatting and the actual empty disposable CLI pass. The CLI reports schema 14 and its UI/backend listeners and temporary database are removed after the smoke check. Targeted and initial failing runs are excluded from the count.

Six warm large-display observations per scenario retain the original 56 Lua invocations and 44 independent-row recomputations with no source overrides. Desktop feedback p95 is 111.2 ms, settled p95 is 643.6 ms and maximum frame gap is 100 ms. Page 4x CPU emulation feedback p95 is 53.3 ms, settled p95 is 1457.9 ms, maximum frame gap is 216.6 ms and maximum long task is 210 ms. These measurements are from the final full suite; they are not a paired bookmark speedup comparison or physical-mobile evidence. The remaining frame-gap limit and all 15 full-trial requirements remain active.
