# Durable server notifications

Follow-up: [script error notifications](script-error-notifications.md) adds native `alertError` delivery for Lua and error-alert trigger effects. The generation engine's fatal error policy remains separate. This avoids turning a setup validation notice into an unrecoverable failed job.

Follow-up: [durable server interactions](interaction-runtime.md) adds schema20 input/select/confirm answers and live-VM waiting. The unsupported interactive-alert policy below describes this earlier schema19 milestone.

Native Lua `alertNormal(id, text)` and original normal-alert trigger effects now deliver through an ownership-checked server notification queue. They no longer require a browser host or the user to acknowledge before generation continues. The original callback is synchronous and returns no user answer; its algorithm body is unchanged. Interactive `alertInput`, `alertSelect` and `alertConfirm` still fail explicitly until a durable interaction/resume protocol exists. Native `alertError` retains its existing fatal-error policy; `alertToast` retains its progress-notice policy.

This is local development using public original source and authored synthetic fixtures. No production access, private script/card inspection, external provider invocation, deployment or push occurred. All15 conditions in [the plan](server-runtime-plan.md) remain active and unproven as a whole.

## Persistence and delivery contract

Schema19 appends `job_notices`. Each row has a stable UUID, source job, admitted chat/epoch, per-job position, immutable text, revision and shared acknowledgement time. The ordered unread index supports bounded headers, a total unread count and an explicit single-body read. Bootstrap, SSE and list headers contain no notification text. Existing authentication and database-identity checks cover the HTTP endpoints and acknowledgement commands.

The native publisher validates synchronously, serializes individual calls and observes asynchronous database errors before final chat persistence. Publication requires the live owner/fence/lease, uncancelled job and original chat incarnation. Identical position/text retries are idempotent while the worker remains valid; changed payloads, gaps and obsolete workers reject without events. Limits are explicit failures: 64KiB UTF-8 per message, 128 messages and 1MiB total per job. The publisher never silently truncates or overwrites one notification with another.

Notifications are side effects with their own transactions, separate from the canonical write set. Already committed notifications survive a later script error, cancellation, worker kill, chat deletion and restart. Failed scripts do not save their intermediate chat/variable effects. A publication failure prevents successful final persistence; already computed output follows the existing retained-result inspection policy. A process killed before an outstanding publication commits can lose that unconfirmed notification. This does not promise exactly-once execution of a callback across uncertain worker failure, and the engine does not automatically rerun it.

The original UI shows the first unread message as escaped plain text in a nonblocking panel, with an unread count and an explicit confirmation button. This deliberately queues distinct calls rather than overwriting the original browser alert store; markup is displayed literally. A confirmation targets the captured notification ID/revision through the durable IndexedDB outbox. Concurrent confirmations produce one acknowledgement event. Replaying the same receipt cannot acknowledge the next message. Any authenticated connected device can acknowledge; every other device observes that shared state. All-tab exit and a pruned-journal bootstrap read the queue again independently of the selected character.

Only the first unread body is loaded. Older body/header responses are fenced by notification-view generation and observed cursor, so a peer confirmation cannot revive an obsolete popup. Failures remain visible with an explicit reload action. Notice events do not change display input clocks or perform the ordinary fields/groups/presentation refresh; they only release an already waiting display cursor when necessary. Notification command scopes do not share a chat/global conflict barrier. The generic browser command pump still has its existing HTTP receipt behavior; this does not add a new parallel-admission transport.

## Validation and limits

Evidence is recorded in [notification-validation.json](notification-validation.json) and `evidence/local-notice-logs/` in the enclosing workspace. Coverage includes original Lua/trigger generation, UTF-8/flood limits, ownership/cancellation, DB reopen/schema18 migration, auth/bounded reads, shared receipts, actual worker kill and an injected SQLite notification failure. A negative control removes the native normal-alert binding: the real Lua test fails; restoring the exact candidate bytes passes.

The actual built UI fixture uses independent authenticated Chromium contexts, the original HTML button and an awaited Lua callback. It closes all tabs while the job is running, reopens on the same origin after restart, displays retained text safely, confirms across peers, loses the HTTP receipt and replays the same durable command without consuming the next message. Prefix DOM identity is checked during acknowledgements. Initial fixture mistakes and old schema-number assertions are retained separately from the final passing evidence.

Notification retention/export, acknowledged-row pruning and a total archive storage budget remain unfinished. This milestone does not resolve interactive browser capabilities, general plugins, complete read dependencies, import/export fidelity, rapid repeated response-arrow feedback, physical mobile behavior or representative latency/long-task acceptance. Schema19 cannot be opened by an older runtime whose maximum schema is18; rollback requires a matching pre-migration DB snapshot.

## Isolated local trial

From this checkout, choose a new absolute `RISU_RUNTIME_DATABASE` path for synthetic data and run:

```bash
RISU_RUNTIME_DATABASE=/tmp/risu-notification-trial/entity.sqlite pnpm dev:entity
```

The local UI is `http://127.0.0.1:5174`, the API is loopback6174. Do not reuse a private or production database. Add an authored character with a normal-alert Lua button or trigger, use two browser profiles, close all tabs during its awaited work, and reopen to confirm retained delivery and shared confirmation. Automated reproducible coverage uses the built fixture:

```bash
pnpm build:native
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/noticesUi.test.cjs
```

The test creates and removes its own SQLite DB, credentials, server and browser contexts; it makes no model request. Native generation coverage uses loopback synthetic providers.
