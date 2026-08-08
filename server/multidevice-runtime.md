# Multi-device server runtime

## Architecture

The normal public entry point is the same-origin RisuAI application on port
6001 behind the public reverse proxy. Desktop and mobile devices render the
upstream RisuAI UI directly; they are not remote-desktop viewers.

One persistent Chromium page runs inside `risuai-runtime` at
`http://risuai:6001/?risu-runtime=executor`. It is the canonical generation
executor. Direct browsers enqueue work and follow its result, while the
resident page runs the upstream prompt builder, Lua, triggers, plugin hooks,
provider call, streaming post-processing, and save path. Closing a direct
browser therefore does not stop accepted work.

The "full compatibility" fallback is the resident Chromium desktop, currently
published by Compose on host port 6002 (`https://SERVER:6002/`). `/full` is a
name for this mode, not an HTTP route on port 6001. Use it for content that
requires the resident DOM, Canvas, clipboard, local file picker, or another
browser-profile capability. Awaited Risu alerts and V2.1
`safeGlobalThis.alert/confirm/prompt` calls made during a command are relayed to
the normal PC/mobile UI; the first device response wins. Startup dialogs and
arbitrary plugin-native dialogs outside a command still require the resident
desktop. Legacy code that assumes synchronous native `confirm()` or `prompt()`
return values cannot be made equivalent by the asynchronous relay.

## Canonical state

`database/database.bin` remains an opaque upstream RisuSave.
The server does not normalize characters, chats, modules, plugins, presets, or
plugin storage into another schema. This is the compatibility boundary that
keeps imported community content on the upstream data and execution paths.

Large or browser-specific auxiliary records are intentionally outside that
blob. Node mode stores inlay binaries, MCP tool-call display payloads, and V3
plugin permission decisions in the server flat store. Legacy inlays are moved
from browser IndexedDB during startup; legacy MCP records migrate lazily when
the profile that owns them first decodes the tool call. Arbitrary community
plugin `localStorage`/safe IndexedDB remains browser-profile-local.

The server owns the canonical blob and serializes revisions:

- `GET /api/sync/database` returns the blob with `ETag`, `X-Risu-Revision`, and
  `X-Risu-Sha256`.
- `PUT /api/sync/database` requires `If-Match` or
  `X-Risu-Base-Revision`, plus `Idempotency-Key`. A matching compare-and-swap
  commit is atomically persisted before the new revision is published.
- A stale base or reused idempotency key with different bytes returns `409`.
  The incoming blob is saved as a conflict artifact and never overwrites the
  current head. `GET /api/sync/database/conflicts` lists artifacts and
  `GET /api/sync/database/conflicts/:conflictId` downloads one. The newest 20
  conflict artifacts are retained.
- `POST /api/sync/socket-ticket` returns a one-use, 30-second ticket for
  `/api/sync/database/ws?ticket=...`. This socket publishes the current head and
  later commits; it has no replay cursor. A follower fetches the announced
  revision through `GET /api/sync/database`.
- Legacy `/api/write` and `/api/remove` calls targeting
  `database/database.bin` return `409 VERSIONED_DATABASE_REQUIRED`. Legacy
  storage routes remain available for non-database assets and backups.

Navigation, scroll position, open panels, and an unsent input remain local to a
page. Committed RisuSave state is shared. A direct page with unsaved changes
does not adopt an announced revision until its write resolves, so a newer head
cannot silently replace or be replaced by an in-flight edit.

## Generation queue and fencing

Direct clients submit idempotent commands to `POST /runtime-generations`.
Supported actions are `send`, `continue`, `reroll`, `unreroll`, `auto`, and the
lower-level `generate` compatibility path. Commands are globally serialized;
there is one resident executor lease for the entire instance, while any number
of devices may observe the queue.

For the normal send/continue UI, the direct browser first submits the raw input
and attachment references against the exact clean canonical database revision.
Only after durable acceptance does it clear the draft; the visible user bubble
is an in-memory optimistic view. The resident runs input triggers/scripts and
the rest of the upstream pipeline exactly once, then its committed snapshot
replaces that bubble. The executor requires revision equality, not merely a
newer revision. If two devices submit against the same head, commands are not
silently merged: after the first advances the chat, the stale command fails and
its originating open page restores its draft.

The observer interfaces are:

- `GET /runtime-generations` and `GET /runtime-generations/:commandId`;
- `GET /runtime-generations/:commandId/events?afterSequence=N`, which returns
  `nextCursor` and `hasMore`;
- `POST /runtime-generations/:commandId/socket-ticket`, followed by
  `/runtime-generations/:commandId/ws?ticket=...&afterSequence=N`;
- `DELETE /runtime-generations/:commandId` for explicit cancellation.

Cancellation of a queued command is immediate. Cancellation of a running
command is two-stage: the server records `cancel_requested` while preserving
the executor fence, then the resident aborts the pipeline, commits any canonical
user-message mutation, and acknowledges the terminal cancellation. This keeps
a fast Stop from discarding the submitted message or its recoverable draft.

Socket tickets are one-use and expire after 30 seconds. Executor identity,
fencing token, and lease expiry are never included in observer responses. Only
the fixed resident container address may claim or mutate an executor lease.
Every database commit made by running generation code carries that lease's
command id, executor id, and monotonically increasing fencing token. An
unfenced database write is locked while the lease is active, and a late
executor is rejected instead of committing partial output.

