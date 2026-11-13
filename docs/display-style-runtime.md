# Display CSS and presentation finalization

The entity original UI now finalizes a display invocation before admitting its Lua variable proposal. CSS decoding and sanitizer hooks use the scope captured before the first asynchronous asset lookup. This extends the previous outer-CBS/Lua boundary; it does not complete the joint persistent-extension contract or the full configured trial.

## Reproduced failure

A neutral 110-message chat initially loads the last 100 rows. Its original Lua listener proposes a variable and returns an opaque CSS block containing the original history macro. Previously the default ChatBody `notrim` route admitted Lua before its later `trimMarkdown` call. CSS decoding used live DBState without the partial-history guard, silently treated 100 loaded messages as complete history and persisted the preceding proposal at revision 1.

The negative original-UI/Worker/IDB/SQLite observation is retained separately in the workspace evidence. No application content, installed scripts or production data was used.

## Responsibility and lifetime

- `ParseMarkdown` still returns a string and preserves the original first five arguments. Actual entity ChatBody calls also provide a per-invocation presentation token. Its finalizer carries the captured CSS/sanitizer context and deferred Lua proposal.
- CSS runs the original CBS parser with its original default row argument (-1), using captured definitions, variables, history and settings. Attempting to enumerate unloaded history records a sticky capability failure. A CSS error fallback cannot turn that failure into permission to save Lua effects.
- ChatBody checks that the invocation still owns the screen, performs final sanitization/CSS decoding, checks capability failure and then admits the proposal through the existing durable controller. Cancellation before finalization does not admit it. Cancellation after durable admission cannot undo that command.
- Quote formatting, inlay image visibility, asset nearest-match limits and sanitizer image/background hooks receive the captured settings. The DOMPurify hook binding is synchronous and restored with `finally`; it is never held across an asset, translation or worker await.
- A pre-sanitized unchanged result is reused, avoiding another sanitizer pass over decoded CSS. The raw-return public route validates its final CSS before admission while preserving its string API; a later unrelated unscoped sanitizer call cannot automatically inherit that context.
- The previous DOM remains while a confirmed projection is fenced. Existing stable message identities, bounded Worker execution, Lua occurrence identity, durable IDB admission and server CAS remain.

## Actual regression observations

The new browser fixture uses the original UI/controller/parser, real Lua Worker, actual IDB/API/SQLite and a neutral authored card. It verifies:

1. Partial 100/110 history explicitly fails at CSS decoding and saves no Lua variable.
2. Loading all 110 messages recovers the real original UI, includes the first message in scoped CSS and saves the occurrence once at revision 1.
3. A cancelled presentation token saves nothing; the same prepared token finalized by its current owner saves once, and repetition keeps revision 1.
4. A real uploaded asset URL is delayed while confirmed server variable and image/quote settings change. The prepared output retains its earlier CSS variable, quote markers, image and background policy. A subsequent ordinary unscoped sanitizer uses the new settings, proving the scoped hook binding was restored.

Ordinary display CBS setters retain upstream `rmVar`/`runVar` behavior, and ordinary display trigger variables remain temporary. This change does not enable persistent normal CBS setters. An actual regex `@@inject` message mutation still requires an explicit stable-message intent and conflict policy.

## Remaining boundaries

CSS and outer-CBS read dependencies still need to join the Lua command's read/CAS provenance; input-clock fencing alone does not cover every derived-variable race. Pending optimistic edits need an explicit policy. Translation, DOM descendants, `checkImg`, inlay ownership and side effects, complete history hydration, other extension capabilities, larger scopes/markup and practical mobile/offline/configured trial remain unfinished. Current synthetic desktop/emulation observations cannot establish physical-mobile lifecycle or a universal zero-stutter guarantee. All 15 original completion requirements remain in scope.

See `local-validation.json` for exact current-source checks and retained backend evidence, and `server-runtime-plan.md` for the full goal. Production access/change, private-content inspection, deployment, service restart and remote push were not performed.
