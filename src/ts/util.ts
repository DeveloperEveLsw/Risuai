import { get, writable, type Writable } from "svelte/store";

import type { Database, Message } from "./storage/database.svelte";

import { getDatabase } from "./storage/database.svelte";

import { DBState, selectedCharID } from "./stores.svelte";

import { open } from "@tauri-apps/plugin-dialog";

import { readFile } from "@tauri-apps/plugin-fs";

import { basename } from "@tauri-apps/api/path";

import { createBlankChar, getCharImage } from "./characters";

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { isIOS, isTauri } from "src/ts/platform";

import type { Attachment } from "svelte/attachments";

import { mount, unmount, type Snippet } from "svelte";

import PopupList from "src/lib/UI/PopupList.svelte";

const appWindow = isTauri ? getCurrentWebviewWindow() : null;

export interface Messagec extends Message {
  index: number;
}

export function messageForm(arg: Message[], loadPages: number) {
  function reformatContent(data: string) {
    return data?.trim();
  }

  let a: Messagec[] = [];
  for (let i = 0; i < arg.length; i++) {
    const m = arg[i];
    a.unshift({
      role: m.role,
      data: reformatContent(m.data),
      index: i,
      saying: m.saying,
      chatId: m.chatId ?? "none",
      generationInfo: m.generationInfo,
    });
  }
  return a.slice(0, loadPages);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const domSelect = true;

export async function selectSingleFile(ext: string[]) {
  if (domSelect) {
    const v = await selectFileByDom(ext, "single");
    const file = v[0];
    return { name: file.name, data: await readFileAsUint8Array(file) };
  }

  const selected = await open({
    filters: [
      {
        name: ext.join(", "),
        extensions: ext,
      },
    ],
  });
  if (Array.isArray(selected)) {
    return null;
  } else if (selected === null) {
    return null;
  } else {
    return { name: await basename(selected), data: await readFile(selected) };
  }
}

export async function selectMultipleFile(ext: string[]) {
  if (!isTauri) {
    const v = await selectFileByDom(ext, "multiple");
    let arr: { name: string; data: Uint8Array }[] = [];
    for (const file of v) {
      arr.push({ name: file.name, data: await readFileAsUint8Array(file) });
    }
    return arr;
  }

  const selected = await open({
    filters: [
      {
        name: ext.join(", "),
        extensions: ext,
      },
    ],
    multiple: true,
  });
  if (Array.isArray(selected)) {
    let arr: { name: string; data: Uint8Array }[] = [];
    for (const file of selected) {
      arr.push({ name: await basename(file), data: await readFile(file) });
    }
    return arr;
  } else if (selected === null) {
    return null;
  } else {
    return [{ name: await basename(selected), data: await readFile(selected) }];
  }
}

export const replacePlaceholders = (msg: string, name: string) => {
  let db = getDatabase();
  let selectedChar = get(selectedCharID);
  let currentChar = db.characters[selectedChar];
  return msg
    .replace(/({{char}})|({{Char}})|(<Char>)|(<char>)/gi, currentChar.name)
    .replace(/({{user}})|({{User}})|(<User>)|(<user>)/gi, getUserName())
    .replace(/(\{\{((set)|(get))var::.+?\}\})/gu, "");
};

export function checkPersonaBinded() {
  return getContextRuntime().checkPersonaBinded();
}

export function getUserName() {
  return getContextRuntime().getUserName();
}

export function getUserIcon() {
  return getContextRuntime().getUserIcon();
}

export function getPersonaPrompt() {
  return getContextRuntime().getPersonaPrompt();
}

export function getUserIconProtrait() {
  return getContextRuntime().getUserIconProtrait();
}

export function selectFileByDom(
  allowedExtensions: string[],
  multiple: "multiple" | "single" = "single",
) {
  return new Promise<null | File[]>((resolve) => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = multiple === "multiple";
    const acceptAll =
      getDatabase().allowAllExtentionFiles ||
      isIOS() ||
      allowedExtensions[0] === "*";
    if (!acceptAll) {
      if (allowedExtensions && allowedExtensions.length) {
        fileInput.accept = allowedExtensions.map((ext) => `.${ext}`).join(",");
      }
    } else {
      fileInput.accept = "*";
    }

    fileInput.addEventListener("change", (event) => {
      if (fileInput.files.length === 0) {
        resolve([]);
        return;
      }

      const files = acceptAll
        ? Array.from(fileInput.files)
        : Array.from(fileInput.files).filter((file) => {
            const fileExtension = file.name.split(".").pop().toLowerCase();
            return (
              !allowedExtensions || allowedExtensions.includes(fileExtension)
            );
          });

      fileInput.remove();
      resolve(files);
    });

    document.body.appendChild(fileInput);
    fileInput.click();
    fileInput.style.display = "none"; // Hide the file input element
  });
}

