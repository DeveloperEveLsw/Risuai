import { get } from "svelte/store";
import type { CharEmotion, selectedCharID } from "../stores.svelte";
import type {
  character,
  customscript,
  groupChat,
  getDatabase,
  getCurrentCharacter,
  getCurrentChat,
} from "../storage/database.svelte";
import type { downloadFile } from "../globalApi.svelte";
import type { alertError, alertNormal } from "../alert";
import type { language } from "src/lang";
import type { selectSingleFile } from "../util";
import type {
  assetRegex,
  CbsConditions,
  risuChatParser as risuChatParserOrg,
  simpleCharacterArgument,
} from "../parser/parser.svelte";
import type { getModuleAssets, getModuleRegexScripts } from "./modules";
import type { HypaProcesser } from "./memory/hypamemory";
import type { runLuaEditTrigger } from "./scriptings";
import type { pluginV2 } from "../plugins/plugins.svelte";
import type { runTrigger } from "./triggers";
export type ScriptMode =
  | "editinput"
  | "editoutput"
  | "editprocess"
  | "editdisplay";
type pScript = {
  script: customscript;
  order: number;
  actions: string[];
};

/** Original upstream operations, with per-context state and injected capabilities. */
export interface ScriptRuntimeHost {
  getDatabase: (typeof import("../storage/database.svelte"))["getDatabase"];
  runLuaEditTrigger: (typeof import("./scriptings"))["runLuaEditTrigger"];
  getCurrentCharacter: (typeof import("../storage/database.svelte"))["getCurrentCharacter"];
  runTrigger: (typeof import("./triggers"))["runTrigger"];
  getCurrentChat: (typeof import("../storage/database.svelte"))["getCurrentChat"];
  pluginV2: (typeof import("../plugins/plugins.svelte"))["pluginV2"];
  getModuleRegexScripts: (typeof import("./modules"))["getModuleRegexScripts"];
  CharEmotion: (typeof import("../stores.svelte"))["CharEmotion"];
  selectedCharID: (typeof import("../stores.svelte"))["selectedCharID"];
  getModuleAssets: (typeof import("./modules"))["getModuleAssets"];
  HypaProcesser: (typeof import("./memory/hypamemory"))["HypaProcesser"];
  assetRegex: (typeof import("../parser/parser.svelte"))["assetRegex"];
  risuChatParserOrg: (typeof import("../parser/parser.svelte"))["risuChatParser"];
  safeStructuredClone: <T>(value: T) => T;
}

