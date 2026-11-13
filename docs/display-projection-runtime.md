# Display input clock and completed projection

The entity controller must pin display Lua only after the browser has applied the canonical data associated with its display input clock. Receipt identity and server revision checks alone cannot establish that the browser calculated an effect from those data.

## Reproduced failure

The real original UI, controller, Wasmoon worker, CBS, IndexedDB outbox and HTTP/SQLite service were tested in two disposable device contexts with authored neutral data. Device A's actual settings-resource read was held while a canonical settings command changed a default variable from `before` to `after`. Device B applied the new settings normally.

While A waited, its display ledger had input clock 4, snapshot cursor 3 and completed projection cursor 3. Its DBState still contained `before`. The previous capture check compared only the snapshot cursor, so it allowed the old settings to be pinned with clock 4. The actual server accepted `$observed=before` because the command used the current clock. B received this value. After A finished applying the settings, Lua displayed `after`, but durable occurrence deduplication correctly retained the first admitted effect. Deduplication cannot repair an incorrectly captured first computation.

The pre-fix browser regression reached this state and failed the expected capture guard assertion. Its raw output and source hash are preserved separately from the corrected run. An earlier readiness timeout did not reach the probe; its cause remains unconfirmed.

## Controller rule

`captureDisplay` now requires its completed projection cursor to reach both the display snapshot cursor and the input clock. `onChange` records a waiting scope before awaiting the actual read-model projection, then notifies display consumers after applying the change. This complements the existing selected character/chat, scope readiness, source revision, epoch and frozen-body guards.

During the controlled gap, the adapter returns no Lua capture. Original markdown processing still returns sanitized HTML, but no Lua execution or persistent proposal is authorized from stale data. Once projection completes, a fresh capture runs actual Lua with `after`; SQLite stores that value once and the other device receives it. Durable IDs, server receipt policy, VM order, local scope identity and wire budgets are unchanged.

## Scope and remaining work

This regression isolates one real settings projection race and tests its persistent two-device consequence. It does not prove that the entire outer CBS/regex/translation/HTML pipeline is pinned consistently. A temporarily unavailable Lua scope can display the pre-Lua content. Changed DOM/assets, absolute metadata for paged history, all supported editors/import formats/extensions/provider/offline workflows, physical mobile behavior and the practical configured trial remain required.

All 15 requirements in `server-runtime-plan.md` remain in scope and unchecked. Production is not accessed or changed; no private content is opened and no remote push is performed.
