import { get } from "svelte/store";

/** Upstream data helpers bound to an explicit context. */
export interface UtilStateRuntimeHost {
  readResourceValue: <T>(value: T) => T;
  DBState: (typeof import("./stores.svelte"))["DBState"];
  selectedCharID: (typeof import("./stores.svelte"))["selectedCharID"];
  getDatabase: (typeof import("./storage/database.svelte"))["getDatabase"];
  createBlankChar: (typeof import("./characters"))["createBlankChar"];
}
export function createUtilStateRuntime(host: UtilStateRuntimeHost) {
  function checkPersonaBinded() {
    try {
      let db = host.DBState.db;
      const selectedChar = get(host.selectedCharID);
      const character = db.characters[selectedChar];
      const chat = character.chats[character.chatPage];
      if (!chat.bindedPersona) {
        return null;
      }
      const persona = db.personas.find((v) => v.id === chat.bindedPersona);
      return host.readResourceValue(persona);
    } catch (error) {
      return null;
    }
  }

  function getUserName() {
    const bindedPersona = checkPersonaBinded();
    if (bindedPersona) {
      return bindedPersona.name;
    }
    const db = host.getDatabase();
    return db.username ?? "User";
  }

  function getUserIcon() {
    const bindedPersona = checkPersonaBinded();
    if (bindedPersona) {
      return bindedPersona.icon;
    }
    const db = host.getDatabase();
    return db.userIcon ?? "";
  }

  function getPersonaPrompt() {
    const bindedPersona = checkPersonaBinded();
    if (bindedPersona) {
      return bindedPersona.personaPrompt;
    }
    const db = host.getDatabase();
    return db.personaPrompt ?? "";
  }

  function getUserIconProtrait() {
    try {
      const bindedPersona = checkPersonaBinded();
      if (bindedPersona) {
        return bindedPersona.largePortrait;
      }
      const db = host.getDatabase();
      return host.readResourceValue(db.personas[db.selectedPersona])
        .largePortrait;
    } catch (error) {
      return false;
    }
  }

  function findCharacterbyId(id: string) {
    const db = host.getDatabase();
    for (const char of db.characters) {
      if (char.type !== "group") {
        if (char.chaId === id) {
          return char;
        }
      }
    }
    let unknown = host.createBlankChar();
    unknown.name = "Unknown Character";
    return unknown;
  }

  function findCharacterIndexbyId(id: string) {
    const db = host.getDatabase();
    let i = 0;
    for (const char of db.characters) {
      if (char.chaId === id) {
        return i;
      }
      i += 1;
    }
    return -1;
  }

  function getCharacterIndexObject() {
    const db = host.getDatabase();
    let i = 0;
    let result: {
      [key: string]: number;
    } = {};
    for (const char of db.characters) {
      result[char.chaId] = i;
      i += 1;
    }
    return result;
  }

  function getAuthorNoteDefaultText() {
    const db = host.getDatabase();
    const template = db.promptTemplate;
    if (!template) {
      return "";
    }
    for (const v of template) {
      if (v.type === "authornote") {
        return v.defaultText ?? "";
      }
    }
    return "";
  }
  return {
    checkPersonaBinded,
    getUserName,
    getUserIcon,
    getPersonaPrompt,
    getUserIconProtrait,
    findCharacterbyId,
    findCharacterIndexbyId,
    getCharacterIndexObject,
    getAuthorNoteDefaultText,
  };
}