export function createScriptRuntime(host: ScriptRuntimeHost) {
  const risuChatParser = host.risuChatParserOrg;
  const dreg = /{{data}}/g;

  async function processScript(
    char: character | groupChat,
    data: string,
    mode: ScriptMode,
    cbsConditions: CbsConditions = {},
  ) {
    return (await processScriptFull(char, data, mode, -1, cbsConditions)).data;
  }

  let bestMatchCache = new Map<string, string>();

  let processScriptCache = new Map<string, string>();

  function generateScriptCacheKey(
    scripts: customscript[],
    data: string,
    mode: ScriptMode,
    chatID = -1,
    cbsConditions: CbsConditions = {},
  ) {
    let hash = data + "|||" + mode + "|||";
    for (const script of scripts) {
      if (script.type !== mode) {
        continue;
      }
      hash += `${script.flag?.includes("<cbs>") ? risuChatParser(script.in, { chatID: chatID, cbsConditions }) : script.in}|||${script.out}${chatID}|||${script.flag ?? ""}|||${script.ableFlag ? 1 : 0}`;
    }
    return hash;
  }

  function cacheScript(hash: string, result: string) {
    processScriptCache.set(hash, result);
    if (processScriptCache.size > 1000) {
      processScriptCache.delete(processScriptCache.keys().next().value);
    }
  }

  function getScriptCache(hash: string) {
    return processScriptCache.get(hash);
  }

  function resetScriptCache() {
    processScriptCache = new Map();
  }

  async function processScriptFull(
    char: character | groupChat | simpleCharacterArgument,
    data: string,
    mode: ScriptMode,
    chatID = -1,
    cbsConditions: CbsConditions = {},
  ) {
    let db = host.getDatabase();
    let emoChanged = false;
    data = await host.runLuaEditTrigger(char, mode, data, { index: chatID });
    if (mode === "editdisplay") {
      const currentChar = host.getCurrentCharacter();
      if (currentChar.type !== "group") {
        try {
          const perf = performance.now();
          const d = await host.runTrigger(currentChar, "display", {
            chat: host.getCurrentChat(),
            displayMode: true,
            displayData: data,
          });
          data = d?.displayData ?? data;
          console.log("Trigger time", performance.now() - perf);
        } catch (e) {
          console.error(e);
        }
      }
    }
    if (host.pluginV2[mode].size > 0) {
      for (const plugin of host.pluginV2[mode]) {
        const res = await plugin(data);
        if (res !== null && res !== undefined) {
          data = res;
        }
      }
    }
    data = risuChatParser(data, { chatID: chatID, cbsConditions });
    const scripts = (db.presetRegex ?? [])
      .concat(char.customscript)
      .concat(host.getModuleRegexScripts());
    const hash = generateScriptCacheKey(
      scripts,
      data,
      mode,
      chatID,
      cbsConditions,
    );
    const cached = getScriptCache(hash);
    if (cached) {
      return { data: cached, emoChanged: false };
    }
    if (scripts.length === 0) {
      cacheScript(hash, data);
      return { data, emoChanged };
    }
    function executeScript(pscript: pScript) {
      const script = pscript.script;
      if (script.in === "") {
        return;
      }
      if (script.type === mode) {
        let outScript2 = script.out.replaceAll("$n", "\n");
        let outScript = outScript2.replace(dreg, "$&");
        let flag = "g";
        if (script.ableFlag) {
          flag = script.flag || "g";
        }
        if (
          outScript.startsWith("@@move_top") ||
          outScript.startsWith("@@move_bottom") ||
          pscript.actions.includes("move_top") ||
          pscript.actions.includes("move_bottom")
        ) {
          flag = flag.replace("g", ""); //temperary fix
        }
        if (outScript.endsWith(">") && !pscript.actions.includes("no_end_nl")) {
          outScript += "\n";
        }
        //remove unsupported flag
        flag = flag.trim().replace(/[^dgimsuvy]/g, "");
        //remove repeated flags
        flag = flag
          .split("")
          .filter((v, i, a) => a.indexOf(v) === i)
          .join("");
        if (flag.length === 0) {
          flag = "u";
        }
        let input = script.in;
        if (pscript.actions.includes("cbs")) {
          input = risuChatParser(input, { chatID: chatID, cbsConditions });
        }
        const reg = new RegExp(input, flag);
        if (outScript.startsWith("@@") || pscript.actions.length > 0) {
          if (reg.test(data)) {
            if (outScript.startsWith("@@emo ")) {
              const emoName = script.out.substring(6).trim();
              let charemotions = get(host.CharEmotion);
              let tempEmotion = charemotions[char.chaId];
              if (!tempEmotion) {
                tempEmotion = [];
              }
              if (tempEmotion.length > 4) {
                tempEmotion.splice(0, 1);
              }
              if (char.type !== "simple") {
                for (const emo of char.emotionImages) {
                  if (emo[0] === emoName) {
                    const emos: [string, string, number] = [
                      emo[0],
                      emo[1],
                      Date.now(),
                    ];
                    tempEmotion.push(emos);
                    charemotions[char.chaId] = tempEmotion;
                    host.CharEmotion.set(charemotions);
                    emoChanged = true;
                    break;
                  }
                }
              }
            } else if (
              (outScript.startsWith("@@inject") ||
                pscript.actions.includes("inject")) &&
              chatID !== -1
            ) {
              const selchar = db.characters[get(host.selectedCharID)];
              selchar.chats[selchar.chatPage].message[chatID].data = data;
              data = data.replace(reg, "");
            } else if (
              outScript.startsWith("@@move_top") ||
              outScript.startsWith("@@move_bottom") ||
              pscript.actions.includes("move_top") ||
              pscript.actions.includes("move_bottom")
            ) {
              const isGlobal = flag.includes("g");
              const matchAll = isGlobal
                ? data.matchAll(reg)
                : [data.match(reg)];
              data = data.replace(reg, "");
              for (const matched of matchAll) {
                if (matched) {
                  const inData = matched[0];
                  let out = outScript
                    .replace("@@move_top ", "")
                    .replace("@@move_bottom ", "")
                    .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                      const index = parseInt(v.substring(1));
                      if (index < matched.length) {
                        return matched[index];
                      }
                      return v;
                    })
                    .replace(/\$\&/g, inData)
                    .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                      const groupName = parseInt(v.substring(2, v.length - 1));
                      if (matched.groups && matched.groups[groupName]) {
                        return matched.groups[groupName];
                      }
                      return v;
                    });
                  if (
                    outScript.startsWith("@@move_top") ||
                    pscript.actions.includes("move_top")
                  ) {
                    data = out + "\n" + data;
                  } else {
                    data = data + "\n" + out;
                  }
                }
              }
            } else {
              data = risuChatParser(data.replace(reg, outScript), {
                chatID: chatID,
                cbsConditions,
              });
            }
          } else {
            if (
              (outScript.startsWith("@@repeat_back") ||
                pscript.actions.includes("repeat_back")) &&
              chatID !== -1
            ) {
              const v = outScript.split(" ", 2)[1];
              const selchar = db.characters[get(host.selectedCharID)];
              const chat = selchar.chats[selchar.chatPage];
              let lastChat =
                chat.fmIndex === -1
                  ? selchar.firstMessage
                  : selchar.alternateGreetings[chat.fmIndex];
              let pointer = chatID - 1;
              while (pointer >= 0) {
                if (chat.message[pointer].role === chat.message[chatID].role) {
                  lastChat = chat.message[pointer].data;
                  break;
                }
                pointer--;
              }
              const r = lastChat.match(reg);
              if (!v) {
                data = data + r[0];
              } else if (r[0]) {
                switch (v) {
                  case "end":
                    data = data + r[0];
                    break;
                  case "start":
                    data = r[0] + data;
                    break;
                  case "end_nl":
                    data = data + "\n" + r[0];
                    break;
                  case "start_nl":
                    data = r[0] + "\n" + data;
                    break;
                }
              }
            }
          }
        } else {
          data = risuChatParser(data.replace(reg, outScript), {
            chatID: chatID,
            cbsConditions,
          });
        }
      }
    }
    let parsedScripts: pScript[] = [];
    let orderChanged = false;
    for (const script of scripts) {
      if (script.ableFlag && script.flag?.includes("<")) {
        const rregex = /<(.+?)>/g;
        const scriptData = host.safeStructuredClone(script);
        let order = 0;
        const actions: string[] = [];
        scriptData.flag = scriptData.flag?.replace(
          rregex,
          (v: string, p1: string) => {
            const meta = p1.split(",").map((v) => v.trim());
            for (const m of meta) {
              if (m.startsWith("order ")) {
                order = parseInt(m.substring(6));
                orderChanged = true;
              } else {
                actions.push(m);
              }
            }
            return "";
          },
        );
        parsedScripts.push({
          script: scriptData,
          order,
          actions,
        });
        continue;
      }
      parsedScripts.push({
        script,
        order: 0,
        actions: [],
      });
    }
    if (orderChanged) {
      parsedScripts.sort((a, b) => b.order - a.order); //sort by order
    }
    for (const script of parsedScripts) {
      try {
        executeScript(script);
      } catch (error) {
        console.error(error);
      }
    }
    if (
      db.dynamicAssets &&
      (char.type === "simple" || char.type === "character") &&
      char.additionalAssets &&
      char.additionalAssets.length > 0
    ) {
      if (
        (!db.dynamicAssetsEditDisplay && mode === "editdisplay") ||
        mode === "editinput" ||
        mode === "editprocess"
      ) {
        cacheScript(hash, data);
        return { data, emoChanged };
      }
      const assetNames = char.additionalAssets.map((v) => v[0]);
      const moduleAssets = host.getModuleAssets();
      if (moduleAssets.length > 0) {
        for (const asset of moduleAssets) {
          assetNames.push(asset[0]);
        }
      }
      const processer = new host.HypaProcesser();
      await processer.addText(assetNames);
      const matches = data.matchAll(host.assetRegex);
      for (const match of matches) {
        const type = match[1];
        const assetName = match[2];
        const cacheKey = char.chaId + "::" + assetName;
        if (type !== "emotion" && type !== "source") {
          if (bestMatchCache.has(cacheKey)) {
            data = data.replaceAll(
              match[0],
              `{{${type}::${bestMatchCache.get(cacheKey)}}}`,
            );
          } else if (!assetNames.includes(assetName)) {
            const searched = await processer.similaritySearch(assetName);
            const bestMatch = searched[0];
            if (bestMatch) {
              data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`);
              bestMatchCache.set(cacheKey, bestMatch);
            }
          }
        }
      }
    }
    cacheScript(hash, data);
    return { data, emoChanged };
  }
  return {
    processScript,
    generateScriptCacheKey,
    cacheScript,
    getScriptCache,
    resetScriptCache,
    processScriptFull,
    risuChatParser,
  };
}