function readFileAsUint8Array(file: File) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const buffer = event.target.result;
      const uint8Array = new Uint8Array(buffer as ArrayBuffer);
      resolve(uint8Array);
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file", { cause: reader.error }));
    };

    reader.readAsArrayBuffer(file);
  });
}

export async function changeFullscreen(db = getDatabase()) {
  const isFull = await appWindow.isFullscreen();
  if (db.fullScreen && !isFull) {
    await appWindow.setFullscreen(true);
  }
  if (!db.fullScreen && isFull) {
    await appWindow.setFullscreen(false);
  }
}

export async function getCustomBackground(db: string) {
  if (db.length < 2) {
    return "";
  } else {
    const filesrc = await getCharImage(db, "plain");
    return `background: url("${filesrc}"); background-size: cover;`;
  }
}

export function findCharacterbyId(id: string) {
  return getContextRuntime().findCharacterbyId(id);
}

export function findCharacterIndexbyId(id: string) {
  return getContextRuntime().findCharacterIndexbyId(id);
}

export function getCharacterIndexObject() {
  return getContextRuntime().getCharacterIndexObject();
}

export function defaultEmotion(em: [string, string][]) {
  if (!em) {
    return "";
  }
  for (const v of em) {
    if (v[0] === "neutral") {
      return v[1];
    }
  }
  return "";
}

export async function getEmotion(
  db: Database,
  chaEmotion: { [key: string]: [string, string, number][] },
  type: "contain" | "plain" | "css",
) {
  const selectedChar = get(selectedCharID);
  const currentDat = db.characters[selectedChar];
  if (!currentDat) {
    return [];
  }
  let charIdList: string[] = [];

  if (currentDat.type === "group") {
    if (currentDat.characters.length === 0) {
      return [];
    }
    switch (currentDat.viewScreen) {
      case "multiple":
        charIdList = currentDat.characters;
        break;
      case "single": {
        let newist: [string, string, number] = ["", "", 0];
        let newistChar = currentDat.characters[0];
        for (const currentChar of currentDat.characters) {
          const cha = chaEmotion[currentChar];
          if (cha) {
            const latestEmotion = cha[cha.length - 1];
            if (latestEmotion && latestEmotion[2] > newist[2]) {
              newist = latestEmotion;
              newistChar = currentChar;
            }
          }
        }
        charIdList = [newistChar];
        break;
      }
      case "emp": {
        charIdList = currentDat.characters;
        break;
      }
    }
  } else {
    charIdList = [currentDat.chaId];
  }

  let datas: string[] = [
    currentDat.viewScreen === "emp" ? "emp" : ("normal" as const),
  ];
  for (const chaid of charIdList) {
    const currentChar = findCharacterbyId(chaid);
    if (currentChar.viewScreen === "emotion") {
      const currEmotion = chaEmotion[currentChar.chaId];
      let im = "";
      if (!currEmotion || currEmotion.length === 0) {
        im = await getCharImage(
          defaultEmotion(currentChar?.emotionImages),
          type,
        );
      } else {
        im = await getCharImage(currEmotion[currEmotion.length - 1][1], type);
      }
      if (im && im.length > 2) {
        datas.push(im);
      }
    } else if (currentChar.viewScreen === "imggen") {
      const currEmotion = chaEmotion[currentChar.chaId];
      if (!currEmotion || currEmotion.length === 0) {
        datas.push(await getCharImage(currentChar.image ?? "", "plain"));
      } else {
        datas.push(currEmotion[currEmotion.length - 1][1]);
      }
    }
  }
  return datas;
}

export function getAuthorNoteDefaultText() {
  return getContextRuntime().getAuthorNoteDefaultText();
}

export async function encryptBuffer(data: Uint8Array, keys: string) {
  // hash the key to get a fixed length key value
  const keyArray = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keys),
  );

  const key = await window.crypto.subtle.importKey(
    "raw",
    keyArray,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  // use web crypto api to encrypt the data
  const result = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(12),
    },
    key,
    asBuffer(data),
  );

  return result;
}

export async function decryptBuffer(data: Uint8Array, keys: string) {
  // hash the key to get a fixed length key value
  const keyArray = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keys),
  );

  const key = await window.crypto.subtle.importKey(
    "raw",
    keyArray,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  // use web crypto api to encrypt the data
  const result = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(12),
    },
    key,
    asBuffer(data),
  );

  return result;
}

