# Strong streaming presentation handoff

The entity UI retains its last visible raw streaming text until the current ChatBody has prepared and finalized its HTML. Final job persistence and presentation preparation are separate lifetimes. Finishing the native job does not remove the visible raw span by itself. Assigning finalized HTML and retiring that span occur in the same Svelte update; the owned HTML range then receives the prepared output.

The exact previous application on commit 51b0ac4 reproduced a blank response across 16 observed animation frames. Its message row remained identical and connected, and its native generation had already completed. Holding only the original asset-URL capability for a neutral PNG exposed the gap; the real original UI, native generation, upload/HTTP and image decoding remained in use.

The bridge is scoped to the mounted entity ChatBody and stores only the last streamed string. It introduces no DBState write, new job, second provider call or persistent-effect admission. The existing parsing cancellation/current-finalizer guard controls retirement: obsolete, rejected or undefined preparation cannot clear the bridge. Closing the component releases its local state and existing DOM/cache owners. The ordinary legacy branch is unchanged.

The actual browser scenario checks visible text during a held final image preparation after native completion, stable row and raw-span identity, zero blank animation-frame observations, one final text/HTML presentation, removal of the raw span, decoded synthetic PNG width, and exactly one provider call. This tests the strong-streaming transition. Existing full-suite owner/cancellation/CSS-failure/IDB/multi-device regressions remain required.

This does not predecode every image before HTML appears, establish all translation/inlay/plugin semantics, or eliminate synchronous parser/DOM long tasks. An explicit empty final response remains empty. Presentation failures remain visible through the existing error path; unaccepted work does not remove the last streamed fallback. All 15 original requirements, configured trial and remaining authority/offline/compatibility work remain active.

Evidence is recorded in docs/local-validation.json and workspace evidence/display-stream-validation.json, with the original reproduction retained separately. Production and private content were not accessed.
