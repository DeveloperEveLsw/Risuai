# Canonical display ordinal and history count

Browser indices identify loaded UI rows. Original display Lua receives the corresponding dense ordinal in the complete canonical chat, and `getChatLength` receives the complete count. A database ordering position can have gaps after deletion and is not that ordinal.

## Reproduction

Two original UI devices, controller, Wasmoon worker, CBS, IDB outbox and HTTP/SQLite use 125 neutral messages with the first 5 deleted through an ownership-checked write set. The initial 100-row page begins at stored position 25: its full ordinal is 20 and its UI index is 0. Original `meta.index` previously received 0 and persisted it. Loading the earlier page displayed 20, but the server and other device retained 0 because the durable occurrence was already admitted. Partial `getChatLength` failed under the complete-history guard.

The actual pre-fix output, canonical value, other device and controller hash are preserved. A separate initial startup timeout did not reach the probe; its cause remains unconfirmed. The fixture now opens independent device contexts sequentially during startup.

## Data and projection contract

- A bounded snapshot returns `history.count`, `history.offset` and each message's dense `ordinal`. One indexed aggregate counts the full chat and prefix without decoding unloaded bodies. Execution snapshots remain complete. No schema migration is required.
- An append event explicitly identifies an addition and its ordinal at insertion. The position aggregate also counts preceding messages. Edits do not identify an addition; deletion events retain the removed position.
- The read model tracks confirmation of the count, each row ordinal and the latest page separately. A deletion shifts affected loaded ordinals and decrements the count; an append increments it once. Replay cannot apply either twice. Editing an unloaded body does not hydrate it into the partial window.
- An older page cannot advance latest-page coverage and swallow an unseen append. A page older than an applied history mutation is re-read up to 3 attempts. A snapshot ahead of projection cannot authorize capture until its cursor has applied. Older rows receive each intervening rank transform once.
- Reorder refresh reads the bounded window and removes bodies that left it while preserving surviving message objects and the array. Display headers remain fresh per invocation with shared frozen body lifetime.
- The controller provides ordinal/count and their confirmation cursor. UI editing/deleting retains its loaded index. Partial chat access exposes only canonical `length`; full-history operations still fail visibly and cannot submit earlier provisional effects. The original scripting algorithms remain unchanged.

## Verification and limits

Actual browser checks include partial/full pages, unloaded edit, deletion before the window, live append, deletion while an older HTTP page is held and retried, and reorder into a fresh third device's latest window. After reorder, UI index 99 is full ordinal 118 with count 119. Full and partial devices run actual Lua and converge; loading older rows preserves the value. Each phase waits for the canonical input clock and ordinal/count.

Real SQLite/read-model tests additionally cover replay, a future older-page cursor with an unseen append, stable objects and a reordered body leaving the window. If every loaded row was deleted but older records remain, the next bounded read uses the latest remaining page instead of an infinite position. An actual browser deletes all 100 rows in a fresh partial window. Its completed-job refresh recovers the remaining 19 with correct count and first ordinal 0. The explicit empty-window recovery path is verified separately with actual SQLite/read-model tests. Original Wasmoon tests verify canonical metadata/count and continued complete-history rejection without partial effects.

An isolated fixture has 20,000 neutral 1,072-byte bodies and gapped positions. Thirty warm 10-row snapshots decode 10 bodies, return 12,006 bytes and have query p95 1.1ms; 30 actual durable appends have p95 4.8ms. This single-process measurement does not establish network/UI/concurrency/import latency or constant-time behavior. Count aggregates still scale with history. Temporary databases are removed.

This corrects the Lua capture/metadata boundary. Outer CBS/regex/translation indexing and whole-presentation consistency remain unfinished. Full-history APIs in a partial display scope still need an equivalent capability or explicit compatibility policy. Changed DOM/assets, remaining extensions/editors/formats/restore/providers/offline/physical-mobile and the configured trial remain required. All 15 original requirements remain active and unchecked. Production, private contents and remote repositories are untouched.
