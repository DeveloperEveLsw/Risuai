# Original advanced character definition editors

The original advanced controls now edit a private, stable-owner field draft in
entity mode. The extracted `CharacterDefinitionSettings.svelte` is shared with
the ordinary browser path; the original input widgets, labels, limits and
portable data shapes remain. The entity path uses `RuntimeObjectFields` and the
existing durable `change-fields` outbox, not an observer that saves arbitrary
DBState mutations.

The twenty character fields are `bias`, `exampleMessage`, `creatorNotes`,
`removedQuotes`, `systemPrompt`, `replaceGlobalNote`, `additionalText`,
`personality`, `scenario`, `defaultVariables`, `translatorNote`,
`customModuleToggle`, `additionalData`, `nickname`, `depth_prompt`,
`alternateGreetings`, `lowLevelAccess`, `hideChatIcon`, `utilityBot` and
`escapeOutput`. Their field revisions and entity incarnations are captured
independently. Nested objects/arrays retain unknown JSON members. Different
fields can be edited concurrently; competing changes within one aggregate field
still require explicit conflict resolution.

Removing an alternate greeting preserves the original operation order: reset
the current chat's `fmIndex` to -1, then remove the greeting. Both changed fields
are submitted in one transaction with separate captured clocks. Other chats'
selection indices are not reset. Original up/down reorder semantics remain;
this does not invent new greeting identity or index adjustment rules.

Editing creator notes also resets `removedQuotes` in the same field command.
Opening the entity editor does not rewrite a plain creator-notes string to the
multilingual encoding or persist absent checkbox defaults. `MultiLangInput`
accepts `normalizeOnMount=false`; its existing callers retain the original
normalization default. Both initial and incoming plain text are represented in
the English editor without changing the stored source until a user edit.

Missing strings/arrays and `additionalData`/`depth_prompt` are also supported.
Controls display their empty/default values without creating stored fields on
opening. The first explicit edit creates the relevant object with valid original
members and preserves any existing unknown members. Minimal imported/trial
definitions no longer fail when opening advanced settings.

`server/browser/characterDefinitionUi.test.cjs` uses actual Vite UI, two
independent Chromium contexts and an isolated synthetic database. Desktop and
Android/touch emulation exercise ordinary and beta mobile layouts with a
separate desktop peer. It covers
every rendered field, notes and greeting atomic commands, bias add/remove,
greeting add/reorder/remove, unknown nested members, independent chat/character
owners, peer propagation, different-field concurrency, same-field conflict,
closing all tabs offline, replay, reload and navigation in the input task.
The same fixture on the prior c6b0f08 controls demonstrates a visible local edit
that never reaches the database or peer. Negative controls and repeated cases
are excluded from unique passing counts. Physical phones and large-array
performance, OS keyboard behavior and actual touch gestures are not established
by browser emulation. [Per-field reactive encoders](field-draft-performance.md)
remove repeated canonical serialization of unchanged text fields while retaining
deep tracking and fresh captured clocks. Objects/arrays remain field aggregates;
large-array and full storage/memory budgets still require measurements.

For a direct trial, run `pnpm trial:local` with a fresh unused loopback port and
the separate password `local-trial`. Select **로컬 구조 시험**, open Character →
Advanced Settings and edit a synthetic field in two independent browser
profiles. Try adding/removing an alternate greeting and inspect the selected
chat separately from **독립 채팅**. Close every tab and reopen the same origin
while the trial process keeps running. Generation uses the trial's loopback
provider; no real model or personal data is imported.

Remaining ports include asset/TTS/plugin management, memory controls,
module-conversion actions and other definition paths outside these controls.
Full extension/read provenance, large collection budgets, representative
latency/long tasks, physical mobile lifecycle and human acceptance remain in the
original fifteen requirements in `server-runtime-plan.md`. No production
connection, data access, deployment or remote push is part of this milestone.
