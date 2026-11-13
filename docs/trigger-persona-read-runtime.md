# Original trigger persona selection and resource lifetimes

The original v2 `Get Persona Description` effect reads the currently selected saved persona directly from DBState. This bypassed the existing selected-resource observation: a warmed native job could save its response after another device deleted or recreated that persona. This local follow-up binds that named expression to the existing lifetime guard. Public source and authored synthetic data are used; all15 [completion requirements](server-runtime-plan.md) remain active.

## Original behavior retained

The effect first evaluates `db.personaPrompt ?? ""`, then evaluates the selected row's `personaPrompt ?? ""`, and finally chooses the first truthy value. It uses the settings selection, independently of the chat's bound persona. A truthy current override does not skip the saved-row evaluation. Missing selection and missing saved prompt still yield the original empty-string fallback.

Only the selected-row expression now passes through `host.readResourceValue`. Browser hosts return the exact supplied object or `undefined`; native hosts use its registered identity to record the captured resource epoch and return the same reference. There is no new clone, Proxy, property traversal, array scan or getter evaluation in this observation. The existing WeakMap lookup and deduplicated guard are used. The extraction manifest reverses the identity port to the original expression; all169 selected declarations remain compared, with167 original algorithms and two previously declared Lua policies.

The six expression checks retain current/index/saved getter ordering and one saved getter evaluation, fallback/null/current override, exact selected object identity and a browser-style identity binding. Original CBS initialization independently observes the bound persona. That observation must remain alongside the trigger's selected persona. Request/display effect allowlists are unchanged; this does not newly permit this effect in display mode.

## Persistence contract

| Change during a captured job                             | Final result                                             |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Selected persona deleted                                 | `NOT_FOUND`; no canonical message/effect writes          |
| Selected persona deleted and recreated under the same ID | `REVISION_CONFLICT`; no canonical message/effect writes  |
| Same persona edited within its incarnation               | Captured configuration may finish; peer edit is retained |
| Unused persona recreated                                 | Job may finish; peer resource is retained                |

This uses the existing resource epoch guard in the owned final transaction and retained-result recovery. It adds no schema migration or command format. A failed complete result remains reviewable; preview and explicit recovery reject the same obsolete lifetime. No model or Lua invocation is automatically repeated. Resource epochs are separate from variable-read revision guards and per-write field CAS. Ordinary same-incarnation configuration changes keep their captured-snapshot policy.

## Actual reproduction and controls

Each native case creates a real synthetic SQLite database and loopback provider, warms the original generation path, then holds the next provider response while a peer command changes a resource. The chat is bound to personaA, while settings select personaB. The input trigger derives its value from B; the actual provider's description uses A through original `{{user}}`. With an empty current persona setting, the original generation gate omits the persona-prompt section; the fixture does not assume that bound prompt text is sent.

The corrected baseline on413b119 completes both obsolete selected-persona cases and adds two messages, while same-incarnation edit and unused replacement controls correctly finish. After the binding, six native cases cover selected deletion/recreation, output-effect recreation, truthy current-override recreation and both merge controls. The stale cases preserve the warm canonical messages and variables, retain the computed response and reject recovery with the matching code. Each case makes two synthetic provider requests, including warmup.

Removing only the new expression observation in a rebuilt native artifact makes all four stale cases save two obsolete messages again. Both merge controls still pass. The candidate source and entire native artifact directory are restored byte for byte in a `finally` block. This behavioral control is separate from structural extraction comparison.

A built original UI case logs in two independent Chromium contexts, sends through the original textarea and completes a warm response. The second browser deletes/recreates the selected persona through authenticated HTTP commands during the next response. Existing prefix row/body identity survives the peer change. Every tab closes before the provider is released; the native job still finishes with the lifetime conflict. Both reopened browsers show unchanged canonical IDs and inspect the retained reply, with recovery unavailable. No provider replay occurs.

Two initial fixture failures are retained honestly: the first provider assertion incorrectly assumed a bound prompt is sent when the current setting is empty; the first expression assertion incorrectly assumed original CBS never observes the bound persona. Both fixtures were corrected to their actual original behavior. Desired persistence/recovery assertions and product limits/timeouts were not weakened.

Validation and fingerprints are in [trigger-persona-read-validation.json](trigger-persona-read-validation.json), the enclosing `evidence/local-trigger-persona-20261004.json`, and `local-trigger-persona-*.log/json` evidence.

The selected serial browser run initially passes19 and fails the existing worker test's minimum2200ms ready-time assertion. The same failed test is rerun independently with unchanged source, artifact and assertions; both logs are retained. This is distinct from a completely green initial suite. The exact timing boundary cause is not established, and no product budget or test condition is relaxed.

## Local check and remaining scope

Use a new synthetic SQLite path for the [local trial](risu-browser-integration.md). Reproduce the selected path with:

```bash
pnpm build:native
node --test --test-name-pattern='native trigger persona lifetime:' server/native/generationWorker.test.cjs
pnpm exec vitest run src/ts/runtime/extensionRuntime.test.ts src/ts/runtime/resourceReadDependencies.test.ts
pnpm audit:engine
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/triggerPersonaUi.test.cjs
```

This closes one public engine expression, not arbitrary raw/copied DBState, whole-map/field/membership/order/absence dependencies or general plugin reads. In particular, adding a previously absent selected row is not recorded as a collection-absence dependency. Same-incarnation resource payload edits still use the captured configuration. Complete extension/import/export/retention/asset/storage contracts, physical mobile, representative latency/long tasks and all15 practical acceptance conditions remain required. No fresh speed measurement or universal stutter fix is claimed.

Production access, private prompt/story/chat/script/auth reads, real model requests, deployments and remote pushes are zero in this continuation. The earlier413b119 deployment is last-confirmed history; this local change is not deployed. Fresh candidate Node24 validation and the private card's actual Lua `gsub` cause remain unverified.
