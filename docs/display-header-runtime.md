# Lean original display headers

The original ChatBody still runs its CBS, regex, Lua, CSS and persistent admission. Each invocation now captures fresh ownership and source metadata without first spreading the projected database, character and chat. The existing lazy Svelte cache reads and pins the full body when its source changes or a guarded fallback needs it. Main conversation and independent bookmark previews use this contract.

## Responsibility and guards

| Read          | Responsibility                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh header  | Server/chat/character ownership, epochs, input clock, projected cursor, history count/cursor/window, stable message ID/revision/origin/source, private variable revision maps, current model and environment |
| Full body     | Original database/character/chat aliases, definitions, source history, variables, modules, lorebooks and trigger preparation                                                                                 |
| Cache capture | Retain frozen shared definitions/history, fork private mutable fields, apply fresh row metadata; rebuild on scope/clock/epoch/cursor/count mismatch                                                          |
| Lazy fallback | Re-read a full fenced body only if the derivation is missing or stale. Reject a missing or mismatched body; never retag stale values                                                                         |

The public full-capture API remains available. The new header API is synchronous and is consumed before awaiting. Stable-ID lookup, projected cursor versus input clock, history cursor, bookmark presentation token and page fences remain in the controller. Header capture does not enumerate projected definitions. Bookmark header ordering still costs work proportional to the bounded page.

The cold-cache regression also found an existing optional-fallback comparison that dereferenced `fallback.pinned` when both fallback and derived body were absent. The cache now requires an actual fallback before using it.

## Evidence and reproduction

The actual client-compiled controller methods use authored counted proxies: main and bookmark headers enumerate database/character/chat zero times, while each full capture enumerates each once. The actual Svelte cache reads the cold body once for 50 headers, refreshes after clock and epoch changes, preserves old pinned scopes/private fields and rejects missing or mismatched fallback bodies. Two temporary guard removals fail for the intended clock assertions and are restored byte for byte. Initial port-collision and cold-cache failure logs are retained. The first broad browser run passed 48 cases and failed the existing owner-capture probe, which observed only the full-body method after row captures moved to headers. Its original Lua marker, canonical write and worker assertions remain; the probe now observes both ownership entry points. The complete browser gate is rerun against that repaired fixture.

Frozen parent `6066c12f` and current source ran the same capture-probed original UI fixture sequentially, six warm samples per scenario, without source overrides. Each sample keeps 56 actual Lua calls and 44 unaffected rows. Desktop first-sample capture count is 64, later desktop and all CPU4x counts are 167. Fresh headers retain those counts; full snapshots fall to 1–2 per sample (167→2 for CPU4x), with one pinned scope preparation.

| Sequential observation              |     Before |      After |
| ----------------------------------- | ---------: | ---------: |
| Desktop settled p50                 |   561.1 ms |   543.9 ms |
| Desktop feedback p95                |    29.5 ms |    97.4 ms |
| CPU4x settled p50                   |  1156.1 ms |  1071.9 ms |
| CPU4x settled p95                   |  1321.9 ms |  1172.5 ms |
| CPU4x maximum frame gap             |   200.0 ms |   150.0 ms |
| CPU4x long tasks / maximum duration | 6 / 191 ms | 6 / 135 ms |

The counter establishes removed repeated captures; the small sequential timing comparison is not a randomized speed guarantee. Desktop feedback has an outlier regression. Long tasks remain. CPU4x limits the browser page, not every worker, and is not a physical mobile OS. Per-row private forks, revision maps, identity work, original stateful scripts, DOM work and initial resources remain relevant costs.

Run the complete isolated gate from the analysis workspace:

```sh
python3 scripts/run_display_header_final.py
```

It runs Prettier, types, app tests, native build, 160-entry extraction audit, backend tests, fresh entity/legacy optimized builds, an isolated actual CLI smoke and every browser regression sequentially. The acceptance counts are 408 app passes plus 3 existing skips, 168 backend passes and 49 browser passes: 625 fresh passes. The validation manifest covers 321 files; no backend result is reused. Detailed logs, paired observations, negative controls and the source manifest are in `evidence/display-header-logs` and `evidence/display-header-validation.json`.

All 15 requirements in `server-runtime-plan.md` remain active. Wider folder/collection/manual-editor/group/extension contracts, offline/restore, physical mobile and a full configured user trial remain. Production, private contents and remote push are outside this local milestone.
