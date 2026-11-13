# Durable server interactions

Original Lua and trigger input/select/confirm calls now await a durable server interaction while their live native execution remains suspended. Any authenticated device can answer the captured interaction. Closing every browser tab does not cancel the VM or erase the question. The server resumes that same execution after accepting one answer; it never rebuilds a lost Lua call stack by replaying scripts, providers or earlier side effects.

This continuation is local development with public original source and authored synthetic fixtures. No production access, private card/script inspection, deployment, remote push or real model invocation occurred. All 15 requirements in [the plan](server-runtime-plan.md) remain active and unproven as a whole.

## Original values and explicit policies

| Original callback | Server value delivered to the awaiting call |
| --- | --- |
| `alertInput` | A string, including the empty string; default value and datalist are retained where the original caller supplies them |
| `alertSelect` | The selected zero-based index as a string; equal option labels remain distinct positions |
| `alertConfirm` | Boolean `true` or `false`; rejecting confirmation is an answer, separate from cancelling the job |
| Normal alerts | The previously implemented nonblocking notification queue |

Select presentation retains the original `alert.ts` / `AlertComp` serialization: `||` joins/splits choices and `__DISPLAY__` encodes an optional display heading. It does not silently switch the return value to an option's label. Original Lua/trigger algorithm bodies are unchanged. Lua must use its original asynchronous wrapper and `:await()` for an interactive answer. An unawaited or concurrent interactive call fails explicitly, blocks subsequent external side effects and prevents partial final persistence. A computed result from an unfinished interaction is not offered as a complete recoverable output. Awaited delivery errors poison the execution context even when script code catches the error.

The original UI shows escaped plain text, input suggestions, separate indexed option buttons and yes/no confirmation. A captured request is immediately marked as saving and its durable outbox entry keeps controls busy after reload or a lost receipt. The job-stop action is itself a durable command tied to the interaction ID/revision, so navigation cannot redirect it to the currently selected chat. A losing peer answer remains available for review/discard through the existing pending-command UI. A later question does not inherit an older question's input draft or error.

## Persistence and ownership

Schema20 adds `job_interactions`. Rows have a stable ID, source job/chat/incarnation, owner/fence, ordered per-job position, immutable descriptor, revision and pending/answered/closed state. Header pages and change events include no prompt, options, answer or worker ownership. Only the first pending descriptor is read by the browser; old header/body responses are fenced by view generation and observed cursor. Bootstrap reloads the global queue independently of selected character or pruned journal history.

Publication validates live ownership, lease, cancellation and chat incarnation. Identical position/descriptor retries are idempotent while owned; changed reuse and gaps fail. One unresolved call per job is enforced in both host and SQLite. The first typed answer changes revision1 to2 in one transaction. A different peer answer fails; a same-value repeat adds no event. Request-ID receipts remain replayable after the job ends and cannot answer or cancel the next question. A captured cancellation atomically flags the owned job and closes its pending question; an already answered question cannot cancel subsequent work.

Pending questions close on cancellation, failure, reported process interruption or lease expiration. Successful finalization cannot leave an unanswered question. The live host rechecks ownership/cancellation after receiving permission to resume. Interactive events do not advance display input clocks or invoke the normal fields/groups/message refresh. They only release an already waiting display cursor when necessary. This preserves unrelated message DOM and avoids rerunning display scripts for question/answer bookkeeping.

SQLite transactions never remain open while waiting for a human. Waiting VMs keep their lease and memory but release the supervisor's active execution slot. Answered VMs request a resume permit before executing more Lua; permits share the configured native concurrency limit and take precedence over starting another process. Total live native processes are bounded by `concurrency + interactionCapacity`. Defaults are2 active slots and8 additional waiting slots; native concurrency accepts1–8 and interaction capacity1–32. At that finite capacity, new jobs remain queued; answering an existing VM still permits it to resume. This is a process-count budget, not a measured/reserved RAM budget.

## Failure and limits

Descriptors are limited to64KiB of serialized UTF-8,128 choices/suggestions,128 calls and1MiB of descriptors per job. Input answers are limited to64KiB UTF-8. Limits fail visibly; neither descriptor nor answer is silently truncated. Answered/closed history, response-text storage and a total archive storage budget still require retention/export work.

The question/answer rows survive DB reopen. The Lua VM/call stack is not serialized. A graceful service restart or observed worker death marks execution interrupted and closes unresolved questions; abrupt supervisor loss can leave the row pending until ownership loss is detected or the lease expires. There is no transparent continuation of a destroyed VM and no automatic script/model replay. An answer already stored before a process dies remains recorded, but it does not establish that later canonical writes completed. Partial Lua chat/variable changes are rejected on failure/cancellation. Previously committed normal notifications retain their separate side-effect policy.

The existing sequential HTTP receipt pump and configuration barriers remain. A pending HTTP response can delay subsequent commands from that browser; this work does not add parallel admission. General plugins, remaining browser capabilities, complete read dependencies, continuation/structural variants, full import/export fidelity, storage/retention, physical mobile behavior and representative latency/long-task acceptance remain part of the full goal.

## Verification and isolated trial

[interaction-validation.json](interaction-validation.json) and `evidence/local-interaction-logs/` in the enclosing workspace retain checks, initial failures, control results and artifact/source hashes. Coverage includes actual awaited original Lua values, peer CAS/idempotency, bounded metadata, schema19 migration, authentication, cancellation, live-VM tab exit, actual process kill, injected SQLite publication failure, native slot release/resume/capacity and stable original UI rows. Missing-capability and display-clock negative controls must fail before candidate restoration passes.

Use a new absolute database path for authored synthetic data:

```bash
RISU_RUNTIME_DATABASE=/tmp/risu-interaction-trial/entity.sqlite pnpm dev:entity
```

The UI is `http://127.0.0.1:5174`, its API uses loopback6174. Do not reuse a private or production DB. Open two browser profiles, invoke an authored asynchronous Lua button with input/select/confirm, close both tabs while it waits and reopen. Answer from either profile or stop the captured job while viewing another character. For a service restart, expect interruption rather than Lua reconstruction.

The reproducible built fixture creates and removes its own SQLite DB, credentials, service and authenticated browser contexts:

```bash
pnpm build:native
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/interactionsUi.test.cjs
```

Schema20 cannot be opened by a runtime whose maximum schema is19. Rollback requires the matching pre-migration DB snapshot as well as the prior source release.
