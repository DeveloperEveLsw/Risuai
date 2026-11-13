# Original group images and captured field dependencies

The entity runtime now connects the original group display sidebar to private
field drafts, immutable asset admission and the durable IndexedDB outbox. The
ordinary-storage branch remains the original implementation.

Icon uploads retain the previous icon in ccAssets and leave existing portable
members intact. Groups do not import character PNG metadata or expose the
character spare-icon/large-portrait controls. The four group display modes remain
none/single/multiple/emp. Additional assets retain names, exclusion/style flags
and unknown tuple members; removal and the current chat's fmIndex reset are one
transaction. Uploading additional assets is also available for entity groups,
whose original legacy sidebar only exposed its existing list.

## Composition

The original button creates a256x256 PNG with ceil(sqrt(member count)) columns
and ceil(count/columns) rows and stretches each image into its grid cell. The
member sequence now determines positions, correcting the old completion-order
race. At most four images are decoded simultaneously and they are released after
each batch. Source references are read in pages of128, without fetching member
prompts/chat bodies to acquire images. Missing/broken images fail visibly;
image-load timeout and editor destruction cancel rather than hanging the button.
Empty groups produce the original transparent image. Composition replaces image
without adding the old icon to ccAssets.

hideAllImages uses a freshly captured settings field and the original none.webp
placeholder; later changes reject persistence. Image bytes are uploaded before
attachment. A rejected attachment may leave an unreferenced immutable blob and
never changes the canonical group. Reference lifetime/garbage collection remains
separate work. Display modes and image/asset edits remain browser-side intent;
the server owns confirmed persistence and peer updates.

## Dependency contract

change-fields optionally carries at most128 checks, containing field targets,
expectedRevision and expectedEpoch without a value/remove operation. The store
checks existence/incarnation/field clocks in the same transaction before edits.
These checks neither read source bodies nor rewrite source revisions/events.

Group sources use a separate groupImageSources digest over ordered membership,
its field revision/owner incarnation and every member image's field revision and
owner incarnation. All members participate, including those beyond128; duplicate
occurrences retain their positions. POST /groups/:id/image-sources returns at
most128 image references and coherent count/nextOffset/guard. Continuations and
the final command compare the complete digest. Image or membership ABA,
source/group deletion/recreation and stale continuation reject atomically.
Unrelated member-name changes remain compatible. Successful request-ID retries
return the original receipt even after later source changes.

Bootstrap advertises fieldReadChecksVersion1 and groupImageSourcesVersion1.
Derived commands require a version1 durable outbox and POST
/commands/guarded-fields, with no fallback to the older unguarded endpoint. This
fails closed on a downgraded server that would otherwise ignore unknown checks.
The private editor captures its own image/spare clocks too, so causal head
allocation cannot silently replace its read dependencies. The outbox snapshots
checks/digest before its first IDB await and retains them across reopen/replay.
Stale derived results cannot be rebased to new field clocks. The conflict panel
offers the server value and explains that the image must be recomputed.

No schema migration is needed; schema21 and ordinary commands are unchanged.
Membership is still an aggregate, and the source digest costs O(member count)
metadata reads per page/admission. The page bound is a response/item bound, not
an established byte/CPU budget for arbitrary imported values. External mutable
image references, legacy aliases and complete asset-reference closure need
further work; synthetic validation uses canonical immutable shared assets.

## Validation and remaining scope

Authored fixtures exercise source pagination beyond128, metadata-only guard
checks, duplicates, malformed JSON field types, missing owners, own/source ABA,
incarnations, idempotency and the actual worker/HTTP route. Real IndexedDB checks
cover immutable dependencies/reopen, rejected rebase and unavailable endpoints.
The actual original group UI is checked in two contexts across desktop and both
mobile layouts, including decoded PNG pixels,130-member composition, icon
picker navigation, failures and all-tab offline replay. An optimized,
authenticated original-UI case covers peer decoded pixels, source conflict and
derived replay without development-module imports. Exact current results live
in the local evidence/report rather than treating intent as acceptance.

The full fifteen completion requirements remain active. Further native
image/vision/plugin ports, complete relational/read contracts, large-collection
latency/long-task budgets, physical mobile and configured user acceptance remain
required. Additional TTS work follows the user's exclusion. Validation uses public source and authored synthetic data. Deployment status
and the exact hosted release are recorded separately in the rollout report.
