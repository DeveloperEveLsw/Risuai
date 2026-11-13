# Entity field commands and native merge, local development

Schema v8 adds durable per-field revisions for character definitions, chat metadata and object resources. Storage/API/native integration and browser field intents are implemented and tested locally. Original sidebar jailbreak/memory/local-mode toggles and common data-driven settings use durable commands, immediate overlays and explicit conflict resolution. The original model settings page also uses explicit field intents and grouped dependent resets; see [model-settings-runtime.md](model-settings-runtime.md). Other manual editors and setup/import flows still need commands. All 15 full-goal requirements remain in scope; the configured user trial is unfinished.

## Command and read contracts

`POST /api/runtime/fields/read` takes `{targets: [...]}` and returns a consistent cursor plus requested values, presence, own revisions and `entityEpoch`. It returns no messages or unrelated values. Targets have `scope`, `entityId` and a top-level `key`; resource targets also have `resourceKind` (`settings`, `module`, `preset`, `persona` or `plugin`). Shared scalar variables retain their existing commands.

`POST /api/runtime/commands` admits an immutable `change-fields` command:

```json
{
  "requestId": "synthetic-field-request",
  "command": {
    "type": "change-fields",
    "after": [],
    "edits": [
      {
        "scope": "resource",
        "resourceKind": "settings",
        "entityId": "global",
        "key": "jailbreakToggle",
        "expectedRevision": 1,
        "expectedEpoch": 0,
        "value": true
      },
      {
        "scope": "chat",
        "entityId": "synthetic-chat",
        "key": "useLocallySetGlobalVariables",
        "expectedRevision": 1,
        "expectedEpoch": 0,
        "value": true
      }
    ]
  }
}
```

Deletion uses `remove: true` without a value. An admitted user command advances its field revision even when setting an equal value. Up to 128 unique edits commit atomically across entities with their admission/journal. Different fields can merge despite aggregate entity revision changes; stale fields, invalid targets or incarnation mismatches roll back everything. Changes away and back, deletion and recreation retain their own revisions.

`expectedEpoch` matches the entity's latest deletion revision. It fences an old edit to an originally absent key after a different incarnation appears under the same ID. Explicit reapply must refresh field revisions and epochs. Whole-resource legacy writes and native deletions also maintain field revisions.

`after` names committed field-command predecessors. An uncommitted predecessor yields `DEPENDENCY_PENDING`, preventing a rejected parent's child from accidentally matching another device's revision. Identical request retries return their receipt; changed content under the same ID is rejected. Browser revision allocation and predecessors commit together in IndexedDB; clients do not infer revisions from an unsaved memory queue.

## Browser controls and recovery

Field intents share the transactional outbox machinery with variable edits but use disjoint head identities. Field heads include the entity epoch, so an older incarnation cannot allocate a new incarnation's revision. Heads survive projected command removal, closing the shared-tab projection race. Intent values are copied before the first asynchronous storage boundary; subsequent caller mutation cannot change the payload under its existing ID.

Pending values live in a separate reactive map. Confirmed DBState remains a server projection. Rejected entries and their causal descendants stop contributing overlays; storage failure removes the transient draft without admitting a command. Field conflicts use the existing **서버 값 사용** and **내 변경 적용** buttons. Resolution reads only affected fields, removes the entire rejected chain atomically, and optionally submits its latest intent under a new ID with current revisions/epochs. A newer incarnation's independent pending change is preserved; reapplying an older chain into it requires separate reconciliation.

The original sidebar controls and the common check/text/number/slider/select/segmented/color settings wrappers use this path. Nested setting paths copy only their top-level field. Four custom quote setters declare an explicit single-field binding and preserve the remaining array values. Pending setting conditions read the same getter projection, so dependent controls can appear before acknowledgement. The original model page now converts its 97 direct bindings and uses isolated drafts for nested regex/order editors. This does not intercept every direct binding in other settings/editor screens.

Text/font/CSS, size and animation presentation helpers accept an explicit settings view. The application's reactive effects track the fields those helpers actually read, including pending intent, remote confirmation and rollback after the settings page closes. Ordinary browser mode retains its original setters/default helper inputs. Persistent character display-script effects remain a separate unfinished contract.

Chat metadata events include field versions/epochs. Narrow field reads and subsequent full projections compare own revisions and cursors, preventing an older response from replacing a freshly read field. Message objects/windows remain untouched. Ordinary field events carry only changed field values, presence, own revisions and epochs. The projection patches those fields without fetching or normalizing whole bodies, preserves unrelated object/message identity, and advances aggregate headers independently. Newly referenced modules/personas are fetched when needed; a new resource incarnation requires one complete body read. Legacy whole-entity writes retain their existing events. Job admission conservatively waits behind unresolved relevant metadata or potentially shared configuration edits until complete read dependencies are available.

