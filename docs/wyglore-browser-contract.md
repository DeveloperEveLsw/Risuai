# WygLore Leaf browser integration contract

Scope: original WygLore Leaf 3.1.6 / Risu plugin API 3.0, author revision
`f028901324a87053ea72b361073744900aabc763`, distributed bundle SHA-256
`5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c`.
The entity path now keeps the original engine and its original settings handlers
in one fenced server process. `PluginSettings.svelte` opens the
`ServerPluginUI.svelte` modal, whose browser client projects sanitized snapshots
into an opaque iframe and forwards events to those original handlers. Admission
is behind the server capability flag and the reviewed release digest. This is
host adaptation of the original plugin, not an independently rewritten memory
algorithm. DOM controls, layout-dependent widgets and file operations have
different capability coverage, detailed below.

## Implemented application boundaries

| Boundary                                             | Entity server path                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entity bootstrap / `plugins.svelte.ts`               | The supported original release is admitted to the native host; it does not boot a second browser graph writer. Unsupported releases retain explicit capability rejection.      |
| `PluginSettings.svelte` / `ServerPluginUI.svelte`    | The plugin settings entry captures the current stable chat ID, epoch and selection. Closing the modal or changing that selection closes its opaque owner.                      |
| `serverPluginUI.ts`                                  | Reads capability/server identity, opens the authenticated owner, polls progress, forwards exact scoped events and closes with keepalive on pagehide.                           |
| `server/native/pluginUIRuntime.cjs`                  | The same original VM/engine owns UI callbacks, staged storage and execution context. It opens the original registered setting callback and checkpoints complete UI operations. |
| `server/native/pluginUISession.cjs`                  | Sanitizes original DOM/style snapshots, maps connected original nodes, validates scope/revision/form values and records durable event admission before invoking a handler.     |
| API v3 plugin storage                                | The entity path uses the server namespace and renewable fenced writer. It does not use the legacy `_coldplugin`/OPFS browser fallback.                                         |
| `getDatabase()` / current character and chat         | The native host provides guarded authoritative fields and records their read dependencies. Lazy browser DBState is not treated as the full catalog.                            |
| Original before/after generation hooks               | Registered by the native host with the enabled, exact reviewed bundle. Browser display projection does not register duplicate hooks.                                           |
| Main document access                                 | The server DOM belongs to that isolated owner; the browser receives an opaque projection, not raw access to the application's main document.                                   |
| Plugin replacement / deletion / other-device changes | Resource incarnation, digest, read dependencies and writer fence invalidate stale ownership before writes. A new UI session must open from current authoritative state.        |

The legacy API v3 iframe remains a separate path for ordinary browser plugins.
Blindly loading all plugins during entity bootstrap would still activate legacy
cold-storage/DBState writes and unsupported hooks, so it is not used as a shortcut.

## Original bundle behavior that affects separation

The unchanged bundle does **not** expose an API to boot only its UI. Before
registering its settings menu it awaits `bootEngine()`, performs archive cleanup,
snapshot pruning, migration/persistence, storage auditing and, when a garden
exists, canonical ingestion. A delayed gzip migration can also write after boot.
Opening a session-bound UI tab can synchronize the garden, ingest canonical
sources and refresh persona state. Consequently, suppressing browser
`beforeRequest` registration alone does not make the browser a read-only viewer.

The bundle has its own storage caches and a graph object. Updating the host's
storage bridge cannot invalidate these internal objects. A stale write must
therefore fail and terminate/restart that original plugin instance. Automatically
fetching a newer revision and retrying the old graph would turn conflict detection
into an overwrite.

The original file is verified by digest before host execution. A narrow runtime
instrumentation seam exports existing lifecycle functions, including the original
`_panelSyncTail`; the executable copy is instrumented and must not be described as
byte-identical to the stored distribution. Boot/session/memory work runs in the
server owner. The browser still pays the ordinary cost of parsing, patching and
painting the sanitized UI, bounded by node and byte budgets.

## Fenced storage client

`src/ts/runtime/serverPluginClient.ts` implements one fenced session with the
original async `pluginStorage` methods: `getItem`, `setItem`, `removeItem`,
`clear`, `key`, `keys`, `length`. The coordinator supplies an already admitted
lease; the client cannot acquire permission or impersonate a server job.

