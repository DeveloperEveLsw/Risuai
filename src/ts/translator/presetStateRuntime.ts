import type {
  decode as decodeMsgpack,
  encode as encodeMsgpack,
} from "msgpackr/index-no-eval";
import type * as fflate from "fflate";
import type { decryptBuffer, encryptBuffer } from "src/ts/util";
import type { decodeRPack, encodeRPack } from "src/ts/rpack/rpack_js.js";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface PresetStateRuntimeHost {}
export function createPresetStateRuntime(host: PresetStateRuntimeHost) {
  interface TranslatorPreset {
    name: string;
    prompt: string;
    maxResponse: number;
  }

  interface TranslatorPresetStateLike {
    translatorPrompt?: string;
    translatorMaxResponse?: number;
    translatorPresets?: unknown[];
    translatorPresetId?: number;
  }

  interface EncryptedTranslatorPresetFile {
    translatorPresetVersion: 1;
    type: "translator-preset";
    preset: Uint8Array | ArrayBuffer;
  }

  const defaultTranslatorPrompt =
    "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isTranslatorPresetValue(value: unknown): value is TranslatorPreset {
    return (
      isRecord(value) &&
      typeof value.name === "string" &&
      typeof value.prompt === "string" &&
      typeof value.maxResponse === "number" &&
      Number.isFinite(value.maxResponse)
    );
  }

  function getDefaultTranslatorPreset(
    state: TranslatorPresetStateLike,
  ): TranslatorPreset {
    return createTranslatorPreset("Default", {
      prompt: state.translatorPrompt ?? "",
      maxResponse: state.translatorMaxResponse ?? 1000,
    });
  }

  function getNormalizedTranslatorPresetName(
    name: unknown,
    index: number,
  ): string {
    if (typeof name === "string" && name.trim().length > 0) {
      return name;
    }
    return `Preset ${index + 1}`;
  }

  function createTranslatorPreset(
    name = "New Preset",
    existing: Partial<TranslatorPreset> = {},
  ): TranslatorPreset {
    return {
      name,
      prompt: typeof existing.prompt === "string" ? existing.prompt : "",
      maxResponse:
        typeof existing.maxResponse === "number" &&
        Number.isFinite(existing.maxResponse)
          ? existing.maxResponse
          : 1000,
    };
  }

  function normalizeTranslatorPresetState<T extends TranslatorPresetStateLike>(
    state: T,
  ): T {
    const defaultPreset = getDefaultTranslatorPreset(state);
    const sourcePresets =
      Array.isArray(state.translatorPresets) &&
      state.translatorPresets.length > 0
        ? state.translatorPresets
        : [defaultPreset];
    state.translatorPresets = sourcePresets.map((preset, index) => {
      const normalizedPreset = isRecord(preset) ? preset : {};
      return createTranslatorPreset(
        getNormalizedTranslatorPresetName(normalizedPreset.name, index),
        normalizedPreset,
      );
    });
    const requestedId =
      typeof state.translatorPresetId === "number" &&
      Number.isInteger(state.translatorPresetId)
        ? state.translatorPresetId
        : 0;
    state.translatorPresetId = Math.min(
      Math.max(requestedId, 0),
      Math.max(state.translatorPresets.length - 1, 0),
    );
    return syncCurrentTranslatorPresetToLegacyFields(state);
  }

  function syncCurrentTranslatorPresetToLegacyFields<
    T extends TranslatorPresetStateLike,
  >(state: T): T {
    const preset = state.translatorPresets?.[state.translatorPresetId ?? 0];
    if (!isTranslatorPresetValue(preset)) {
      return normalizeTranslatorPresetState(state);
    }
    state.translatorPrompt = preset.prompt;
    state.translatorMaxResponse = preset.maxResponse;
    return state;
  }

  function getCurrentTranslatorPresetFromState<
    T extends TranslatorPresetStateLike,
  >(state: T): TranslatorPreset {
    const presetId =
      typeof state.translatorPresetId === "number" &&
      Number.isInteger(state.translatorPresetId)
        ? state.translatorPresetId
        : -1;
    const preset = Array.isArray(state.translatorPresets)
      ? state.translatorPresets[presetId]
      : undefined;
    if (!isTranslatorPresetValue(preset)) {
      const normalizedState = normalizeTranslatorPresetState(state);
      const normalizedPreset =
        normalizedState.translatorPresets?.[
          normalizedState.translatorPresetId ?? 0
        ];
      return isTranslatorPresetValue(normalizedPreset)
        ? normalizedPreset
        : getDefaultTranslatorPreset(normalizedState);
    }
    state.translatorPrompt = preset.prompt;
    state.translatorMaxResponse = preset.maxResponse;
    return preset;
  }
  return {
    isTranslatorPresetValue,
    isRecord,
    getDefaultTranslatorPreset,
    getNormalizedTranslatorPresetName,
    createTranslatorPreset,
    normalizeTranslatorPresetState,
    syncCurrentTranslatorPresetToLegacyFields,
    getCurrentTranslatorPresetFromState,
    defaultTranslatorPrompt,
  };
}
