# Main and actual display worker profiles

Runtime source and optimized artifacts remain at8d17ebe/schema21. This is a local synthetic diagnostic, with no production access, private content/authentication reads, model calls, deployment or push. It preserves all15 completion requirements. Profiling establishes the next optimization target; it does not establish a speedup or completion.

## Verified target and workload

The worker is attached through its owning page with flattened `Target.setAutoAttach`, without pausing startup. A separate synthetic protocol probe first verified evaluation and profiling through that session. Every application measurement then verifies the live worker name `risu-display-lua`, localhost `/assets/display.worker-…` URL and installed message handler. It profiles that worker and the page, rather than inferring worker CPU from the page profile.

Four unchanged-helper executions cover100 labelled rows,1/96 HTML cells per row and0/600000 extra Lua iterations per row. Each records one profiled click on desktop and pageCPU4x mobile emulation:8 main profiles and8 worker profiles. All preserve106 labelled callbacks,94 independent row callbacks, final values and existing row/body DOM. The first completed large-idle probe is explicitly reused by the manifest; later probes have separate terminal logs. No override or HMR is used. Loop0 still executes original Lua/CBS/regex. Worker CPU throttling remains unverified.

These8 clicks are diagnostics, excluded from the previous192 unprofiled warm observations. Main and worker profiler windows start/stop separately and extend beyond click settlement. Sampling and CDP reported counters include collection/scheduling overhead; neither proves exact CPU time or an overall wall-time breakdown.

## Locations and observations

The summary uses each exact optimized bundle SHA and TypeScript AST character ranges to classify callFrames, preserving line and column. It identifies wire string/value sizing, presentation key encoding, capture encoding/decoding, fresh snapshot pinning, the markdown pipeline and thought/tool formatting. Builtin/native frames only contribute to an inclusive category when the recorded ancestor stack reaches that verified source range. Program, unclassified, idle and GC samples remain explicit. Inclusive categories overlap and must not be added together.

| PageCPU4x diagnostic sampled weights / ms                     | SmallHTML, extra loop0 | LargeHTML, extra loop0 |
| ------------------------------------------------------------- | ---------------------: | ---------------------: |
| Main wire value sizing, inclusive                             |                433.661 |                492.200 |
| Main wire string sizing, inclusive (also inside value sizing) |                289.505 |                318.866 |
| Main presentation key, inclusive                              |                311.675 |                402.954 |
| Main thought/tool formatting, self                            |                  1.621 |                 83.195 |
| Worker capture decode, inclusive                              |                 75.628 |                142.307 |
| Worker WASM, inclusive                                        |                 18.690 |                133.195 |
| Main program / unclassified, self (not attributed)            |      677.829 / 412.346 |      958.401 / 759.814 |
| Worker idle, self                                             |               1733.386 |               2515.038 |

With600000 extra iterations, worker WASM inclusive weights increase to579.638ms for smallHTML and677.151ms for largeHTML in pageCPU4x, versus18.690/133.195ms without the extra loop. Desktop has the same qualitative change. This positive workload control confirms that the actual worker profile sees Lua/WASM work; it does not prove worker throttling or every real card's behavior.

CDP independently reports page LayoutDuration/RecalcStyleDuration deltas0.011453/0.005341s for smallHTML and0.018412/0.005428s for largeHTML in the loop0 probes. These counters do not cover every HTML parsing/sanitization/native task, and are not summed with profile weights. The samples contradict treating layout alone as the established bottleneck in this fixture. They also do not justify replacing the Lua engine as the sole fix.

## Next change and fidelity

First inspect repeated main-thread byte sizing and presentation encoding: the fresh mutable outer inputs still get traversed even when history definitions are reused. Check actual exact-string cache hit/miss/eviction behavior and allocation cost before altering cache admission or encoding. Keep16MiB logical scope and structural limits, fresh field/getter reads, unknown metadata/order, immutable ownership, independent worker JSON projection, original Lua globals/order, and durable hashes/CAS intact. Then compare any candidate with the same optimized helper in both run orders, separately from profiles.

Thought/tool formatting repeatedly scans tag-free text, but it is not the dominant classified work in the smallHTML probe. Native/unclassified main tasks need stronger tracing before attributing the rest. Physical mobile, cold loading, concurrent devices, single largeHTML, assets, full raw/cloned field/map/collection/membership reads, general extensions, import/export, storage budgets and full user trial remain. All15 requirements remain active.

Evidence: `evidence/local-display-thread-profiles-run-20261004.json`, `local-display-thread-profile-summary-20261004.json`, eight identity/metrics records, sixteen profiles and full logs in the enclosing workspace; compact receipt in `display-thread-profile-validation.json`. Previous timing evidence remains in `display-snapshot-sharing-validation.json`.
