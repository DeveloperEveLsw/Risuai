# Fresh-read sharing of immutable display snapshots

Local schema21 follow-up. Production access, private reads, model calls, deployment and push are zero in this follow-up. The separately authorized hosted b6e6eed rollout is prior history; this change does not deploy itself. All15 completion requirements remain active.

The [preceding diagnosis](display-workload-analysis.md) found a full-JSON-equal100-row history definition sent again whenever a variable changed. The owner now passes its last private pinned body into `pinDisplayCapture`. Every fresh enumerable field is still read, in the original order, with the existing structural budget. Only an exactly equal, registered immutable container can replace its newly pinned equivalent. Changed fields, deleted/added/ordered unknown metadata, array length, aliases and cycles remain significant. Raw-reference equality, shallow freezing and version/cursor equality do not skip those reads.

The traversal maps each fresh object to its private result and prevents distinct fresh objects from collapsing onto an old alias. A shared fresh object remains shared during pinning; the worker continues to JSON-project each reference independently. Maps use the existing fresh Map copy contract and never qualify as immutable JSON. Prior unregistered wrappers can lead to registered children through own data descriptors; prior accessors never execute. Own `__proto__` keys remain ordinary data. Array pinning also preserves trailing sparse length, which the previous Object.keys-only copy lost.

Registered JSON is already recursively frozen and cannot change. `freezeDisplayJson` now leaves its registration/identity intact rather than walking and registering it again. This preserves worker dictionary references and presentation identities. The owner retains its latest pinned body plus the existing guarded fallback, and clears those references on closure. It does not retain a new archive or cache Lua results. Headers, version Maps, environmental inputs, variable shells, provisional admission and persistent guards remain fresh on every invocation. Worker JSON and Lua globals/order are unchanged; original scripts still run.

The fresh traversal still enforces200000 visited nodes/depth128. Logical16MiB scope, encoder/decoder structure and dictionary budgets remain enforced; registered identity is not permission to skip scope admission. This is not a total browser heap/DB/asset budget.

## Evidence and limits

- App505 passes +3existing skips; fresh Node22.21.0 backend377; type0 errors/0 warnings; native/entity/ordinary builds;169 extraction comparisons (167original +2existing host policies).
- Focused74 checks include1000 deterministic arbitrary JSON pairs, mutation/order/unknown-field changes, getter order/count, sparse length, alias split/merge, cycles, prototype fields, structural/byte budgets and private decode. Actual Lua keeps fresh variables, separate revision Maps and invocation order; a new owner does not borrow the previous owner's body.
- Serial19 browser checks include original built UI, two devices, tab closure/restart, stale-read rejection, stable rows/assets and actual worker transfer. Variable-only refresh sends0 new definitions while a changed history sends a fresh definition and a new worker gets its own dictionary.
- An exact prior cache-source override, over current dependencies in the development Svelte/worker harness, reproduces100045 logical definition bytes on the variable-only refresh. The new harness sends0. Actual Lua outputs/canonical state match. This is a removal control, not an optimized latency comparison or the complete old release.
- Separate original optimized100-row probe observes107 execution packets/0 definitions per toggle in desktop/mobile emulation. The earlier matched workload sent one1092001-byte history definition. Bodies are not written. This is logical definition metadata, not physical IPC or network byte measurement.

The paired same-helper optimized measurements are recorded in [the validation receipt](display-snapshot-sharing-validation.json). Four workloads (HTML1/96cells, extra Lua loops0/600000) each have6 warm observations per scenario, baseline/candidate in forward and reverse execution orders. The initial incorrectly configured diagnostic and the initially double-pinned unit fixture are retained separately. No product timeout or assertion was relaxed.

| PageCPU4x settlement median / ms | Run1 before → after | Run2 before → after |
| -------------------------------- | ------------------- | ------------------- |
| 1cell, extra loop0               | 1316.55 → 1254.25   | 1245.70 → 1259.80   |
| 96cells, extra loop0             | 1949.90 → 1943.45   | 1928.85 → 1994.65   |
| 1cell, extra loop600000          | 1788.20 → 1803.20   | 1784.95 → 1764.20   |
| 96cells, extra loop600000        | 2448.55 → 2360.40   | 2424.15 → 2414.65   |

The large idle frame-gap medians are183.25→199.95ms and199.95→183.35ms, respectively. Outcomes are mixed across order/conditions; no statistically established or general speedup is claimed. With6 samples per condition/run, nearest-rank p95 is the observed maximum. Runs and separate structural diagnostics are not pooled.

Reduced transfer is not proof of eliminating the remaining2–3second settlement. Independent worker JSON projection, original callbacks, formatting/HTML/layout work remain. Physical mobile, worker CPU attribution, cold starts, large single HTML, concurrent devices, full read/extension/import-export/storage contracts and the complete practical trial remain unproven. The private Nexus card's actual gsub cause remains unknown; no supplied message content was recorded. The full goal stays active.
