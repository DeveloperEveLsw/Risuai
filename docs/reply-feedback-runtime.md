# Reply selection feedback

The original response arrows now publish a reactive activity state before their first header read. A captured selection stays busy while its request is prepared, committed to the browser outbox, admitted by the server and projected locally. Native generation or button work on the same chat also makes its response arrows unavailable. Schema19, response-choice storage, provider-first selection and immutable reply-batch algorithms are unchanged.

This continuation uses public original source and authored synthetic data locally. No production access, private card/script inspection, deployment, push or real model invocation occurred. All 15 conditions in [the plan](server-runtime-plan.md) remain active; this is one verified interaction improvement.

## Interaction contract

| State | What the user sees | Repeated selection |
| --- | --- | --- |
| Preparing | Response choices are being checked | Disabled immediately, before the header response |
| Saving | Request is being saved locally | Disabled |
| Pending | Selection request is being sent | Disabled, including a lost HTTP receipt |
| Accepted | Selection is being applied locally | Disabled until its projection removes the outbox entry |
| Generation / button job | Generation is queued/running, or a chat action is running | Disabled for this chat |
| Blocked | Server rejection reason and a discard action beside the response arrows | Disabled until the durable rejected request is discarded |
| Header/local preparation error | Captured failure message | A fresh attempt is allowed |
| Idle | Original response arrows | Available |

One selection can be in flight per chat incarnation. Rapid clicks do not create a speculative queue of requests against an obsolete reply revision or trigger extra fallback model requests. The controller enforces this policy even when a caller bypasses the disabled arrow. A request UUID is captured before the header read and used for the durable command. The current canonical response stays visible until a confirmed change arrives; the client does not speculate about an output or move its index backwards on receipt loss.

Navigation never redirects the captured intent. Leaving a chat hides its status; returning derives it from that chat's draft, outbox and jobs. Another chat is independently usable. A recreated chat cannot inherit an old incarnation's activity or error. Pending, accepted and blocked command status survives reload through the existing IndexedDB outbox. Preparation before that transaction commits is transient and is not promised to survive tab termination. Closing the controller prevents a late header response from admitting a request.

The activity label belongs to the currently visible final response. Shared job events keep the arrows busy during actual server work. This does not create a new command-admission transport: the existing sequential HTTP receipt pump and configuration barriers still apply. Discard uses the existing durable-outbox cancellation contract; it is not cancellation of an already accepted model job.

## Evidence and limits

[reply-feedback-validation.json](reply-feedback-validation.json) records the current checks and source/artifact hashes. Raw logs are in `evidence/local-reply-feedback-logs/` in the enclosing workspace. Six activity tests cover preparation, durable admission/projection, rejection, fresh attempts, chat incarnations and native job state. The existing application suite and backend regressions are retained.

The actual built original UI runs in two independent authenticated Chromium contexts. Its synthetic fixture holds a response-header read and then the HTTP receipt, attempts twenty arrow clicks, checks the visible activity at a requestAnimationFrame callback, navigates away/back and verifies one header and one admitted command. It also checks shared canonical selection, unchanged response-row identity after selection, provider fallback, all-tab exit, lost-receipt replay and explicit adjacent discard after a peer conflict. General production UI, group generation, retained-result recovery, explicit retry and notification fixtures are rerun against the same built candidate.

A negative control substitutes the previously committed controller, builds into an isolated temporary directory and runs the same actual arrow fixture. It must fail because the initial arrow is not disabled. The candidate controller is restored byte-for-byte before the candidate fixture is run again. Control failures and restoration are retained as evidence.

The final six-fixture run passed with 447 application tests (three existing skips), 305 backend tests, zero type errors/warnings, native/entity/ordinary builds and 168 extraction declarations (166 original bodies and two prior explicit policies). Its first requestAnimationFrame observation was 1.7ms; the restored focused fixture observed 1.9ms. Both kept the old body visible and admitted one command for twenty attempted clicks.

These requestAnimationFrame observations are small loopback synthetic samples, not GPU paint timing, latency percentiles, physical mobile validation or proof that all 2–3 second stalls are removed. Representative card size, rendering long tasks, compatibility, complete read dependencies, interactive server alerts, continuation/structural variants, import/export fidelity and user trial remain required by the full goal.

## Isolated trial

Use a fresh absolute database path for authored synthetic data:

```bash
RISU_RUNTIME_DATABASE=/tmp/risu-reply-feedback-trial/entity.sqlite pnpm dev:entity
```

The local UI uses `http://127.0.0.1:5174` and its loopback API uses `6174`. Do not reuse a private or production database. With swipe arrows enabled and an authored assistant response, select a cached alternative or a synthetic-provider fallback, observe the adjacent status, try repeated clicks, navigate to another chat and return. Reopen another browser profile to check shared confirmed state. A rejected selection can be discarded beside its arrows.

The reproducible built fixture creates and removes its own synthetic DB, credentials, provider, browser contexts and service:

```bash
pnpm build:native
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_WORKER_BUILD_PATH="$PWD/dist" node --test server/browser/replyChoicesUi.test.cjs
```
