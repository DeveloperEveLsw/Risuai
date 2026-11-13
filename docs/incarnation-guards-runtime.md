# Native read and bookkeeping incarnation guards

Follow-up: [native variable API read dependencies](variable-read-runtime.md) changes the earlier ordinary/local/global variable snapshot policy for observed API keys. Same-incarnation character/settings configuration continues using its captured snapshot; complete field/resource/collection dependencies remain unfinished.

An already initialized group member could be deleted and recreated under the same ID while a job used its captured definition. The job then committed another three messages against that obsolete member incarnation. An initial minimal-card fixture did not expose this: incidental normalization writes already failed their definition guards. Warming the member with one real native generation exposed the read-only case. The retained before-control reports a completed job and canonical history growing from three to six messages.

The first diagnosis suspected a change to the replacement member's activity. Additional recorded values showed its activity remained at25; that claim was corrected. The reproduced application defect is the stale member reference in the newly committed group batch. Separate SQL tests below cover bookkeeping namespaces directly.

## Persistence contract

Every current native context includes each loaded character's ID and captured entity epoch in `characterReads`. The final ownership-checked transaction validates that these characters still exist with the same incarnation before applying any writes. Deletion fails with `NOT_FOUND`; deletion/recreation fails with `REVISION_CONFLICT`. The worker preserves the already computed write set/result as an uncommitted result and does not repeat either provider request. No message, variable, counter or group activity from that result enters canonical state.

This guard deliberately checks entity lifetime rather than the entire definition revision. A job can finish using its admitted definition while another device renames the same character or changes an unrelated setting. The native positive control edits both the member name and username during a held request: peer edits survive, the provider uses the captured original name, the original three messages remain intact, the new turn commits and its original three-message statistics increment merges.

Native statistics and activity entries also carry their target's epoch. A statistics delta may merge concurrent counts within the same settings incarnation, and generated activity may merge timestamps within the same character incarnation. They cannot be redirected to a recreated settings/character row. Epoch validation happens even for an otherwise unchanged activity value; it precedes a no-op return. Explicit activity revisions can repeat after a character is recreated, so they alone cannot identify its lifetime.

Settings created after an earlier deletion use the captured deleted-resource revision as their epoch. No schema change is required: schema15 already retains entity deletion revisions. These guards use those existing tombstones. Current native hosts emit the metadata; older trusted internal write sets may omit it for compatibility. That legacy internal path is not proof that every possible writer now carries a complete read contract. Any future recovery of an older retained write set must reconstruct/review its guards before applying it.

## Validation

Three additional real-process group cases cover member deletion, deletion/recreation and ordinary member/settings edits after a real warmup generation. Invalid lifetime changes retain both computed responses, make no additional provider request and preserve canonical messages, variables, statistics and owner activity. The replacement member's activity stays intact. Three additional SQLite cases cover a generated statistics delta and generated/explicit activity after target recreation; each failure rolls back earlier messages, variables, journal entries and bookkeeping changes. Existing independent-chat merges now also include explicit epoch metadata.

Final gates: 431 application tests pass with three existing skips; 243 backend tests pass, including 15 native group and 12 bookkeeping cases; types report zero errors/warnings; native, entity-web and ordinary-web builds pass. Three actual browser cases pass sequentially: built group stream/reroll/process-kill/service-restart, original development member controls and built authenticated member controls. The existing 168-declaration audit still reports 166 original bodies and two prior Lua policies. The new guards are custom host/storage policy, not a changed upstream algorithm.

The native positive fixture initially omitted the user row from the original statistics increment, expecting two rather than three. The corrected assertion retains exact counter semantics. Before failures, the normalization-masked preliminary pass, source/log hashes and fresh gate accounting are in [incarnation-guards-validation.json](incarnation-guards-validation.json) and root `evidence/local-incarnation-guards-20261004.json` / `evidence/local-incarnation-guards-logs/`.

## Limits and local trial

This is an incarnation read guard for loaded characters, not a full per-field read-dependency system. Same-incarnation configuration changes retain the admitted snapshot policy. The original group path reads names of inactive members too, so deleting/recreating one can conservatively invalidate a job that loaded it. Character/resource resolution, large archives and group arrays still have their previously documented costs. Final validation adds small ID/epoch lookups proportional to loaded definitions; constant cost or universal zero stutter is not established.

Retained-output choose/copy/retry UI, browser-side variant caches, automode and empty/orphan-group acceptance, arbitrary extensions, physical mobile lifecycle and representative latency/long tasks remain required. In a disposable synthetic local DB, compare a name edit during generation with deletion/recreation of the same member: the former should merge; the latter should report a retained failed result while the old group history stays intact. Do not automatically retry an already computed result.

All 15 completion requirements and the active goal remain unchanged. This milestone used only public code, synthetic cards and a loopback provider. No production access, private-content read, deployment, remote push or real model call occurred.
