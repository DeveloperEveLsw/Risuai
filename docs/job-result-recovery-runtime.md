# Retained output inspection and atomic recovery

Subsequent follow-up: [explicit native retry](job-retry-runtime.md) now implements the previously reserved schema16 retry disposition and dialog action. The validation and unimplemented-retry statements below describe this recovery milestone's original scope; current retry behavior and remaining limits are documented in that follow-up.

Local follow-up to `a6908a9`. All 15 conditions in [the runtime plan](server-runtime-plan.md) remain required. Production was not accessed, queried, changed or pushed to. Only public code and authored synthetic data/providers were used.

## Behavior

- Background job reads now use `/jobs/:id/status`. They return bounded error fields, live progress when needed and a durable result disposition. Failed snapshots, settings, script bodies and terminal progress are excluded from these reads. The existing full job endpoint remains available to internal tools.
- The original UI offers **보존된 응답 확인** for unsuccessful jobs in the current chat's recent history. The dialog displays raw message text in readonly textareas; inspection executes neither HTML nor original display scripts. Partial interrupted output is explicitly identified.
- **전체 결과 복구** applies the stored complete write set without another generation/provider request. Messages, script variables, supported definition/settings changes and bookkeeping are one SQL transaction. The browser supplies the captured job/chat identity and review revision, never replacement writes.
- The original job failure/output remains immutable. Schema16 `job_result_actions` relates each source job to exactly one durable disposition request. Different request IDs from two devices cannot apply the effects twice. Same-request receipt replay remains durable after reopen.
- Preview temporarily applies the exact guarded write set under a savepoint and rolls it back, including journal entries, counters and revisions. Commit repeats the checks. A successful preview does not authorize overwriting later changes.
- Dialog targets stay captured across navigation. The durable browser outbox and confirmed event projection are used for submission. A rejected recovery remains a reviewable blocked command; the original retained output remains available.

## Guards and limits

Recovery requires a failed terminal job, the same chat incarnation, unchanged original content and any legacy metadata guard, no accepted queued/running same-chat job, and all original field/message/variable/read-incarnation/bookkeeping guards. Supported character/resource writes require field form and incarnation metadata. Legacy snapshots missing provenance, resource deletions, cancelled jobs and incomplete progress cannot be silently promoted to successful full transactions.

These checks do not establish every original field read dependency. Same-incarnation changes outside guarded writes still follow the pinned snapshot contract documented in [incarnation guards](incarnation-guards-runtime.md). Recovery persists calculated data; it cannot undo external effects already performed by a script/provider. It does not rerun those effects.

The UI currently lists up to the existing 50 recent jobs per chat. It offers copyable raw text for unsupported/conflicting output; explicit paid retry, reply-only salvage, job-history pagination and reply variants remain unfinished. The disposition relation reserves a retry action but no retry API/UI is implemented here.

Compact status reduces transfer/browser stringification. SQLite still parses stored JSON, and explicit preview takes a write transaction while testing the result. This is not constant-cost storage or representative mobile performance acceptance. Physical mobile, large histories, general extensions and the complete configured user trial remain required.

## Validation

See [machine-readable results](job-result-recovery-validation.json) and root `evidence/local-job-result-recovery-20261004.json` for source identity and retained logs.

| Check                          | Result                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL recovery tests             | 11: two DB workers, different request IDs, reopen/replay, rollback-only preview, content/variable/incarnation/busy/client-payload rejection, interrupted/legacy/malformed results and schema15→16 migration                                                       |
| Real native group save failure | SQLite trigger blocks final message INSERT after two provider replies. No canonical partial writes. Remove the trigger, recover the original three messages, regex/trigger/Lua variables and message statistics exactly once; total provider requests stay at two |
| Built authenticated browsers   | Two isolated contexts inspect raw output without executing it, concurrently recover one result, retain the source across original sidebar navigation, reject a later peer-variable conflict, retain copyable conflicted/partial output and survive reload         |
| Original group regression      | Streaming, tab exit, atomic reroll, actual process kill and full service restart remain covered. The assertion now accepts the new bounded `[code]` field between state and colon; canonical row identity/count checks remain unchanged                           |
| Full gates                     | Application433 pass/3 existing skips; backend255 pass; browser2 pass/0 skips; types0 errors/0 warnings; native/entity/ordinary web builds and original engine audit pass                                                                                          |

An initial synthetic deletion fixture omitted the required revision/epoch and second chat; it was corrected before passing. The first combined browser run used the prior literal `Job interrupted:` assertion and failed after adding the code label; its log is retained separately. Existing build and Node experimental warnings remain.

Schema16 is forward-only for this code. A previous schema15 executable rejects it. Any future rollback must restore a consistent pre-migration database snapshot together with its matching executable; changing only the source revision is insufficient. No production migration happened.

## Local trial

1. Build native and entity web, then run the existing local development service with a fresh synthetic database.
2. Select a synthetic failed job and open **보존된 응답 확인**. Raw text should remain selectable, and incomplete output should have no full-recovery button.
3. For a complete supported result whose persistence failure has cleared, choose **전체 결과 복구**. Another browser should receive the canonical messages/variables. Repeating the action must not repeat effects or provider calls.
4. If a peer edits a guarded value after preview, verify rejection, unchanged canonical data and retained raw output. Discard the blocked command through the existing status action before a different same-chat intent if needed.

This milestone does not complete the overall goal. Continue explicit retry/reply variants, remaining group and extension semantics, physical devices, representative latency/long tasks and the full 15-condition trial.
