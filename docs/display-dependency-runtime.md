# Display read provenance and admission

The original entity UI now carries variable read provenance from its first synchronous CBS pass through regex/trigger/Lua processing and final CSS decoding. The durable display command joins those reads with the original Lua read set. The server retains its existing revision CAS, external input clock, source revision and entity epoch checks.

## Actual failure and corrected boundary

The neutral original-UI fixture prepares a Lua proposal and an opaque CSS block reading a chat variable at revision 1. A second actual original Lua invocation changes that source to revision 2. Derived display writes intentionally retain the same external input clock. Previously the first command had an empty reads array, so its captured CSS used the old value while SQLite accepted its stale dependent proposal.

The independent negative observation remains in workspace evidence. The corrected fixture uses the actual parser, Lua Worker, IDB, API and SQLite. The server rejects the stale proposal and retains the blocked command for review/discard; the original UI shows that rejection. Reading the latest value in a fresh occurrence recovers and saves once. A separate first-CBS-before-Lua race is rejected in the same way. A stored message containing an ordinary CBS macro also proves that the real Chat.svelte/ChatBody path supplies the dependency to its automatically submitted command.

## Ownership and original semantics

- A MarkdownPresentation token optionally carries the first CBS capture. Chat.svelte supplies that token to ChatBody. ParseMarkdown forks its private variable fields, revision maps and source header using the existing frozen-body shell mechanism; it does not copy the whole archive or recapture a later body under an earlier formatted string.
- A WeakMap ledger belongs to each captured owner. Original variable getters and readonly variable proxy property reads record chat, chat-global and global targets, including absent keys. Global reads retain the original local override precedence and record the local lookup even when it falls through to the global value.
- Forks inherit the first CBS ledger. Later regex/trigger CBS and CSS use the same owner and append their reads. Lua's provisional writes remain visible to later CSS against their base revisions, so read-your-own-proposal behavior is preserved.
- Joint reads are deduplicated, require matching revisions and use deterministic key order. The existing 128-read and 256 KiB proposal limits remain. A pure display can read more keys, but a persistent proposal explicitly fails the bounded admission contract.
- An exact shared Lua calculation keeps its original immutable command. Commit builds a separate joined proposal. Equivalent read sets share one admission; different provenance cannot silently reuse another caller's cached admission. Original VM globals, calculation order, exact-duplicate coalescing, queue/scope budgets and durable occurrence identity remain.
- Lua work identity excludes presentation overlays because the original Lua and nested CBS read pinned canonical maps; the already-expanded input remains a separate work key. Each caller retains its own outside reads and provisional admission.
- A revision-driven first-CBS refresh retains its existing UI owner only when expanded text, full canonical scope, outside reads and admission policy match. Equal confirmed overlays may disappear without rerunning stateful Lua. Differing overlays remain in this owner identity even before later CSS or regex reads them. Explicit UI refreshes retain their previous behavior.
- Commit still waits for durable local IDB admission rather than a network round trip. A later server conflict remains a reviewable blocked command and is visible in the original UI. Closing a tab does not lose accepted durable work.

## Pending values

Original global overlay getters continue to provide immediate presentation feedback. A read is provisional when the captured overlay differs from the confirmed value or existence, including a pending local deletion changing global precedence. A proposal depending on that provisional value is shown without submitting canonical Lua effects. This preview does not poison the shared draft's admission promise. Confirmation produces a new capture/occurrence that can persist with confirmed revisions.

The actual browser fixture delays only the owned RuntimeSyncClient HTTP command capability. A real global edit is durable in IDB while HTTP admission waits. The original CBS/Lua preview displays the pending value and stores no derived target. After forwarding the actual request and projecting the confirmed value, the same logical interaction saves the derived target once. An initial test attempted to replace window.fetch after the client had already bound its transport; that fixture timeout is retained separately and corrected to the actual owned transport port.

## Performance regression guard

The initial joint-capture implementation increased the neutral 50-row toggle fixture from 56 Lua calls to 62. The failed measurement is retained separately. The owner identity and canonical work identity prevent an overlay cleanup from adding another six calls; current-source counts and timings require the separate full validation evidence. The 44 independent rows still execute because arbitrary original Lua can share VM state. This is not a claim that arbitrary Lua can be skipped safely or that a CPU-throttled page represents a physical mobile device.

## Explicit limits

Variable dictionary enumeration has no collection revision/phantom-read protocol yet. Pure display enumeration works, while a proposal relying on it explicitly requires that capability. The new tests also cover absent reads, override/deletion provenance, private inherited ledgers, command immutability, preview/confirmation, equivalent and different coalesced read sets, matching revisions and existing count/byte limits.

This does not implement persistent outer CBS setters, regex @@inject stable-message intents, scripted/plugin capabilities, arbitrary first-CBS callers without an explicit token, complete translation/DOM/checkImg/inlay ownership, larger-row optimization or the full configured/offline/mobile trial. All 15 original completion requirements remain. See local-validation.json for exact current-source validation and retained unchanged backend evidence. Production access/change, private-content inspection, deployment/restart and remote push were not performed.
