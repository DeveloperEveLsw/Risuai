import { get } from "svelte/store";
import { LuaFactory as DefaultLuaFactory, type LuaEngine } from "wasmoon";
import { Mutex } from "../mutex";
import type { PyodideContext } from "./scriptings";
import type { asBuffer } from "src/ts/util";
import type {
  getChatVar,
  getGlobalChatVar,
  setChatVar,
} from "../parser/chatVar.svelte";
import type {
  hasher,
  simpleCharacterArgument,
  risuChatParser,
} from "../parser/parser.svelte";
import type {
  getCurrentCharacter,
  getCurrentChat,
  getDatabase,
  setDatabase,
  Chat,
  character,
  groupChat,
  triggerscript,
} from "../storage/database.svelte";
import type {
  DBState,
  ReloadChatPointer,
  ReloadGUIPointer,
  selectedCharID,
} from "../stores.svelte";
import type {
  alertSelect,
  alertError,
  alertInput,
  alertNormal,
  alertConfirm,
} from "../alert";
import type { HypaProcesser } from "./memory/hypamemory";
import type { generateAIImage } from "./stableDiff";
import type { writeInlayImage, getInlayAsset } from "./files/inlays";
import type { OpenAIChat, MultiModal } from "./index.svelte";
import type { requestChatData, StreamResponseChunk } from "./request/request";
import type { v4 } from "uuid";
import type { getModuleLorebooks, getModuleTriggers } from "./modules";
import type { tokenize } from "../tokenizer";
import type { fetchNative, readImage } from "../globalApi.svelte";
import type { loadLoreBookV3Prompt } from "./lorebook.svelte";
import type { getPersonaPrompt, getUserName, getUserIcon } from "../util";
interface BasicScriptingEngineState {
  code?: string;
  mutex: Mutex;
  chat?: Chat;
  setVar?: (key: string, value: string) => boolean | void;
  getVar?: (key: string) => string;
}

interface LuaScriptingEngineState extends BasicScriptingEngineState {
  engine?: LuaEngine;
  type: "lua";
}

interface PythonScriptingEngineState extends BasicScriptingEngineState {
  pyodide?: PyodideContext;
  type: "py";
}

type ScriptingEngineState =
  LuaScriptingEngineState | PythonScriptingEngineState;

/** Upstream script APIs with a private engine cache, access tokens and execution state. */
export interface ScriptingRuntimeHost {
  LuaFactory?: typeof DefaultLuaFactory;
  /** Allows a transactional host to reject all effects after a caught script failure. */
  onScriptError?: (error: unknown) => void;
  getCurrentCharacter: (typeof import("../storage/database.svelte"))["getCurrentCharacter"];
  setChatVar: (typeof import("../parser/chatVar.svelte"))["setChatVar"];
  getChatVar: (typeof import("../parser/chatVar.svelte"))["getChatVar"];
  getCurrentChat: (typeof import("../storage/database.svelte"))["getCurrentChat"];
  PyodideContext: (typeof import("./scriptings"))["PyodideContext"];
  getGlobalChatVar: (typeof import("../parser/chatVar.svelte"))["getGlobalChatVar"];
  alertError: (typeof import("../alert"))["alertError"];
  alertNormal: (typeof import("../alert"))["alertNormal"];
  alertInput: (typeof import("../alert"))["alertInput"];
  alertSelect: (typeof import("../alert"))["alertSelect"];
  alertConfirm: (typeof import("../alert"))["alertConfirm"];
  tokenize: (typeof import("../tokenizer"))["tokenize"];
  risuChatParser: (typeof import("../parser/parser.svelte"))["risuChatParser"];
  ReloadGUIPointer: (typeof import("../stores.svelte"))["ReloadGUIPointer"];
  ReloadChatPointer: (typeof import("../stores.svelte"))["ReloadChatPointer"];
  HypaProcesser: (typeof import("./memory/hypamemory"))["HypaProcesser"];
  fetchNative: (typeof import("../globalApi.svelte"))["fetchNative"];
  generateAIImage: (typeof import("./stableDiff"))["generateAIImage"];
  writeInlayImage: (typeof import("./files/inlays"))["writeInlayImage"];
  getDatabase: (typeof import("../storage/database.svelte"))["getDatabase"];
  selectedCharID: (typeof import("../stores.svelte"))["selectedCharID"];
  readImage: (typeof import("../globalApi.svelte"))["readImage"];
  asBuffer: (typeof import("src/ts/util"))["asBuffer"];
  getUserIcon: (typeof import("../util"))["getUserIcon"];
  hasher: (typeof import("../parser/parser.svelte"))["hasher"];
  getInlayAsset: (typeof import("./files/inlays"))["getInlayAsset"];
  requestChatData: (typeof import("./request/request"))["requestChatData"];
  DBState: (typeof import("../stores.svelte"))["DBState"];
  getUserName: (typeof import("../util"))["getUserName"];
  getPersonaPrompt: (typeof import("../util"))["getPersonaPrompt"];
  getModuleLorebooks: (typeof import("./modules"))["getModuleLorebooks"];
  loadLoreBookV3Prompt: (typeof import("./lorebook.svelte"))["loadLoreBookV3Prompt"];
  v4: (typeof import("uuid"))["v4"];
  getModuleTriggers: (typeof import("./modules"))["getModuleTriggers"];
  fetch: typeof fetch;
  Image: new () => HTMLImageElement;
}