Namespace identity is `{pluginId, bundleSha, pluginEpoch}`. The lease contains
the writer ID, opaque token, monotonically increasing fence, expiry and namespace
revision. The initial `readAll` must match the lease revision and identity before
any original-plugin bootstrap starts. Values remain JSON, with independent
copies so that mutating a returned object is not an implicit storage write.

Storage operations serialize within a session. The default checkpoint mode stages
graph values for same-session reads and commits all changed keys atomically at an
explicit complete-operation boundary. A chunk written without its new manifest
is not visible to another device. `checkpoint()` is a coordinator operation, not
an automatic timer. `closeAndCheckpoint()` stops new API admission, drains already
admitted calls, waits for the final acknowledgement and closes the local session.
Calling it requires the original operation to have completed; interruption while
an operation is incomplete uses `close()` and discards its staged writes.

An opt-in `per-operation` mode acknowledges each individual API write. It is
suitable only for a proven independent single-key setting; it does not establish
safe original multikey graph persistence and is not the original-plugin default.

A commit carries the current
namespace revision, a fresh commit ID, and a copied lease. The client promotes
its local snapshot only after the server acknowledges that exact commit,
namespace and next revision. Namespace/epoch changes, external revisions, expired
leases, storage conflicts and uncertain network outcomes permanently invalidate
the session. They do not silently retry a cached graph. The coordinator receives
`onInvalidated` and must remove menu callbacks, destroy the iframe and release its
lease before permitting a fresh instance. A coordinator-renewed lease is accepted
only if writer ID, token, fence, namespace and current revision match; renewal
cannot impersonate ownership transfer.

Ordered server change events are observed after any in-flight acknowledgement.
This prevents a session from treating its own acknowledged write as an external
conflict when the event arrives first. Older ordered events do not revert the
session. `close()` blocks further local API calls immediately; the coordinator
still owns release and remote cleanup.

The API transports are injected. No unauthenticated endpoint, permission bypass,
whole-DBState save or local-storage fallback is introduced by this client.

## Writer lifecycle for the original UI

1. Resolve an installed plugin record by stable resource ID, original script
   digest, current incarnation and enabled state. Keep API v3 script-hash
   permissions; a replacement script requires a new permission decision.
2. Before executing an original editing UI, obtain the plugin's browser writer
   lease and an exact storage snapshot. The lease is plugin-wide, including other
   chats and devices, because global settings and garden indices share keys.
3. Map the API v3 storage aliases to that session. Do not let either v2 aliases,
   old `setDatabaseLite`, delayed migration callbacks or plugin arguments become
   an unguarded DBState write. Empty save-dirty hints are not database commands.
4. Original before/after generation hooks execute on the native server host. The
   browser coordinator must prevent duplicate local generation hook execution;
   permission denial must also prevent native registration.
5. Before admitting server generation, wait for a complete original UI operation,
   checkpoint its staged graph, unload the editing UI and release its
   lease, or report that another editor currently owns the plugin. Arbitrarily
   taking over a still-valid browser writer would allow its delayed writes to
   corrupt a newer server graph. A hidden or terminated tab releases ownership
   through a short renewable lease, not through an assumed `pagehide` event. A
   lease release while final checkpoint acknowledgement is pending is unsafe.
6. A server worker's storage authority is its job owner/fence/chat incarnation.
   Cancellation or job ownership loss invalidates plugin writes. Background
   memory work needs a durable owner after the generation job finishes; detached
   browser timers do not satisfy this requirement.
7. On another device's plugin change, lost acknowledgement or writer conflict,
   invalidate the server original instance and its browser projection. Reopen from authoritative data
   after ownership is available; never rebase old graph writes automatically.

This ownership model preserves data safety but serializes plugin writers across
chats. A future per-garden lock needs proof that global settings/index/migration
keys are independent; key-name heuristics alone are insufficient.

## Validation delivered for the client primitive

Focused Vitest tests cover parallel API calls, read isolation and falsy JSON,
namespace revision conflicts, acknowledgement loss, own event-before-ack order,
external event invalidation, script replacement/incarnation changes, wrong
acknowledgements, stale initial snapshots, expiry/close, lease renewal, guarded
clear/remove, atomic chunk/manifest staging, incomplete-operation discard,
checkpoint conflicts and async-close admission barriers.
They use synthetic settings/graphs without reading deployed conversations or
contacting model providers. That storage primitive is not the production original-UI writer: the current UI
path uses `pluginStorageSession.cjs` in its server owner. Original handlers, route
ownership and actual browser rendering are tested separately; synthetic storage
results do not establish full plugin UI compatibility.

