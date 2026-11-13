# Direct display JSON sizing

The display budget now sizes top-level JSON scalars and already measured private
immutable roots before allocating traversal state. The unchanged decoder calls
this method for each scalar and field key. Fresh arrays/objects still use the
existing recursive walk, read getters again, reject cycles and unsupported
containers, and admit private immutable sizes only after a successful check.

Strings keep the same exact escaped UTF-8 calculation and bounded LRU cache.
Numbers preserve native JSON behavior for nonfinite values and negative zero.
Null, booleans and every cached result still pass the same final byte limit.
Unregistered, mutable and shallow-frozen objects cannot enter the private weak
size cache. Cache lifetime, dictionary and packet formats, complete input limits,
alias separation, unknown fields, private decode, original CBS/Lua calls and
ordering, server storage and schema21 remain unchanged.

## Diagnostic evidence

A separate copy of the verified40e0757 optimized entity build instruments exact
TypeScript AST locations in the main and worker budget classes. Original sources
and build files remain unchanged. The actual `risu-display-lua` worker is verified
by name and URL in two one-click scenarios: desktop and page CPU4x,100 rows,
9600 HTML cells, no additional synthetic Lua loop. Each preserves106 labelled
calculations and94 independent rows. Counters contain no user bodies.

The worker packet budget reports170203/170228 string cache hits against4/3
misses per click. Its expanded-value budget makes188396/188420 top-level measure
calls, each measuring a scalar or field key. Increasing the string cache is not
supported by this diagnosis. Avoiding Map/Set and recursive closures on those
direct calls is the chosen adjustment. Repeated packet walks and private JSON
decoding remain; this does not skip original callback work or cache Lua results.

Instrumented `performance.now` timings include diagnostic overhead and nested
categories overlap. They are not wall-time percentages or allocation-byte
measurements. These two diagnostic clicks are excluded from the separate
uninstrumented warm comparison. Page CPU4x does not prove worker CPU throttling
or physical mobile OS behavior.

## Meaning and verification

A focused control intercepts only the synchronous sizing calls' Map/Set
constructors. Eleven scalar/trusted-root checks allocate neither collection;
two fresh getter containers still allocate traversal state and read twice.
Native JSON/TextEncoder remains the byte oracle. Removing only the early direct
branch makes the allocation assertion fail with11 Map and11 Set instances;
the exact candidate source is then restored. Existing1000-case JSON, serialized
projection and scope projection differential checks remain unchanged.

The first test shim passed at runtime but had two TypeScript constructor errors.
It was corrected to match the empty collection construction under test. Initial
failure logs and the expected removal-control failure are retained separately
from acceptance counts; no product limit, existing assertion or timeout was
weakened.

Full gates and the paired optimized UI measurements are recorded in
[display-scalar-sizing-validation.json](display-scalar-sizing-validation.json).
The unchanged UI helper runs small HTML, large HTML and large HTML with600000
extra Lua loop iterations, both role orders, six warm clicks per scenario and
role:12 executions and144 observations. Artifact hashes distinguish the prior
verified build from the candidate. Both roles' helper source hashes refer to the
current filesystem, not two different source checkouts. Profilers, overrides
and HMR are excluded. Each click retains106/94 calculations, final toggle values
and stable DOM. Six-sample nearest-rank p95 is the observed maximum, not a
population-tail estimate.

Overall speedup and absence of stutter are not established. Cold starts,
concurrent devices, physical mobile lifecycle, large changed HTML/assets,
complete extension/resource contracts, global storage budgets and the complete
configured trial remain active. All15 original completion requirements and their
check state remain unchanged. This local step neither accesses nor changes the
hosted service, reads private content, makes real provider calls nor pushes.

For a reproducible synthetic trial from `development/risuai`:

```bash
RISU_DISPLAY_WORKER_BUILD_PATH=/tmp/risu-display-scalar-sizing-entity-build-20261004 \
  node --test server/browser/displayWorkerBuildUi.test.cjs

RISU_DISPLAY_PERF_BUILD_PATH=/tmp/risu-display-scalar-sizing-entity-build-20261004 \
RISU_DISPLAY_PERF_ROWS=100 RISU_DISPLAY_PERF_CELLS=96 \
RISU_DISPLAY_PERF_LOOP=0 RISU_DISPLAY_PERF_SAMPLES=6 \
RISU_DISPLAY_PERF_OUTPUT=/tmp/risu-display-scalar-sizing-user-trial-20261004.json \
  node --test server/browser/displayPerformance.test.cjs
```

The next diagnostic should separate remaining packet traversal, private decode,
original callback and DOM costs while preserving stateful callback ordering and
fresh Svelte dependencies. This is progress, not whole-goal completion. The
historical Nexus card-script `gsub` correction and incomplete-result policy stay
in their prior records and are separate from this display allocation change.
