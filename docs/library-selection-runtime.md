# Atomic preset/persona selection in the local runtime

The original preset and persona controls now use durable entity commands. The server captures the current item's live settings and applies the selected definition inside one transaction. This extends the original module-library integration; it does not complete the configured trial or the 15 requirements in `server-runtime-plan.md`. Production remains untouched.

## Original behavior and execution boundary

Original preset selection first saves current settings into the previous preset, then applies the new preset's fields, defaults and prompt-template normalization. `createPresetRuntime` contains the upstream `saveCurrentPreset` and `setPreset` algorithms. Browser and server call the same implementation; the extraction audit compares these two declarations with the pinned upstream source. The normalization helpers moved into `createPromptTemplateRuntime` and remain part of the audit. Unknown definition fields survive server capture through a merge with the existing definition.

Persona capture maps the current username, icon, description and note back to the selected definition, preserving its ID, portrait flag and unknown fields. Activation applies the target's corresponding global settings. Missing optional fields are removed through explicit field deletion, including deletion clocks. The original browser-only path retains its previous storage behavior.

The server requires the standalone erasable TypeScript helper modules and the actual `LLMFormat` constants. The installed Node 22.21 runtime supports this directly. A packaged runtime must include these files and support unflagged TypeScript erasure (Node 22.18 or later in the chosen Node 22 release line); verify that release runtime before deployment. [Node's TypeScript documentation](https://nodejs.org/docs/latest-v22.x/api/typescript.html) confirms that default and the restriction on TypeScript files under `node_modules`; a packaged dependency would need compiled helpers rather than this source checkout layout. No browser DOM or Chromium instance runs these server selection algorithms.

## Command contracts

Both commands go through `POST /commands`, immutable request/payload matching, the durable IndexedDB outbox and journal projection acknowledgement.

| Command                     | Required intent and guards                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activate-library-resource` | `kind` is `preset` or `persona`; stable `resourceId`; target observed `expectedRevision` and incarnation `expectedEpoch`; `expectedActiveId`; own selection-field `expectedSelectionRevision` and `expectedSelectionEpoch`; optional boolean `saveCurrent`, default true. |
| `save-active-library`       | The same target/selection guards; the target must equal the currently selected stable ID. Captures current canonical settings into that definition without switching selection.                                                                                           |

The selection-field guards are strict. A changed selection or settings incarnation rejects the entire command. Resource incarnation guards are also strict: deletion and recreation cannot authorize an older intent. An observed target revision must be a nonnegative safe integer no greater than the current revision. Selection/capture uses the latest canonical definition within that same incarnation, rather than replacing it with a browser's older copy. A same-incarnation rename or edit may therefore precede selection successfully. Whole-draft `save-library-resource` retains strict aggregate revision checking.

Activation captures the old item, rereads the target (including self-selection), applies the original helper and commits changed global fields in the outer transaction. Canonical effects, field/catalog clocks, journal and command receipt roll back together on failure. Deleting the selected preset/persona applies the remaining definition in the same transaction; deleting another item and reordering preserve the selected stable identity. The final preset/persona cannot be deleted.

## Browser controls and pending intent

Original preset creation, name editing, copying, selection, drag ordering, deletion and import/export use the entity bridge. Persona creation, username/note/description editing, portrait toggling, selection, ordering and deletion use the same boundaries. Input and portrait changes use the effective pending getter and own field commands. Library selection waits for unresolved settings/preset/persona field intents, including conflict-resolution replacements appended after the selection request. Independent field intents remain eligible while the selection waits. Successful admission schedules another pass without waiting for the periodic retry timer.

This barrier currently covers all global settings fields, so an unrelated unresolved preference can also delay activation. Finer declared dependency sets remain required; this is not proof of unrestricted independent configuration operations. Multiple competing selections remain explicit conflicts rather than silently applying stale browser choices.

Deletion captures the stable ID and resource header before opening the original confirmation dialog. A later selection on another device cannot redirect the deletion to a different item. A definition changed while confirmation is open is rejected with a visible cancellable command. Preset export also resolves the originally clicked ID after its format dialog and catches errors.

The read model hydrates newly referenced preset/persona members when membership changes and preserves selected identity across reorder. These screens still retain full preset/persona arrays. Compact catalog browsing and lazy body loading are currently verified for modules; this milestone does not extend that performance claim to other libraries or native execution snapshots.

## Files and current capability limits

The original JSON/NAI/ST/encrypted preset decoder routes installation through guarded resource creation, assigning a new ID. Original preset download retains credential/endpoint redaction and the encrypted/RPack encoder. Actual browser acceptance exercises an encrypted export/import with deliberately synthetic credential markers, confirms redaction in the imported copy and retains the source definition's marker. This does not prove every import variant, file picker, preset asset or archive format.

The later [shared asset milestone](shared-assets-runtime.md) connects persona image selection and original persona PNG import/export to server assets, with a guarded attachment command and two-device PNG acceptance. This document's selection milestone preceded that integration. Complete asset/card/archive/picker/native-image fidelity and plugin management remain in scope.

## Evidence and remaining work

`server/entity/librarySelection.test.cjs` exercises original preset application, canonical capture, unknown fields, missing-field removal, stale selection rollback, latest-definition activation, future revisions, invalid IDs/options, deletion/recreation fences, save-active identity and selected-delete fallback. `src/ts/runtime/risuReadModel.test.ts` covers member hydration and selected identity after reorder.

`server/browser/librarySelectionUi.test.cjs` runs the original app in two disposable Chromium contexts with synthetic data. It exercises preset creation/rename/copy/HTML5 drag order/encrypted roundtrip/redaction/delete, persona creation/portrait/edit/switch/delete, an offline conflicting edit held before selection and the actual conflict-resolution button, and a selection change during delete confirmation. The fixture polls rendered and canonical state; it does not establish physical-device latency, a physical persona drag gesture, full mobile acceptance or complete import/export fidelity.

See `local-validation.json` for source and artifact hashes, final commands, counts and retained evidence. Run the isolated application with the documented `pnpm dev:entity` launcher. Complete manual/nested editors, plugin/native capabilities, assets/import/export, display-side effects, declared read/write/collection dependencies, HTML descendant lifetime, continue/reroll/cache policy, offline authority policy, representative performance/mobile checks and the practical user trial/report remain required.
