# Chat memory editing and server persistence

Original SupaMemory text and HypaMemory V2 chunk/main-chunk editing now use
stable chat field commands in entity mode. They no longer mutate only DBState.
Ordinary mode keeps the original bound values and chunk/main-chunk semantics.
The original Hypa V2 modal still edits existing entries only; editing a main
chunk does not change its derived related chunks.

The modal captures its opening character/chat IDs. Navigation cannot redirect
its pending input to the newly selected chat. Detached field drafts retain
unknown memory and chunk members, and revision/epoch guards preserve explicit
conflicts with peers and server generation. The durable outbox retains offline
edits after every tab closes. Initial rendering of absent Supa text or Hypa V2
data uses control-only defaults; opening a modal does not create stored memory.
The character sidebar and composer menu follow this rule in entity mode.

`server/browser/chatMemoryUi.test.cjs` uses neutral authored data and independent
Chromium contexts on desktop and both mobile emulations. It exercises actual
original controls, peer updates, navigation, same-field conflicts and offline
all-tab replay, including group Supa text and the composer modal entry. A desktop
case additionally edits a memory marker through the
original text control, closes all pages and checks whether the original native
generation consumes it through a loopback synthetic provider. Passing results
are recorded in the current receipt, rather than inferred from the test's presence.

Memory objects are still aggregate fields; this port is not itemwise merging or
large-memory performance proof. Hypa V3 summary/category/tag/merge/re-summary
controls, global memory settings/preset management, embedding capability and
complete history/read provenance remain in the original goal. Physical phones,
representative workload costs and human acceptance remain unverified.

On 2026-10-05 the user explicitly excluded further TTS work. Existing TTS settings
remain; synthesis/playback/provider acceptance are excluded from required work.
The original fifteen checklist lines and their hash remain unchanged.
Production access, private saved content, real model calls, deploy and push are
outside this local work.
