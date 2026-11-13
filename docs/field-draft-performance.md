# Per-field character, lore and script draft encoders

The subsequent [TTS/clock follow-up](server-character-tts-editors.md) found stale
peer aggregates in an optimized UI trial. Current incoming encoders also observe
their field's confirmed revision/epoch, preserving refresh when object identity is
reused. Equal field clocks keep unrelated progress from encoding long fields. The
new six-edit diagnostic encodes only the nickname four times and zero unchanged
long fields; its instrumented timings are excluded. The paired timings and two-call
count below are historical `8f31f6d` results, not measurements of the clock follow-up.

`RuntimeObjectFields` retains one reactive incoming encoder and one draft encoder
for each captured field. A cheap source-value derived read separates a rebuilt
projection record from canonical JSON calculation. Equal primitive values do not
re-encode; editing a nested proxy still invalidates its field's encoder. Flush,
incoming/clock reconciliation, imports and removal confirmations reuse those
current encodings. This does not cache old revisions or observe arbitrary DBState
writes. Each open component owns the encodings until destruction.

Stable character/chat owners, independently captured revision/epoch headers,
atomic multi-field commands and detached JSON values remain. Capture commit
still obtains fresh authoritative clocks even if an encoding is equal, so an
external A→B→A edit cannot pass a stale import or confirmation. Different-field
concurrency, same-field conflict and all-tab/offline replay remain covered by
the original browser tests.

The advanced definition controls also accept absent text/array/metadata fields.
Opening an editor displays empty/default controls without creating stored fields.
An explicit creator/version edit creates `additionalData`; an explicit depth
edit creates both original depth-prompt members. Existing unknown members remain.
The minimal synthetic trial omitted those nested objects and previously failed
when opening advanced settings; the previous fuller fixture did not expose this.

The actual original-UI diagnostic uses six authored long text fields, each
131072 characters, and edits only the short nickname. Six warm edits each encode
the unchanged long fields 66 times with the original wrapper, versus zero with
the per-field wrapper. Total wrapper calls are 231→2 and encoded characters are
8652171→58 per edit. Both roles include the same absent-field control fix and
send exactly one nickname edit, retaining the other fields. These instrumented
counts identify removed work; their timings are not speedup evidence.

The uninstrumented comparison uses two optimized entity builds differing only
in `RuntimeObjectFields.svelte`: the original wrapper from2585a40 and the current
wrapper, both with the same optional-field fix. The unchanged helper exercises
the visible nickname input, observes animation-frame callbacks and long tasks,
and confirms actual server commands. Sizes128 and131072 characters per field
are measured in forward and reversed role order, six warm edits per role at
pageCPU1× and4×. One warm-up per condition is excluded. No provider requests are
sent. PageCPU throttling does not emulate a physical phone or throttle Workers.
The first-frame metric is a scheduling opportunity, not proof of painted text.
The observation window includes an intentional 120ms settlement wait and is not
a send or database-commit latency. See the local report and paired raw evidence.

All eight executions completed: 96 warm observations in sixteen conditions.
Median input-to-first-frame opportunity, original→candidate (milliseconds):

| Characters per field | Page CPU | Forward order | Reversed order |
| -------------------- | -------- | ------------- | -------------- |
| 128                  | 1×       | 0.80→0.70     | 0.70→0.80      |
| 128                  | 4×       | 3.40→3.00     | 3.00→3.15      |
| 131072               | 1×       | 5.25→1.00     | 5.05→1.00      |
| 131072               | 4×       | 20.80→4.20    | 23.20→3.75     |

Large-field pageCPU4× median maximum frame gaps are34.05→18.85ms forward and
33.25→23.10ms reversed. Neither role produces a50ms long task in these edits.
The large-text warm path improves in both orders; small-field differences are
mixed. This is not evidence that multi-second chat/display stalls are resolved.

Fresh checks pass app570 (three existing skips), original UI10, optimized CLI
trial1, types0/0, candidate entity/ordinary builds and extraction audit169
(original164/declared existing policies5). Backend408 and native bundle53efb3…
are explicitly reused from2585a40 with unchanged server/native source. Earlier
diagnostic initialization and one parallel first-desktop CDP timeout are retained;
the final serial UI group and isolated diagnostic pair pass without increasing
timeouts. Cold Vite dynamic-import errors also remain in the diagnostic logs;
their root cause was not established and their timings are excluded from speed
claims. No fresh unique test-case count is added for expanded existing assertions.

This cache keeps two current serialized values per open field, increasing live
memory in proportion to their sizes. It has no global/history cache, but this
milestone does not establish full collection/storage budgets or large-array
performance. First-open/cold costs, large HTML/native Worker delays, assets/TTS/
plugins, remaining editor ports, complete extension/read provenance, physical
mobile lifecycle and human acceptance remain in all fifteen original completion
requirements. No production/private/provider/deployment/push access is included.
