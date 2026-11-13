# Runtime failure diagnostics

Initial visits could display database errors that disappeared after reload. General HTTP/database failures were returned to the client without a retained server record, and browser runtime errors existed only in memory. The earlier user's incident remains unidentified; the subsequent fresh two-exchange chat did not reproduce it.

This change gives each front-door request a generated UUID, forwards that ID to the loopback runtime, and includes it in the response header and error body. Runtime HTTP errors and live SSE resets are correlated with a separate server metadata journal. The browser records HTTP failures, network/timeouts, stream resets and uncorrelated runtime UI failures; initial connection errors show the request ID. Explicit stop/navigation cancellation does not count as a network error.

| Location   | Contract                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server     | `<database>.diagnostics.jsonl` and `.1`, up to 1 MiB each; private `0600` files, at most 256 pending records, serialized asynchronous writes outside the entity worker/transaction |
| Browser    | `localStorage['risu-runtime-diagnostics:v1']`, latest 30 sanitized records, retained across reload; unavailable/full storage does not break the runtime                            |
| Fields     | Timestamp, fixed category, normalized endpoint template, method, allowlisted code, HTTP status, optional request UUID and server elapsed milliseconds                              |
| Exclusions | Error messages/stacks, SQL, request/response bodies, prompts, chat/character IDs, credentials/headers, query values, remote origin and arbitrary paths/codes                       |
| Health     | Dropped-record and write-failure counters report journal degradation without returning private content                                                                             |

Unknown codes become `RUNTIME_ERROR`; unknown paths become `unknown`. Request IDs are regenerated at the external front door instead of trusting a supplied correlation value. Loopback propagation accepts only a UUID. Browser HTTP failures tolerate HTML/empty gateway responses and retain status/correlation instead of replacing them with a JSON parser exception. Corrupted browser history is reset; old stored entries are sanitized when retained.

The journal is diagnostic evidence, not a command durability mechanism. It does not change DB schema, outbox admission, retries, generation ownership or original scripting behavior. Queued records can be lost during a hard kill or power loss, and bounded rotation discards older records. A network failure before a response may have no server request ID. Preexisting errors cannot be reconstructed by adding this feature. Browser history is device-local and is not automatically uploaded to the server.

Validation uses synthetic content: a thrown SQLite error at initial bootstrap, malformed JSON/auth failures, a live SSE database failure, normal stream closure, restart/rotation/permissions, overflow/storage failure, HTML gateway response, corrupted/full browser storage and explicit cancellation. The built UI test checks a first-entry error, visible request ID, matching server/browser records, reload recovery and retained metadata. Relevant transport, tab-exit, production UI, application, backend and type/build regressions are recorded in `docs/error-diagnostics-validation.json` when completed.

Continue remaining original editor/extension compatibility, conflict/recovery, user-card and physical-mobile checks. Final responsiveness polish follows core stability validation, using actual devices and input/long-task measurements. All 15 acceptance requirements remain in scope.
