let browserRuntime: ReturnType<typeof createPresetStateRuntime>;
import {
  decode as decodeMsgpack,
  encode as encodeMsgpack,
} from "msgpackr/index-no-eval";

import * as fflate from "fflate";

import { decryptBuffer, encryptBuffer } from "src/ts/util";

import { decodeRPack, encodeRPack } from "src/ts/rpack/rpack_js.js";

export interface TranslatorPreset {
  name: string;
  prompt: string;
  maxResponse: number;
}

export interface TranslatorPresetStateLike {
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
export const defaultTranslatorPrompt =
  getBrowserRuntime().defaultTranslatorPrompt;

export const translatorPresetFileExtension = "risutl";

export const translatorPresetImportExtensions = [translatorPresetFileExtension];

const translatorPresetEncryptionKey = "risutl";

function isRecord(value: unknown): value is Record<string, unknown> {
  return getBrowserRuntime().isRecord(value);
}

function isTranslatorPresetValue(value: unknown): value is TranslatorPreset {
  return getBrowserRuntime().isTranslatorPresetValue(value);
}

function getBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return null;
}

function isEncryptedTranslatorPresetFile(
  value: unknown,
): value is EncryptedTranslatorPresetFile {
  return (
    isRecord(value) &&
    value.translatorPresetVersion === 1 &&
    value.type === "translator-preset" &&
    getBytes(value.preset) !== null
  );
}

function getDefaultTranslatorPreset(
  state: TranslatorPresetStateLike,
): TranslatorPreset {
  return getBrowserRuntime().getDefaultTranslatorPreset(state);
}

function getNormalizedTranslatorPresetName(
  name: unknown,
  index: number,
): string {
  return getBrowserRuntime().getNormalizedTranslatorPresetName(name, index);
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "preset";
}

export function createTranslatorPreset(
  name = "New Preset",
  existing: Partial<TranslatorPreset> = {},
): TranslatorPreset {
  return getBrowserRuntime().createTranslatorPreset(name, existing);
}

export function normalizeTranslatorPresetState<
  T extends TranslatorPresetStateLike,
>(state: T): T {
  return getBrowserRuntime().normalizeTranslatorPresetState(state);
}

export function syncCurrentTranslatorPresetToLegacyFields<
  T extends TranslatorPresetStateLike,
>(state: T): T {
  return getBrowserRuntime().syncCurrentTranslatorPresetToLegacyFields(state);
}

export function getCurrentTranslatorPresetFromState<
  T extends TranslatorPresetStateLike,
>(state: T): TranslatorPreset {
  return getBrowserRuntime().getCurrentTranslatorPresetFromState(state);
}

async function decodeEncryptedTranslatorPresetFile(
  data: Uint8Array,
): Promise<TranslatorPreset> {
  let encodedPreset: Uint8Array;
  try {
    encodedPreset = await decodeRPack(data);
  } catch {
    throw new Error("Invalid translator preset file.");
  }

  let decodedContainer: unknown;

  try {
    decodedContainer = decodeMsgpack(fflate.decompressSync(encodedPreset));
  } catch {
    throw new Error("Invalid translator preset file.");
  }

  if (!isEncryptedTranslatorPresetFile(decodedContainer)) {
    throw new Error("Invalid translator preset file.");
  }

  const encryptedPreset = getBytes(decodedContainer.preset);

  if (!encryptedPreset) {
    throw new Error("Invalid translator preset file.");
  }

  let decryptedPreset: ArrayBuffer;

  try {
    decryptedPreset = await decryptBuffer(
      encryptedPreset,
      translatorPresetEncryptionKey,
    );
  } catch {
    throw new Error("Invalid translator preset file.");
  }

  const parsedPreset: unknown = decodeMsgpack(new Uint8Array(decryptedPreset));

  if (!isTranslatorPresetValue(parsedPreset)) {
    throw new Error("Invalid translator preset file.");
  }

  return createTranslatorPreset(
    parsedPreset.name.trim().length > 0 ? parsedPreset.name : "Imported Preset",
    parsedPreset,
  );
}

export async function encodeTranslatorPresetFile(
  preset: TranslatorPreset,
): Promise<Uint8Array> {
  const normalizedPreset = createTranslatorPreset(
    preset.name.trim().length > 0 ? preset.name : "Preset",
    preset,
  );
  const encryptedPreset = new Uint8Array(
    await encryptBuffer(
      encodeMsgpack(normalizedPreset),
      translatorPresetEncryptionKey,
    ),
  );
  const payload: EncryptedTranslatorPresetFile = {
    translatorPresetVersion: 1,
    type: "translator-preset",
    preset: encryptedPreset,
  };

  return await encodeRPack(fflate.compressSync(encodeMsgpack(payload)));
}

export async function decodeTranslatorPresetFile(
  data: Uint8Array,
): Promise<TranslatorPreset> {
  return await decodeEncryptedTranslatorPresetFile(data);
}

export function getTranslatorPresetDownloadName(name: string): string {
  return `translator_preset_${sanitizeFileNamePart(name)}.${translatorPresetFileExtension}`;
}
import { createPresetStateRuntime } from "./presetStateRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createPresetStateRuntime({}));
}
