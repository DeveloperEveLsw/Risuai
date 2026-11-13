# Browser runtime transport and pending commands

The local runtime now has a browser transport with a real IndexedDB outbox and a pull-based SSE reader. It is not yet wired into Risu bootstrap, DBState, settings, HTML controls or the message components. The usable local Risu trial, UI/mobile acceptance and latency gates remain unfinished.

`src/ts/runtime/browserOutbox.ts` persists immutable request IDs, canonical command payloads and admission receipts in individual rows. An enqueue resolves after the read/write transaction completes, with the strict durability hint. Request success alone does not confirm the enclosing transaction committed. Failed storage prevents network admission; the transport never substitutes an in-memory-only queue. This follows the [IndexedDB transaction contract](https://w3c.github.io/IndexedDB/#transaction-lifecycle).

`src/ts/runtime/runtimeSyncClient.ts` separates transport from projection through `onBootstrap`, `onChange`, `onAccepted` and `onPending`. The future Risu adapter must supply these callbacks. `onPending` exposes pending/accepted/blocked operations for UI feedback and explicit errors, without putting provisional content into confirmed DBState. Storage completion, immediate visual feedback and server confirmation remain distinct states.

Each server database has a persisted UUID in schema v5. Every transport request sends the expected `Risu-Runtime-Id`; a mismatching database rejects the request before admission. Outbox storage is scoped by that UUID. The app integration must retain the expected identity across reloads and require reconciliation if an existing origin changes identity; blindly adopting a new bootstrap identity would hide the old pending queue. This identifies an authority, not a user: production authentication is still a separate release gate. Backup copying/rollback and intentional authority replacement need an explicit restore/import policy.

The client reads an initial bootstrap, awaits projection, then opens the feed from that bootstrap cursor. For each change it awaits successful projection before advancing its applied cursor. It owns reconnect positions rather than letting an EventSource receipt advance ahead of asynchronous projection. The [HTML SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) describes the event ID and dispatch rules used by the parser. The reader supports UTF-8 boundaries, CR/LF framing, comments, multiline data and inherited IDs, and bounds incomplete frames. The server's retry field is unused; client reconnection uses its own bounded backoff.

Projection callbacks must be idempotent and preserve per-entity revision/snapshot watermarks. The browser may fetch a newer character/resource/chat snapshot while replaying older events. A scoped adapter must reject stale events for that entity, preserve stable message objects/IDs and keep a separate pending layer. A partial snapshot must not silently erase unloaded history. Those DBState/DOM behaviors are not implemented by this transport and are not proved by the protocol harness.

Committed mutation receipts remain pending until their cursor has been projected. A dropped HTTP acknowledgement leaves the original ID/payload for retry. Revision/identity/payload failures remain blocked; later intent for the same chat waits, while another chat can progress. `CHAT_BUSY` and transport failures retain retryable intent. No automatic rebasing, new request ID or last-writer overwrite hides a conflict.

Jobs are acknowledged independently of observation. The terminal journal event removes a known job after successful projection; a projection restoring an already terminal job from fresh job/chat reads calls `acknowledgeJob`. Closing the client aborts observation/read requests and stops retry timers without issuing a server cancellation. The adapter must recover unknown active jobs on initial/new-device hydration and must expose interrupted output as a recoverable artifact, rather than a completed canonical reply.

Two tabs may share the same IndexedDB queue and submit the same command concurrently. Transactional immutable IDs and server admission deduplication preserve one execution; the client does not currently elect a tab leader. Cache persistence, offline startup, eviction recovery, disconnecting a specific account/authority and explicit conflict actions are still app integration work.

## Verification

Run on a host with a Chromium executable. The local default points to the already installed testing browser; `RISU_BROWSER_CHROMIUM` overrides it.

```sh
pnpm test:runtime-browser
```

The test bundles the actual transport/outbox into a small protocol harness, serves it through a loopback fixture, launches disposable Chromium profiles and uses temporary SQLite plus a synthetic streaming provider. It does not use private saves, real providers, installed scripts, production services or user browser profiles. All resources are closed and temporary files removed.

Eleven browser scenarios pass (12 Node test results including the parent): offline admission surviving tab destruction, discarded acknowledgement/deduplication, failed asynchronous projection/replay, bootstrap-to-feed handoff, pruned-history resnapshot, retained revision conflicts/independent chat progress, shared-tab immutable admission, native generation finishing after all observing tabs close and terminal recovery with matching output ID, replacement database rejection, storage failure preventing network admission, and closing during asynchronous hydration without a leaked retry timer.

Four additional unit tests verify stream parsing/cancellation/frame bounds and canonical JSON validation. A schema-v4-to-v5 migration test preserves running progress and revisions while assigning a stable identity. These tests do not prove the existing Risu UI, physical mobile browsers, arbitrary cards/providers/plugins, DOM/asset lifetime, import/export fidelity or responsiveness.

## Field intent extension, schema v8

Field commands use the shared transactional outbox with distinct per-field/incarnation head keys. Two additional actual Chromium scenarios verify shared-tab allocation, immutable caller-input capture, rejected causal chains, independent key progress, lost acknowledgements, retained heads, and old/new incarnation separation without deleting a newer pending intent. There are now 16 transport scenarios plus their parent; the separate actual Risu UI scenario covers original field controls and presentation rollback. See [entity-fields.md](entity-fields.md) and [risu-browser-integration.md](risu-browser-integration.md). These additions do not complete configured setup, all editors, physical-mobile or representative-performance acceptance.
