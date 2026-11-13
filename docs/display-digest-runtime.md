# Bounded display SHA-256 reuse

The browser display owner reuses SHA-256 only for exactly equal input strings.
Code, raw source, presentation and scope strings still come from fresh captured
values. Receipt identities and server hashes have the same values and format.
Original Lua callbacks, global state, preparation order, current-owner checks,
read provenance, private effects and final admission remain in their existing
paths. This cache contains neither a Lua result nor a write proposal.

Each browser owner has a 2 MiB input/digest text budget and a 256-entry limit.
The text budget accounts for UTF-16 input plus the 64-character digest; it is not
a measured total JavaScript heap limit. Oversized inputs are calculated without
retention. Concurrent identical inputs share a pending digest, failed digests are
removed, and LRU eviction bounds retention. Closing the owner frees its entries;
late success/failure cannot repopulate it or remove a newer entry.
Replacing the browser SubtleCrypto object/digest method clears old entries so
an adapter change cannot inherit previous successes or mask a new error.

## Actual optimized UI observations

An authored fixture has 50 canonical messages, a greeting, a roughly 67 KiB Lua
script and original CBS/regex/Lua. Each timed send precedes server admission.
Four sequential executions use baseline/candidate/candidate/baseline order,
three independent browser contexts per condition. Draft entry and send-control
readiness precede the timed click. The observer reads only animation frames,
does not force layout and records actual display Worker execute/results.

| Per product/condition, n=6                    |  Baseline | Candidate |
| --------------------------------------------- | --------: | --------: |
| Desktop send to first visible text, median    |  178.75ms |  166.10ms |
| Page CPU4x send to first visible text, median |  778.30ms |  744.70ms |
| Desktop mounted row to first text, median     |  129.60ms |  129.80ms |
| Page CPU4x mounted row to first text, median  |  651.95ms |  633.30ms |
| Warm main-thread digest calls per send        |       255 |         4 |
| Warm digest input bytes per send              | 4,348,816 |    13,159 |
| Original Lua executions/results per send      |     51/51 |     51/51 |

Initial and final Lua global counters agree in every comparison. The same user
row ID receives original CBS, regex and Lua output; canonical messages stay at
50 and admitted jobs stay at zero, including after browser teardown. The fixture
explicitly closes its native scheduler and fails held requests before closing a
page, so it cannot start a model request. HTTPS in the browser is blocked.

First text is earlier in the final observations, but desktop blank-row duration
is essentially unchanged. Slow-page results across the earlier and final runs
are mixed and do not establish a reliable improvement. All observations and
comparison order remain in the evidence. This is a reduction of avoidable hash
work, not a solution to the whole display cost or the initial empty-body contract.
Page CPU4x does not establish Worker throttling or physical-phone behavior.
Large HTML, original stateful scripts, synchronous CBS, UI preparation, worker
waiting and representative physical/mobile acceptance remain open.

## Verification and earlier experiments

Five cache tests cover exact Unicode/JSON-like inputs, concurrency, UTF-16/count
budgets, eviction, oversize bypass, failed retries, late evicted failures, close
and replacement of the browser digest adapter.
A real original Lua test confirms repeated identical text still advances its
global counter, fresh variables/metadata remain observable, and changed code
starts its own lease. Final source gates pass 569 app tests (three existing skips), 13 actual
browser cases, type checking with zero errors/warnings, native/entity/ordinary
builds and the extraction audit: 169 comparisons, 164 original structures and
five existing explicit policies. The freshly rebuilt native bundle is byte-identical
to b8b9ac3; its previous 64 native/HTTP tests are explicitly reused, not fresh
backend or target-Node24 acceptance. Documentation-only metric updates follow
these gates and have a separate final format check.

Earlier observers forced layout from mutation callbacks and produced conflicting
timings; they are excluded from latency acceptance. One later baseline overlapped
the app suite and is also excluded. A light-observer baseline then failed because
the send button was absent; the cause of that transient state was not confirmed.
The final procedure checks actual control readiness and explicitly aborts held
requests at teardown, with the native scheduler stopped. Initial procedures did
not establish the model/admission boundary after teardown; their model-zero
labels are not accepted as proof of that whole lifecycle. Their logs and data are
preserved separately, without adding repeated cases to the final 24 observations.
A final comparison attempt timed out at CDP screen-metrics configuration before
its slow-page send. Its log and incomplete sequence are retained separately; the
same unchanged protocol was rerun with fresh output paths and original deadlines.
One new test fixture's undeclared metadata field caused a type error and was
corrected with an ordinary metadata assignment; final type results are separate.

Evidence outside the repository: scripts/observe_display_digests_ready.cjs,
scripts/verify_display_digest_measurements_accepted_retry.py,
evidence/display-digests-accepted-retry-{baseline-1,candidate-1,candidate-2,baseline-2}-20261005.json,
evidence/display-digests-accepted-retry-summary-20261005.json and
evidence/local-display-digests-20261005.json. These diagnostics use public source
and authored data. No production connection/deployment, private card/auth read
or remote push occurs. All 15 completion requirements remain unchanged and the
overall goal remains active.
