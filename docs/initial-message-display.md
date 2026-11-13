# First message display feedback

New entity-runtime message rows show “Preparing message display…” while their
first asynchronous presentation is unfinished. Svelte owns this localized status
outside the stable HTML sibling range, with `role=status`, polite announcement
and `aria-busy`. It contains no message source and does not bypass CBS, display
regex or Lua. Korean labels are supplied; other locales use the English base.

A successful finalizer clears the status, including a deliberately empty script
result. Later preparations keep the already rendered body and its DOM. Strong
streamed text and its finalization handoff remain in their existing path.

A first finalizer failure shows “Could not display this message.” and the existing
error report. A fresh presentation can recover. In entity mode, after the original
four parsing attempts fail, the error propagates instead of publishing unprocessed
source. This is an explicit native display failure policy; the ordinary browser
keeps its original retry/fallback behavior. Lua algorithms, callback order/globals,
persistent-effect admission and server generation are unchanged. A previous
successful body remains visible after a later failure.

`server/browser/displayInitialFeedbackUi.test.cjs` runs actual display Workers on
desktop and Android/mobile/touch emulation in ordinary and beta mobile layouts.
It holds a newly sent message's display execution, checks status frames without
exposing authored hidden tokens, and verifies original CBS/regex/Lua output,
empty results and stable input/image nodes. Injected IndexedDB acceptance failure
and actual Lua errors exercise failure labels, retry attempts and fresh recovery.

The fixture stops the native scheduler and holds job admission at both CDP and
its owned frontend server, then closes the page and checks zero jobs. Closing a
target can release a CDP-held transport; the fixture's server middleware keeps
that request and any retry from reaching admission. Original service behavior and
the zero-job assertion are unchanged. It never calls a real provider. The final
case uses the optimized entity build. Frame observations concern a small synthetic
fixture, not physical-phone latency or heavy-script stuttering. Final logs,
screenshots, hashes and unique counts are in the local validation receipt. An
initial selector ignored the renderer's `x-risu-` class prefix; its three failed
tests/log remain separate. Gates that preceded the final error-policy guard are
followed by a fresh final app/type run; repeated tests are not summed.

Run `pnpm trial:local` for the independent synthetic trial described in
[local-user-trial.md](local-user-trial.md). Production/private-data access, remote
push and deployment are outside this milestone. [The 15-condition checkpoint](server-runtime-checkpoint-20261005.md)
retains the full storage/generation/synchronization goal and remaining work.

The headless Linux environment lacks Korean system glyphs: the Korean DOM label
is verified, but its stored screenshot displays missing-glyph boxes. Physical
font rendering is not established by that screenshot. Product fonts are unchanged.
