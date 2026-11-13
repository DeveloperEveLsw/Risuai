# Canonical display owners during native progress

Native generation checkpoints advance the synchronization delivery cursor even
when a saved message's complete display inputs remain equal. Using that cursor
as part of the UI presentation identity repeatedly retired original Lua owners,
so unchanged history could queue ahead of the incoming response.

The UI owner comparison now omits only `projectedCursor`. It still captures a
fresh fenced header and complete private body before comparing every original
value, variable revision, source revision, epoch, history/window, environment,
module and outside-read admission. The shared cache still rebuilds when its
projection metadata changes; execution/in-flight keys and canonical admission
retain the actual cursor. No cached body is retagged or projection guard removed.

An unchanged owner continues its existing stateful Lua work. A real variable,
history, streaming flag, source or settings change creates another owner. An
explicit original reload still runs the callback. Incoming provisional text
continues through original CBS, regex, Lua, Markdown and assets, and cannot
persist effects before canonical ownership is established.

## Evidence

The actual original UI regression uses two independent browser stores, native
loopback SSE gates and a stateful greeting callback. Both off and balanced modes
fail with the previous cursor comparison when the next response delta invokes
that callback again. Both modes pass with the candidate, while a real toggle
change still advances the callback and both devices update the response. The
existing private-effects, source/index, PNG decode and DOM lifetime checks remain.

Unit checks distinguish delivery-only owner equality from execution-key equality,
and retain changed clocks, epochs, history, source, arbitrary metadata, streaming
flags, modules, variable revisions and outside reads. Browser cache/header and
admission regressions remain required. The baseline source is restored byte for
byte after the controlled negative run, and its failing log is preserved.

Performance observations use a separate authored100-message fixture,96 HTML cells
per message,16 original display regexes, six toggle-dependent rows and optional
600000 Lua loop iterations per callback. The actual optimized original UI/native
pair runs locally. Provider chunks are held until input/preparation work has been
quiet for500ms, then eight chunks arrive150ms apart. The final chunk is held until
the stage7 marker returned by Lua is visible. Provider write, native checkpoint
observation, completed Worker invocations, frame gaps and observed long tasks are
reported separately. These are diagnostic runs, not a claim about all cards or
physical mobile performance.

The first probe had a selector error because Lua appended its marker outside the
source section. Another preparation expected the wrong emitted worker filename.
An early run also waited for completion after changing a variable already read by
the native prompt: the actual result was a revision conflict. Later observations
explicitly distinguish post-completion toggles from that guarded conflict case;
they do not relax the final write checks or replay model calls. Initial failure
logs and narrower earlier observations remain available.

An initial comparison incorrectly treated the100-row snapshot page length as
the complete canonical count. The probe now checks the existing indexed
`history.count` aggregate; the fixture and expected102 completed messages are
unchanged. That failed run and its measurement manifest are preserved.

The first full browser gate passed25 cases and failed one with a CDP
`Page.navigate` timeout. Its source and deadlines are unchanged for the isolated
and full browser rechecks. The initial log/receipt remain separate; the timeout's
root cause is unconfirmed, so a successful recheck does not establish its repair.

## Limits

Actual script work on genuine input changes, full snapshot reconstruction,
partial response parsing, DOM/layout and concurrency can still cost time. The
page CPU4x condition does not establish Worker throttling or physical phone
behavior. Polling/observer overhead and one run per condition do not establish a
general latency percentile or universal speedup. No output-only Lua cache,
read-dependency whitelist, raw-mode substitution or new schema/protocol is used.

All15 original completion requirements and their checkbox/hash state remain
unchanged. Full compatibility/read/write/storage/extension closure, cold and
concurrent cases, physical-device lifecycles and user acceptance remain active.
This follow-up uses public source and authored synthetic data only; no production
access/change/deployment, private data inspection, external model call or remote
push. Current gates and exact observations are recorded in
[display-progress-owner-validation.json](display-progress-owner-validation.json).
