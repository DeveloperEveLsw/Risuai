import { defaultColorScheme } from "../gui/defaultColorScheme";
import { createSettingsRuntime } from "../storage/settingsRuntime";
import { createHypaPresetRuntime } from "../process/memory/hypaPresetRuntime";
import { createPresetStateRuntime } from "../translator/presetStateRuntime";
import {
  defaultMainPrompt,
  defaultJailbreak,
  defaultAutoSuggestPrompt,
} from "../storage/defaultPrompts";
import { prebuiltNAIpresets } from "../process/templates/templates";
import { defaultHotkeys } from "../defaulthotkeys";
import * as chatPages from "../chatLoadPages";
import { LLMFormat } from "../model/types";
import { checkNullish } from "../utilText";
import type { Database } from "../storage/database.svelte";

/** Apply actual upstream settings defaults without selecting or iterating other chat histories. */
export function normalizeNativeSettings(database: Database) {
  const view = { ...database, characters: [] };
  const defaults = createSettingsRuntime({
    ...createHypaPresetRuntime({}),
    ...createPresetStateRuntime({}),
    ...chatPages,
    defaultMainPrompt,
    defaultJailbreak,
    defaultAutoSuggestPrompt,
    prebuiltNAIpresets,
    defaultHotkeys,
    LLMFormat,
    checkNullish,
    safeStructuredClone: structuredClone,
    isNodeServer: true,
    isTauri: false,
    changeLanguage: () => {}, // The execution host owns job-local language; no global UI state.
    setDatabaseLite: (data) => {
      for (const [key, value] of Object.entries(data))
        if (key !== "characters") database[key] = value;
    },
    defaultColorScheme,
  });
  defaults.setDatabase(view);
}