## Server confirmation and progress DOM boundary

`server/native/pluginDom.cjs` provides a scratch DOM using the existing production
`node-html-parser` dependency. It supplies the element/text/tree/class/style and
listener operations used by the original cold-start confirmation and progress
overlays. It does not render a browser or fabricate layout measurements. An
unsupported DOM operation marks the bridge unhealthy even if the plugin catches
the thrown error; the native host must check this state before persistence.

For a non-progress original `role="dialog"`, the bridge enumerates the original
enabled button labels and passes them to the existing durable `alertSelect`
host. A valid answer dispatches only the selected button's original click
callback. It does not translate labels into guessed decisions or resolve a
missing DOM as permission to proceed. Missing interaction capability, an invalid
answer or an original timeout closing a dialog before its durable answer marks
the job unhealthy. The coordinator must abort/close any remaining durable
interaction on such failure.

The original `.at-coldstart-overlay` remains a progress view and can run during
provider work. Its current text and original control IDs/labels are emitted as
`plugin-ui` progress. `dispatchAction(id)` calls an original callback only while
its button is connected and enabled. It never starts an unawaited blocking
selection beside provider work. The server transport still needs an authenticated,
job-fenced progress-action command to expose these IDs to users; exposing an ID
alone does not establish that the application has that control wired.

The bridge accepts the job AbortSignal, closes callback IDs on stop and offers
`assertHealthy()`/`check()`. Native workers must use the check at final persistence
and propagate `onFailure` to their sticky execution failure. The bridge is not a
replacement for the full original settings UI, nor is its DOM a raw
main-document permission grant.

Focused Node tests include the unchanged function spans of the hash-verified
author bundle for cold-start skip/proceed and overlay progress/cancel behavior.
Appearance-only CSS/icon fixtures are used for that narrow test; full bundle
execution belongs to the native integration gate. Tests never download a fixture
automatically. When the pinned public cache is missing those two tests report an
explicit skip; a compatibility release gate must provision and verify the cache
and require actual execution.

## Original UI snapshots and event transactions

`createPluginUISession(window, options)` requires an authoritative `guard`, the
original lifecycle's `settle`, an atomic `checkpoint`, and durable receipt adapters
`read/admit/complete/fail`. A lightweight `prepareEvent` waits only for the original
panel sync tail before event admission. Full persistence after each completed
handler belongs to `settle` and the checkpoint. Calling the full flush before
validating every event could itself change original telemetry/UI and invalidate
a fresh browser revision.

The exact public scope contains session/plugin/digest/epoch, character/chat/chat
epoch and writer ID/fence. The private lease token and trusted DB scope never enter
the iframe. Snapshots contain revision, allowlisted HTML/CSS, explicit form
property states, visible/busy flags and capability flags. Stable node IDs are
stored outside HTML attributes of the original tree. HappyDOM's select proxy
identity and stale selected-options cache are adapted so original handlers see
current checkbox/radio/select/textarea values rather than fabricated defaults.

An event must name the exact scope, current revision and connected original
node, with a fresh `plugin-ui:<UUID>` ID. Unsupported type/field, disabled or
read-only input, invalid numeric/selection payload, old node or changed scope is
rejected before admission. The admitted hash contains the wire request; durable
rows contain IDs/hash/proof, not chat text, API keys, snapshots or typed values.
After the original callback and its queued work settle, graph/chat writes and
receipt completion commit in the same SQLite transaction. A read-only
`receipts.complete` verifies that proof; it is not a second completion transaction.

A completed exact event can return a fresh guarded view without repeating the
original callback. Admitted/failed events are uncertain and never auto-replayed.
The browser may perform a body-free receipt lookup after losing the response;
it verifies event/session/request hash/commit ID. A confirmed completion with a
closed owner reports saving confirmed and asks for a fresh settings window.
Incomplete/unknown outcomes stop that UI instance. Explicit stale-event rejection
can refresh its display, but does not silently resubmit that user action.

## Opaque browser renderer and current limits

