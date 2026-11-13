# Owned display-key UTF-8 checking

This document records the frontend4d validation. The later pre-deployment [database initialization follow-up](database-initialization.md) changes only server connection setup and explicitly reuses these unchanged frontend artifacts and timings.

The display owner now serializes its private tagged presentation key once, then checks the exact UTF-8 byte length with a fixed 16 KiB encodeInto scratch. Previously it recursively walked generated tag arrays, repeatedly encoded strings through the existing 256-entry cache, and then serialized the same key. Raw scope/worker admission keeps its original structural walker and immutable-size policy.

The separate instrumented baseline build recorded 333 owner-key measurements and about 168,000 node visits per synthetic toggle. Its large-HTML/page-CPU4x sample recorded 44,278 cache misses/evictions; its small-HTML sample recorded 44,386. Increasing cache capacity would still leave generated-tree traversal. These diagnostic counts and timings include observer overhead and are separate from the uninstrumented comparison.

## Preserved contract

- Every fresh source field, changed getter, unknown metadata, revision, alias and environment is read using the same encoder and order. Registered frozen identities and generated key strings are unchanged.
- The owned key still enforces exactly 16 MiB logical JSON/UTF-8 bytes. Existing source node/depth/type/cycle guards run first. Raw caller inputs never use this method.
- Two 1,000-case property checks compare UTF-8 sizes and the prior tagged-tree size oracle, including exact acceptance/rejection boundaries. Unicode/escapes/lone surrogates, scratch-boundary emoji and the encode-only browser fallback are covered.
- The scratch retains at most 16 KiB and no input object, but can contain its final encoded fragment until reuse/close. JSON serialization occurs before the owned-key byte rejection; this is not a transient-heap or total-storage guarantee.
- Worker private JSON, original Lua/CBS/regex calls, VM globals/order, proposal admission, durable source hashes and server CAS/persistence remain unchanged. No Lua result cache or skipped callback was introduced.

## Original optimized UI comparison

The unmodified original helper ran 16 times in forward/reverse condition and build orders: 100 rows, HTML 1/96 cells per row, extra Lua loop 0/600000; 6 warm clicks per desktop and page CPU4x scenario, 192 observations. Every click retains 106 labelled and 94 independent row callbacks, final values and original DOM. Distinct artifact hashes identify baseline8d/e852 and the candidate. No HMR, source override or probe instrumentation is used for these timings. Helper source fingerprints describe the current filesystem for both roles.

| Condition / run | Page CPU4x settle median before → after / ms | Frame-gap median before → after / ms |
| --------------- | -------------------------------------------: | -----------------------------------: |
| small-idle / 1  |                             1326.50 → 926.85 |                      116.75 → 100.05 |
| small-idle / 2  |                             1207.40 → 993.55 |                      116.70 → 116.65 |
| large-idle / 1  |                            1939.55 → 1597.15 |                      199.95 → 166.70 |
| large-idle / 2  |                            1897.85 → 1618.20 |                      183.35 → 183.40 |
| small-cpu / 1   |                            1725.70 → 1428.50 |                      125.00 → 116.65 |
| small-cpu / 2   |                            1723.65 → 1444.25 |                      124.95 → 108.30 |
| large-cpu / 1   |                            2395.55 → 2150.65 |                      208.35 → 200.00 |
| large-cpu / 2   |                            2343.30 → 2125.95 |                      216.70 → 199.95 |

Quantiles are grouped per execution/condition/scenario; with n=6, p95 is the observed maximum. These observations are not a statistically established or physical-mobile speedup. Page throttling does not prove worker CPU throttling. The full per-run desktop/CPU4x feedback, settlement, frame gaps and long tasks remain in the validation JSON and local matrix evidence. Instrumented counters/CPU profiles are not pooled into these warm observations.

## Validation and remaining work

Fresh application 508 passed/3 existing skips, serial browser19 passed/0 skips, types0 errors/0 warnings, native/entity/ordinary builds and audit169 (167 unchanged plus two existing explicit policies). The 115 non-browser server source files and native artifact are byte-identical to8d; its recorded Node24 server377 results are reused for local validation. The authorized rollout separately records a fresh target-Node24 run and production readiness, without conflating them with these local gates.

All 15 original completion requirements remain active and unchanged. Original callback count, HTML processing and worker execution remain. General raw/copied resource and collection read contracts, arbitrary extensions, import/export/restore/storage budgets, cold/concurrent/physical-mobile behavior and the configured user trial remain required. The actual private Nexus gsub cause is unknown; no card body, script, prompt, story, chat or auth value was inspected. Deployment success does not complete this broader goal.

See display-wire-sizing-validation.json for hashes, boundaries and separate timing groups; the local deployment report/receipt records snapshots, release switch and rollback.
