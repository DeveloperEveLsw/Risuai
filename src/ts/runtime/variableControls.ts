import {
  getGlobalChatVar,
  isLocallyHandledGlobalChatVar,
  removeLocallyHandledGlobalChatVar as removeLocal,
  setGlobalChatVar as setLocal,
} from "../parser/chatVar.svelte";
import {
  browserRuntime,
  entityRuntimeEnabled,
} from "./browserRuntimeState.svelte";

export { getGlobalChatVar, isLocallyHandledGlobalChatVar };
// Explicit user controls enter the command path. Display evaluation needs its own effect contract.
export function setGlobalChatVar(key: string, value: string) {
  if (entityRuntimeEnabled) browserRuntime().setGlobalVariable(key, value);
  else setLocal(key, value);
}
export function removeLocallyHandledGlobalChatVar(key: string): boolean {
  if (!entityRuntimeEnabled) return removeLocal(key);
  browserRuntime().unpinGlobalVariable(key);
  return true;
}