The server DOM facade repairs two observed HappyDOM 20.1.0 selection differences:
its selected-options cache and its count/index mix-up when a preselected option
is inserted into a single select. The original unit editor preselects its type
before insertion; the facade preserves that actual option and selected index
instead of substituting a plugin-specific value. The insertion fixture is checked
against actual Chromium semantics, and the original relation create/edit/reopen
test checks persistence. The dependency-specific seam is scoped to active DOM
owners and restored when the last owner closes.

`openServerPluginUI({pluginId, owner, ...})` exposes snapshot, subscribe,
dispatch, refresh, resolveEffect, downloadArtifact, closed and close.
`mountServerPluginUI(container, session)` exposes
iframe and destroy. The caller owns closing the session when unmounting; pagehide
also sends keepalive close. The one-second polling loop continues during an
accepted asynchronous event so progress remains visible.

The iframe has `sandbox="allow-scripts"` without `allow-same-origin`, a random
script nonce, and CSP forbidding network, nested frames, external fonts, forms and
plugin scripts. The only executable script is the fixed trusted renderer. Initial
HTML contains no plugin markup; snapshots arrive on a one-use MessageChannel
whose setup checks the parent source and random secret. Writer lease tokens and plugin JavaScript do not enter this channel, and the
application's provider transport credentials are not attached. Original plugin
settings fields use this same authenticated projection; if the original provider
settings UI displays a configured API key/password input, that field can be seen
by the authorized settings owner. It is not copied into durable event receipts
or diagnostic logs.

The renderer patches keyed original DOM nodes, preserves the active input,
cursor, draft and scroll, and serializes original input/change events. Queued
unadmitted draft events use the latest acknowledged revision only while their
same original keyed control survives. Progress views cannot overwrite a draft
while an older accepted input is awaiting its acknowledgement. A replaced or
removed control stops queued input; accepted events are never repeated to repair
an uncertain response.

Click dispatch uses an actual MouseEvent, preserving native summary/details
default behavior and the original `toggle` listener, including preventDefault.
Supported transport operations are click, input, change, blur and the supported
keyboard keys (Escape/Enter/Tab), with checkbox/radio, textarea, numeric and
single/multiple select values. Connected editable form controls explicitly expose
native input/change/blur value synchronization even when the original plugin
registers no field listener: the original unit modal reads its fields' `.value`
in the save-button callback. Those events update only that scoped original
control's properties before dispatch; they do not grant unregistered clicks or
keyboard callbacks. Disabled/read-only/file/button inputs and invalid options,
numeric ranges or oversized values remain rejected before admission. The normal
event queue delivers these updates before the original save click.

The reviewed original web panel uses CSS cards,
rings and relations with click inspection/editing, modals and multiple selection;
it does not require a canvas or pointer/wheel/drag listener bridge. These original
handlers use the supported DOM event path; their dedicated original-UI acceptance
checks are separate from the setting-toggle checks below.

Help popovers keep their original content and open/dismiss handlers. The fixed
renderer finds the original help anchor through its `aria-describedby` and
popover ID, measures the actual browser rectangles, and applies the original
six-pixel anchor gap and eight-pixel viewport inset. Resize and scroll recompute
that placement locally; no coordinates or original plugin source execute on the
server's behalf in the browser. This placement does not provide a general layout
API or main-document bridge. CBS floating/widget mounting remains unsupported.
The server realm reads the original emergency-disable flag as active so the
default-enabled three-second mount cannot poison the memory engine. The stored
setting, imported source and memory are unchanged; manually releasing that guard
fails before any unsupported main-document mount. Navigation and arbitrary main-document access
also remain outside this projection. Inline file inputs are visibly unavailable;
the original file APIs use the trusted parent transfer boundary below. Disallowed
elements/URLs and unsupported event fields remain rejected.

The original provider-tab cache diagnostic reads the authoritative fields
`automaticCachePoint`, `claude1HourCaching`, `claudeRetrivalCaching` and
`promptTemplate` beside the guarded character catalog. Those reviewed reads keep
the settings revision/incarnation dependency; peer changes invalidate an event
before persistence. The original model field's 250-ms timer and provider-field
queue's 400-ms debounce are also part of event completion: a digest/profile-guarded
execution seam drains the pending original flush callbacks before the database
checkpoint and acknowledgement. It does not wait for arbitrary presentation
timers or invoke unmodified old controls with no pending save. The browser test
verifies the actual original model and API fields survive closing immediately
after their successful admitted input replies.