If a direct call site or plugin invokes the upstream `sendChat()` below the
normal input UI, the direct page first persists its already-mutated RisuSave and
queues `generate`; the resident page then executes the existing upstream
generation path. Preview-only calls remain local.

## Durable local-provider transport

`/proxy-stream-jobs` supplements the generation queue for OpenAI-compatible
streaming/tool requests explicitly routed to a local or private-network
provider. The server validates and pins a private target address, sends the
provider request once, and durably records response headers, raw decoded bytes,
and terminal events. Risu parsing and post-processing still run in the resident
upstream bundle.

The transport interfaces are:

- `POST /proxy-stream-jobs` with an `Idempotency-Key`;
- `GET /proxy-stream-jobs`, `GET /proxy-stream-jobs/:jobId`, and
  `GET /proxy-stream-jobs/:jobId/events?afterSequence=N`;
- `POST /proxy-stream-jobs/:jobId/socket-ticket`, followed by
  `/proxy-stream-jobs/:jobId/ws?ticket=...&afterSequence=N`;
- `POST /proxy-stream-jobs/:jobId/ack` after terminal transport consumption;
- `DELETE /proxy-stream-jobs/:jobId` for explicit cancellation.

Proxy socket tickets are one-use and expire after 30 seconds. Losing HTTP or
WebSocket connectivity reattaches to the same job and replays after the last
event sequence; it never falls back to a second provider request. This spool is
not used for arbitrary public provider URLs.

Terminal records are pruned by age or count, whichever applies first. Defaults
are 7 days after a proxy transport acknowledgement, 14 days without one, at
most 2,000 terminal proxy jobs, and 30 days/2,000 terminal generation commands.
Queued and running records are not age-pruned. See `.env.example` for the
positive-integer millisecond/count overrides.

## Direct-browser storage

The goal is near-zero duplicate content storage, not an empty browser profile:

- the canonical RisuSave, assets, and Risu backups live in `risuai-save`;
- direct pages hold the current RisuSave only in memory;
- Node self-hosting unregisters the Risu service worker and deletes
  `risuCache`, so it does not keep a second offline asset/content copy;
- each device keeps its non-exportable P-256 Node authentication key pair in
  IndexedDB. Five-minute signed tokens are generated when needed and are not
  persisted in `localStorage`;
- the authenticated app refreshes a 24-hour, HttpOnly, `/hub-proxy`-only cookie
  so original Hub images and login frames that cannot attach a custom header
  continue to work. It grants access only to the server's fixed HTTPS Hub
  origin and is never forwarded upstream;
- inlays, MCP tool-call display data, and V3 permission decisions use the
  server flat store; the Node translation cache is bounded and memory-only;
- ordinary browser HTTP cache, upstream UI preferences, and content that
  explicitly uses device-local `localStorage`, `safeLocalStorage`, or safe
  IndexedDB may still consume space. `pluginStorage` inside the RisuSave is
  server-owned and shared.

Clearing a direct browser's site data removes its credential and local-only
preferences, but not Risu content. That device must enter the Node password
again to register a new key.

## Restart semantics

- Closing, navigating away from, or losing connectivity in a direct browser
  does not affect an accepted generation.
- A resident Chromium crash or lease expiry marks its running command
  `interrupted`; it is never reported complete or automatically re-executed.
- A Node restart reloads completed records, leaves queued generation commands
  eligible for the resident executor, and marks running generation commands and
  running proxy jobs `interrupted`. A proxy job that crashed before dispatch is
  durably failed without retrying the provider. The user must explicitly retry
  interrupted or failed work.
- Completed database revisions survive all container recreation because they
  are in `risuai-save`. The resident browser profile survives in
  `risuai-runtime-profile`.

## Acceptance checks

1. Open the public domain on desktop and mobile. Confirm both show the same
   character/chat and that a committed edit on one appears on the other.
2. Send once on desktop, wait until the command is accepted, close the page,
   then open mobile. The output must appear once, with only one provider
   request.
3. Keep both devices open and repeat send, continue, reroll, and cancellation.
   Each terminal result must appear once on both devices.
4. Exercise Lua input/start/output triggers, module regex, low-level `LLM()` or
   `sendChat()`, plugin request replacers/listeners, bridged alerts, tool calls,
   and auto-continue. Use the port-6002 full-runtime fallback for resident DOM,
   file/clipboard, startup-permission, or profile-local behavior.
5. Reload a direct page during streaming, then separately restart only
   Chromium and only the Node app. Reconnect must replay durable events;
   process loss must become `interrupted`, never fabricated success.
6. Inspect direct-browser storage. There must be no persistent RisuSave or
   `risuCache`; only the credential and explicitly local upstream/plugin data
   are expected.
7. With the executor deliberately busy, submit from desktop and mobile against
   the same revision. Exactly one may advance that chat; the stale request must
   fail visibly and preserve/restore its open-page draft instead of answering a
   different tail.
8. On an upgraded profile, render an old MCP tool call from the profile that
   owns its legacy record, then reload on the other device and verify the
   server-backed detail remains visible.