export function createScriptingRuntime(host: ScriptingRuntimeHost) {
  const LuaFactory = host.LuaFactory ?? DefaultLuaFactory;
  let luaFactory: DefaultLuaFactory;

  let ScriptingSafeIds = new Set<string>();

  let ScriptingEditDisplayIds = new Set<string>();

  let ScriptingLowLevelIds = new Set<string>();

  let lastRequestResetTime = 0;

  let lastRequestsCount = 0;

  let ScriptingEngines = new Map<string, ScriptingEngineState>();

  let luaFactoryPromise: Promise<void> | null = null;

  let pendingEngineCreations = new Map<string, Promise<ScriptingEngineState>>();

  async function runScripted(
    code: string,
    arg: {
      char?: character | groupChat | simpleCharacterArgument;
      chat?: Chat;
      data?: string | OpenAIChat[];
      setVar?: (key: string, value: string) => boolean | void;
      getVar?: (key: string) => string;
      lowLevelAccess?: boolean;
      meta?: object;
      mode?: string;
      type?: "lua" | "py";
    },
  ) {
    const type: "lua" | "py" = arg.type ?? "lua";
    const char = arg.char ?? host.getCurrentCharacter();
    const data = arg.data ?? "";
    const setVar = arg.setVar ?? host.setChatVar;
    const getVar = arg.getVar ?? host.getChatVar;
    const meta = arg.meta ?? {};
    const mode = arg.mode ?? "manual";
    let chat = arg.chat ?? host.getCurrentChat();
    let stopSending = false;
    let lowLevelAccess = arg.lowLevelAccess ?? false;
    if (type === "lua") {
      await ensureLuaFactory();
    }
    let ScriptingEngineState = await getOrCreateEngineState(mode, type);
    return await ScriptingEngineState.mutex.runExclusive(async () => {
      ScriptingEngineState.chat = chat;
      ScriptingEngineState.setVar = setVar;
      ScriptingEngineState.getVar = getVar;
      if (code !== ScriptingEngineState.code) {
        let declareAPI: (name: string, func: Function) => void;
        if (ScriptingEngineState.type === "lua") {
          console.log("Creating new Lua engine for mode:", mode);
          ScriptingEngineState.engine?.global.close();
          ScriptingEngineState.code = code;
          ScriptingEngineState.engine = await luaFactory.createEngine({
            injectObjects: true,
          });
          const luaEngine = ScriptingEngineState.engine;
          declareAPI = (name: string, func: Function) => {
            luaEngine.global.set(name, func);
          };
        }
        if (ScriptingEngineState.type === "py") {
          console.log("Creating new Pyodide context for mode:", mode);
          ScriptingEngineState.pyodide?.close();
          ScriptingEngineState.pyodide = new host.PyodideContext();
          declareAPI = (name: string, func: Function) => {
            ScriptingEngineState.pyodide?.declareAPI(name, func as any);
          };
        }
        declareAPI("getChatVar", (id: string, key: string) => {
          return ScriptingEngineState.getVar(key);
        });
        declareAPI("setChatVar", (id: string, key: string, value: string) => {
          if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
            return;
          }
          ScriptingEngineState.setVar(key, value);
        });
        declareAPI(
          "setChatVarChanged",
          (id: string, key: string, value: string) => {
            if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
              return;
            }
            if (ScriptingEngineState.setVar(key, value) === true) {
              return true;
            }
          },
        );
        declareAPI("getGlobalVar", (id: string, key: string) => {
          return host.getGlobalChatVar(key);
        });
        declareAPI("stopChat", (id: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          stopSending = true;
        });
        declareAPI("alertError", (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          host.alertError(value);
        });
        declareAPI("alertNormal", (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          host.alertNormal(value);
        });
        declareAPI("alertInput", (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          return host.alertInput(value);
        });
        declareAPI("alertSelect", (id: string, value: string[]) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          return host.alertSelect(value);
        });
        declareAPI("alertConfirm", (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          return host.alertConfirm(value).then((res) => (res ? true : false));
        });
        declareAPI("getChatMain", (id: string, index: number) => {
          const chat = ScriptingEngineState.chat.message.at(index);
          if (!chat) {
            return JSON.stringify(null);
          }
          const data = {
            role: chat.role,
            data: chat.data,
            time: chat.time ?? 0,
          };
          return JSON.stringify(data);
        });
        declareAPI("getChatData", (id: string, index: number) => {
          const chat = ScriptingEngineState.chat.message.at(index);
          return chat?.data ?? "";
        });
        declareAPI("getChatRole", (id: string, index: number) => {
          const chat = ScriptingEngineState.chat.message.at(index);
          return chat?.role ?? "";
        });
        declareAPI("getRecentChatsMain", (id: string, count: number) => {
          const chats = ScriptingEngineState.chat.message;
          const safeCount = Math.max(0, Math.floor(count || 0));
          const start = Math.max(0, chats.length - safeCount);
          return JSON.stringify(
            chats.slice(start).map((v) => ({
              role: v.role,
              data: v.data,
              time: v.time ?? 0,
            })),
          );
        });
        declareAPI("setChat", (id: string, index: number, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const message = ScriptingEngineState.chat.message?.at(index);
          if (message) {
            message.data = value ?? "";
          }
        });
        declareAPI(
          "setChatRole",
          (id: string, index: number, value: string) => {
            if (!ScriptingSafeIds.has(id)) {
              return;
            }
            const message = ScriptingEngineState.chat.message?.at(index);
            if (message) {
              message.role = value === "user" ? "user" : "char";
            }
          },
        );
        declareAPI("cutChat", (id: string, start: number, end: number) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          ScriptingEngineState.chat.message =
            ScriptingEngineState.chat.message.slice(start, end);
        });
        declareAPI("removeChat", (id: string, index: number) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          ScriptingEngineState.chat.message.splice(index, 1);
        });
        declareAPI("addChat", (id: string, role: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          let roleData: "user" | "char" = role === "user" ? "user" : "char";
          ScriptingEngineState.chat.message.push({
            role: roleData,
            data: value ?? "",
          });
        });
        declareAPI(
          "insertChat",
          (id: string, index: number, role: string, value: string) => {
            if (!ScriptingSafeIds.has(id)) {
              return;
            }
            let roleData: "user" | "char" = role === "user" ? "user" : "char";
            ScriptingEngineState.chat.message.splice(index, 0, {
              role: roleData,
              data: value ?? "",
            });
          },
        );
        declareAPI("getTokens", async (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          return await host.tokenize(value);
        });
        declareAPI("getChatLength", (id: string) => {
          return ScriptingEngineState.chat.message.length;
        });
        declareAPI("getFullChatMain", (id: string) => {
          const data = JSON.stringify(
            ScriptingEngineState.chat.message.map((v) => {
              return {
                role: v.role,
                data: v.data,
                time: v.time ?? 0,
              };
            }),
          );
          return data;
        });
        declareAPI("sleep", (id: string, time: number) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(true);
            }, time);
          });
        });
        declareAPI("cbs", (value) => {
          return host.risuChatParser(value, {
            chara: host.getCurrentCharacter(),
          });
        });
        declareAPI("setFullChatMain", (id: string, value: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const realValue = JSON.parse(value);
          ScriptingEngineState.chat.message = realValue.map((v) => {
            return {
              role: v.role,
              data: v.data,
            };
          });
        });
        declareAPI("logMain", (value: string) => {
          console.log(JSON.parse(value));
        });
        declareAPI("reloadDisplay", (id: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          host.ReloadGUIPointer.set(get(host.ReloadGUIPointer) + 1);
        });
        declareAPI("reloadChat", (id: string, index: number) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          host.ReloadChatPointer.update((v) => {
            v[index] = (v[index] ?? 0) + 1;
            return v;
          });
        });
        //Low Level Access
        declareAPI(
          "similarity",
          async (id: string, source: string, value: string[]) => {
            if (!ScriptingLowLevelIds.has(id)) {
              return;
            }
            const processer = new host.HypaProcesser();
            await processer.addText(value);
            return await processer.similaritySearch(source);
          },
        );
        declareAPI("request", async (id: string, url: string) => {
          if (!ScriptingLowLevelIds.has(id)) {
            return;
          }
          if (lastRequestResetTime + 60000 < Date.now()) {
            lastRequestsCount = 0;
            lastRequestResetTime = Date.now();
          }
          if (lastRequestsCount > 5) {
            return JSON.stringify({
              status: 429,
              data: "Too many requests. you can request 5 times per minute",
            });
          }
          lastRequestsCount++;
          try {
            //for security and other reasons, only get request in 120 char is allowed
            if (url.length > 120) {
              return JSON.stringify({
                status: 413,
                data: "URL to large. max is 120 characters",
              });
            }
            if (!url.startsWith("https://")) {
              return JSON.stringify({
                status: 400,
                data: "Only https requests are allowed",
              });
            }
            const bannedURL = [
              "https://realm.risuai.net",
              "https://risuai.net",
              "https://risuai.xyz",
            ];
            for (const burl of bannedURL) {
              if (url.startsWith(burl)) {
                return JSON.stringify({
                  status: 400,
                  data: "request to " + url + " is not allowed",
                });
              }
            }
            //browser fetch
            const d = await host.fetchNative(url, {
              method: "GET",
            });
            const text = await d.text();
            return JSON.stringify({
              status: d.status,
              data: text,
            });
          } catch (error) {
            return JSON.stringify({
              status: 400,
              data: "internal error",
            });
          }
        });
        declareAPI(
          "generateImage",
          async (id: string, value: string, negValue: string = "") => {
            if (!ScriptingLowLevelIds.has(id)) {
              return;
            }
            const gen = await host.generateAIImage(
              value,
              char as character,
              negValue,
              "inlay",
            );
            if (!gen) {
              return "Error: Image generation failed";
            }
            const imgHTML = new host.Image();
            imgHTML.src = gen;
            const inlay = await host.writeInlayImage(imgHTML);
            return `{{inlay::${inlay}}}`;
          },
        );
        declareAPI("getCharacterImageMain", async (id: string) => {
          try {
            const db = host.getDatabase();
            const selectedChar = get(host.selectedCharID);
            if (selectedChar < 0 || selectedChar >= db.characters.length) {
              return "";
            }
            const character = db.characters[selectedChar];
            if (!character || character.type === "group" || !character.image) {
              return "";
            }
            const img = await host.readImage(character.image);
            const imgObj = new host.Image();
            const extention = character.image.split(".").at(-1);
            imgObj.src = URL.createObjectURL(
              new Blob([host.asBuffer(img)], { type: `image/${extention}` }),
            );
            const imgid = await host.writeInlayImage(imgObj, {
              name: character.image,
              ext: extention,
              id: character.image,
            });
            if (imgid) {
              return `{{inlayed::${imgid}}}`;
            }
            console.warn("Failed to create character image inlay");
            return "";
          } catch (error) {
            console.error("Error in getCharacterImageMain:", error);
            return "";
          }
        });
        declareAPI("getPersonaImageMain", async (id: string) => {
          try {
            const icon = host.getUserIcon();
            if (!icon) {
              return "";
            }
            const img = await host.readImage(icon);
            const imgObj = new host.Image();
            const extention = icon.split(".").at(-1);
            imgObj.src = URL.createObjectURL(
              new Blob([host.asBuffer(img)], { type: `image/${extention}` }),
            );
            const imgid = await host.writeInlayImage(imgObj, {
              name: icon,
              ext: extention,
              id: icon,
            });
            if (imgid) {
              return `{{inlayed::${imgid}}}`;
            }
            console.warn("Failed to create character image inlay");
            return "";
          } catch (error) {
            console.error("Error in getCharacterImageMain:", error);
            return "";
          }
        });
        declareAPI("hash", async (id: string, value: string) => {
          return await host.hasher(new TextEncoder().encode(value));
        });
        const parseLuaOptions = (optionsStr?: string) => {
          if (!optionsStr) {
            return {};
          }
          try {
            const parsed = JSON.parse(optionsStr);
            return parsed && typeof parsed === "object" ? parsed : {};
          } catch {
            return {};
          }
        };
        const collectLuaStreamText = async (
          stream: ReadableStream<StreamResponseChunk>,
        ) => {
          const reader = stream.getReader();
          let text = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              if (value && typeof value["0"] === "string") {
                text = value["0"];
              }
            }
          } finally {
            reader.releaseLock();
          }
          return text;
        };
        declareAPI(
          "LLMMain",
          async (
            id: string,
            promptStr: string,
            useMultimodal: boolean = false,
            optionsStr: string = "",
          ) => {
            let prompt: {
              role: string;
              content: string;
            }[] = JSON.parse(promptStr);
            if (!ScriptingLowLevelIds.has(id)) {
              return;
            }
            let promptbody: OpenAIChat[] = prompt.map((dict) => {
              let role: "system" | "user" | "assistant" = "assistant";
              switch (dict["role"]) {
                case "system":
                case "sys":
                  role = "system";
                  break;
                case "user":
                  role = "user";
                  break;
                case "assistant":
                case "bot":
                case "char": {
                  role = "assistant";
                  break;
                }
              }
              return {
                content: dict["content"] ?? "",
                role: role,
              };
            });
            if (useMultimodal) {
              for (const msg of promptbody) {
                const inlays: string[] = [];
                msg.content = msg.content.replace(
                  /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                  (match: string, p1: string, p2: string) => {
                    if (msg.role === "assistant") {
                      if (p2 && p1 === "inlayeddata") {
                        inlays.push(p2);
                      }
                    } else {
                      if (p2) {
                        inlays.push(p2);
                      }
                    }
                    return "";
                  },
                );
                const multimodals: MultiModal[] = [];
                for (const inlay of inlays) {
                  const inlayData = await host.getInlayAsset(inlay);
                  multimodals.push({
                    type: inlayData?.type,
                    base64: inlayData?.data,
                    width: inlayData?.width,
                    height: inlayData?.height,
                  });
                }
                msg.multimodals =
                  multimodals.length > 0 ? multimodals : undefined;
              }
            }
            const options = parseLuaOptions(optionsStr) as {
              streaming?: boolean;
            };
            const result = await host.requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: options.streaming === true,
                forceStreaming: options.streaming === true,
                noMultiGen: true,
              },
              "model",
            );
            if (result.type === "fail") {
              return JSON.stringify({
                success: false,
                result: "Error: " + result.result,
              });
            }
            if (result.type === "streaming") {
              try {
                return JSON.stringify({
                  success: true,
                  result: await collectLuaStreamText(result.result),
                });
              } catch (error) {
                return JSON.stringify({
                  success: false,
                  result: "Error: " + error,
                });
              }
            }
            if (result.type === "multiline") {
              return JSON.stringify({
                success: false,
                result: result.result,
              });
            }
            return JSON.stringify({
              success: true,
              result: result.result,
            });
          },
        );
        declareAPI("simpleLLM", async (id: string, prompt: string) => {
          if (!ScriptingLowLevelIds.has(id)) {
            return;
          }
          const result = await host.requestChatData(
            {
              formated: [
                {
                  role: "user",
                  content: prompt,
                },
              ],
              bias: {},
              useStreaming: false,
              noMultiGen: true,
            },
            "model",
          );
          if (result.type === "fail") {
            return {
              success: false,
              result: "Error: " + result.result,
            };
          }
          if (result.type === "streaming" || result.type === "multiline") {
            return {
              success: false,
              result: result.result,
            };
          }
          return {
            success: true,
            result: result.result,
          };
        });
        declareAPI("getName", (id: string) => {
          const db = host.getDatabase();
          const selectedChar = get(host.selectedCharID);
          const char = db.characters[selectedChar];
          return char.name;
        });
        declareAPI("setName", (id: string, name: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const selectedChar = get(host.selectedCharID);
          if (typeof name !== "string") {
            throw "Invalid data type";
          }
          host.DBState.db.characters[selectedChar].name = name;
        });
        declareAPI("getDescription", (id: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const selectedChar = get(host.selectedCharID);
          const char = host.DBState.db.characters[selectedChar];
          if (char.type === "group") {
            throw "Character is a group";
          }
          return char.desc;
        });
        declareAPI("setDescription", (id: string, desc: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const selectedChar = get(host.selectedCharID);
          const char = host.DBState.db.characters[selectedChar];
          if (typeof data !== "string") {
            throw "Invalid data type";
          }
          if (char.type === "group") {
            throw "Character is a group";
          }
          char.desc = desc;
          host.DBState.db.characters[selectedChar] = char;
        });
        declareAPI("getCharacterFirstMessage", (id: string) => {
          const selectedChar = get(host.selectedCharID);
          const char = host.DBState.db.characters[selectedChar];
          return char.firstMessage;
        });
        declareAPI("setCharacterFirstMessage", (id: string, data: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const db = host.getDatabase();
          const selectedChar = get(host.selectedCharID);
          const char = db.characters[selectedChar];
          if (typeof data !== "string") {
            return false;
          }
          char.firstMessage = data;
          host.DBState.db.characters[selectedChar] = char;
          return true;
        });
        declareAPI("getPersonaName", (id: string) => {
          return host.getUserName();
        });
        declareAPI("getPersonaDescription", (id: string) => {
          const db = host.getDatabase();
          const selectedChar = get(host.selectedCharID);
          const char = db.characters[selectedChar];
          return host.risuChatParser(host.getPersonaPrompt(), { chara: char });
        });
        declareAPI("getAuthorsNote", (id: string) => {
          return ScriptingEngineState.chat?.note ?? "";
        });
        declareAPI("getBackgroundEmbedding", (id: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const db = host.getDatabase();
          const selectedChar = get(host.selectedCharID);
          const char = db.characters[selectedChar];
          return char.backgroundHTML;
        });
        declareAPI("setBackgroundEmbedding", (id: string, data: string) => {
          if (!ScriptingSafeIds.has(id)) {
            return;
          }
          const db = host.getDatabase();
          const selectedChar = get(host.selectedCharID);
          if (typeof data !== "string") {
            return false;
          }
          host.DBState.db.characters[selectedChar].backgroundHTML = data;
          return true;
        });
        // Lore books
        declareAPI("getLoreBooksMain", (id: string, search: string) => {
          const db = host.getDatabase();
          const selectedChar = db.characters[get(host.selectedCharID)];
          if (selectedChar.type !== "character") {
            return;
          }
          const loreSources = [
            selectedChar.chats[selectedChar.chatPage]?.localLore ?? [],
            selectedChar.globalLore,
            host.getModuleLorebooks(),
          ];
          const found = [];
          for (const source of loreSources) {
            for (const b of source) {
              if (b.comment === search) {
                found.push({
                  ...b,
                  content: host.risuChatParser(b.content, {
                    chara: selectedChar,
                  }),
                });
              }
            }
          }
          return JSON.stringify(found);
        });
        type upsertLoreBookOptions = {
          alwaysActive?: boolean;
          insertOrder?: number;
          key?: string;
          secondKey?: string;
          regex?: boolean;
        };
        declareAPI(
          "upsertLocalLoreBook",
          (
            id: string,
            name: string,
            content: string,
            options: upsertLoreBookOptions,
          ) => {
            if (!ScriptingSafeIds.has(id)) {
              return;
            }
            if (char.type !== "character") {
              return;
            }
            const {
              alwaysActive = false,
              insertOrder = 100,
              key = "",
              regex = false,
              secondKey = "",
            } = options;
            const currentChat = char.chats[char.chatPage];
            const newLocalLoreBooks = currentChat.localLore.filter(
              (book) => book.comment !== name,
            );
            newLocalLoreBooks.push({
              alwaysActive,
              comment: name,
              content: content,
              insertorder: insertOrder,
              mode: "normal",
              key,
              secondkey: secondKey,
              selective: !!secondKey,
              useRegex: regex,
            });
            currentChat.localLore = newLocalLoreBooks;
          },
        );
        declareAPI("loadLoreBooksMain", async (id: string, reserve: number) => {
          if (!ScriptingLowLevelIds.has(id)) {
            return;
          }
          const db = host.getDatabase();
          const selectedChar = db.characters[get(host.selectedCharID)];
          if (selectedChar.type !== "character") {
            return;
          }
          const fullLoreBooks = (await host.loadLoreBookV3Prompt()).actives;
          const maxContext = db.maxContext - reserve;
          if (maxContext < 0) {
            return JSON.stringify([]);
          }
          let totalTokens = 0;
          const loreBooks = [];
          for (const book of fullLoreBooks) {
            const parsed = host
              .risuChatParser(book.prompt, { chara: selectedChar })
              .trim();
            if (parsed.length === 0) {
              continue;
            }
            const tokens = await host.tokenize(parsed);
            if (totalTokens + tokens > maxContext) {
              break;
            }
            totalTokens += tokens;
            loreBooks.push({
              data: parsed,
              role: book.role === "assistant" ? "char" : book.role,
            });
          }
          return JSON.stringify(loreBooks);
        });
        declareAPI(
          "axLLMMain",
          async (
            id: string,
            promptStr: string,
            useMultimodal: boolean = false,
            optionsStr: string = "",
          ) => {
            let prompt: {
              role: string;
              content: string;
            }[] = JSON.parse(promptStr);
            if (!ScriptingLowLevelIds.has(id)) {
              return;
            }
            let promptbody: OpenAIChat[] = prompt.map((dict) => {
              let role: "system" | "user" | "assistant" = "assistant";
              switch (dict["role"]) {
                case "system":
                case "sys":
                  role = "system";
                  break;
                case "user":
                  role = "user";
                  break;
                case "assistant":
                case "bot":
                case "char": {
                  role = "assistant";
                  break;
                }
              }
              return {
                content: dict["content"] ?? "",
                role: role,
              };
            });
            if (useMultimodal) {
              for (const msg of promptbody) {
                const inlays: string[] = [];
                msg.content = msg.content.replace(
                  /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                  (match: string, p1: string, p2: string) => {
                    if (msg.role === "assistant") {
                      if (p2 && p1 === "inlayeddata") {
                        inlays.push(p2);
                      }
                    } else {
                      if (p2) {
                        inlays.push(p2);
                      }
                    }
                    return "";
                  },
                );
                const multimodals: MultiModal[] = [];
                for (const inlay of inlays) {
                  const inlayData = await host.getInlayAsset(inlay);
                  multimodals.push({
                    type: inlayData?.type,
                    base64: inlayData?.data,
                    width: inlayData?.width,
                    height: inlayData?.height,
                  });
                }
                msg.multimodals =
                  multimodals.length > 0 ? multimodals : undefined;
              }
            }
            const options = parseLuaOptions(optionsStr) as {
              mode?: string;
              streaming?: boolean;
            };
            const modes = new Set([
              "emotion",
              "memory",
              "otherAx",
              "submodel",
              "translate",
            ]);
            const mode = options.mode ?? "otherAx";
            if (!modes.has(mode)) {
              return JSON.stringify({
                result: "Error: Invalid axLLM mode: " + mode,
                success: false,
              });
            }
            const result = await host.requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: options.streaming === true,
                forceStreaming: options.streaming === true,
                noMultiGen: true,
              },
              mode as
                "emotion" | "memory" | "otherAx" | "submodel" | "translate",
            );
            if (result.type === "fail") {
              return JSON.stringify({
                success: false,
                result: "Error: " + result.result,
              });
            }
            if (result.type === "streaming") {
              try {
                return JSON.stringify({
                  success: true,
                  result: await collectLuaStreamText(result.result),
                });
              } catch (error) {
                return JSON.stringify({
                  success: false,
                  result: "Error: " + error,
                });
              }
            }
            if (result.type === "multiline") {
              return JSON.stringify({
                success: false,
                result: result.result,
              });
            }
            return JSON.stringify({
              success: true,
              result: result.result,
            });
          },
        );
        declareAPI("getCharacterLastMessage", (id: string) => {
          const chat = ScriptingEngineState.chat;
          if (!chat) {
            return "";
          }
          const db = host.getDatabase();
          const selchar = db.characters[get(host.selectedCharID)];
          let pointer = chat.message.length - 1;
          while (pointer >= 0) {
            if (chat.message[pointer].role === "char") {
              const messageData = chat.message[pointer].data;
              return messageData;
            }
            pointer--;
          }
          return selchar.firstMessage;
        });
        declareAPI("getUserLastMessage", (id: string) => {
          const chat = ScriptingEngineState.chat;
          if (!chat) {
            return "";
          }
          let pointer = chat.message.length - 1;
          while (pointer >= 0) {
            if (chat.message[pointer].role === "user") {
              const messageData = chat.message[pointer].data;
              return messageData;
            }
            pointer--;
          }
          return "";
        });
        declareAPI("getCharacterLastMessage", (id: string) => {
          const chat = ScriptingEngineState.chat;
          if (!chat) {
            return "";
          }
          const db = host.getDatabase();
          const selchar = db.characters[get(host.selectedCharID)];
          let pointer = chat.message.length - 1;
          while (pointer >= 0) {
            if (chat.message[pointer].role === "char") {
              const messageData = chat.message[pointer].data;
              return messageData;
            }
            pointer--;
          }
          return selchar.firstMessage;
        });
        declareAPI("getUserLastMessage", (id: string) => {
          const chat = ScriptingEngineState.chat;
          if (!chat) {
            return "";
          }
          let pointer = chat.message.length - 1;
          while (pointer >= 0) {
            if (chat.message[pointer].role === "user") {
              const messageData = chat.message[pointer].data;
              return messageData;
            }
            pointer--;
          }
          return "";
        });
        console.log("Running Lua code:", code);
        if (ScriptingEngineState.type === "lua") {
          await ScriptingEngineState.engine?.doString(luaCodeWrapper(code));
        }
        if (ScriptingEngineState.type === "py") {
          await ScriptingEngineState.pyodide?.init(code);
        }
        ScriptingEngineState.code = code;
      }
      let accessKey = host.v4();
      if (mode === "editDisplay") {
        ScriptingEditDisplayIds.add(accessKey);
      } else {
        ScriptingSafeIds.add(accessKey);
        if (lowLevelAccess) {
          ScriptingLowLevelIds.add(accessKey);
        }
      }
      let res: any;
      try {
        if (ScriptingEngineState.type === "lua") {
          const luaEngine = ScriptingEngineState.engine;
          try {
            switch (mode) {
              case "input": {
                const func = luaEngine.global.get("onInput");
                if (func) {
                  res = await func(accessKey);
                }
                break;
              }
              case "output": {
                const func = luaEngine.global.get("onOutput");
                if (func) {
                  res = await func(accessKey);
                }
                break;
              }
              case "start": {
                const func = luaEngine.global.get("onStart");
                if (func) {
                  res = await func(accessKey);
                }
                break;
              }
              case "onButtonClick": {
                const func = luaEngine.global.get("onButtonClick");
                if (func) {
                  res = await func(accessKey, data);
                }
                break;
              }
              case "editRequest":
              case "editDisplay":
              case "editInput":
              case "editOutput": {
                const func = luaEngine.global.get("callListenMain");
                if (func) {
                  res = await func(
                    mode,
                    accessKey,
                    JSON.stringify(data),
                    JSON.stringify(meta),
                  );
                  res = JSON.parse(res);
                }
                break;
              }
              default: {
                const func = luaEngine.global.get(mode);
                if (func) {
                  res = await func(accessKey);
                }
                break;
              }
            }
            if (res === false) {
              stopSending = true;
            }
          } catch (error) {
            host.onScriptError?.(error);
            console.error(error);
          }
        }
        if (ScriptingEngineState.type === "py") {
          switch (mode) {
            case "input": {
              res = await ScriptingEngineState.pyodide?.python(
                `onInput('${accessKey}')`,
              );
              break;
            }
            case "output": {
              res = await ScriptingEngineState.pyodide?.python(
                `onOutput('${accessKey}')`,
              );
              break;
            }
            case "start": {
              res = await ScriptingEngineState.pyodide?.python(
                `onStart('${accessKey}')`,
              );
              break;
            }
            case "onButtonClick": {
              res = await ScriptingEngineState.pyodide?.python(
                `onButtonClick('${accessKey}', '${data as string}')`,
              );
              break;
            }
            case "editRequest":
            case "editDisplay":
            case "editInput":
            case "editOutput": {
              res = await ScriptingEngineState.pyodide?.python(
                `callListenMain('${mode}', '${accessKey}', '${JSON.stringify(data)}', '${JSON.stringify(meta)}')`,
              );
              res = JSON.parse(res);
              break;
            }
            default: {
              res = await ScriptingEngineState.pyodide?.python(
                `${mode}('${accessKey}')`,
              );
              break;
            }
          }
        }
        chat = ScriptingEngineState.chat;
        return {
          stopSending,
          chat,
          res,
        };
      } finally {
        ScriptingSafeIds.delete(accessKey);
        ScriptingEditDisplayIds.delete(accessKey);
        ScriptingLowLevelIds.delete(accessKey);
      }
    });
  }

  async function makeLuaFactory() {
    const _luaFactory = new LuaFactory();
    async function mountFile(name: string) {
      let code = "";
      for (let i = 0; i < 3; i++) {
        try {
          const res = await host.fetch("/lua/" + name);
          if (res.status >= 200 && res.status < 300) {
            code = await res.text();
            break;
          }
        } catch (error) {}
      }
      await _luaFactory.mountFile(name, code);
    }
    await mountFile("json.lua");
    luaFactory = _luaFactory;
  }

  async function ensureLuaFactory() {
    if (luaFactory) return;
    if (luaFactoryPromise) {
      try {
        await luaFactoryPromise;
      } catch (error) {
        luaFactoryPromise = null;
      }
      return;
    }
    try {
      luaFactoryPromise = makeLuaFactory();
      await luaFactoryPromise;
    } finally {
      luaFactoryPromise = null;
    }
  }

  async function getOrCreateEngineState(
    mode: string,
    type: "lua" | "py",
  ): Promise<ScriptingEngineState> {
    let engineState = ScriptingEngines.get(mode);
    if (engineState) {
      return engineState;
    }
    let pendingCreation = pendingEngineCreations.get(mode);
    if (pendingCreation) {
      return pendingCreation;
    }
    const creationPromise = (() => {
      const engineState: ScriptingEngineState = {
        mutex: new Mutex(),
        type: type,
      };
      ScriptingEngines.set(mode, engineState);
      pendingEngineCreations.delete(mode);
      return Promise.resolve(engineState);
    })();
    pendingEngineCreations.set(mode, creationPromise);
    return creationPromise;
  }

  function luaCodeWrapper(code: string) {
    return `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)

${code}
`;
  }

  async function runLuaEditTrigger<T extends string | OpenAIChat[]>(
    char: character | groupChat | simpleCharacterArgument,
    mode: string,
    content: T,
    meta?: object,
  ): Promise<T> {
    switch (mode) {
      case "editinput":
        mode = "editInput";
        break;
      case "editoutput":
        mode = "editOutput";
        break;
      case "editdisplay":
        mode = "editDisplay";
        break;
      case "editprocess":
        return content;
    }
    try {
      let data = content;
      const triggers =
        char.type === "group"
          ? host.getModuleTriggers()
          : char.triggerscript
              .map((v) => {
                v.lowLevelAccess = false;
                return v;
              })
              .concat(host.getModuleTriggers());
      for (let trigger of triggers) {
        if (trigger?.effect?.[0]?.type === "triggerlua") {
          const runResult = await runScripted(trigger.effect[0].code, {
            char: char,
            lowLevelAccess: false,
            mode: mode,
            data,
            meta,
          });
          data = runResult.res ?? data;
        }
      }
      return data;
    } catch (error) {
      host.onScriptError?.(error);
      return content;
    }
  }

  async function runLuaButtonTrigger(
    char: character | groupChat | simpleCharacterArgument,
    data: string,
  ): Promise<any> {
    let runResult;
    try {
      const triggers =
        char.type === "group"
          ? host.getModuleTriggers()
          : char.triggerscript
              .map<triggerscript>((v) => ({
                ...v,
                lowLevelAccess:
                  char.type !== "simple"
                    ? (char.lowLevelAccess ?? false)
                    : false,
              }))
              .concat(host.getModuleTriggers());
      for (let trigger of triggers) {
        if (trigger?.effect?.[0]?.type === "triggerlua") {
          runResult = await runScripted(trigger.effect[0].code, {
            char: char,
            lowLevelAccess: trigger.lowLevelAccess,
            mode: "onButtonClick",
            data: data,
          });
        }
      }
    } catch (error) {
      throw error;
    }
    return runResult;
  }

  function close() {
    for (const state of ScriptingEngines.values()) {
      if (state.type === "lua") state.engine?.global.close();
      else state.pyodide?.close();
    }
    ScriptingEngines.clear();
    ScriptingSafeIds.clear();
    ScriptingEditDisplayIds.clear();
    ScriptingLowLevelIds.clear();
  }
  function diagnostics() {
    return {
      engines: ScriptingEngines.size,
      safeTokens: ScriptingSafeIds.size,
      displayTokens: ScriptingEditDisplayIds.size,
      lowLevelTokens: ScriptingLowLevelIds.size,
    };
  }
  return {
    runScripted,
    runLuaEditTrigger,
    runLuaButtonTrigger,
    close,
    diagnostics,
  };
}