Identity, navigation, messages, script variables and library collections require their own commands. Statistics counters keep their own storage; `statics` field edits can change only its extra metadata. Unknown JSON fields and prototype-named keys remain own data. Nested objects/arrays currently count as one top-level field; lorebook/list/item edits need further commands.

## Native execution and legacy guards

Execution snapshots and lazy character reads include field revisions/epochs from a consistent WAL view. The private job retains its execution-time values while another device confirms edits. Its own effects remain visible within that context; later device edits apply to later snapshots.

Modern final writes use `metadataFields`/`metadataEpoch`, character `fields`/`expectedEpoch` and resource `fields`/`expectedEpoch` for existing guarded objects. They send changed/deleted values instead of replacing entire objects, preserving concurrent untouched fields. Metadata field edits do not advance the message content guard. Overlapping changed values conflict atomically, retaining computed output without replaying the provider. Identical upstream defaults can coalesce without another write; future revisions remain rejected.

Older whole-metadata write sets retain an aggregate metadata guard recorded at claim, preventing overwrite of intervening field edits. Older whole-character/resource formats keep entity revision checks. Initial resource creation still uses its guarded full payload, and scalar global variables keep their per-resource guard.

Transactional v7-to-v8 migration seeds field versions without changing bodies, aggregate revisions, server identity, journal cursor or running progress and initializes legacy metadata guards. No production database was opened or migrated.

## Lean field projection

The server reuses each admitted entity body for both the event and receipt and bumps only the admitted field revisions. A synthetic fixture with roughly 1 MiB of unrelated data per entity verifies one body read per touched entity, receipts/events below 3 KiB and preserved untouched data. The actual two-browser UI fixture includes large unused settings/character/chat fields and observes zero full body/list reads during three field confirmations in an active native job. This is a scoped network/read assertion, not a representative mobile latency benchmark.

Deleting a known default field restores its browser default without re-normalizing the entire entity. Settings statistics retain their independently confirmed counters. Narrow field reads and replay also respect resource reincarnation, including a newer read arriving ahead of old deletion/creation events. Large _changed_ fields still travel as values, not bounded references; very large native effects and representative parsing/serialization cost require further work.

## Evidence and limits

Eight entity tests cover independent merge, atomic multi-entity rollback, predecessors, retries, lean reads, protected fields/counters, prototype keys, ABA/deletion/recreation/epochs, native overlap/merge, legacy guards, default equivalence/future versions and v7 migration. A context test verifies the actual changed-field adapter and preservation of unknown values. A real HTTP test covers reads, independent-field admission, deduplication, versions and conflicts.

An actual native generation test gates a synthetic provider while five setting/character/chat values change. Upstream Lua/CBS output processing still reads `Synthetic:0`; final persistence retains all latest device values with one provider call.

The actual full Risu UI acceptance now clicks original setting/character/chat toggles during a gated native provider call and observes confirmation on another independent browser before completion. It also exercises offline field overlays, both conflict buttons, the accessibility settings checkbox, conditional custom quote inputs, the original animation slider and its actual CSS value after page closure/conflict rollback, and field storage-failure recovery. Existing HTML/manual controls, stable message/asset nodes, all-tab exit and fresh-tab restoration remain covered. Two additional Chromium protocol scenarios exercise shared-tab allocation, lost acknowledgements, retained heads, full-chain resolution, incarnation separation and immutable input capture. A read-model test fences narrow reads against stale character/chat/settings projections while retaining the message window.

Current local validation reports 284 application tests passing (3 skipped), 59 entity tests, 16 native tests, 12 HTTP tests and 18 reported browser results (16 protocol scenarios, their parent and one full UI scenario): 389 reported passing tests. Type checking, native/entity-mode/ordinary-mode builds and the 145-declaration structural audit pass. The small synthetic desktop feedback observation is not representative performance acceptance.

Definition/metadata/resource bodies remain per-entity JSON aggregates. This version normalizes revisions and separates commands; it does not make every nested value an independent relational row or establish large-field performance. Complete editors/create/delete/import/export/order, remaining direct settings bindings and cross-control dependencies, persistent display effects, complete write-intent/read/collection contracts, changed HTML/assets, remaining capabilities/lifetimes, offline/authority policy, representative/mobile performance and the practical configured trial remain required.
