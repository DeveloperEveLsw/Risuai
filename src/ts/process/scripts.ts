import { get } from "svelte/store";

import { CharEmotion, selectedCharID } from "../stores.svelte";

import {
  type character,
  type customscript,
  type groupChat,
  getDatabase,
  getCurrentCharacter,
  getCurrentChat,
} from "../storage/database.svelte";

import { downloadFile } from "../globalApi.svelte";

import { alertError, alertNormal } from "../alert";

import { language } from "src/lang";

import { selectSingleFile } from "../util";

import {
  assetRegex,
  type CbsConditions,
  risuChatParser as risuChatParserOrg,
  type simpleCharacterArgument,
} from "../parser/parser.svelte";

import { getModuleAssets, getModuleRegexScripts } from "./modules";

import { HypaProcesser } from "./memory/hypamemory";

import { runLuaEditTrigger } from "./scriptings";

import { pluginV2 } from "../plugins/plugins.svelte";

import { runTrigger } from "./triggers";

const randomness = /\|\|\|/g;

export type { ScriptMode } from "./scriptRuntime";

export function processScript(
  ...args: Parameters<ReturnType<typeof createScriptRuntime>["processScript"]>
) {
  return getBrowserRuntime().processScript(...args);
}

export function exportRegex(s?: customscript[]) {
  let db = getDatabase();
  const script = s ?? db.globalscript;
  const data = Buffer.from(
    JSON.stringify({
      type: "regex",
      data: script,
    }),
    "utf-8",
  );
  downloadFile(`regexscript_export.json`, data);
  alertNormal(language.successExport);
}

export async function importRegex(o?: customscript[]): Promise<customscript[]> {
  o = o ?? [];
  const filedata = (await selectSingleFile(["json"])).data;
  if (!filedata) {
    return o;
  }
  let db = getDatabase();
  try {
    const imported = JSON.parse(Buffer.from(filedata).toString("utf-8"));
    if (imported.type === "regex" && imported.data) {
      const datas: customscript[] = imported.data;
      const script = o;
      for (const data of datas) {
        script.push(data);
      }
      return o;
    } else {
      alertError("File invaid or corrupted");
    }
  } catch (error) {
    alertError(error);
  }
  return o;
}

export function resetScriptCache(
  ...args: Parameters<
    ReturnType<typeof createScriptRuntime>["resetScriptCache"]
  >
) {
  return browserRuntime?.resetScriptCache(...args);
}

export function processScriptFull(
  ...args: Parameters<
    ReturnType<typeof createScriptRuntime>["processScriptFull"]
  >
) {
  if (entityRuntimeEnabled && args[2] === "editdisplay")
    return processPinnedDisplay(...args);
  return getBrowserRuntime().processScriptFull(...args);
}

const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm;

export const risuChatParser = risuChatParserOrg;
import { createScriptRuntime } from "./scriptRuntime";
import type { ScriptMode } from "./scriptRuntime";

import { createDisplayCbsScope } from "../runtime/displayCbsScope";
import { getBrowserCbsHost } from "../parser/parser.svelte";
import { createTriggerRuntime } from "./triggerRuntime";
import { getBrowserTriggerHost } from "./triggers";
import { writable } from "svelte/store";
import { captureDisplayScope } from "./scriptings";

async function processPinnedDisplay(
  ...args: Parameters<
    ReturnType<typeof createScriptRuntime>["processScriptFull"]
  >
) {
  const metadata = displayMetadata.get(args[0]) ?? {
    firstMessage: Boolean(args[4]?.firstmsg),
    captured: true,
    capture: captureDisplayScope(
      args[3] ?? -1,
      Boolean(args[4]?.firstmsg),
      args[0].chaId,
      args[4]?.messageId,
    ),
  };
  if (!metadata.capture) return { data: args[1], emoChanged: false };
  const capture = metadata.capture;
  const scope = createDisplayCbsScope(capture, getBrowserCbsHost());
  if (pluginV2.editdisplay.size)
    scope.fail("Display plugins require a pinned transaction capability");
  const selected = writable(0);
  const trigger = createTriggerRuntime({
    ...getBrowserTriggerHost(),
    getDatabase: () => scope.database,
    getCurrentCharacter: () => scope.character,
    getCurrentChat: () => scope.chat,
    DBState: { db: scope.database },
    selectedCharID: selected,
    ReloadGUIPointer: writable(0),
    ReloadChatPointer: writable({} as Record<number, number>),
    getModuleTriggers: () =>
      capture.triggers.slice(
        capture.character.type === "group"
          ? 0
          : capture.character.triggerscript.length,
      ),
    risuChatParser: scope.parse,
    setCurrentCharacter: () =>
      scope.fail("Persistent display character writes require a server intent"),
    runScripted: () =>
      scope.fail(
        "Display scripted triggers require a pinned transaction capability",
      ),
  });
  const host = {
    ...getBrowserScriptHost(),
    getDatabase: () => scope.database,
    getCurrentCharacter: () => scope.character,
    getCurrentChat: () => scope.chat,
    selectedCharID: selected,
    risuChatParserOrg: scope.parse,
    runTrigger: async (...parameters: Parameters<typeof runTrigger>) => {
      try {
        return await trigger.runTrigger(...parameters);
      } catch (error) {
        return scope.fail(error);
      }
    },
    HypaProcesser: new Proxy(HypaProcesser, {
      construct: () =>
        scope.fail(
          "Dynamic display assets require a pinned embedding capability",
        ),
    }),
    getModuleRegexScripts: () =>
      capture.cbsModules?.flatMap((module) => module.regex ?? []) ?? [],
    getModuleAssets: () =>
      capture.cbsModules?.flatMap((module) => module.assets ?? []) ?? [],
  };
  const char = { ...scope.character };
  displayMetadata.set(char, metadata);
  const result = await createScriptRuntime(host).processScriptFull(
    char,
    args[1],
    "editdisplay",
    capture.history?.ordinal ?? args[3] ?? -1,
    args[4],
  );
  scope.check();
  return result;
}

let browserRuntime: ReturnType<typeof createScriptRuntime>;
function getBrowserRuntime() {
  return (browserRuntime ??= createScriptRuntime(getBrowserScriptHost()));
}
function getBrowserScriptHost(): import("./scriptRuntime").ScriptRuntimeHost {
  return {
    getDatabase,
    runLuaEditTrigger,
    getCurrentCharacter,
    runTrigger,
    getCurrentChat,
    pluginV2,
    getModuleRegexScripts,
    CharEmotion,
    selectedCharID,
    getModuleAssets,
    HypaProcesser,
    assetRegex,
    risuChatParserOrg,
    safeStructuredClone: (value) => safeStructuredClone(value),
  };
}

import { entityRuntimeEnabled } from "../runtime/browserRuntimeState.svelte";
import { displayMetadata } from "../runtime/browserDisplayMetadata";
