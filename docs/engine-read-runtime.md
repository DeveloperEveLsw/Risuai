# Native engine expression reads and truthful schema metadata

Follow-up to [variable API read dependencies](variable-read-runtime.md). Original trigger conditions/effects and generation toggle metadata also access persistent variables directly. Three explicit expression ports now record those point reads before final persistence, without replacing the original calculation or wrapping the whole database in a Proxy. This is local development using public original sources and authored synthetic fixtures. All15 requirements in [the plan](server-runtime-plan.md) remain active.

## Original expression contract

| Port                                  | Original expression                   | Native observation                                                  |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `readGlobalVariable(key)`             | `DBState.db.globalChatVariables[key]` | Global key only; bypasses chat-local pins and preserves `undefined` |
| `readOptionalScriptState(state, key)` | `state?.[key]`                        | Admitted chat key, including absent/tombstoned values               |
| `readScriptState(state, key)`         | `state[key]`                          | Admitted chat key, including the setter's equality decision         |

Browser hosts evaluate the original expressions directly. Native hosts return the supplied trigger clone's value, rather than substituting current context state. This preserves `structuredClone`, scalar values, defaults, read-your-own-writes and private trigger ordering. Local temporary variables and display-only setters retain the original early returns. Display contexts do not create a persistent read tracker; serialized maps and final write-set comparison do not add observations.

The generation port covers the original `promptInfoInsideChat` toggle metadata. The two trigger ports cover inner `getVar` and the `setVar` equality check, including v1/v2 effects. The extraction manifests reverse those calls to their original expressions for structural comparison against the pinned original source. This structural audit alone is not proof of correct native binding; real native tests and independently removed binding observations provide that evidence.

The existing final transaction and retained-result recovery guards validate recorded revision/existence before any canonical writes. A peer edit to an observed key rejects stale derived output, retains computed results and preserves the peer's edit. There is no automatic model or Lua replay. Unread keys can still merge. Limits and captured configuration policies from the preceding variable API milestone remain unchanged. Dependencies are captured from the worker execution snapshot, not the earlier HTTP admission time.

## Failure reproduction and validation

Before the change, actual native/provider cases accepted stale results for a v1 condition, a no-op v1 assignment, an absent-variable default and global toggle metadata: four jobs completed and saved two messages each. The Lua API control was already rejected by the previous implementation; the unread-toggle control correctly completed. Both original baseline logs are retained.

Eight native cases now cover those six scenarios plus a v2 literal-to-lowercase assignment whose equality read has no preceding `getVar`, and a temporary local variable shadowing a peer-edited persistent name. Each uses exactly one loopback synthetic provider request. Stale cases retain output with `REVISION_CONFLICT` and save zero canonical messages/effects. The unread-toggle and temporary-local controls complete, preserving the peer's independent edit.

Removing only the observation from each of the three native ports independently makes the relevant actual test fail: the job incorrectly completes and saves stale messages. Restoring the exact source and native bundle restores the guards. Unit coverage also checks raw-global/pin distinction, optional absent values, private cloned scalar values and display isolation. The full gates and artifact hashes are recorded in [engine-read-validation.json](engine-read-validation.json); enclosing evidence is `evidence/local-engine-read-20261004.json` and `evidence/local-engine-read-logs/`.

## Schema metadata and readiness

The front `/_health` endpoint and synthetic backup restore report previously advertised schema14 while the actual store used schema20. Both now read the opened store's `schemaVersion()`. A closed database worker makes the front return HTTP503, `ready: false` and `STORE_UNAVAILABLE` with a correlated request ID; it does not report a stale schema number. The meaningful closed-worker test failed against the earlier HTTP200 response and passes with this change.

This uses schema20 without a migration. Health checks verify a responding database worker; they do not establish provider/scheduler readiness or bound a hung database call with a new timeout. The restore test uses authored synthetic backup data, not the user's production backup. These fixes do not change deployment or prove production readiness.

## Remaining scope and local trial

This covers the named engine expressions, not arbitrary raw `DBState` access, whole-map enumeration/replacement, complete field/resource/collection/membership read closure, general plugins or legacy write-set provenance. Same-incarnation character/settings snapshot policy remains as documented; representative latency/long-task and physical-mobile acceptance are unproven. Import/export/retention/total-storage budgets, asset fidelity, continuation/structural extension behavior and the full practical user trial remain in scope. All15 completion checkboxes are unchanged. No production access, private content read/import, deployment, push or real model request occurred.

Use a new synthetic SQLite path and the existing [isolated local launch](risu-browser-integration.md). For reproducible checks:

```bash
pnpm build:native
node --test --test-name-pattern='native raw variable read:' server/native/generationWorker.test.cjs
node --test server/runtime/production.test.cjs server/runtime/restoreBackup.test.cjs
pnpm exec vitest run src/ts/runtime/variableReadDependencies.test.ts
pnpm audit:engine
```

A normal-alert script that reports `Server capability is required: alertNormal` ran under a host without that capability binding. The [local server notification implementation](notification-runtime.md) already covers that call; this continuation does not deploy it to the hosted service.
