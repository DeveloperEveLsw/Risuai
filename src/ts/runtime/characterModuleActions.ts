import type { character } from "../storage/database.svelte";
import type { RisuModule } from "../process/modules";
import type { FieldTarget } from "./fieldCommands";
import { commandJson, type Json } from "./clientProtocol";
import { browserRuntime, RuntimeUIState } from "./browserRuntimeState.svelte";
import { DBState } from "../stores.svelte";
import { getFieldValue } from "./fieldControls";

export const moduleApplicationFields = [
  "globalLore",
  "customscript",
  "triggerscript",
] as const;

// These are precisely the fields read by the original conversion algorithm.
// Histories and unrelated definitions never enter a new module's payload.
export const characterModuleSourceFields = [
  "name",
  "creatorNotes",
  "globalLore",
  "customscript",
  "triggerscript",
  "lowLevelAccess",
  "hideChatIcon",
  "backgroundHTML",
  "additionalAssets",
  "moduleNamespace",
  "customModuleToggle",
  "image",
  "desc",
  "firstMessage",
  "alternateGreetings",
  "replaceGlobalNote",
] as const;

const encode = (value: unknown) =>
  value === undefined ? "absent" : commandJson(value);
const clone = (value: unknown) =>
  value === undefined ? undefined : JSON.parse(commandJson(value));
const target = (id: string, key: string): FieldTarget => ({
  scope: "character",
  entityId: id,
  key,
});

export function characterModuleSource(value: character): character {
  return Object.fromEntries(
    characterModuleSourceFields.map((key) => [
      key,
      clone(getFieldValue(target(value.chaId, key), value[key])),
    ]),
  ) as character;
}

/** Capture before the picker; its result can never follow a new selection. */
export function captureModuleApplication(value: character) {
  const runtime = browserRuntime();
  const id = value.chaId;
  if (
    !RuntimeUIState.ready ||
    !RuntimeUIState.scopeReady ||
    value.type !== "character"
  )
    throw new Error("The character is not ready for module application");
  const fields = moduleApplicationFields.map((key) => {
    const owner = target(id, key);
    const original = clone(getFieldValue(owner, value[key]));
    if (original !== undefined && !Array.isArray(original))
      throw new Error("Invalid character module collection");
    return {
      key,
      target: owner,
      original,
      encoded: encode(original),
      header: { ...runtime.fieldHeader(owner) },
    };
  });
  return async (moduleId: string) => {
    // The selector contains catalog summaries. Read only the selected full body.
    // Applying copies that detached body; it does not create a live module link.
    const resource = await runtime.getLibraryResource("module", moduleId);
    const module = resource.payload as unknown as RisuModule;
    const sourceKeys = ["lorebook", "regex", "trigger"] as const;
    const changes = fields.flatMap((field, index) => {
      const additions = module[sourceKeys[index]];
      if (additions === undefined || additions === null) return [];
      if (!Array.isArray(additions))
        throw new Error("Invalid module collection");
      if (!additions.length) return [];
      return [
        {
          target: field.target,
          value: [...(field.original ?? []), ...clone(additions)] as Json,
          expected: field.header,
        },
      ];
    });
    if (!changes.length) return;
    const current = DBState.db.characters.find(
      (character) => character.chaId === id,
    );
    for (const field of fields) {
      const fresh = runtime.fieldHeader(field.target);
      if (
        !current ||
        current.type !== "character" ||
        fresh.revision !== field.header.revision ||
        fresh.epoch !== field.header.epoch ||
        encode(getFieldValue(field.target, current[field.key])) !==
          field.encoded
      )
        throw new Error(
          "The character changed while selecting a module; try again",
        );
    }
    await runtime.commitFields(
      changes.map(({ target, value }) => ({ target, value })),
      changes.map(({ expected }) => expected),
    );
  };
}