Validation includes the public original setting callback and toggle, strict
scope/stale/forged-event cases, asynchronous progress, exact receipt replay,
DOM/CSS sanitization, browser transport and body-free lost-ACK proof tests. The
isolated Chromium renderer test uses only synthetic controls and proves opaque
origin/CSP isolation, rapid ordered typing, focus/cursor/scroll retention,
checkbox/select/multiselect/textarea values and keyed tag replacement. The actual original browser integration test provisions temporary SQLite with the
hash-verified public distribution, calls the real owner HTTP routes and the
compiled execution context, navigates all seven original main tabs and a visible
advanced summary, changes the original toggle, verifies its atomic durable
receipt/storage, preserves an original focused field across polling, and
closes/reopens with the stored setting. It changes the original model and API
fields, waits for each HTTP input reply, immediately closes/reopens and verifies
the values and completed receipts. It also opens two distinct original provider
help anchors and the usage-tab help popover at upper and bottom-right positions,
checks real viewport placement and invokes their original outside-click
dismissal. It does not activate provider probes, network/model-list/OAuth controls
or advanced main-document actions, and contacts no model provider. The separate HTTP/runtime gates
cover ownership, concurrency, stale sources and generation handoff.

## Trusted parent file and clipboard effects

The original server UI can publish up to four explicit pending effects beside its
DOM snapshot: file selection, confirmation, clipboard copy or download. An effect
has a UUID, its admitted `plugin-ui:<UUID>` event ID and kind-specific metadata.
Effects can change while the original DOM revision stays the same and the event
is busy; polling continues to surface those changes. The opaque iframe receives
no effect payload. Trusted controls in `ServerPluginUI.svelte` handle these
interactions outside the plugin projection without executing plugin JavaScript.

`POST /api/runtime/plugin-ui/:sessionId/effect` requires the same runtime identity
and opaque owner header as its session. The client accepts only the exact currently
advertised effect, an allowed kind-specific answer and one submission attempt.
It verifies the acknowledgement identity and then refreshes. An uncertain reply
never causes automatic repetition of a file operation, copy or download. Confirmed
file cancellation or rejected confirmation may close the server owner; a subsequent
`PLUGIN_UI_CLOSED` or owner `FORBIDDEN` response closes that local window without
turning confirmed cancellation into an ambiguous error.

File selection is a native trusted-parent input restricted to JSON/plain text.
Files must have a safe basename and contain valid UTF-8, with an eight-MiB byte
limit; the browser and server both enforce the boundary. File-picker cancellation
is an explicit `file:null` answer. Clipboard copy starts `navigator.clipboard.writeText`
directly in the trusted button activation and submits only success or a bounded
failure. There is no alternate clipboard implementation or automatic retry.
Neither private file content nor clipboard text is placed in durable event
receipts, iframe event messages or diagnostic logs.

Downloads appear only after the original event's database checkpoint succeeds.
`GET /api/runtime/plugin-ui/:sessionId/artifact/:effectId?eventId=...` fetches raw
owner-scoped bytes with authenticated headers; it is never a navigated owner-token
URL. The client validates JSON/plain MIME, advertised byte count and the eight-MiB
limit while reading. A trusted parent Blob URL hands those exact bytes to the
browser's download mechanism and acknowledges receipt. The UI reports handing the
file to the browser, rather than claiming a specific disk save path. Closing,
changing selection or losing the owner aborts the fetch/selection and prevents a
late download. Fetch/action acknowledgements are not automatically replayed.

Focused transport tests cover effect schema/identity, oversize and malformed UTF-8,
same-revision transitions, uncertain acknowledgements, confirmed cancellation,
artifact MIME/byte verification, close during transfer, clipboard activation and
one-use behavior. A separate isolated Chromium acceptance test drives a native
file chooser, confirmation, byte-identical disk download and native clipboard
under real user activation while a synthetic original event remains pending.
The original bundle's file/confirmation/checkpoint behavior is covered by the
native and HTTP integration gates; that browser transfer test deliberately uses
synthetic payloads and does not claim to replace the original-engine gates.
