import { get } from "svelte/store";

import { getChatVar, setChatVar } from "../parser/chatVar.svelte";

import { selectedCharID } from "../stores.svelte";

import { type Message, type loreBook } from "../storage/database.svelte";

import { DBState } from "../stores.svelte";

import { tokenize } from "../tokenizer";

import { risuChatParser } from "../parser/parser.svelte";

import { findCharacterbyId, pickHashRand, selectSingleFile } from "../util";

import { alertError, alertNormal } from "../alert";

import { language } from "../../lang";

import { downloadFile } from "../globalApi.svelte";

import { getModuleLorebooks } from "./modules";

import { CCardLib } from "@risuai/ccardlib";

import { v4 } from "uuid";

export function addLorebook(type: number) {
  const selectedID = get(selectedCharID);
  if (type === 0) {
    DBState.db.characters[selectedID].globalLore.push({
      key: "",
      comment: `New Lore ${DBState.db.characters[selectedID].globalLore.length + 1}`,
      content: "",
      mode: "normal",
      insertorder: 100,
      alwaysActive: false,
      secondkey: "",
      selective: false,
    });
  } else {
    const page = DBState.db.characters[selectedID].chatPage;
    DBState.db.characters[selectedID].chats[page].localLore.push({
      key: "",
      comment: `New Lore ${DBState.db.characters[selectedID].chats[page].localLore.length + 1}`,
      content: "",
      mode: "normal",
      insertorder: 100,
      alwaysActive: false,
      secondkey: "",
      selective: false,
    });
  }
}

export function addLorebookFolder(type: number) {
  const selectedID = get(selectedCharID);
  const id = v4();
  if (type === 0) {
    DBState.db.characters[selectedID].globalLore.push({
      key: "\uf000folder:" + id,
      comment: `New Folder`,
      content: "",
      mode: "folder",
      insertorder: 100,
      alwaysActive: false,
      secondkey: "",
      selective: false,
    });
  } else {
    const page = DBState.db.characters[selectedID].chatPage;
    DBState.db.characters[selectedID].chats[page].localLore.push({
      key: "\uf000folder:" + id,
      comment: `New Folder`,
      content: "",
      mode: "folder",
      insertorder: 100,
      alwaysActive: false,
      secondkey: "",
      selective: false,
    });
  }
}

export async function loadLoreBookV3Prompt() {
  return getBrowserRuntime().loadLoreBookV3Prompt();
}

export async function importLoreBook(mode: "global" | "local" | "sglobal") {
  const selectedID = get(selectedCharID);
  const page =
    mode === "sglobal" ? -1 : DBState.db.characters[selectedID].chatPage;
  let lore =
    mode === "global"
      ? DBState.db.characters[selectedID].globalLore
      : DBState.db.characters[selectedID].chats[page].localLore;
  const lorebook = (await selectSingleFile(["json", "lorebook"])).data;
  if (!lorebook) {
    return;
  }

  try {
    const importedlore = JSON.parse(Buffer.from(lorebook).toString("utf-8"));
    if (importedlore.type === "risu" && importedlore.data) {
      const datas: loreBook[] = importedlore.data;
      for (const data of datas) {
        lore.push(data);
      }
    } else if (importedlore.entries) {
      const entries: { [key: string]: CCLorebook } = importedlore.entries;
      lore.push(...convertExternalLorebook(entries));
    }
    if (mode === "global") {
      DBState.db.characters[selectedID].globalLore = lore;
    } else {
      DBState.db.characters[selectedID].chats[page].localLore = lore;
    }
  } catch (error) {
    alertError(error);
  }
}

export interface CCLorebook {
  key: string[];
  comment: string;
  content: string;
  order: number;
  constant: boolean;
  name: string;
  keywords: string[];
  priority: number;
  entry: string;
  secondary_keys: string[];
  selective: boolean;
  forceActivation: boolean;
  keys: string[];
  displayName: string;
  text: string;
  contextConfig?: {
    budgetPriority: number;
    prefix: string;
    suffix: string;
  };
}

export function convertExternalLorebook(entries: {
  [key: string]: CCLorebook;
}) {
  let lore: loreBook[] = [];
  for (const key in entries) {
    const currentLore = entries[key];
    lore.push({
      key: currentLore.key
        ? currentLore.key.join(", ")
        : currentLore.keys
          ? currentLore.keys.join(", ")
          : currentLore.keywords
            ? currentLore.keywords.join(", ")
            : "",
      insertorder:
        currentLore.order ??
        currentLore.priority ??
        currentLore?.contextConfig?.budgetPriority ??
        0,
      comment:
        currentLore.comment ||
        currentLore.name ||
        currentLore.displayName ||
        "",
      content:
        currentLore.content || currentLore.entry || currentLore.text || "",
      mode: "normal",
      alwaysActive:
        currentLore.constant ?? currentLore.forceActivation ?? false,
      secondkey: currentLore.secondary_keys
        ? currentLore.secondary_keys.join(", ")
        : "",
      selective: currentLore.selective ?? false,
    });
  }
  return lore;
}

export async function exportLoreBook(mode: "global" | "local" | "sglobal") {
  try {
    const selectedID = get(selectedCharID);
    const page =
      mode === "sglobal" ? -1 : DBState.db.characters[selectedID].chatPage;
    const lore =
      mode === "global"
        ? DBState.db.characters[selectedID].globalLore
        : DBState.db.characters[selectedID].chats[page].localLore;
    const stringl = Buffer.from(
      JSON.stringify({
        type: "risu",
        ver: 1,
        data: lore,
      }),
      "utf-8",
    );

    await downloadFile(`lorebook_export.json`, stringl);

    alertNormal(language.successExport);
  } catch (error) {
    alertError(error);
  }
}
import { createLorebookRuntime } from "./lorebookRuntime";
let browserRuntime: ReturnType<typeof createLorebookRuntime>;
function getBrowserRuntime() {
  return (browserRuntime ??= createLorebookRuntime({
    selectedCharID,
    DBState,
    getModuleLorebooks,
    findCharacterbyId,
    CCardLib,
    getChatVar,
    pickHashRand,
    tokenize,
    risuChatParser,
    setChatVar,
    safeStructuredClone: (value) => safeStructuredClone(value),
  }));
}
