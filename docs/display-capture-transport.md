# Display worker capture transport

Follow-up: [display source identities](display-source-identity.md) compact matching large immutable source fields in local work keys; raw sources and execution/durable checks remain complete. Its optimized comparison and remaining2.24-second/240ms limits are separate from this transport milestone.

Each large registered immutable display body is sent once per worker lease; later invocations send references with fresh mutable fields. Lua results are not cached, stateful calls are not skipped and the original sequence is retained. This follows [optimized UI measurement](optimized-display-performance.md). Local public-source/synthetic-data scope, schema20 and all15 [completion requirements](server-runtime-plan.md) remain unchanged. No production/private access, model call, deployment or push occurred.

## State and compatibility

Only private recursively frozen JSON registered by the display scope cache qualifies. Shallow freezes, getters, Maps and ordinary mutable containers remain fresh. Roots smaller than4096 UTF-8 JSON bytes stay inline. The sender retains weak source identities and bounded ID/size metadata, not body references in its dictionary. Changed bodies get new definitions; eviction resends a later reused body. Excess current roots are inlined rather than dropped.

The receiver retains canonical JSON strings. It parses every reference independently for every occurrence and invocation, preserving the former JSON projection and alias separation. Undefined object fields disappear; sparse/undefined array entries and nonfinite numbers become null; negative zero becomes ordinary zero; own prototype-shaped keys remain data. Decoded history and variables are private per invocation, while the original Lua globals persist for their VM lease. Fresh source/message identity, revision maps, CBS environment and mutable variable maps accompany each execution. No decoded mutable capture becomes another DBState.

The complete logical scope retains16MiB; each dictionary permits16MiB UTF-8 JSON/512 roots; transport packets permit32MiB to accommodate tags/definitions. Encoded structures have200000-node/128-depth guards. UTF-8 dictionary bytes are not a heap ceiling: JSON strings, Lua values, existing size caches and other application state also consume memory. User arrays/objects are tagged explicitly, so token-shaped JSON cannot impersonate a reference. IDs, definitions, evictions, declared sizes and expanded alias bytes are checked before committing dictionary changes.

Timeout, owner closure and worker lifetime end clear the dictionaries. A malformed capture is fatal: the actual worker rejects and terminates, the browser retains safe source presentation and submits no partial display proposal. Ordinary Lua errors keep their existing policy. Original CBS/regex/Lua algorithms and display admission rules are unchanged.

## Actual worker and correctness evidence

The client-compiled Svelte fixture executes actual worker Lua/CBS with a100045-byte history definition. The first encoded packet is102027 bytes; the next is1971 bytes with zero new definitions. These are exact JSON packet bytes for the authored fixture, not browser IPC allocation or production network measurements.

The first two invocations both read canonical counter0, their private edits are private-1/private-2 and the original global count advances1→2. Canonical counter9, replacement history and changed CBS environment are visible with count3. A new worker gets the current data/full definition and count1. Injecting an unknown reference produces a failed draft, preserved source, zero commands, worker termination and zero dictionary entries. Closing the earlier owner also clears its dictionary.

Five unit cases include1000 seeded arbitrary trees compared with original JSON projection; explicit Unicode/tag/sparse/prototype/alias/inline-negative-zero cases; mutable/shallow/accessor/Map values; replacement/eviction/resend/inline overflow; failed-encode atomicity; malformed packets; dictionary overflow; and expanded16MiB alias rejection. The inline negative-zero discrepancy found in review was fixed before the candidate build/full tests.

## Optimized UI comparison

Same unchanged helper and observer, original checkbox/CBS/16 regex scripts/Lua/sanitized HTML,100 mounted messages,1068010 source bytes and9600 HTML cells. Six rows depend on the toggle. Every click still completes106 Lua calls including94 independent-row calls, with stable original rows and independent HTML. Completed worker messages are observed without changing HTML or outputs.

There are12 unprofiled warm observations per scenario/stage,48 total. Values are descriptive median/p95 using nearest rank; with12 samples p95 is the observed maximum, not a population-tail estimate.

| Scenario / measure, ms                       |  Previous bundle | Candidate bundle |
| -------------------------------------------- | ---------------: | ---------------: |
| Desktop checkbox                             |     22.00 /26.30 |     21.15 /32.20 |
| Desktop complete refresh                     | 1272.45 /1336.60 | 1146.60 /1199.90 |
| Desktop maximum frame gap per click          |   100.00 /100.10 |   100.00 /100.10 |
| Mobile emulation checkbox                    |     42.55 /64.20 |     41.85 /56.90 |
| Mobile emulation complete refresh            | 2519.10 /2822.20 | 2426.25 /2648.90 |
| Mobile emulation maximum frame gap per click |   266.60 /300.00 |   250.00 /300.00 |

Mobile is390×844/page CPU4× emulation; worker CPU throttle is unverified. Physical mobile and concurrent-device acceptance are incomplete. Mobile long-task count is12→13 and the longest task274→282ms. The measured settlement reduction is small, while approximately250ms frame gaps and2.4-second settlement remain. This does not resolve the user's2–3-second waiting problem or prove universal speedup. Next measurements must distinguish synchronous first CBS/HTML preparation/layout from fresh Lua calculation and capture decoding.

The prior bundle index hash is a119f65528a17504fcea5716836de35b7f3660ac28534044994cb2f74a77fd8a, attributed by the prior ed4fc6c receipt; candidate hash is cc0243aca467703d2b3226feff4740e07bb41272e2a0b8b581e4fd0d8cd7c677. The before measurement records then-current in-progress source while running the earlier bundle; those source hashes must not be labeled ed4fc6c source. Helper hash, fixture and observer are identical. New transport source fingerprints are recorded separately in the validation receipt.

## Gates and remaining scope

An independent source override disables only immutable capture-reference recognition. The dev worker actually loads that override; two observations per desktop/mobile-emulated scenario retain106 calls,94 independent-row calls, final values and stable DOM. Those four dev observations are a semantic control, kept separate from the48 optimized comparison samples. Original source files are never mutated by the override.

Types0errors/0warnings, app472passed/3existing skips, backend354, native/entity/ordinary builds and169 structural checks (167original/2existing policies) pass. Serial browser regression12 means9 built original-UI cases plus1 built-worker,1 client-compiled Svelte scope/actual-worker fixture and1 dev original-UI worker case. Their count does not establish the full user trial. Native artifact hash remains692e674125e28c4d4352b2d45082f6beab42eab8eb6c5fc5bafe91f92709d411.

See [capture-transport-validation.json](capture-transport-validation.json) and workspace evidence/local-capture-transport-* / evidence/local-responsiveness-logs/capture-*. One concurrently started Vite fixture import failed; direct isolated HTTP and the isolated actual-worker case passed. Cause is unconfirmed; final regressions ran serially. Intermediate/final evidence and failures remain distinct.

Complete raw/cloned/field/map/collection resource dependencies, extension policies, import/export/assets/retention/storage budgets, cold/configuration/large changed HTML workloads, physical mobile lifecycle and the practical full trial remain. Existing15 conditions and the goal stay active.