export function toState<T>(t: T): Writable<T> {
  return writable(t);
}

export function BufferToText(data: Uint8Array) {
  if (!TextDecoder) {
    return Buffer.from(data).toString("utf-8");
  }
  return new TextDecoder().decode(data);
}

export function encodeMultilangString(data: { [code: string]: string }) {
  let result = "";
  if (data.xx) {
    result = data.xx;
  }
  for (const key in data) {
    result = `${result}\n# \`${key}\`\n${data[key]}`;
  }
  return result;
}

export function parseMultilangString(data: string) {
  let result: { [code: string]: string } = {};
  const regex = /# `(.+?)`\n([\s\S]+?)(?=\n# `|$)/g;
  let m: RegExpExecArray;
  while ((m = regex.exec(data)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }
    result[m[1]] = m[2];
  }
  result.xx = data.replace(regex, "");
  return result;
}

export const toLangName = (code: string) => {
  try {
    switch (code) {
      case "xx": {
        //Special case for unknown language
        return "Unknown Language";
      }
      default: {
        return new Intl.DisplayNames([code, "en"], { type: "language" }).of(
          code,
        );
      }
    }
  } catch (error) {
    return code;
  }
};

export const capitalize = (s: string) => {
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function blobToUint8Array(data: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("reader.result is not ArrayBuffer"));
      }
    };
    reader.onerror = () => {
      reject(reader.error);
    };
    reader.readAsArrayBuffer(data);
  });
}

export const languageCodes = [
  "af",
  "ak",
  "am",
  "an",
  "ar",
  "as",
  "ay",
  "az",
  "be",
  "bg",
  "bh",
  "bm",
  "bn",
  "br",
  "bs",
  "ca",
  "co",
  "cs",
  "cy",
  "da",
  "de",
  "dv",
  "ee",
  "el",
  "en",
  "eo",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fo",
  "fr",
  "fy",
  "ga",
  "gd",
  "gl",
  "gn",
  "gu",
  "ha",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "ia",
  "id",
  "ig",
  "is",
  "it",
  "iu",
  "ja",
  "jv",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "ku",
  "ky",
  "la",
  "lb",
  "lg",
  "ln",
  "lo",
  "lt",
  "lv",
  "mg",
  "mi",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "nb",
  "ne",
  "nl",
  "nn",
  "no",
  "ny",
  "oc",
  "om",
  "or",
  "pa",
  "pl",
  "ps",
  "pt",
  "qu",
  "rm",
  "ro",
  "ru",
  "rw",
  "sa",
  "sd",
  "si",
  "sk",
  "sl",
  "sm",
  "sn",
  "so",
  "sq",
  "sr",
  "st",
  "su",
  "sv",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "ti",
  "tk",
  "tl",
  "tn",
  "to",
  "tr",
  "ts",
  "tt",
  "tw",
  "ug",
  "uk",
  "ur",
  "uz",
  "vi",
  "wa",
  "wo",
  "xh",
  "yi",
  "yo",
  "zh",
  "zu",
];

export function getNodetextToSentence(node: Node): string {
  let result = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.nodeName === "BR") {
        result += "\n";
        continue;
      }

      // If a child has a style it's not for a markdown formatting
      const childStyle = (child as HTMLElement)?.style;
      if (childStyle?.cssText !== "") {
        result += getNodetextToSentence(child);
        continue;
      }

      // convert HTML elements to markdown format
      if (child.nodeName === "DEL") {
        result += "~" + getNodetextToSentence(child) + "~";
      } else if (child.nodeName === "STRONG" || child.nodeName === "B") {
        result += "**" + getNodetextToSentence(child) + "**";
      } else if (child.nodeName === "EM" || child.nodeName === "I") {
        result += "*" + getNodetextToSentence(child) + "*";
      } else {
        result += getNodetextToSentence(child);
      }
    }
  }
  return result;
}

