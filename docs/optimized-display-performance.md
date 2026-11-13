# Optimized original UI responsiveness and remaining costs

Follow-up: [display worker capture transport](display-capture-transport.md) reduces repeated immutable body transfer, verifies independent invocation state in actual workers and repeats the optimized100-row comparison. The measurements below remain the earlier immutable-size milestone; the later fixture still has roughly250ms frame gaps and2.4-second mobile-emulated settlement.

This local follow-up measures the actual optimized original UI with neutral authored data. All 15 completion requirements remain active. Production, personal data and model services were not accessed. Schema20 and server generation behavior are unchanged.

## Measurement

displayPerformance.test.cjs supports an optimized bundle and 7–100 mounted messages. The original checkbox, CBS, 16 regex rules, Lua, sanitation and HTML run normally, with a 600,000-iteration checksum loop per invocation. Six rows depend on the toggle. Other rows still execute stateful Lua and return unchanged presentation; completed script results are not cached or omitted.

| Fixture                 | Message source bytes | HTML cells | Completed Lua invocations per click |
| ----------------------- | -------------------: | ---------: | ----------------------------------: |
| 50 messages × 48 cells  |              269,190 |      2,400 |   56, including 44 independent rows |
| 100 messages × 96 cells |            1,068,010 |      9,600 |  106, including 94 independent rows |

Desktop and a 390×844 viewport with page CPU throttling at 4× run serially. These are headless Chromium emulations, not physical mobile acceptance. Worker CPU throttling is unverified. Warm optimized comparisons use six samples per small scenario and twelve per large scenario. Nearest-rank p95 with these small samples is descriptive and often equals the observed maximum; it is not a population tail estimate.

Production strips console.log, so an isolated page wrapper observes completed display-worker result messages. It does not add HTML counters, change Lua output or force unchanged rows to sanitize again. Development uses original Lua logs. Built mode makes no development-module imports. Canonical server variables, cleared runtime status, completed computations and final dependent HTML establish settlement. Original message rows and independent HTML descendants must retain identity. Checkbox feedback confirms selection after two animation frames. Long-task/frame-gap windows include overlapping tasks and a final observer delivery interval. Profiled runs are separate from the unprofiled optimized comparison.

## Change and compatibility

The worker wire-size validator previously revisited captured history and definitions for every row. It now caches exact sizes only for private recursively frozen JSON registered by the existing display-scope identity layer. WeakMap keys do not retain source containers. Mutable shells, replaced values, shallow-frozen containers, accessor results and Maps remain traversed. close() discards the weak cache. UTF-8 escaping, undefined/sparse arrays, aliases and the existing 16 MiB boundary retain their prior semantics.

Tests compare native JSON UTF-8 sizes for 1,000 seeded arbitrary trees before and after registration/reuse. Changing shells, shallow freeze, mutable getters, Maps, circular values, exact limits and cleanup have dedicated checks. Original VM globals/order, private invocation copies and persistent reads/effects/admission remain in force.

## Observed result

| Optimized 100-row scenario                   | Before median | After median |     Before / after p95 |
| -------------------------------------------- | ------------: | -----------: | ---------------------: |
| Desktop checkbox feedback                    |      22.00 ms |     22.25 ms |       28.40 / 26.00 ms |
| Desktop complete settlement                  |   1,279.65 ms |  1,255.75 ms | 1,421.00 / 1,305.90 ms |
| Mobile emulation checkbox feedback           |      45.35 ms |     42.00 ms |       56.60 / 55.30 ms |
| Mobile emulation complete settlement         |   2,534.10 ms |  2,476.40 ms | 2,782.60 / 2,702.70 ms |
| Mobile emulation longest frame gap per click |     258.30 ms |    250.10 ms |     283.40 / 283.40 ms |

Settlement differences are small and do not prove a material product speedup. The large fixture retains roughly 250 ms frame gaps and 2.5-second settlement. A fast checkbox does not mean all dependent HTML is already updated. This change does not solve stuttering or eliminate two-to-three-second waits.

Exploratory development CPU profiles identify wire traversal and main-thread worker transfer as costs. Disabling only immutable-size recognition through a source override is verified actually loaded; all 106 invocations, final values and stable independent DOM still pass. A single profile per configuration cannot attribute all wall time or establish a general speedup. Native/program time includes rendering costs not yet fully isolated.

The unprofiled before/after 100-row runs use identical helper hashes, fixture dimensions/source bytes, observer and workload. Initial harness failures are retained: an absent development diagnostic required optional invocation, production console counters were stripped, and the fixed 60-row display setting could not satisfy a 100-row assertion. Corrected settings mount the tested rows; these failures are not attributed to product performance. The final fixture range is capped at the tested first-page limit of 100 messages; it does not assert complete larger-archive rendering.

## Reproduction and next work

```bash
VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build
RISU_DISPLAY_PERF_BUILD_PATH="$PWD/dist" \
RISU_DISPLAY_PERF_ROWS=100 RISU_DISPLAY_PERF_CELLS=96 \
RISU_DISPLAY_PERF_SAMPLES=12 RISU_DISPLAY_PERF_OUTPUT=/tmp/risu-performance.json \
node --test server/browser/displayPerformance.test.cjs
```

Omit BUILD_PATH for development mode. PROFILE enables a separate exploratory CPU capture. Source overrides are rejected in built mode. Visible final values, stable DOM, invocation breadth, navigation/exception checks and the existing 750 ms fixture frame-gap guard remain enforced; that guard is not whole-product acceptance.

Next isolate remaining main-thread preparation/layout bursts and full-scope transfers. Any shared worker transport must preserve original JSON projection, private mutable invocation state, exact source lifetime/read fencing, Lua globals/order, budgets, owner retirement and visible failures. Do not substitute script-result caching. Multiple active-device performance, settings/modules/presets scaling, changed large HTML/assets, unloaded archives, physical mobile lifecycle, full import/export/storage/extension contracts and the configured user trial remain incomplete.

Raw data, profiles, failure logs and gate receipts are in workspace evidence/local-responsiveness-* files. responsiveness-validation.json attributes newly run regressions separately from historical checks.
