# Native group generation and browser presentation

The native host could run individual characters but omitted the original `groupOrder` capability. An unordered synthetic group failed before contacting the provider. Connecting speaker selection exposed a second failure: the upstream trigger clones a member character, including its guarded individual history, even though generation supplies the group chat explicitly.

`groupOrderRuntime.ts` extracts the original `groupOrder` and `getWords` bodies from upstream f9728b14. Browser and server use the same algorithm; the structural audit verifies both declarations. Name mentions, probability/shuffling, fallback selection and repeated name occurrences retain the original behavior. The native trigger adapter gives admitted members the explicit group chat when making that clone; it does not load their individual conversations or weaken the general cross-chat guard.

Original processing distinctions remain: group output uses the group's regex and module edit listeners; the speaking member's start/output triggers receive the group chat. Tests deliberately include member regex that must not run as group output processing, individual history sentinels that must not reach provider prompts, member Lua and module Lua that persist only in the group chat.

Browser checks then exposed two separate presentation defects:

- Original group rows supply a null simple-character argument. The entity finalizer required a character and returned no HTML after reconnect, despite three stored messages. The finalizer now uses the already captured canonical owner/settings for those rows. It still skips character display scripts as the original null argument does; an authored negative regex verifies this distinction.
- Progress checkpoints replace their message collection. Emitting only the last reply removed the first member's row as the second member streamed. Native group progress now includes all newly created messages still present in the private job, identified against the initial message IDs. Confirmed history bodies are excluded, and final persistence remains one transaction. The same first row and its visible text remain through the next stream.

## Synthetic validation

Six native tests use real isolated Node processes, the extracted engine and a loopback synthetic provider: mention order/shared history, ordered mode/inactive members, repeated names/stable IDs, second-response cancellation with no partial messages or variables, independent group chats, and member/module Lua. The built original UI test uses two independent Chromium storage contexts and password authentication, observes both streams, checks first-row identity, closes every tab before the second reply finishes, and reconnects both contexts to the same three canonical message IDs. It reports no browser runtime exceptions and exactly two synthetic provider calls.

Before/after controls and final gate logs/hashes are retained in `docs/group-generation-validation.json` and root `evidence/local-group-generation-logs/`. A test-fixture correction (job-list summaries omit results) and Lua fixture mistakes are separate from the reproduced application defects. No actual provider, production server or private user card was used in this milestone.

## Remaining boundaries

Subsequent work reproduces and fixes the original first-reroll batch boundary, exercises original group continue and clarifies the upstream group HTML-button no-op: [original group reroll](group-reroll-runtime.md). Previous/next variants and interrupted compound recovery remain required. The following paragraphs describe the earlier extraction milestone, not the current aggregate editor/reroll coverage.

Subsequent work implements the original membership editor and atomic greetings: [durable group member editing](group-member-runtime.md). The paragraph below records this generation extraction's boundary; group buttons, variants, automode and recovery remain unfinished.

Group member add/remove editors and atomic membership-array commands are not implemented by this extraction. Group buttons still require an explicit member context and fail visibly. Group continue/reroll selection, automode, inactive/empty-group edge cases, interrupted multi-member recovery and arbitrary history-rewriting scripts require dedicated acceptance. Read definitions are pinned when resolved; this milestone does not add a full read-dependency transaction contract for every member definition change during a provider call. Progress does not project every edit to already confirmed messages before completion.

The group progress filter scans the private history IDs per emission and retains an initial ID set. It avoids serializing confirmed bodies but does not establish bounded CPU/memory for very large groups or archives. The original probabilistic algorithm and repeated mentions can produce multiple calls; they were preserved rather than capped. Physical mobile behavior, configured user-card compatibility and representative latency/long-task acceptance remain necessary. All 15 completion requirements stay active; this is a local milestone and is not deployed.
