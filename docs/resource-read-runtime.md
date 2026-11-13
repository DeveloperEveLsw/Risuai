# Selected resource lifetimes and native preset chains

Follow-up: [original trigger persona selection](trigger-persona-read-runtime.md) closes a distinct raw selected-persona expression that differs from bound-persona prompt helpers. It retains eager getter/fallback semantics and captured same-incarnation policy; arbitrary raw/copied/field/collection closure remains unfinished.

Follow-up: [native resource copy provenance and Lua contracts](resource-copy-runtime.md) preserves selected row lifetimes through bound clone ports and admitted snapshots. Arbitrary raw/JSON/nested/field/collection read closure remains unfinished.

Selected modules, bound personas and presets can disappear or be recreated while a server job uses their captured definitions. Previously a warmed native job accepted obsolete module/persona results and appended two messages after such a peer change. Native `presetChain` also failed before its first provider request because `changeToPreset` had no server binding. This local follow-up fixes those cases using public original source and authored synthetic fixtures. All15 [completion requirements](server-runtime-plan.md) remain active.

## Resource lifetime contract

Native `resourceReads` carry only `{kind, id, expectedEpoch}`. Settings are part of every context using an existing settings row. Original resource selection returns the same object/array through a reversible identity expression port: module lookup records selected modules, persona helpers record the bound or selected persona, and preset capture/application records the active and selected preset. Membership scans do not mark every loaded resource as consumed. This avoids making deletion of an unused module invalidate generation.

The context resolves selected object identity through the existing resource WeakMap and deduplicates captured rows. It does not recursively traverse payloads, wrap full maps in Proxies or observe serialization. The synchronous selector returns its original reference, including `undefined`, so original cloning, cache, namespace deduplication and scalar behavior remain. Embedded persona modules are covered by their owning selected persona. Display hosts use an identity callback and persistent display contexts do not record reads. Persistent contexts permit4096 distinct resource identities; overflow fails visibly and poisons finalization rather than silently omitting guards.

The final ownership-checked transaction validates resource existence and lifetime before canonical changes. Deletion rejects with `NOT_FOUND`; deletion/recreation under the same stable ID rejects with `REVISION_CONFLICT`. A captured configuration may still merge ordinary payload edits within the same incarnation. Epoch guards are separate from per-write field CAS and variable-read revision guards. Selected resource values remain the worker's captured snapshot; adding/removing candidates, whole membership/order dependencies and full per-field reads are not claimed as closed.

Computed output remains in the failed job. Retained-result preview/recovery runs the same guard and cannot apply an obsolete resource result. Explicit fresh invocation remains available under the existing policy; there is no automatic model/Lua replay. Trusted legacy internal write sets without `resourceReads` keep their prior policy, so their acceptance does not prove provenance for old results. The validator rejects malformed/duplicate/extra-field/oversized records and routes global variables through their separate variable guard. Schema20 and its existing deletion epochs suffice; there is no migration.

## Original preset chain binding

The original `changeToPreset(id, savecurrent)` joins `saveCurrentPreset` and `setPreset` in the extracted preset runtime. The extraction audit compares the new declaration and reverses the identity observation expressions against pinned original source. Native generation now binds that original sequence before provider execution: capture the current settings, switch the numeric selection and apply the chosen preset. The original random selection and missing-name notice remain intact.

The native capture boundary retains the active preset's stable ID and unknown imported fields, matching the existing library capture adapter. This explicit storage adaptation is outside the original algorithm body. It avoids an identity removal and unknown metadata loss when original `saveCurrentPreset` replaces its array entry. The job persists captured preset/settings changes through the existing write-set and field CAS; cache invalidation follows the switch. Conflicting persistent fields can reject final persistence while retaining output; concurrent preset switches do not gain an exactly-once provider guarantee.

When the selected target is also the active preset, the original sequence captures current settings first. It therefore uses that freshly captured active definition; it does not force a stale separately saved prompt onto current settings. A preset application may introduce a default setting that appears in the next capture. The initial same-preset test wrongly assumed one warmup settles every such field; the corrected check retains peer name/prompt, metadata and epoch assertions while permitting original unrelated normalization additions. The failure log is preserved.

## Evidence and practical checks

The initial six real native cases independently reproduced three obsolete-resource saves and the missing preset binding, while same-incarnation module edits and unused-module replacement completed correctly. After adding preset lifetime and edit controls, eight native cases cover module deletion/recreation, bound-persona recreation, preset recreation, same-module/preset edits, unused-module replacement and actual chained generation. Warmed resource cases make exactly two loopback provider requests, including warmup; the distinct-target preset case makes one. No real model is called.

SQLite checks validate rollback/existence/epoch, same-incarnation merges, invalid contracts and legacy compatibility. Context tests check selected-only identity recording, untouched serialization, cloned values and display behavior. The built original UI fixture sends through the original textarea, observes both authenticated devices, checks unchanged prefix row/body identity after preset/settings commits, closes every tab during a second request and verifies canonical outputs/IDs after reopening. Existing native interaction, notice, group, choices and result/retry browser checks are rerun with the new bundle.

Two independent removal controls restore the defects: omitting final resource validation accepts the obsolete warmed module result; removing the native preset binding fails before any provider call. Candidate source and native bundle are restored byte for byte. Full counts, artifact fingerprints and gate logs are in [resource-read-validation.json](resource-read-validation.json), enclosing `evidence/local-resource-read-20261004.json` and `evidence/local-resource-read-logs/`.

Use a new synthetic SQLite file for the [local trial](risu-browser-integration.md). Reproducible checks:

```bash
pnpm build:native
node --test --test-name-pattern='native resource lifetime:|native preset chain' server/native/generationWorker.test.cjs
node --test server/entity/resourceReads.test.cjs
pnpm exec vitest run src/ts/runtime/resourceReadDependencies.test.ts
pnpm audit:engine
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/presetChainUi.test.cjs
```

Arbitrary raw `DBState` and cloned-resource provenance, whole-map/field/resource/collection/membership read closure, general plugins, retention/import/export/asset/storage budgets, continuation/structural extensions, physical mobile, representative latency/long-task measurement and whole user acceptance remain unfinished. Settings/character/resource configuration snapshot policies are retained within a live incarnation. Selection and snapshot loading still have their prior resource-array cost; constant-time responsiveness is unproven. All15 completion checkboxes are unchanged. No production access/private-content read/import, deployment, remote push or real model request occurred.
