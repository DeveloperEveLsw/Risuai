# Display invocation validation

The browser executor validates its fresh complete logical invocation inside the
capture encoder, rather than checking the envelope and then checking the full
capture again. This removes one redundant traversal; it does not remove original
CBS, regular expressions, Lua callbacks, scope fields or independent-row work.
Schema21 and all15 [completion requirements](server-runtime-plan.md) remain active.

## Boundary and compatibility

The optional envelope is the executor's newly constructed, pinned data. It must
own an enumerable data property named `capture` referring to the exact value
being encoded. An unrelated value, accessor, hidden property or undefined capture
is rejected before reading or committing transport state. This is not an API for
externally supplied objects with side-effecting accessors. The executor's input
spread and private snapshot construction remain unchanged.

The full envelope, including content, source identity, revisions and unknown
fields, is still checked against the same16MiB logical UTF-8 JSON budget. The
standalone encoder still validates its complete capture. Dictionary-root size
checks,32MiB packet checks, node/depth limits, receiver checks, JSON alias
separation and mutable-field freshness remain. There is no asynchronous boundary
between constructing the envelope, validating it and encoding its capture.

Only after all checks succeed is the dictionary committed. Failure of a large
outer content field cannot post to the worker or change its dictionary, and a
subsequent valid invocation still works. Lua VM lifetime, callback ordering,
2000ms invocation budget, initialization budget, current guards, durable effects
and server generation remain unchanged. This adjustment is separate from the
historical card-script `gsub` failure and incomplete-result recovery policy.

## Why this path

Fresh diagnostics used the previous verified optimized entity UI,100 messages,
9600 HTML cells and no extra synthetic Lua loop. Actual `risu-display-lua` workers
were identified, and two main plus two worker profiles were categorized using
exact bundle SHA and TypeScript AST ranges. The page CPU4x sample had36.141ms
inclusive first-CBS-wrapper weight,232.834ms scope-sizing weight and215.290ms
capture-encoder weight. These inclusive categories overlap; they cannot be added
or treated as wall-time percentages. Program, idle, GC and unclassified samples
remain unassigned. One profiled click per target is diagnostic evidence only.

The no-context HTML guard already existed. The measured result changed the next
target from moving synchronous CBS to removing the duplicate complete-capture
check. Synchronous CBS and its Svelte reactive reads are retained.

## Verification

Exact-limit and limit-minus-one tests compare native JSON UTF-8 sizes with the old
two-pass oracle, including300 seeded arbitrary bodies/extensions. Additional
coverage preserves Unicode/escaping, repeated aliases, unknown fields, mutated
wrappers, unchanged packet contents and failed-encode state. Existing1000-case
JSON projection checks remain.

An injected transport test verifies the actual executor rejects3MiB of NUL input
(over16MiB when JSON escaped) before posting. It then sends valid calls, observes
fresh unknown/revision fields and checks reuse of one immutable definition. A
control removing only the envelope argument fails that oversized-content
assertion. The exact candidate bytes are restored after the control. This fixture
does not run Lua; real-browser worker/Lua checks are recorded separately.

The unchanged optimized UI helper retains100 mounted rows,106 labelled Lua
computations and94 independent-row calculations on every click, final toggle
values and stable DOM. Paired forward/reverse orders use small HTML, large HTML
and large HTML with600000 extra loop iterations. Six warm clicks per role,
condition, order and desktop/pageCPU4x scenario give144 observations. Profiling,
source overrides and HMR are excluded from those measurements. Baseline and
candidate artifacts have separate full file hashes; current filesystem hashes
in helper output must not be presented as baseline source hashes.

Measured outcomes and final gates are in
[display-envelope-validation.json](display-envelope-validation.json) and the
workspace report. Per-run n6 p95 is the observed maximum, not a population-tail
estimate. Physical mobile OS, worker CPU throttling, cold/concurrent devices,
large changed bodies/assets and the complete user trial remain unverified.

Complete-refresh median milliseconds are shown per order; each entry uses six
warm clicks. Order1 runs baseline then candidate; order2 reverses the roles.

| Fixture/scenario               | Order1 baseline→candidate | Order2 baseline→candidate |
| ------------------------------ | ------------------------: | ------------------------: |
| Small HTML/desktop             |             323.90→306.80 |             323.85→321.55 |
| Small HTML/pageCPU4x           |             999.00→919.50 |             940.95→986.60 |
| Large HTML/desktop             |             523.80→560.45 |             538.60→515.75 |
| Large HTML/pageCPU4x           |           1465.70→1466.80 |           1509.00→1383.25 |
| Large HTML+extra Lua/desktop   |           1047.70→1062.25 |           1058.10→1095.60 |
| Large HTML+extra Lua/pageCPU4x |           1958.60→1889.65 |           1975.55→1941.20 |

Results are mixed: small pageCPU4x and large desktop reverse direction across
orders, and extra-Lua desktop increases in both. Candidate pageCPU4x feedback
medians are30.25–40.35ms, per-click maximum-gap medians100.00–116.70ms and observed
long tasks reach166ms. These results do not establish consistent overall speed
or stutter improvement. The small consolidation is retained for its verified
single complete-envelope check, not as a solution to the waiting problem.

## Remaining work

Final fresh gates:541 application passes with3 existing skips,402 sequential
backend passes and23 sequential browser passes, types0errors/0warnings,
native/entity/ordinary builds and169 structural declarations (167 original and2
existing explicit policies). The966 unique regression cases exclude repeated
focused tests, the expected failure control, profiled diagnostics and the144
warm observations. Browser coverage includes actual worker timeout/recovery,
private capture changes, dependencies/projection/history, task pinning,
stream/DOM/image lifetime, two-device/all-tab-exit behavior and both backup paths.
The initial test-count assumption failure and removal-control failure are retained;
product checks and execution budgets were not weakened.

Removing this traversal alone does not establish faster overall refresh or solve
the user's2–3second wait. Broad callback work, other sizing/serialization, private
decode/Lua and presentation preparation remain. Further changes must retain
stateful callback counts and original reactive reads and measure cost separately.
Complete resource dependencies/extensions, storage budgets, mobile lifecycle and
all15 conditions remain active. No production access/change, private data read,
actual provider call or remote push is part of this local work.
