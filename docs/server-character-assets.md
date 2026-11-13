# Character image and asset controls in the local entity UI

The character display sidebar now sends field commands for the original portrait,
spare icons, emotion images, generated-image configuration and additional assets.
This is part of the original fifteen requirements; group composite images and
native image/vision capabilities still need implementation and acceptance.

## Ownership and storage

The editor uses twelve portable character fields and the selected chat's fmIndex.
Its private draft is keyed by stable character/chat IDs. Simple name, style and
preview-exclusion edits send their changed field, without serializing unrelated
image-generation settings. Icon selection and its spare-icon list share one
guarded transaction. Screen/inlay changes call the original updateInlayScreen;
their captured read fields participate in the same server comparison. Removing
an additional asset and resetting that chat's greeting selection are atomic.

File selection captures field values and their revision/incarnation clocks before
opening the actual browser picker. Binaries use existing immutable shared-asset
admission before the guarded attachment. A competing edit, including A to B to A,
rejects attachment. Closing or navigating away from the opening editor cancels
its attachment; it cannot modify the next character. A rejected late attachment
can leave an unreferenced immutable blob under the existing retention policy.

Original PNG metadata names and the 20,000-character per-chunk limit remain.
Unknown portable fields and array members survive ordinary edits; changing the
image mode intentionally uses the original replacement/default semantics for
newGenData. File-name/extension and icon rotation semantics remain the original
ones. Opening absent optional settings does not persist defaults. Emotion inlay
activation creates an absent additionalAssets array; disabling it removes an
empty array as in the original controls.

Media previews use a per-reference await block rather than assigning asynchronous
results into a shared array indexed by the currently selected character. The
editor keeps the original selected display tab across character/chat navigation.
Ordinary browser storage continues through its existing sidebar branch.

## Local trial

Run pnpm trial:local and open the printed loopback URL in two independent browser
profiles. Use the original Character editing tab and Character Display page.

1. In Character Icon, select a small authored PNG, switch a spare icon and change
   Large Portrait. Inspect the other profile and reload it.
2. In Additional Character Screen, choose Emotion Image and upload named images.
   Rename an emotion and switch the inlay option. Image Generation retains the
   original prompt/instruction fields and mode defaults; this editor does not
   establish native image generation support.
3. In Additional Assets, upload authored images or passive files, rename a row,
   toggle preview exclusion and remove a row. Shared media URLs and saved bytes
   belong to the server; removal resets the current chat's greeting selection.
4. Leave a picker open while the other profile changes its target fields. A stale
   attachment reports a failure. Navigate to another character before completing
   a picker and verify that character stays unchanged.
5. Edit a row name offline, close all trial tabs, reopen the same database/origin
   and verify replay. Competing row-list edits show the existing conflict buttons;
   choose the server value or explicitly apply the local change.

The browser fixture uses authored PNG/CSS files, actual file chooser interception,
independent browser storage, both mobile layouts, field conflicts and offline
all-tab replay. A separate negative control selects the existing legacy sidebar
branch: its name edit is visible locally but is neither stored nor shared.
Exact passing commands and counts belong to the milestone's verification receipt.

## Remaining work

Emotion/additional/spare collections remain portable field aggregates: same-list
edits conflict explicitly, rather than providing per-item merging or pagination.
Large collection import/render/serialization budgets and timing still need
representative measurements. These small UI checks are not proof of latency on
large cards or physical mobile suspension. Group composite images, mutable asset
aliases, offline binary upload/cache/lifetime policy, full native inlay/vision and
plugin image capabilities remain within the complete goal. TTS additional work
is excluded by the user's existing decision. No production access, personal
content, real provider request, deployment or remote push is part of this local
milestone.
