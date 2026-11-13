# Bounded native display packet checking

The sender can check a small owned packet with native JSON serialization and the
existing exact serialized UTF-8 checker instead of recursively walking its
generated tag arrays again. Complete logical input validation remains16MiB,
the packet budget remains32MiB, and the receiver independently keeps its full
packet, dictionary, expanded-capture and structure checks. Packet format and
schema21, fresh source reads, callback ordering and private JSON alias separation
are unchanged. The serialized string is checked locally and is never sent in
place of the original structured packet.

## Eligibility and transient size

The native path is restricted to packets with no new raw definitions. Each other
value is a freshly constructed plain field or tag array containing JSON scalars;
unsupported values and containers have already been rejected by the original
visitor. Cold/changed raw definitions retain the old full tree check. Prototype
`toJSON` hooks and replacement of the captured platform serializer also select
the old check, so the optimization cannot execute those raw container hooks.

The original visitor counts every node and the UTF-16 units of inline string
values and emitted object keys. A conservative UTF-8 output bound is:

```text
6 * inlineStringUnits + 64 * visitedNodes + 32 * (drop.length + 1) + 128
```

Each source UTF-16 unit needs at most six JSON-escaped bytes. Sixty-four bytes
per visited node cover the node's tag/array/field punctuation, sibling comma,
quote delimiters and finite numeric value or safe reference ID. Inline field-key
units are counted once per emitted field. Thirty-two bytes cover each eviction
ID/comma, and128 cover the fixed outer object. Nodes representing references do
not include their already held body. Undefined object fields are omitted, array
holes/undefined/nonfinite values retain their original normalization, and unknown
keys remain present.

Native serialization is eligible only when that bound is at most1MiB. Otherwise
the old walker is used, including valid packets larger than1MiB. This bounds the
additional serialized text's UTF-8 bytes, not measured engine heap allocations;
a UTF-16 string can require more memory. The existing fixed16KiB encoding scratch
is retained. All byte guards succeed before committing the sender dictionary.
Nothing is cached from mutable captures or Lua results, and no callback is skipped.

## Why this adjustment

Separate diagnostics instrumented exact AST locations in a copy of the verified
fccac3f optimized UI. Two actual `risu-display-lua` workers were identified by
name and URL. For one desktop and one pageCPU4x click with100 rows/9600 cells,
107 packets represented106 labelled calculations plus the unlabelled greeting.
No new definitions were serialized during those warm clicks. Reference parsing
processed116844107 characters per click, with about53–56ms of measured time.
Sender packet checks took about35ms on desktop and135ms with page CPU4x; capture
encoding took59/239ms including logical and packet checks. Worker Lua execution
took141/146ms and includes asynchronous VM/API work.

These are diagnostic wall times with overhead and nested overlapping categories,
not complete end-to-end or CPU attribution. They cannot be added as percentages
of total UI settlement. The page throttle does not prove worker CPU throttling
or physical mobile behavior. Diagnostic clicks are excluded from the paired
uninstrumented performance measurements.

## Verification and remaining scope

New1000-seed generated packet checks compare native JSON/TextEncoder with the
independent old tree-size oracle and original decoded JSON. Unicode/escapes/lone
surrogates, sparse arrays, aliases, prototype keys, getter read count, native exact
limit/limit-minus-one and failed dictionary state are checked. Cold and changed
definitions select the old walker; warm references decode into separate private
objects. Over1MiB escaped output remains valid through the old path. Prototype
getter hooks are not executed, and replacing the serializer retains the old path.
The existing1000 JSON/scope/wire and300 full-envelope differential cases remain.

Removing only the native branch fails its actual path assertion. Removing only
the conservative cap incorrectly admits1200068 bytes to the native path and
fails the1MiB assertion. Both controls restore the exact candidate bytes. Two
initial diagnostic preparations missed the optimized template literal used for
the `execute` message; the final AST matcher supports literal-like values. These
failures are retained separately; no product guard or existing assertion/timeout
was weakened.

The initial serial browser run passed22 and failed one `Page.navigate` CDP
timeout. Its root cause remains unconfirmed; original budgets/assertions are
retained, and failed plus subsequent unchanged isolated/full recheck logs are
reported separately. This is not a claimed product fix.

Full gates and same-helper paired small/large/extra-Lua, forward/reverse-order
measurements are in [display-native-packet-validation.json](display-native-packet-validation.json).
Source fingerprints refer to the candidate filesystem for both measurement roles;
distinct artifact hashes identify the actual prior and candidate UI builds.
Profilers, HMR and source overrides are excluded from those comparisons. Each
click retains106 labelled/94 independent computations, final values and stable
DOM. A six-sample nearest-rank p95 is the observed maximum, not a population tail.

The paired warm comparison reports11 of12 settlement medians lower. Large
pageCPU4x HTML changes1398.60→1337.10ms and1425.35→1330.20ms in the two
orders; extra-Lua pageCPU4x changes1906.80→1850.55ms and1890.15→1808.00ms.
One extra-Lua desktop median increases1.6%. Candidate pageCPU4x feedback
medians range26.55–43.40ms, per-click maximum-frame-gap medians100.10–116.65ms
and the observed longest long task is139ms. These observations do not establish
population speedup or absence of stutter; about1.3–1.85seconds remain.

Physical mobile, cold/concurrent/large changed HTML-assets, remaining resource and
extension contracts, total storage budgets and the full configured trial remain
required. All15 original completion conditions and check state are unchanged.
This local step does not access/change production, read private prompts/scripts,
make real provider calls or push. Historical Nexus `gsub` findings and partial
result recovery policy remain separate. This is progress, not whole-goal completion.

For a repeatable synthetic trial from `development/risuai`:

```bash
RISU_DISPLAY_WORKER_BUILD_PATH=/tmp/risu-display-native-packet-entity-build-20261004 \
  node --test server/browser/displayWorkerBuildUi.test.cjs

RISU_DISPLAY_PERF_BUILD_PATH=/tmp/risu-display-native-packet-entity-build-20261004 \
RISU_DISPLAY_PERF_ROWS=100 RISU_DISPLAY_PERF_CELLS=96 \
RISU_DISPLAY_PERF_LOOP=0 RISU_DISPLAY_PERF_SAMPLES=6 \
RISU_DISPLAY_PERF_OUTPUT=/tmp/risu-display-native-packet-user-trial-20261004.json \
  node --test server/browser/displayPerformance.test.cjs
```
