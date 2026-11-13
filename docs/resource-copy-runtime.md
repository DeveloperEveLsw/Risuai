# Resource identity across native copies and Lua value contracts

The native host previously bound safeStructuredClone to the ordinary intrinsic. An unselected copied resource then passed to readResourceValue was no longer recognized by the context's WeakMap. A synthetic SQLite finalization could persist a value derived from a deleted configuration row. This is a selector/copy boundary defect; it does not identify a defect in a private card or prove that every original caller reaches that boundary.

## Copy contract

cloneResourceValue still calls the ordinary structuredClone exactly once and returns its result. It associates copied resource records, known resource row arrays, and already admitted database snapshots with the context's existing captured identities. The native model/CBS/scripting/generation/preset clone ports use this binding. getDatabase with snapshot:true keeps its original JSON normalization and propagates the same row identities.

The metadata is context-local WeakMap/WeakSet state. It is not serialized, added to user payloads, inferred from an id string, or shared with another job. Copies alone do not record reads. A later explicit selector records only selected rows and retains the original reference. Row arrays are inspected only when registered as resource arrays; ordinary message/user arrays and arbitrary nested graphs are not recursively walked. Accessor descriptors are skipped instead of evaluating a getter again. The existing 4096 dependency limit and display prohibition remain.

This preserves the current captured-configuration policy: ordinary payload edits within one incarnation may merge; deletion rejects with NOT_FOUND and recreation under the same ID rejects with REVISION_CONFLICT. Separate write-field CAS and variable-read revisions remain unchanged. There is no schema migration or automatic model replay.

Eight added context cases cover copied records/arrays/admitted snapshots/repeated copies, selection without consuming copied unused rows, forged or modified IDs, getter count, unsupported graph boundaries, deletion rollback, recreation and same-incarnation edits. Snapshot cases admit only one character: this does not relax the existing cross-chat history/resolver barrier. The removal control disables only the copy metadata call in a Vite-loaded public context, verifies the loaded bytes and unchanged source, and restores stale derived persistence after deletion. The candidate rejects that save. This control makes no generation, browser or private-card diagnosis claim.

## Lua contracts and the reported gsub error

Six real native worker cases run the original Lua wrapper/listeners and a loopback synthetic provider. Input/output listener values are strings in these fixtures; editRequest gets an array represented as a Lua table. getChat returns a table containing the message data string, full/recent chat APIs return tables, and getState returns the JSON-defined value, including tables. Correct field extraction and gsub complete with one provider request. Calling gsub on a chat/state object or request array produces the reported nil-method wording.

Input and request failures make zero provider calls; an output failure occurs after one call. A later failing module rejects earlier character effects, and a button failure rejects earlier message/variable changes. Every failure preserves canonical baseline messages and variables. These checks do not establish a universal shape for every model/multimodal payload or recover a successful provider response from every later script error.

The user reported this error for “주식회사 넥서스v2.5” during message sending. Its private code and installation were not inspected. The exact responsible card/module, callback, variable and line remain unknown. The runtime wrapper contributes to the Lua chunk line number; Execution capability errors is a generic aggregation, not proof of a missing capability. The metadata copy fix does not convert Lua objects into strings and is not presented as a fix for that reported card.

## Validation and remaining work

See [resource-copy-validation.json](resource-copy-validation.json). Fresh local Node22.21.0 gates: application487 with3existing skips, backend360 without skips, serial browser13 (9original built UI and4display cases), types0errors/0warnings, native/entity/ordinary builds and169extraction checks (167original-preserved and2existing explicit policies). The existing source audit includes the original Lua wrapper/API algorithms but is not a behavioral equivalence proof for the whole browser host. Node24 was not freshly run for this candidate.

Initial logs are retained: the new Lua fixture omitted trigger conditions (1pass/5fail), then6passed after fixture correction; the first copy tests had2real missing-origin assertions,2snapshot admission failures and2missing proposed-method failures. After implementing the port, two snapshot tests still lacked single-character admission; corrected fixtures and all final gates passed. No production code or timeout was relaxed to hide those failures.

Raw property reads, plain structuredClone/JSON copies outside the bound ports, accessor-returned resources, arbitrary nested graphs, field/membership/order/absence dependencies and general plugins remain open. Copy provenance is not full read closure. Retention/import/export/assets/storage limits, physical mobile, latency/long tasks and user acceptance also remain open. All15[completion requirements](server-runtime-plan.md) stay active; prior performance numbers are historical, not remeasured here. Production/private reads, model calls, deployment and remote push are zero for this milestone.
