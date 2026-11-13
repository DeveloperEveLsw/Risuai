# Browser display scheduling and measured limits

Latest follow-up: [optimized original UI measurement](optimized-display-performance.md) adds built-bundle/larger-fixture evidence and weak immutable wire-size reuse. Large-fixture settlement remains about 2.5 seconds and frame gaps about 250 ms; responsiveness acceptance remains open. The historical comparison below retains its original attribution.

This records the `83e06ed` scheduling milestone. The later [browser worker implementation](display-worker-runtime.md) adds single-invocation termination and separate resource initialization; the measurements below remain the original historical comparison.

This is a local milestone within the original server engine, relational storage and multiple-device goal. All 15 completion requirements remain in scope and unchecked. The configured user trial is not ready. No production access, private-content inspection, deployment/restart or remote push is involved.

`BrowserDisplayLua` now yields to a new browser task before each serialized Lua invocation. Native `scheduler.yield()` is used where available; a timer provides the fallback. A chain of resolved Promises alone does not allow the browser to process input or paint between synchronous WASM Lua calls. The old sequence could execute every mounted row within one long microtask checkpoint.

The private variable values, revision maps and source identity are captured before asynchronous work. The yield does not recapture live state, reorder one VM's invocations, skip scripts, share one proposal's writes with another or wait for a server acknowledgement. Server admission still validates the captured reads and writes. The owner/VM retirement check follows the yield so closing the owner cannot begin a queued Lua invocation or submit its effect. The original scripting factory and its existing error/token cleanup policies are unchanged by this wrapper.

## Reproducible comparison

`server/browser/displayPerformance.test.cjs` runs the actual original UI, original checkbox and original Lua/CBS/regex/HTML path against a fresh synthetic SQLite database and disposable Chromium profile. It contains 50 messages, 48 HTML cells per message, 16 display regex rules and a 600,000-iteration checksum loop per Lua invocation. Six messages read the toggle; 44 return unchanged presentation. Counters use the original Lua `log()` and page-scoped CDP console events, so measurement does not change those 44 messages' HTML. The test verifies both stable message containers and stable independent HTML descendants.

Measurements run serially at desktop size and with a 390×844 mobile viewport and fourfold CPU throttling. Thirty warm observations per scenario are preserved before and after the change. The baseline uses the exact `654dbe6` browser Lua runtime. The comparison and raw source hashes are retained in the workspace `evidence/display-performance-logs` directory and `evidence/display-performance-comparison.json`; the report contains observed quantiles, rather than a universal latency promise. Long-task windows include tasks overlapping the click time. Frame gaps come from a continuously sampled `requestAnimationFrame` heartbeat. Checkbox feedback waits for two frames and confirms the original control's selection. Settling waits for all Lua invocations, confirmed pending work and the final dependent HTML, then allows two frames.

```bash
RISU_DISPLAY_PERF_SAMPLES=30 \
RISU_DISPLAY_PERF_OUTPUT=/tmp/risu-display-performance-repeat.json \
node --test server/browser/displayPerformance.test.cjs
```

The normal regression suite uses six observations and a 750 ms maximum-frame-gap guard for this controlled fixture. This guard does not define actual-mobile or whole-product acceptance. Development Vite assets, warm repetition, headless rendering, logging instrumentation, this CPU workload and this one message shape limit generalization. CPU profiles are preserved as exploratory evidence, separate from the final unprofiled comparison. Earlier instrumented runs that placed counters in HTML are preserved but excluded from the final comparison.

The final benchmark disables Vite HMR and fails on main-frame navigation during measurement. A previous comparison lost its window instrumentation and failed; its root cause was not established and its log is retained. The baseline is an explicit negative control: it must reproduce a frame gap above the regression budget. The updated run enforces the budget. Both use the same fixture/helper source hashes; the baseline runtime hash matches the committed parent.

The first full browser run also exposed an existing settings test's missing peer projection barrier. Three independent writes can reach another device at different times; confirming only the model field cannot establish that URL/key controls have caught up. The original assertions passed on an unchanged isolated rerun. The test now additionally verifies all three canonical synthetic values and waits for all three peer controls before the existing assertions. No synchronization implementation change is attributed to this test repair. Failure logs, including initially incorrect field names in the added verification, are retained.

## Remaining work

- All 50 rows still run Lua on a broad external display clock. An unchanged row is not automatically a pure script: original Lua globals, nondeterminism, state writes, history reads and plugins make unconditional result caching unsafe. Fine dependencies require an explicit compatible read/effect policy.
- Total computation is still performed. Breaking a queue into browser tasks improves responsiveness, but does not make its CPU work free or guarantee a shorter final settlement.
- A single expensive or infinite Lua call still monopolizes its task. Worker isolation, enforceable execution budgets and consistent cancellation/VM lifetime are required. Timer fallback can be throttled in hidden tabs; server generation continues independently of presentation.
- Synchronous CBS, regex, sanitation, large changed HTML, assets and DOM layout still need bounded scheduling and representative scenarios. Full outer CBS/regex/plugin scope and persistent-effect policy remain incomplete.
- An optimized production web build, real mobile OS/browser lifecycle, larger histories, multiple active devices and the full configured user trial remain required. Existing format/archive/editor/provider/offline/restore requirements are preserved.
