# Native variable API read dependencies

Follow-up: [native expression reads and schema metadata](engine-read-runtime.md) also observes original trigger clone/equality reads and generation toggle metadata. Complete arbitrary raw/map/field/resource/collection closure remains unfinished. The schema metadata discrepancy recorded below describes the earlier milestone and is corrected by that follow-up.

An original Lua button could read variable A, wait for a human answer, and store B computed from A after another device confirmed a different A. All five controlled stale-read cases completed with one obsolete message and derived variable at the previous release. Existing per-write CAS protects a changed B but cannot detect an unchanged, read-only A. The new native point-read contract rejects that final transaction, preserves the already computed result and does not repeat scripts or provider calls.

This changes the earlier native variable snapshot policy: observed ordinary/local/global variable dependencies must still match at final persistence. Same-incarnation character/settings configuration retains its existing captured-snapshot policy, and unrelated variable keys still merge. This is a host/storage policy; original CBS, Lua, trigger and variable algorithm bodies remain unchanged.

This work uses local public source and authored synthetic fixtures only. No production access/query/change/deployment, remote push, private content inspection/import or real model request occurred. The 15 original [plan requirements](server-runtime-plan.md) remain unchanged and active; complete read closure and the whole goal are not established by this milestone.

## Observed point reads and final transaction

Native contexts record the original bound variable APIs: `getChatVar`, `getGLChatVar`, `getGlobalChatVar`, setters' relevant equality/pin observations, and local-pin check/removal. Each unique dependency includes only namespace, key, captured revision and presence. It contains no variable value. Chat and chat-global dependencies are implicitly bound to the job's chat; a record cannot redirect them to another chat. Global dependencies use the existing resource deletion revision. Revision and presence are checked before any canonical message, metadata, variable, resource or bookkeeping final write.

The captured state is the consistent engine execution snapshot, rather than the earlier HTTP enqueue timestamp. Missing keys and tombstones are dependencies too. A missing ordinary value that used character defaults becomes stale if another device creates that value. A deleted/recreated key fails even if its new value equals the captured value. `null` is a present row distinct from an absent row. Read-your-own-writes retain the original snapshot revision and remain valid when final writes apply atomically after validation.

Original global precedence is preserved. A truthy local pin other than literal `"null"` avoids a global dependency; an absent, empty, false, zero, null or literal-null pin uses the global fallback. Both the observed pin and actual fallback must remain valid. An unrelated global edit therefore cannot reject a truthy-pinned read. Same strings/boolean results remain delivered to Lua.

Each job permits 4096 distinct point reads; repeats are deduplicated. Keys use the existing nonempty/256-character storage identity rule. Invalid reads or overflow fail visibly and poison persistent finalization even if script code catches the exception. Records never silently truncate. The tracker is created lazily for the first persistent API observation; browser display mode never creates it. The dedicated SQLite worker does bounded per-key lookups; this is not a representative latency/RAM benchmark.

Retained-result inspection and recovery reuse the same final-write validation in a rollback-only preview or atomic commit. A stale read makes recovery unavailable while raw computed output remains inspectable/copyable. An explicit fresh invocation runs against a new snapshot; the old invocation is not automatically repeated. Old trusted internal write sets lacking `variableReads` retain their prior compatibility policy, so their acceptance is not evidence of this provenance contract.

## Verification

| Evidence | Result |
| --- | --- |
| Actual native Lua before change | Five stale ordinary/global/pin/default cases incorrectly completed; two unaffected controls completed |
| Actual native Lua after change | All seven pass: stale cases retain failed output without canonical derived effects, truthy-pin/unread-key controls complete |
| Original provider/CBS/output Lua | A held synthetic request is issued once; peer variable changes preserve their values, computed response is retained, no partial input/output/effect is saved |
| SQLite tests | Five tests cover three namespaces, absent/deleted/null/equal-value ABA, unrelated merges, malformed/redirected/duplicate/over-budget metadata and stale retained recovery |
| Unit tests | Six cover provenance, fallback/truthiness, own writes, repeat diff isolation, limits and sticky errors |
| Built two-browser UI | Authenticated peer edit during original HTML/Lua wait, failed history and raw retained response, unavailable stale recovery, explicit fresh invocation, both devices' canonical output, same button and owning row |
| Final gates | App460 + existing skip3; backend333; built UI8; types0 errors/warnings; native/entity/ordinary builds; selected declaration audit168=166 original+2 previous policies |
| Negative control | Remove final read validation: the real global-read job completes and stores obsolete output; restore exact candidate bytes: the same check passes |

[variable-read-validation.json](variable-read-validation.json) and enclosing workspace `evidence/local-variable-read-logs/` retain source/artifact/log hashes and failures. The initial native fixture used the wrong shape of the `readVariables` response; the corrected before run independently demonstrates five application failures and two positive controls. The old generation test intentionally expected variable-snapshot completion and now checks the explicit policy change, preserving its one-provider-call check. Initial UI assertions selected the first row even though the original layout places a newer response first: diagnostics proved the old button and old row remained connected; the final check targets the button's own row instead of weakening the DOM lifetime requirement.

## Limits and isolated trial

This covers the declared variable API boundary. Arbitrary direct reads of raw `DBState`, whole-variable-map enumeration/replacement and future general plugin hosts still require provenance/collection tracking. Do not treat those paths, complete field/resource/membership dependencies or every possible legacy writer as validated. Configuration snapshot policy and entity incarnation guards remain separate; complete resource lifetime/read closure, continuation/structural variants, retention/import/export/storage budgets, physical mobile and representative latency/long-task/user acceptance remain required. The local front health response was also found to still hardcode schema14 while the actual DB is schema20; correcting that metadata is a tracked next action, not a DB migration.

Use a new absolute synthetic database path with `RISU_RUNTIME_DATABASE=/tmp/risu-variable-read-trial/entity.sqlite pnpm dev:entity`. In two authenticated profiles, invoke an authored async Lua HTML button that reads a variable then awaits input. Change that observed variable from the other profile before answering. Expect a retained failed result with `REVISION_CONFLICT`; an unread-key edit should allow completion. Start a new invocation to use the new value. Never reuse or import a private/production DB for this check.

Reproduce the built isolated fixture:

```bash
pnpm build:native
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/variableReadsUi.test.cjs
```

There is no schema migration in this milestone (schema20). The previous schema20 rollback rule still requires the matching pre-migration DB snapshot when returning to a schema19 runtime.
