# Bounded history windows and original bookmark navigation

A bookmark jump now reads a contiguous window around its stable message ID instead of loading all preceding message bodies. The original BookmarkList callback uses the accepted current index after display hydration. Historical views expose earlier/later pages and a return to latest; another device's new response stays outside that view until navigation.

This is a navigation foundation. The original list still resolves loaded messages. Full canonical bookmark pages and outside-page original HTML previews with independent provenance remain required. Schema14 and all15 completion requirements remain unchanged; the full configured user trial is incomplete.

## Read contract

- `/chats/:id?limit=N&around=messageId` finds the canonical owner and dense ordinal, clamps a centered page and seeks ordered positions. Unknown, removed or foreign anchors reject.
- `before=position` reads preceding rows; `after=position` reads following rows. Conflicting boundaries reject. Browser navigation uses its existing page size100; the HTTP contract still permits bounded limits up to1000.
- Gaps from deletion retain stable IDs and canonical dense ordinals. Count/offset and `hasEarlier/hasLater` describe the full history; empty boundary reads do not invent rows.
- The query decodes only selected message bodies. Dense counts and offset seeks can still scan indexed entries; this is not constant-time lookup for arbitrarily large histories. Metadata, tombstone and display-admission histories retain their existing size limits.
- Generation retains the full execution snapshot. Browser pagination does not truncate the original model context or replace native Node/WASM execution with Chromium.

## Projection and races

A navigation captures chat, selection generation, epoch and navigation generation. Replacement checks existing history/removal/attribute fences before removing out-of-window rows. Surviving loaded message objects and arrays remain stable. A stale read retries the requested anchor; a removed anchor rejects rather than resurrecting.

Automatic reorder/job refresh cannot retire an in-flight user navigation. If that request fails after a deferred reorder, the old window refreshes against current canonical ranks. Selecting another conversation retires navigation immediately, including its loading indicator. A newer jump retires an older latest-return request; the controller returns false so the original scrolling callback cannot scroll the newer screen.

Historical views project total count/rank changes but omit unloaded remote message edits/appends and job presentation tails. The original HTML/Lua sees canonical ordinals and full counts. After server completion, a bounded refresh preserves the historical anchor. Latest mode retains its prior append and older-page behavior; automatic older-page scrolling is disabled while a historical replacement loads.

The original bookmark callback recomputes the target's stable-ID index after display hydration. If another device removed it during that await, the jump returns -1 and retains the list instead of closing it and scrolling to an unrelated index.

## Retired presentation policy

Rapid original navigation and peer changes reproduced `Display scope preparation queue limit reached` despite bounded message reads. Checking retirement only at parser entry was insufficient: already queued obsolete presentations still occupied capacity.

The original ChatBody supplies a private viewport-lifetime guard. Navigation, conversation selection and destruction retire that owner; ordinary variable/overlay rerenders keep their original stateful script calls. The parser checks it after its task yield and assets; the display queue checks it before preparation and before entering Lua. A queued calculation from a retired viewport releases its turn without entering the VM. Independent guarded owners do not share an abandoned result. The finalizer cannot admit a retired presentation.

Original Lua already executing finishes; its VM globals are not rolled back. Live unguarded calls retain original order and the existing240-distinct-call acceptance. Queue/context/wire budgets are unchanged. This explicitly cancels abandoned presentation work before script execution; extensions cannot assume that a discarded renderer will execute its display script. Arbitrary live bursts, synchronous first CBS, plugins, translation/inlays and physical mobile limitations remain.

## Evidence and trial

Current final acceptance is recorded in `docs/local-validation.json` and the local history-window evidence directory. Targeted failures and prototype sources are retained separately and excluded from final pass totals. The final sequence checks types, application/backend regressions, extraction audit, native build, fresh entity/legacy builds, an isolated-cache CLI smoke and the sequential browser suite.

The authored220-message browser fixture uses two independent contexts, actual IndexedDB/HTTP/SQLite and one actual native request to a loopback synthetic provider. It verifies the original loaded bookmark preview/jump, original Lua ordinal128 with canonical count218 then220, bounded100-body windows, overlap identity, original earlier/later/latest controls, late-selection rejection, latest preemption and peer target deletion during held display hydration. Canonical count ends219 after that deletion. No actual user content or credentials are read.

For a local manual check, follow the launch procedure in `docs/server-runtime-plan.md` and use disposable data. Open the same conversation in two devices, jump a loaded bookmark, create a new response on the other device, then use later/latest controls. Confirm that the historical viewport stays contiguous and the new count changes. Repeat while switching conversations or deleting the target on the peer. Complete the remaining original list/preview and branch contracts before declaring the full trial ready.

Production remains unchanged; no SSH, deployment, restart or remote push occurs in this stage.
