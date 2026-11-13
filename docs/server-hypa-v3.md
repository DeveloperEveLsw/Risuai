# Automatic HypaMemory V3 in native generation

The user reported `Server generation capability is required: hypaMemoryV3` after enabling HypaMemory V3. The previously deployed `1b5a168` binds the manual summary calculation but omits the automatic V3 entry point. The original generation branch therefore reaches the native host's missing-capability proxy. This is a confirmed implementation omission, distinct from the earlier generic display-Lua failure whose underlying cause remains unconfirmed.

`createHypaV3Runtime` now shares the original default and experimental V3 algorithms between browser and native generation. The public browser functions and data types remain available through thin wrappers. The native job binds this runtime after the original summary, preset, embedding and contextual-embedding adapters. Token correction, overflow batching, stable memo selection, orphan cleanup, recent/important/similar selection and serialization retain the original algorithms. The structural extraction audit compares these factories with the public upstream source; it introduces no additional policy exceptions.

API embeddings use the original `HypaProcesser` or `HypaProcessorV2`, including the original Voyage contextual document groups, independent query embeddings and rate limiter. Browser wrappers resolve their dependencies lazily, preserving original import-time behavior. Native adapters use the job's admitted settings and existing provider transport. The native derived embedding cache is private to a job; it neither replaces canonical chat state nor persists across jobs. Repeated embedding cost between jobs remains an optimization opportunity.

Automatic summaries and the final reply enter the existing durable generation transaction. Same-chat ordering, independent chats, idempotent admission, leases, fences, cancellation and provider-output retention remain in force. A configuration update within the same incarnation does not restart a paid request: generation uses its admitted snapshot while preserving the peer's newer settings. Resource deletion/recreation remains guarded by the existing incarnation contract. A peer change to the written `hypaV3Data` field instead rejects completion with `REVISION_CONFLICT`, preserves already received provider output, and leaves the peer's memory and canonical history intact. No automatic provider replay is added. Cancellation and embedding-provider failure submit no partial canonical effects.

This differs from the manual [summary preview API](server-hypa-summary.md), whose calculation applies a conservative resource-revision guard. Its durable preview/apply/dismiss API remains separate. The original V3 summary/category/tag/merge/re-summary modal and durable result re-opening UI still need to be connected to those APIs. Summary data remains a chat-field aggregate; item-level relational storage and item-level merging are not claimed.

Validation uses synthetic fixtures and fake provider responses only:

- Runtime units exercise both implementations, overflow, empty memory, ranking, orphan handling, contextual grouping and independent host configuration.
- Composed native jobs exercise both implementations with custom, OpenAI small and Voyage contextual embedding transport; no external request is made.
- HTTP jobs exercise actual native tokenization and loopback summary/embedding endpoints, restart persistence, idempotency, provider failure, peer edits and cancellation.
- The original UI is exercised on desktop and two emulated mobile layouts. Both tabs close while a summary request is pending; the server finishes, then two independent contexts reload the persisted summary and final reply.

Run from the repository root:

```sh
pnpm build:native
pnpm check
pnpm test
node --test --test-concurrency=1 server/native/hypaV3Bindings.test.cjs server/runtime/hypaV3Generation.test.cjs
node --test --test-concurrency=1 server/browser/hypaV3GenerationUi.test.cjs
pnpm audit:engine
```

The browser tests start an isolated original UI with authored data and a loopback provider. They do not use the user's browser profile or saved cards. The general [local UI trial](local-user-trial.md) remains available, but it disables memory by default; it is not a configured interactive V3 trial. Turning on V3 with an ordinary real-provider configuration can make billable summary/embedding calls. No such calls were used for this checkpoint.

Native CPU/WASM/WebGPU local embedding models still require an unimplemented `runEmbedding` capability, and WebLLM/WebGPU local summary models fail explicitly. API embedding transport verification does not establish compatibility with every model/provider. The original memory-progress event is emitted but is not yet wired into the durable queue UI. Physical phones, actual user acceptance, representative performance and the remaining original fifteen completion requirements are still open. TTS follows the user's explicit exclusion. This checkpoint is local only; it does not update the hosted release or prove that the earlier display-Lua issue is fixed.
