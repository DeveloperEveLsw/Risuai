import { get } from "svelte/store";

import { DBState, selectedCharID } from "../stores.svelte";

import { parseKeyValue } from "../util";
import {
  entityRuntimeEnabled,
  VariableOverlays,
} from "../runtime/browserRuntimeState.svelte";
import { variableIdentity } from "../runtime/variableCommands";

import {
  getCurrentCharacter,
  getCurrentChat,
} from "../storage/database.svelte";

export function getChatVar(key: string): string {
  return getContextRuntime().getChatVar(key);
}

export function setChatVar(key: string, value: string): boolean {
  return getContextRuntime().setChatVar(key, value);
}

export function getGLChatVar(key: string): string {
  if (entityRuntimeEnabled) {
    const chat = getCurrentChat();
    if (!chat) return undefined;
    const overlay = VariableOverlays.get(
      variableIdentity({ scope: "chat-global", chatId: chat.id, key }),
    );
    return (
      overlay
        ? overlay.exists
          ? overlay.value
          : undefined
        : chat.GLGlobalVariables?.[key]
    ) as string;
  }
  return getContextRuntime().getGLChatVar(key);
}

export function setGLChatVar(key: string, value: string) {
  return getContextRuntime().setGLChatVar(key, value);
}

export function getGlobalChatVar(key: string): string {
  if (entityRuntimeEnabled) {
    const local = getGLChatVar(key);
    if (local && local !== "null") return local;
    const overlay = VariableOverlays.get(
      variableIdentity({ scope: "global", key }),
    );
    return (
      overlay
        ? overlay.exists
          ? (overlay.value ?? "null")
          : "null"
        : (DBState.db.globalChatVariables[key] ?? "null")
    ) as string;
  }
  return getContextRuntime().getGlobalChatVar(key);
}

export function setGlobalChatVar(key: string, value: string) {
  return getContextRuntime().setGlobalChatVar(key, value);
}

export function isLocallyHandledGlobalChatVar(key: string): boolean {
  if (entityRuntimeEnabled) return !!getGLChatVar(key);
  return getContextRuntime().isLocallyHandledGlobalChatVar(key);
}

export function removeLocallyHandledGlobalChatVar(key: string): boolean {
  return getContextRuntime().removeLocallyHandledGlobalChatVar(key);
}
import { createChatVariableRuntime } from "./chatVariableRuntime";
let contextRuntime: ReturnType<typeof createChatVariableRuntime>;
function getContextRuntime() {
  return (contextRuntime ??= createChatVariableRuntime({
    selectedCharID,
    DBState,
    parseKeyValue,
    getCurrentChat: () => getCurrentChat(),
  }));
}
