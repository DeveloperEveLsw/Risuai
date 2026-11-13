# Immediate variable controls, local development

The original custom prompt/module/character toggle controls now show a local pending selection before waiting for HTTP admission. Confirmed DBState remains a separate server projection. This is an integration milestone; the full application trial and all fast-interaction requirements remain unfinished.

## Storage and command boundary

Schema v8 retains three independent scopes introduced in v6: ordinary `chat_variables`, per-chat global overrides in `chat_global_variables`, and shared `global-variable` resources. Keys retain their own revision and deletion revision. `GLGlobalVariables` remains available in the Risu-shaped snapshot/native context, but its canonical values live in separate rows. Metadata retains the optional map's presence, empty/null shape and unknown fields. Migration from v5 is transactional, preserves server identity/jobs/chat revisions, and rolls back on invalid legacy values. The v6-to-v7 migration initializes the new content and map-range guards while preserving variable revisions, running job progress, identity and journal cursor. No production migration was run.

`POST /api/runtime/commands` accepts a bounded `change-variables` command:

```json
{
  "requestId": "synthetic-request-id",
  "command": {
    "type": "change-variables",
    "after": [],
    "edits": [
      {
        "scope": "chat-global",
        "chatId": "synthetic-chat",
        "key": "toggle_example",
        "expectedRevision": 1,
        "remove": true
      },
      {
        "scope": "global",
        "key": "toggle_example",
        "expectedRevision": 2,
        "value": "1"
      }
    ]
  }
}
```

Unpinning and setting the shared value commit together. A stale revision or invalid edit rolls back the entire mutation, admission and journal. `scope: "chat"` addresses ordinary scriptstate keys including their original `$` prefix. Scalars and deletion are explicit; duplicate targets and self dependencies are invalid.

`after` lists already committed variable command IDs. An uncommitted predecessor yields transient `DEPENDENCY_PENDING`. Revision matching alone is insufficient: after a rejected parent, a child's expected revision can accidentally match another device's write. The predecessor prevents that child from silently replacing the remote value. Command retention must cover durable queue/head dependencies; pruning identities requires a separate coordinated policy.

`POST /api/runtime/variables/read` accepts `{targets: [...]}` and returns a consistent cursor plus only the requested keys, including absent/deleted revisions. Conflict resolution does not load message history.

## Variable confirmation during generation

`change-variables` commits ordinary and per-chat global edits while a native job is running in that same chat. Message/metadata edits retain the chat lock; the legacy `set-chat-variable` command retains its original lock contract. The database worker is separate from the generating engine worker.

The chat's full `revision` still advances on every chat-local change. Its separate `contentRevision` advances on messages and metadata, allowing modern native write sets to fence content without rejecting unrelated variable edits. The lightweight job claim records both guards. The engine acquires a consistent WAL snapshot after verifying ownership and content; variables confirmed between claim and that read are included. That snapshot supplies the job's baseline. Subsequent device changes do not alter the in-flight engine's view; the job's own effects remain visible inside its private context.

Modern native write sets include `expectedContentRevision` and separate changed/deleted local-global keys from ordinary metadata. Each changed key uses its own expected revision. Unchanged keys retain the server's latest value, and replacing other metadata preserves the current local-global marker. A same-key revision conflict rolls back all canonical engine effects, retains computed output as an uncommitted artifact, and does not repeat the provider call. Legacy final/write-set formats keep the coarse full-chat guard.

Removing the entire local-global map uses `chatGlobalRevision`, a range guard that also advances when its keys change. It prevents removal from silently hiding a newly confirmed key. Compatible object creation can merge independent keys; future snapshot/map revisions remain invalid. A shape-only event preserves empty/null/absent fidelity and its own projection cursor prevents an older snapshot from recreating a removed empty map.

## Browser behavior

- A synchronous draft supplies immediate selection feedback. Only a committed IndexedDB transaction permits network admission. Storage failure removes the draft, returns to confirmed display and reports an error.
- IndexedDB v2 adds durable per-key heads. Revision allocation, predecessor selection and command insertion occur in one transaction across tabs. Heads remain after projected entries are removed, so a tab with an older memory projection can allocate the next local revision. V1 upgrade preserves existing immutable entries.
- Pending values use a keyed reactive map. Confirmed DBState is never overwritten by pending selection. An accepted overlay remains until canonical projection covers its receipt.
- Rejected parents and causal descendants stop contributing overlays. Unrelated keys may continue. A generation depending on blocked chat/global variables waits for resolution.
- The actual status UI offers **서버 값 사용** and **내 변경 적용**. A narrow refresh precedes transactional removal/replacement of the dependent chain. Reapplying uses its latest per-key intent and a fresh request ID/revision. If a concurrent edit adds an unread target, resolution retries the read instead of discarding the intent. Another intervening remote write remains an explicit conflict.
- Original custom variable controls use an explicit command adapter. Browser display evaluation does not automatically become a persistent command producer; its legacy effects require a separate compatibility policy.

## Evidence and remaining limits

New entity tests exercise all scopes, atomic unpin/set rollback, tombstone recreation, causal predecessor protection, lean reads, native metadata writes and v5 migration/rollback. Risu projection tests cover local-key events/deletions racing older snapshots, own prototype-named keys and narrow refresh.

Disposable Chromium checks exercise shared-tab allocation, a durable head after outbox removal, independent keys during a conflict, latest-intent replacement and IndexedDB v1 upgrade. The full existing Risu UI scenario clicks its original toggle under synthetic command transport failure, queues three clicks, receives another device's selection, uses both conflict buttons, pins/unpins a per-chat value, and rolls back after browser storage closes. It also gates a third native provider call while a chat-local toggle confirms, verifies another independent browser sees that selection before generation finishes, and verifies final output preserves it. Existing HTML/native generation/unchanged DOM/all-tab-exit checks still pass. Navigation becomes ready only after read-model loading, job hydration and message presentation finish.

The current desktop feedback observation is recorded in `docs/local-validation.json`. This includes CDP observation, is one small fixture observation, and is not representative mobile latency, long-task analysis or a general no-stutter guarantee.

Six additional entity tests cover concurrent-key preservation, atomic overlap rollback, snapshot acquisition after claim, whole-map guards, legacy/future/content conflicts and schema-v6 migration. Two additional actual native-generation tests exercise pinned ordinary/local/global reads during a provider wait, independent output writes, and a same-key conflict with computed output retained and exactly one provider call. Application projection/context tests cover per-key diffs and map removal across stale snapshots.

This implements snapshot semantics and guards changed values; it is not a complete read/write-intent or collection dependency tracker for arbitrary scripts. Arbitrary HTML/Lua buttons continue through native jobs; their result cannot generally be predicted on click. Directly bound jailbreak/memory/local-toggle-mode settings and other editors still need entity commands. Changed HTML descendants, persistent display effects, full imports/exports/providers/mobile acceptance and the configured user trial remain in the full goal.