export const TagList = [
  {
    value: "female",
    alias: ["feminine", "girl"],
  },
  {
    value: "male",
    alias: ["masculine", "boy"],
  },
  {
    value: "OC",
    alias: ["original-character", "original-characters"],
  },
  {
    value: "game-character",
    alias: ["video_game", "video-game", "game", "video-game-character"],
  },
  {
    value: "anime",
    alias: ["animation", "anime-character"],
  },
  {
    value: "v-tuber",
    alias: ["virtual-tuber", "virtual-youtuber", "virtual-youtube"],
  },
  {
    value: "fantasy",
    alias: ["mystical"],
  },
  {
    value: "religious",
    alias: ["spiritual", "faith", "religion", "religious-character"],
  },
  {
    value: "comedy",
    alias: ["funny", "humor", "humorous"],
  },
  {
    value: "mystery",
    alias: ["mysterious", "enigma"],
  },
  {
    value: "romance",
    alias: ["love", "lovers", "couple"],
  },
  {
    value: "dominance",
    alias: ["dominant", "dom", "submissive", "sub", "bdsm"],
  },
  {
    value: "yandere",
    alias: ["yan", "yandere-character"],
  },
  {
    value: "non-character",
    alias: ["not-a-character", "noncharacter", "non-characters"],
  },
  {
    value: "simulator",
    alias: ["simulation", "sim"],
  },
  {
    value: "minor",
    alias: ["underage", "young"],
  },
  {
    value: "giant",
    alias: ["giantess", "giant-character"],
  },
  {
    value: "tiny",
    alias: ["tiny-character", "tiny-characters"],
  },
  {
    value: "realistic",
    alias: ["real", "real-life"],
  },
  {
    value: "cartoon",
    alias: ["toon", "animated"],
  },
  {
    value: "furry",
    alias: ["anthropomorphic"],
  },
  {
    value: "kenomimi",
    alias: ["animal-ears"],
  },
  {
    value: "mecha",
    alias: ["robot", "mech"],
  },
  {
    value: "monster",
    alias: ["creature", "beast", "monstrous"],
  },
  {
    value: "alien",
    alias: ["extraterrestrial", "alien-character"],
  },
  {
    value: "demon",
    alias: ["devil", "demonic", "demon-character"],
  },
  {
    value: "angel",
    alias: ["heavenly", "angelic", "angel-character"],
  },
  {
    value: "elf",
    alias: ["elven", "elf-character"],
  },
  {
    value: "mermaid",
    alias: ["merfolk", "mermaid-character"],
  },
  {
    value: "vampire",
    alias: ["vampiric", "vampire-character"],
  },
  {
    value: "werewolf",
    alias: ["lycan", "lycanthrope", "werewolf-character"],
  },
  {
    value: "zombie",
    alias: ["undead", "zombie-character"],
  },
  {
    value: "ghost",
    alias: ["spirit", "apparition", "ghost-character"],
  },
  {
    value: "witch",
    alias: ["sorceress", "witch-character"],
  },
  {
    value: "wizard",
    alias: ["sorcerer", "wizard-character"],
  },
  {
    value: "ninja",
    alias: ["shinobi", "ninja-character"],
  },
  {
    value: "pirate",
    alias: ["buccaneer", "pirate-character"],
  },
  {
    value: "knight",
    alias: ["paladin", "knight-character"],
  },
  {
    value: "samurai",
    alias: ["bushi", "samurai-character"],
  },
  {
    value: "cowboy",
    alias: ["cowgirl", "cowboy-character"],
  },
  {
    value: "noble",
    alias: ["royal", "nobility", "noble-character"],
  },
  {
    value: "thief",
    alias: ["rogue", "thief-character"],
  },
  {
    value: "spy",
    alias: ["secret-agent", "spy-character"],
  },
  {
    value: "soldier",
    alias: ["military", "soldier-character"],
  },
  {
    value: "villain",
    alias: ["antagonist", "villain-character"],
  },
  {
    value: "hero",
    alias: ["protagonist", "hero-character"],
  },
  {
    value: "superhero",
    alias: ["super-hero", "super-heroine", "superhero-character"],
  },
  {
    value: "mage",
    alias: ["magician", "mage-character", "magical"],
  },
  {
    value: "animal",
    alias: ["pet", "pet-character"],
  },
  {
    value: "cute",
    alias: ["adorable", "cute-character"],
  },
  {
    value: "nonbinary",
    alias: ["genderqueer", "genderfluid"],
  },
  {
    value: "multiple-characters",
    alias: ["group", "multiple"],
  },
  {
    value: "rpg",
    alias: ["roleplaying", "role-playing"],
  },
  {
    value: "non-human",
    alias: ["inhuman", "nonhuman", "non-human-character", "not-human"],
  },
];

export const searchTagList = (query: string) => {
  const splited = query.split(",").map((v) => v.trim());
  if (splited.length > 10) {
    return [];
  }
  const realQuery = splited.at(-1).trim().toLowerCase();

  const result: string[] = [];

  for (const tag of TagList) {
    if (tag.value.startsWith(realQuery)) {
      result.push(tag.value);
      continue;
    }
    for (const alias of tag.alias) {
      if (alias.startsWith(realQuery)) {
        result.push(tag.value);
        break;
      }
    }
  }

  return result.filter((v) => splited.indexOf(v) === -1);
};

