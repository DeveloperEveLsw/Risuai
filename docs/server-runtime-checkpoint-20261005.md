# Original 15 requirements: current local checkpoint

Every requirement in `server-runtime-plan.md` remains in scope. A test's existence
alone is not a passing result or complete compatibility proof. Fresh results belong
to this milestone's receipt; historical tests and production releases stay separate.

The user explicitly excluded further TTS work on 2026-10-05. Existing configuration
ports remain, but native synthesis/playback/provider acceptance are not required
for completion. Historical TTS limitations below describe the existing evidence;
they do not override this user decision. All fifteen original checklist lines remain.

The current [script editor port](server-script-editors.md) covers character regex
and trigger arrays and global regex through stable, detached field drafts and the
durable outbox. Its authored two-browser checks exercise conflicts, real JSON
import/export, offline/all-tab restoration and navigation. The follow-up
[lorebook port](server-lore-editors.md) connects character/chat lore and settings,
atomic local activation and captured confirmation/import to the same outbox.
The [advanced definition port](server-character-definition-editors.md) adds twenty
character fields and an atomic current-chat greeting reset through the original
controls. These are field aggregates; general asset/plugin management, memory controls,
other manual paths still require ports. Target Node24 and
physical mobile acceptance remain separate from local Node22 results.

The [field encoder follow-up](field-draft-performance.md) removes repeated
unchanged text serialization and supports absent metadata without writes on open.
Captured clocks and the original conflicts/replay/import guards remain. Existing
backend408 results are reused with unchanged server/native source and bundle;
the follow-up freshly checks app/UI/types and optimized builds. It does not
resolve first-open, large HTML/Worker, aggregate-array or physical-device costs.

The [TTS settings port](server-character-tts-editors.md) adds eleven character
fields and original reference WAV/model ZIP selection, with byte sharing and fresh
ownership checks. Desktop and both emulated mobile layouts cover concurrent/offline
edits and replay. This is configuration and media persistence: native `sayTTS`
remains unsupported, and provider playback, pending-picker interaction and larger
resource budgets remain open. No speedup or real voice synthesis is established.
An optimized two-profile check exposed stale cached aggregate values despite a
confirmed server write. Per-field incoming encoders now refresh on revision/epoch
changes, and the expanded CLI case checks successive peer values. The unchanged
long-field encoding reduction remains; the old timing experiment is historical.

The [module action port](server-character-module-actions.md) connects original
character-to-module conversion, captured atomic application and chat/character
activation to server commands. The popup uses paginated summaries and one selected
body. It retains original copy semantics and explicit aggregate-field conflicts;
physical touch/context-menu acceptance and wider offline/catalog/resource budgets
remain open.

The [chat memory port](server-chat-memory-editors.md) connects original Supa text
for characters/groups and Hypa V2 chunks/main-chunks to chat field commands.
Both sidebar and composer entry points avoid storing absent memory on open.
Modal ownership stays with its opening chat, including after navigation. Authored
desktop/mobile-emulation checks cover peers, explicit conflicts and all-tab
offline replay; an original native generation additionally consumes UI-saved
Supa text after the tabs close, with its original punctuation policy preserved.
Hypa V3 and global memory settings/presets still require ports. Memory aggregates
do not yet provide itemwise merging or large-memory cost acceptance.

| #   | Requirement and authoritative local path                                                                                                         | Remaining acceptance                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | Original UI launch: `server/runtime/localTrial.cjs`, `server/browser/localTrialUi.test.cjs`                                                      | Default CLI builds/login/lifecycle passed; user feedback and Windows loopback forwarding remain unverified.    |
| 2   | IDs/resources/archive: `server/entity/store.cjs`, `server/entity/archive.test.cjs`, `server/browser/archiveUi.test.cjs`                          | Editing/import/export over remaining screens and original resource shapes.                                     |
| 3   | Scoped reads: `server/entity/messageWindow.cjs`, `server/browser/historyWindowUi.test.cjs`                                                       | Large-archive cold/warm reads and ordinary-update bytes across remaining paths.                                |
| 4   | Durable admission: `src/ts/runtime/browserOutbox.ts`, `server/runtime/service.test.cjs`                                                          | Representative interrupted/offline lifecycle beyond existing synthetic retries.                                |
| 5   | Chat ordering/independence: `server/native/scheduler.cjs`, `server/native/generationWorker.test.cjs`                                             | Shared-resource interactions across remaining original features.                                               |
| 6   | Tab-independent generation: `server/browser/vertexStreamingUi.test.cjs`, `server/browser/localTrialUi.test.cjs`                                  | Wider provider/memory/extension combinations.                                                                  |
| 7   | Original scripts/extensions: `src/ts/runtime/executionContext.ts`, `server/engine/auditExtraction.mjs`, `server/native/pluginAdmission.cjs`      | Full read provenance and remaining provider/plugin/Python/asset capabilities; rejection is not implementation. |
| 8   | Device DBState sync: `src/ts/runtime/runtimeSyncClient.ts`, `src/ts/runtime/risuReadModel.test.ts`, `server/runtime/service.test.cjs`            | Resource-edit coverage and physical mobile lifecycle/reconnection.                                             |
| 9   | Responsive controls: `server/browser/displayWorkerUi.test.cjs`, `server/browser/displayDomLifetimeUi.test.cjs`                                   | Large cards, background/resume and response latency.                                                           |
| 10  | Stable DOM/assets: `src/ts/runtime/stableDisplayDom.ts`, `server/browser/displayStreamingHandoffUi.test.cjs`                                     | Large HTML/cold assets/translation and first-body costs; feedback is separate from completed body.             |
| 11  | Cancel/ownership/recovery: `server/native/scheduler.cjs`, `server/runtime/service.test.cjs`                                                      | Remaining resource/provider/pending-UI combinations.                                                           |
| 12  | Browser integration: `server/browser/displayProvisionalUi.test.cjs`, `server/browser/archiveUi.test.cjs`, `server/browser/localTrialUi.test.cjs` | Physical mobile suspension and the wider import/edit/resource matrix.                                          |
| 13  | Latency/long tasks: `docs/display-workload-analysis.md`, `docs/display-thread-profiling.md`, `docs/display-digest-runtime.md`                    | Multi-second stalls, cold data/HTML scaling and physical/Worker CPU acceptance.                                |
| 14  | Checks/builds/regressions: `package.json`, current gate logs                                                                                     | Fresh local Node22 backend408 passed; target Node24 and physical-device acceptance remain unverified.          |
| 15  | Direct trial/limits: `docs/local-user-trial.md`, `pnpm trial:local`                                                                              | Current default CLI trial and limits delivered; human acceptance cannot be inferred.                           |

The previous implementation turn made progress with original module copy,
conversion and activation. This follow-up persists original Supa text and Hypa V2
memory editing. Completion is not redefined around these editor milestones;
the user explicitly excluded further TTS implementation and verification.

Next work includes remaining character definition/asset/plugin and memory editing,
complete extension/read contracts, first-body/main-thread/Worker costs and representative
multi-device/mobile acceptance. No production service, saved card, installed
script, prompt, credential or real model is accessed. The fifteen original
checklist lines and their section hash remain intact.
