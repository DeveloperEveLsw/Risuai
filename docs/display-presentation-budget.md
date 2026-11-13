# Browser presentation byte-size reuse

The first original CBS pass still runs inside the Svelte reaction, keeping its original variable dependencies and optimistic-overlay behavior. Its presentation identity now uses the browser display owner’s existing bounded wire-size cache instead of a new empty cache per row. Every input and admission is still read, encoded and compared anew.

The cache contains immutable string values and their exact UTF-8 JSON byte sizes, with256 entries /2MiB retained string characters and the unchanged16MiB logical limit. No Lua results, mutable captures, admissions or DOM are cached by this change. Owner closure clears the cache, and a closed owner rejects a new identity calculation. The byte cache is not a bound on total browser heap.

The uncached identity remains available for adapters and as an independent control. Seeded arbitrary JSON, mutable fields/getters, version changes, outside reads, provisional admission and byte boundaries compare with that path. The actual browser owner is checked for reuse and closure. Worker scopes, raw-source SHA, original CBS/regex/Lua, Lua globals/ordering and persistent commands remain unchanged.

Measurement uses the unchanged actual checkbox/original UI helper,100 messages /1068010 source bytes /9600 HTML cells /16 regex scripts /6 dependent rows. CPU profiles are separate diagnostics: before sampled mobile first presentation185.17ms, identity114.96ms; after134.96ms/77.11ms. These single sampled profiles have incomplete attribution and do not establish a wall-time speedup. Optimized warm observations and the removal control are recorded separately in [presentation-budget-validation.json](presentation-budget-validation.json).

## Optimized observations

Twelve unprofiled warm samples per scenario/stage,48 total. Values are median / nearest-rank p95 in milliseconds; with12 samples p95 is the observed maximum. The reference helper and fixture are unchanged, without source overrides or HMR. Before29 source hashes match clean bd9b167; after29 fingerprints match the candidate. Bundle index hashes and the source inventory are in the validation receipt.

| Measure                                      |            Before |         Candidate |
| -------------------------------------------- | ----------------: | ----------------: |
| Desktop checkbox                             |     20.55 / 23.80 |     21.00 / 26.00 |
| Desktop complete refresh                     | 1138.80 / 1204.80 | 1121.30 / 1188.10 |
| Desktop maximum frame gap per click          |   100.00 / 100.10 |   100.00 / 100.10 |
| Mobile emulation checkbox                    |     39.55 / 50.40 |     37.25 / 49.30 |
| Mobile emulation complete refresh            | 2324.40 / 2468.40 | 2282.55 / 2398.40 |
| Mobile emulation maximum frame gap per click |   250.00 / 316.80 |   208.30 / 250.00 |

Desktop long tasks9→1, longest69→54ms; mobile-emulated long tasks14→12, longest302→227ms. Every click still completes106 original Lua calls including94 independent-row calls, with stable original message nodes/independent bodies and correct final values. The captured first-presentation sample and observed longest-task reduction support removing repeated work in that path, but do not prove a universal causal speedup. Approximately208ms frame gaps and2.28-second settlement remain. Mobile is390×844/page CPU4× emulation; physical OS and worker CPU throttling are unverified.

The independent removal control changes only the owner method's budget argument. Its declared source override is actually loaded by Vite, with4 separate dev observations preserving106 calls/94 independent rows, values and DOM; these are not pooled with48 optimized observations. No measured source was edited during any performance run.

Two new unit cases compare500 seeded arbitrary fresh JSON trees with the uncached identity, mutate getters/fields and revisions, retain outside/provisional read distinctions and exact byte rejection, and check actual-owner scalar reuse/closure. The remaining original UI/worker/native gates and limitations are recorded in the receipt.

All15 [completion requirements](server-runtime-plan.md) remain active. Physical mobile, cold/configuration/changed-HTML workloads, concurrent-device scaling, complete resource reads, extension/storage/import/export and the practical full trial are incomplete. Development uses only local public sources and synthetic data, without production access, real model calls or remote pushes. The hosted bd9b167 release remains the last separately authorized deployment.

Initial serial browser regression had27 passes/1 notification bootstrap timeout at login readiness/character list. The isolated notification test passed. Failure logs are retained and failure-only synthetic bootstrap diagnostics were added without changing the30-second gate or application behavior. Cause and permanent resolution are unconfirmed; the final serial receipt records the recheck separately.

Final gates: app479passed/3existing skips, types0errors/0warnings, native/entity/ordinary builds, audit169(167original/2existing policies), final serial browser28tests across27files (9built original UI/19display cases). Backend354 is explicitly reused from the saved bd9b167 Node24 run, not newly run here;93backend source fingerprints and native artifact bytes are identical. See the receipt for36source fingerprints, artifacts, initial failure and all measurement scopes.