export const isKnownUri = (uri: string) => {
  return (
    uri.startsWith("http://") ||
    uri.startsWith("https://") ||
    uri.startsWith("ccdefault:") ||
    uri.startsWith("embeded://")
  );
};

export const sortableOptions = {
  delay: 300, // time in milliseconds to define when the sorting should start
  delayOnTouchOnly: true,
  filter: ".no-sort",
  onMove: (event) => {
    return event.related.className.indexOf("no-sort") === -1;
  },
} as const;

export async function replaceAsync(
  string: string,
  regexp: RegExp,
  replacerFunction: (...args: string[]) => Promise<string>,
) {
  const replacements = await Promise.all(
    Array.from(string.matchAll(regexp), (match) =>
      replacerFunction(...(match as string[])),
    ),
  );
  let i = 0;
  return string.replace(regexp, () => replacements[i++]);
}

export function asBuffer(
  arr: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer>;

export function asBuffer(arr: ArrayBufferLike): ArrayBuffer;

export function asBuffer(
  arr: Uint8Array<ArrayBufferLike> | ArrayBufferLike,
): Uint8Array<ArrayBuffer> | ArrayBuffer {
  if (arr instanceof Uint8Array) {
    return arr as unknown as Uint8Array<ArrayBuffer>;
  } else {
    return arr as unknown as ArrayBuffer;
  }
}

export class Semaphore {
  private available: number;
  private readonly max: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    if (this.available < this.max) {
      this.available += 1;
    }
  }
}

export function openKeypairStoreDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("DPoPDB", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(name || "DPoPStore")) {
        db.createObjectStore(name || "DPoPStore");
      }
    };

    request.onsuccess = (event) =>
      resolve((event.target as IDBOpenDBRequest).result);
    request.onerror = (event) =>
      reject((event.target as IDBOpenDBRequest).error);
  });
}

export async function saveKeypairStore(name: string, keyPair: CryptoKeyPair) {
  const db = await openKeypairStoreDB(name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name || "DPoPStore", "readwrite");
    const store = tx.objectStore(name || "DPoPStore");

    const data = {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    };

    const request = store.put(data, "dpop");

    request.onsuccess = () => resolve(true);
    request.onerror = (event) => reject((event.target as IDBRequest).error);
  });
}

export async function getKeypairStore(
  name: string,
): Promise<CryptoKeyPair | null> {
  const db = await openKeypairStoreDB(name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name || "DPoPStore", "readonly");
    const store = tx.objectStore(name || "DPoPStore");
    const request = store.get("dpop");

    request.onsuccess = (event) => {
      const result = (event.target as IDBRequest).result;
      if (result) {
        resolve({
          privateKey: result.privateKey,
          publicKey: result.publicKey,
        } as CryptoKeyPair);
      } else {
        resolve(null);
      }
    };

    request.onerror = (event) => reject((event.target as IDBRequest).error);
  });
}

export function base64url(source: Uint8Array | ArrayBuffer): string {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  let encodedSource = btoa(String.fromCharCode.apply(null, [...bytes]))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return encodedSource;
}

import { createUtilStateRuntime } from "./utilStateRuntime";

let contextRuntime: ReturnType<typeof createUtilStateRuntime>;

function getContextRuntime() {
  return (contextRuntime ??= createUtilStateRuntime({
    readResourceValue: (value) => value,
    DBState,
    selectedCharID,
    getDatabase,
    createBlankChar,
  }));
}
import {
  parseKeyValue,
  parseToggleSyntax,
  sfc32,
  uuidtoNumber,
  pickHashRand,
  isLastCharPunctuation,
  trimUntilPunctuation,
  prebuiltAssetCommand,
} from "./utilText";
export {
  parseKeyValue,
  parseToggleSyntax,
  sfc32,
  uuidtoNumber,
  pickHashRand,
  isLastCharPunctuation,
  trimUntilPunctuation,
  prebuiltAssetCommand,
} from "./utilText";
import type {
  sidebarToggleGroup,
  sidebarToggleGroupEnd,
  sidebarToggle,
} from "./utilText";
export type {
  sidebarToggleGroup,
  sidebarToggleGroupEnd,
  sidebarToggle,
} from "./utilText";

export { simplifySchema, jsonOutputTrimmer, checkNullish, appendLastPath } from "./utilText";
