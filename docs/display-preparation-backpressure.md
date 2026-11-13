# Bounded preparation for a rendered message

The owning ChatBody parser previously treated a superseded parsing generation
as current until navigation or destruction. Repeated reloads could therefore
retain distinct captures behind a slow hash or Lua invocation. BrowserDisplayLua
rejects a chat's 129th pending preparation; ChatBody immediately retries a live
failure three times, amplifying this burst. The subsequent generic Lua error
means the display calculation failed and its persistent effects were withheld.
It does not by itself establish a database or model-generation failure.

Each entity ChatBody now owns a DisplayPreparationQueue with one active parser
and one replaceable successor. Replaced waiters resolve without parsing. The
current-generation predicate also checks parsingEpoch, so an active obsolete
capture is rejected before entering original Lua or accepting its effects.
Destroying the row resolves its pending waiter. Retries use their existing
active turn and cannot deadlock by reacquiring it. Reactive source/capture and
translation inputs are read before waiting; pending work checks its owner again.

Already executing Lua remains ordered in the original VM, including its globals.
Different rows do not serialize on this new queue. Existing per-chat preparation,
invocation, context, structural and wire budgets remain unchanged. This queue
applies to entity presentation only; canonical jobs, message persistence, provider
requests and the ordinary renderer retain their respective existing paths.

## Reproduction and limits

A neutral three-message chat plus greeting uses the actual original UI and Lua
Worker. A controlled digest gate stalls preparation during 300 explicit original
GUI reloads. The prior ChatBody source fails with the exact reported preparation
limit and the generic Lua parsing retry stack. The candidate retains the existing
row/input/local text, starts at most twelve held hashes across four rows, and
after release executes each latest row once, with no error or canonical write.

The test loads the prior public component in isolated Vite without modifying the
checkout. It is a causal reproduction of the accumulation path, not a capture of
the user's real Nexus session. The real session's precise initiating event and
physical device timing remain unconfirmed. This does not make genuine expensive
Lua, full-scope comparison, translation or large HTML work universally fast.

Queue unit tests cover 400 replacements, close, independent rows and idempotent
completion. Existing original stateful Lua ordering, overload limits, private
effects, cursor ownership, CBS/regex, DOM/assets, multi-device and production
lifecycle regressions remain applicable. Exact gate and rollout outcomes are
recorded in the local validation receipt and deployment report. The user's latest
request authorizes this verified repair's deployment; all 15 broader completion
requirements and their checkbox/hash state remain active.
