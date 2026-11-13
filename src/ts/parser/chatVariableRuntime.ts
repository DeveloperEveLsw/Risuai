import { get } from "svelte/store";

/** Upstream data helpers bound to an explicit context. */
export interface ChatVariableRuntimeHost {
  selectedCharID: (typeof import("../stores.svelte"))["selectedCharID"];
  DBState: (typeof import("../stores.svelte"))["DBState"];
  parseKeyValue: (typeof import("../util"))["parseKeyValue"];
  getCurrentChat: (typeof import("../storage/database.svelte"))["getCurrentChat"];
}
export function createChatVariableRuntime(host: ChatVariableRuntimeHost) {
  function getChatVar(key: string): string {
    const selectedChar = get(host.selectedCharID);
    const char = host.DBState.db.characters[selectedChar];
    if (!char) {
      return "null";
    }
    const chat = char.chats[char.chatPage];
    chat.scriptstate ??= {};
    const state = chat.scriptstate["$" + key];
    if (state === undefined || state === null) {
      const defaultVariables = host
        .parseKeyValue(char.defaultVariables)
        .concat(host.parseKeyValue(host.DBState.db.templateDefaultVariables));
      const findResult = defaultVariables.find((f) => {
        return f[0] === key;
      });
      if (findResult) {
        return findResult[1];
      }
      return "null";
    }
    return state.toString();
  }

  function setChatVar(key: string, value: string): boolean {
    const selectedChar = get(host.selectedCharID);
    const chat =
      host.DBState.db.characters[selectedChar].chats[
        host.DBState.db.characters[selectedChar].chatPage
      ];
    chat.scriptstate ??= {};
    const stateKey = "$" + key;
    if (chat.scriptstate[stateKey] === value) {
      return false;
    }
    chat.scriptstate[stateKey] = value;
    return true;
  }

  function getGLChatVar(key: string): string {
    console.log("getGLChatVar", key);
    const chat = host.getCurrentChat();
    return chat?.GLGlobalVariables?.[key];
  }

  function setGLChatVar(key: string, value: string) {
    console.log("setGLChatVar", key, value);
    const chat = host.getCurrentChat();
    if (chat) {
      console.log("setGLChatVar", key, value, chat.GLGlobalVariables);
      chat.GLGlobalVariables ??= {};
      chat.GLGlobalVariables[key] = value;
    }
  }

  function getGlobalChatVar(key: string): string {
    const vt = getGLChatVar(key);
    if (vt !== "null" && vt) {
      return vt;
    }
    return host.DBState.db.globalChatVariables[key] ?? "null";
  }

  function setGlobalChatVar(key: string, value: string) {
    if (host.getCurrentChat()?.useLocallySetGlobalVariables) {
      setGLChatVar(key, value);
      return;
    } else if (getGLChatVar(key) !== undefined) {
      delete host.getCurrentChat().GLGlobalVariables[key];
    }
    host.DBState.db.globalChatVariables[key] = value;
  }

  function isLocallyHandledGlobalChatVar(key: string): boolean {
    return !!getGLChatVar(key);
  }

  function removeLocallyHandledGlobalChatVar(key: string): boolean {
    if (getGLChatVar(key) !== undefined) {
      delete host.getCurrentChat().GLGlobalVariables[key];
      return true;
    }
    return false;
  }
  return {
    getChatVar,
    setChatVar,
    getGLChatVar,
    setGLChatVar,
    getGlobalChatVar,
    setGlobalChatVar,
    isLocallyHandledGlobalChatVar,
    removeLocallyHandledGlobalChatVar,
  };
}
