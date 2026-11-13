# Response streaming in the entity runtime

The native generation and browser progress paths already support streaming when
the original `useStreaming` setting is enabled. The chat composer now exposes a
streaming checkbox for models whose catalog advertises support. It reads pending
settings through the same field overlay as the original model settings page and
persists changes through durable field commands. It does not enable streaming on
mount, override an explicitly disabled preference, or change the display
optimization mode. The control is disabled while the selected chat is generating.
Other devices receive the confirmed setting. The original model settings control
remains available, and ordinary browser mode retains its original UI.

## Vertex / Gemini transport

The native Google adapter uses one streaming UTF-8 decoder and consumes completed
JSON SSE events once. It retains unfinished framing and the accumulated response,
instead of reparsing the complete network history for every chunk. It understands
CR, LF, CRLF, comments, optional data-field spaces and multiline JSON data. Valid
final data without a trailing blank line is accepted at EOF. Network chunks that
contain several events produce one visible accumulated snapshot after processing
each event. A queued snapshot cannot be changed by a later delta.

Korean and emoji split between network bytes remain intact. Signed parts are
processed once, so later deltas do not replay signature persistence or replace the
earlier inlay marker. Invalid complete/truncated JSON and invalid UTF-8 fail the
stream instead of silently accepting a shortened response. A provider error event
also rejects a started stream instead of saving its preceding partial answer. The readable stream
delivers parsing/transport failures; its `pipeTo` side promise is observed so it
does not also create an unhandled rejection. Tool dispatch, request construction,
thought formatting and final output processing retain their existing paths.

Three changed Google declarations are explicit, fingerprint-pinned policies in
`googleRuntime-ports.json`. The extraction audit reports them separately from
structural equality. Together with the two existing Lua invocation policies, the
audit compares 169 declarations: 164 original structures and 5 declared policies.
Signature persistence and MCP tools still need their existing explicit server
capabilities; the signed-part regression supplies an isolated test capability.
The ordinary legacy Google adapter is not changed by this milestone.

## Generation, display and persistence

The provider emits deltas to the native job. The existing coalesced job checkpoints
and server events deliver provisional messages with stable IDs to each browser.
This is incremental display, not a promise to paint every provider token. The
normal configured interval is 250ms for progress checkpoints and 200ms for event
polling; the controlled browser fixture uses 25ms and 20ms respectively.

Original display CBS, regex and Lua process provisional messages through the
existing private display scope. Canonical messages and output-script effects are
committed after complete original output processing. Every client tab can close
while the server continues; reopening reads retained progress or the final result.
Cancellation, fencing, provider failures and shared-setting conflicts keep the
existing explicit outcomes and do not automatically repeat provider requests.

## Verification and limits

- The prior parser corrupts a Korean/emoji event fragmented one byte at a time;
  the new native adapter exposes the intact prefix before the provider closes.
- Protocol tests cover framing, one-time parsing, EOF, malformed JSON and signed
  part replay. The original Vertex auth, thought formatting and quota cases remain.
- A real Chromium/original UI/native service test enables streaming from an
  initially disabled setting, confirms it on an independent device, displays a
  fragmented Vertex/Gemini-format response on both devices, reloads a peer, closes
  both tabs before completion and verifies final IDs, output regex/Lua and a fresh
  browser. Switching streaming off uses the ordinary complete-response request.
- Existing off/balanced provisional display, images, input shrinking and strong
  streaming handoff tests remain green. The scoped fresh acceptance is 563 app,
  64 native/HTTP and 4 browser cases, with 3 existing app skips.

All provider requests in this milestone target isolated loopback synthetic
servers. Actual Vertex credentials, production settings and private cards were
not inspected, and no production rollout occurred. It therefore does not identify
why a particular current hosted session showed no partial response or establish
live Vertex/provider/proxy latency. Model reasoning before the first body token,
card regex/HTML that needs a complete block and expensive display scripts can
still delay visible content. Physical mobile and representative full-card
performance acceptance remain outstanding. All 15 original requirements stay
active.
