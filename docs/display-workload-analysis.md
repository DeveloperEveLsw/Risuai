# Display workloads: HTML, original Lua and unchanged history

This is a local diagnosis of the unchanged5a6bdd3/schema21 implementation. No production access, private content, model calls, deployment or push occurred. All15 completion conditions remain active; this is not a performance fix or full-product acceptance.

The unchanged optimized original-UI helper varies100 rows between1/96 HTML cells per row and0/600000 extra Lua loop iterations per row. Zero means only the added stress loop is disabled: the original callback, CBS, regex, worker transport and formatting still run. Each condition has6 warm samples per scenario in forward/reverse execution orders:96 observations total. The median averages the middle pair; with6 samples the nearest-rank p95 is the maximum. Runs and diagnostics are not pooled.

| Workload                  | Desktop settlement median, runs1 / 2 | PageCPU4x mobile emulation median, runs1 / 2 | Mobile maximum frame gap median, runs1 / 2 |
| ------------------------- | ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| 1cell, extra loop0        | 414.15 / 463.65ms                    | 1269.00 / 1410.65ms                          | 125.05 / 141.60ms                          |
| 96cells, extra loop0      | 702.75 / 680.90ms                    | 2001.70 / 2261.60ms                          | 200.10 / 225.05ms                          |
| 1cell, extra loop600000   | 957.10 / 980.25ms                    | 1822.85 / 1858.95ms                          | 141.70 / 133.40ms                          |
| 96cells, extra loop600000 | 1186.45 / 1204.35ms                  | 2573.90 / 2521.70ms                          | 249.90 / 225.00ms                          |

Every observed toggle retains106 labelled row callbacks,94 independent rows, final dependent values and existing message/independent DOM. Mobile-emulated checkbox feedback medians remain38.20–69.10ms. Fast selection does not establish a finished HTML update. Zero extra loop still leaves roughly1.3–1.4s in the small case and2.0–2.26s in the large case. Changing cells also changes source/transport/formatting/layout work; these differences do not isolate DOM CPU or allocate causal percentages to individual stages. This is synthetic stress evidence, not a universal real-card estimate.

## Separate structural and sampled diagnostics

Two profiled helper executions and one history probe are excluded from96 warm samples. Idle frames are about16.7ms, so the observed long gaps are not the browser's baseline frame interval. Main-thread sampled profiles include string sizing/encoding and program/native time, but attribution is incomplete. Worker profiling failed in three preserved terminal attempts: zero matched targets, empty worker target URL/title, then attached Runtime.evaluate timeout. No worker identity/profile was verified, no timeout/product gate was relaxed, and no worker CPU percentages are claimed. The failed preload remains a diagnostic prototype outside the application.

The wire observer sees107 execution packets per toggle:106 labelled row callbacks plus the greeting not counted by the fixture. Exactly one dictionary definition is the100-row message history, with1092001 logical UTF-8 JSON bytes. In both desktop/mobile history probes its full JSON equals the earlier definition from the same VM. Thus a fresh global-variable snapshot re-registers and transfers unchanged history. Bodies are compared only in the isolated synthetic browser and are not written to diagnostic files. Definition metadata does not measure physical IPC bytes or HTTP/network traffic; profiler/serialization overhead is not used as latency evidence.

`createDisplayScopeCache` repins and recursively freezes the complete body when display revisions change. `pinDisplayValue` allocates new containers; `freezeDisplayJson` registers new identities, causing `DisplayCaptureEncoder` to define an equal history again. Existing transport reuse is within the lifetime of one registered body. The observation establishes this repeated-work boundary; it does not prove that removing it alone eliminates the whole stall.

## Next implementation and proof requirements

Compare every fresh source field while reusing only exact prior registered immutable JSON subtrees across snapshots. Keep changed variables/definitions, epoch/inputClock/cursor/message revisions, unknown fields, JSON ordering, aliases/cycles, getter reads, provisional admission and source ownership fresh. Do not rely on raw reference equality or shallow freeze. Clear retained snapshot references on owner closure. Preserve logical16MiB/structural/transport budgets and the original worker's private JSON projection.

Validate changed/deleted/reordered bodies and metadata, getter/read counts, alias separation/merging, cycles, mutation isolation and cleanup. In the actual original UI require correct peer updates/stale-write fencing, equivalent-overlay suppression, unchanged Lua globals/order/callback breadth and stable DOM/assets. Compare the same optimized workload helper and retain failures/removal controls. This is the next work; no structural-sharing implementation or speedup is claimed here. Large single-row HTML, cold starts, concurrent devices, physical mobile, full extension/read/storage/import-export contracts and the practical full trial remain required.

## Evidence and reproducibility

[Validation receipt](display-workload-validation.json) contains16 run/scenario summaries, source/artifact hashes, raw evidence/script fingerprints and diagnostic failures. Workspace scripts `measure_display_workloads.py`, `observe_display_wire.cjs`, `observe_display_history_wire.cjs` and `record_display_workloads.py` reproduce/seal the named evidence. The measurement driver is pinned to clean5a6bdd3 and refuses to overwrite runs. For an isolated single condition use:

```bash
RISU_DISPLAY_PERF_BUILD_PATH="$PWD/dist" \
RISU_DISPLAY_PERF_ROWS=100 RISU_DISPLAY_PERF_CELLS=96 \
RISU_DISPLAY_PERF_LOOP=0 RISU_DISPLAY_PERF_SAMPLES=6 \
RISU_DISPLAY_PERF_OUTPUT=/tmp/risu-display-workload.json \
node --test server/browser/displayPerformance.test.cjs
```

The existing8ce optimized bundle is reused after verifying every tracked src file unchanged and matching its index hash. No source overrides/HMR or new build/Node24 check is used. The5a implementation's494app+3existing skips/377server/14serialUI/types0/0/169audit are explicitly reused, not fresh regression runs this turn. New gates are8 workload executions,2 main-profile executions and1 structural probe, all through the unchanged original-UI helper. Existing15 completion conditions and hostedbd9b167 history are preserved.
