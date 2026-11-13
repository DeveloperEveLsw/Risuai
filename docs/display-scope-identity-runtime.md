# Concurrent display presentation identity

The original server generation, relational storage and multi-device goal remains active. All 15 completion requirements remain unchecked. The configured user trial is unfinished; production and private content remain untouched.

## Reproduced problem and change

Two new tests execute the original Wasmoon Lua and CBS. With the same durable occurrence, cursor and presentation text, concurrent captures of a changed local variable returned `0/0` instead of `0/9`; a changed trigger environment returned `before/before` instead of `before/after`. Their failing pre-fix log is preserved in the parent workspace. Fresh captures were correct, but the asynchronous manager merged their results.

The manager now computes a separate local presentation scope hash before coalescing. It includes the captured database, character/chat aliases, definitions, modules/lore, local/shared variables, state, source/policy, environment and all three revision maps. This hash enters only the in-flight key. The durable display occurrence, server receipts, CAS and original VM lease key remain unchanged. Exact duplicate captures still share one calculation; changed local presentations execute separately.

## Cost, order and lifetime

Only private recursively frozen plain JSON containers receive owner-side weak identities. Shallow freezing, mutable Maps, accessor containers and cycles cannot qualify. Tagged array/object/frozen/shell encodings prevent ordinary JSON from impersonating a frozen token. Private chat/character/database forks are bound weakly to their frozen base: every invocation compares field references and records changed, replaced, added and removed fields. Unchanged scalar settings do not need another full encoding. Fresh mutable shell fields are read and serialized synchronously before the first await. Shared frozen histories/settings need only their weak identities, so this does not serialize an entire history for every row. Unregistered adapters compare complete JSON values instead. Key scans and initial registration still cost owner time.

The local signature has its own 200,000-node/128-depth and 16 MiB encoded-JSON budget; this can be more restrictive than the worker wire size for an unregistered capture. Its primitive length cache retains at most 256 strings and 2 MiB of logical UTF-16 content and clears on owner closure. Weak identities retain no containers. These are bounds on particular structures, not a hard process heap quota. Initial freezing, private dictionaries, cold strings, structured clone and rendering still have costs.

Hashes begin independently. A bounded preparation queue admits captures in their original order per server/chat/epoch, without awaiting Lua execution and without blocking another chat. This prevents asynchronous digest completion from reversing original VM globals. The queue limits are 128 pending preparations per chat and 128 times the configured VM limit across the manager. Existing per-lease execution limits remain. Capture, malformed/oversized scope and digest failures report a display error and return the original text; no failed preparation starts Lua or persists effects.

## Verification and remaining work

Original Lua regressions cover both reproduced errors, exact-duplicate coalescing, changed frozen bodies/private variables/version maps, durable identity stability, shallow-freeze/Map rejection, cyclic/oversized scope, reordered digest completion with another independent chat, and recovery after a failed digest. Existing partial-history, provisional admission, metadata, pending receipts, VM globals/bounds and owner-close tests remain.

The client-compiled Svelte fixture uses actual workers and original Lua/CBS, holding its first invocation while a second capture arrives. Seven cases cover exact duplicates, local values, fresh trigger environment, revision maps, private fork values, nested history and nested modules. Distinct cases retain two invocations and ordered globals; duplicate requests execute once. Environment/version/private changes still reuse one frozen body. This is a neutral boundary fixture, not proof of every actual editor or configured user workflow.

The witnessed comparison supplies the exact `075c55e` manager/cache adapters through isolated Vite overrides and verifies both actually load. The same current original UI/helper/fixture runs 30 warm observations per variant/scenario. All 56 Lua calculations and 44 independent row recalculations remain; both variants prepare one body per toggle. This compares two adapters, not the complete previous checkout.

| p95 or task count     | Prior adapters | Final correction |
| --------------------- | -------------- | ---------------- |
| Desktop click         | 43.2 ms        | 52.6 ms          |
| Desktop settle        | 540.6 ms       | 529.2 ms         |
| Desktop frame gap     | 16.8 ms        | 16.8 ms          |
| Desktop long tasks    | 0              | 0                |
| Page CPU4x click      | 32.4 ms        | 27.9 ms          |
| Page CPU4x settle     | 1,008.7 ms     | 1,068.2 ms       |
| Page CPU4x frame gap  | 100 ms         | 133.4 ms         |
| Page CPU4x long tasks | 30             | 30               |

Results are mixed: correct scope comparison adds work, the slow-page frame/settle cost grows, and all slow-page long tasks remain. An earlier full-shell encoding observation had a 250 ms slow-page frame p95 and prompted cheaper unchanged-scalar differences; that historical observation is unpaired and does not isolate the final optimization's causal benefit. The current source-hashed adapter comparison is in the parent workspace `evidence/display-identity-comparison.json`. Neither result establishes worker throttling equivalence, physical mobile OS/network/cold assets or universal response times.

Original UI/IDB/two-device/tab-exit, worker timeout and optimized bundle regressions are recorded separately in `local-validation.json` after verification. Physical mobile OS, full extensions/editors/formats/restore/provider/offline configuration, projection/ledger consistency, absolute partial-history metadata, changed HTML/DOM/assets and the full trial remain required. The earlier shared-scope milestone is historical evidence.

```bash
pnpm test src/ts/runtime/browserDisplayLua.test.ts
RISU_DISPLAY_REUSE_OUTPUT=/tmp/display-scope-identity.json \
  node --test server/browser/displayScopeCache.test.cjs
```

Next: reproduce the ledger/projection timing gap, preserve canonical absolute positions/counts with paged history, verify changed DOM/assets, and complete the remaining original 15 requirements.
