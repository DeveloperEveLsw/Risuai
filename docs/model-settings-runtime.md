# Original model settings and native SupaMemory, local development

This milestone connects the original Risu model settings page to the entity runtime and adds the original SupaMemory algorithm to native workers. It does not complete the configured user trial or any of the 15 requirements by itself. Production was not accessed or modified; no production/private data was imported and no remote push occurred.

## Original UI and durable intents

The 97 original direct settings bindings in `BotSettings.svelte` now read the pending settings view and write explicit field intents. They include model/submodel selection, endpoints and credentials, request formats, provider-specific fields, sampling parameters, nested maps/arrays and the direct prompt fields. Sidebar/common data-driven controls retain their existing command paths. Other settings pages and embedded provider/prompt/memory editors still need integration.

`BrowserRuntimeController.setFields` captures every target/value and exposes one pending group before durable IndexedDB admission. Existing own revisions, entity epochs, causal predecessors, deduplication and conflict resolution apply to the group. A model selection includes its dependent resets in that same command. Clearing a NanoGPT key includes the key, subscription mode/status, request model/name and provider. Unchanged dependency targets remain in an effective group so their revisions are checked too.

Nested paths copy only the touched top-level field, retain unknown siblings and capture the caller value. A nested field remains one conflict unit: concurrent edits to different indices/keys inside it are not independently merged. Prepared fields avoid a second helper copy before controller admission. This is not full nested relational normalization or representative latency evidence.

Binding initialization, identical projection and display defaults do not originate storage writes. In entity mode, the page's legacy observer effects do not reset model settings when another device confirms changes. User actions perform those resets explicitly. The NanoGPT dashboard reports key-scoped availability into local UI state; asynchronous metadata responses never directly modify confirmed DBState. The ordinary browser mode retains its subscription-status persistence.

Legacy regex/order editors receive an isolated one-field draft because their nested bindings mutate references. The draft emits a captured field intent and reconciles confirmed/pending values without echoing remote hydration. This does not establish all nested editor interaction, popup, drag/order, offline reload or concurrent editing semantics. Preset icon writes target the actual preset resource; complete preset creation/order/import remains unfinished.

## Native SupaMemory

`createSupaMemoryRuntime` ports the complete original `supaMemory` function through explicit state/tokenizer/network/embedding/summarizer capabilities. `createStringlizeRuntime` ports all 12 original chat string functions, retaining browser entry points and supplying native private-state reads. The extraction audit verifies all 158 selected declarations after reversing the declared ports. It does not prove every provider or memory backend.

Native tests use real Tiktoken and an isolated synthetic HTTP provider. Overflowing history invokes the actual memory-model request route, includes the resulting summary in the final prompt and persists `supaMemoryData`/`lastMemory` while retaining all canonical history and unknown metadata. Request accounting includes summary calls. The actual browser scenario also generates after the original memory toggle has been enabled; it uses the endpoint/key/model entered through the UI and persists its fourth reply.

Under-budget SupaMemory retains the upstream token allowance. A legacy completion error remains an error. The native local DistilBART summarizer is still unavailable: its test verifies explicit failure before provider calls or canonical chat effects. Hyper retrieval, local embeddings, Hypa V2/V3, Hanurai and remaining providers/capabilities still require implementation/acceptance. No memory option was disabled to make the UI generation test pass.

## Verification

- 293 application tests pass with 3 skipped, 60 entity tests, 18 native worker tests, 12 HTTP tests and 18 reported browser tests pass: 401 reported passes, including the browser suite parent.
- Type checking has zero errors/warnings; native, entity-mode and ordinary-mode web builds pass. Existing runtime/build warnings remain.
- The real full Risu UI uses two independent disposable browser contexts. Model/endpoint/key/format controls synchronize, input remains pending while admission is unavailable, clearing a provider key submits six fields together, and a nested regex edit retains unknown siblings. Opening model settings and hydrating a remote editor update create no journal changes. A real textarea submission reaches and completes the newly configured native provider with the original memory option enabled.
- Earlier all-tab exit, native continuation, durable replay/conflicts, immediate controls and stable unchanged message/asset boundaries remain covered. Ordinary field confirmations still make zero full body/chat-list projection reads with large synthetic unused fields.

Logs, source fingerprints and the built native artifact are recorded in `local-validation.json`. These desktop synthetic tests do not establish physical-mobile behavior, representative card/archive latency, every memory/provider/backend, complete editor/CRUD/import/export/order, persistent display effects, complete read/write/collection dependencies or changed HTML descendant lifetimes.

Next: connect character/chat and resource management, remaining manual editors and import/export/order so the local application can be configured from an empty database and used for a practical trial. Preserve the remaining native/lifetime/variant, display/HTML, offline/authority, mobile/performance and trial/report requirements in `server-runtime-plan.md`.
