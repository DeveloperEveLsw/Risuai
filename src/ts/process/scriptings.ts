import { untrack } from "svelte";
import { asBuffer } from "src/ts/util";

import {
  getChatVar,
  getGlobalChatVar,
  setChatVar,
} from "../parser/chatVar.svelte";

import {
  hasher,
  type simpleCharacterArgument,
  risuChatParser,
} from "../parser/parser.svelte";

import { LuaEngine, LuaFactory } from "wasmoon";
import luaWasmUrl from "wasmoon/dist/glue.wasm?url";
class BrowserLuaFactory extends LuaFactory {
  constructor() {
    super(import.meta.env.SSR ? undefined : luaWasmUrl);
  }
}

import {
  getCurrentCharacter,
  getCurrentChat,
  getDatabase,
  setDatabase,
  type Chat,
  type character,
  type groupChat,
  type triggerscript,
} from "../storage/database.svelte";

import { get } from "svelte/store";

import {
  DBState,
  ReloadChatPointer,
  ReloadGUIPointer,
  selectedCharID,
} from "../stores.svelte";

import {
  alertSelect,
  alertError,
  alertInput,
  alertNormal,
  alertConfirm,
} from "../alert";

import { HypaProcesser } from "./memory/hypamemory";

import { generateAIImage } from "./stableDiff";

import { writeInlayImage, getInlayAsset } from "./files/inlays";

import type { OpenAIChat, MultiModal } from "./index.svelte";

import { requestChatData, type StreamResponseChunk } from "./request/request";

import { v4 } from "uuid";

import { getModuleLorebooks, getModuleTriggers } from "./modules";

import { Mutex } from "../mutex";

import { tokenize } from "../tokenizer";

import { fetchNative, readImage } from "../globalApi.svelte";

import { loadLoreBookV3Prompt } from "./lorebook.svelte";

import { getPersonaPrompt, getUserName, getUserIcon } from "../util";

export async function runScripted(
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
  return getBrowserRuntime().runScripted(code, arg);
}

export async function runLuaEditTrigger<T extends string | OpenAIChat[]>(
  char: character | groupChat | simpleCharacterArgument,
  mode: string,
  content: T,
  meta?: object,
): Promise<T> {
  if (
    entityRuntimeEnabled &&
    mode === "editdisplay" &&
    typeof content === "string"
  ) {
    // Most characters have no display Lua. Avoid copying loaded history/settings
    // or initializing a VM while retaining Lua from any active module.
    if (
      !hasDisplayLua(char.type === "group" ? [] : char.triggerscript) &&
      !hasDisplayLua(getModuleTriggers())
    )
      return content;
    const metadata = displayMetadata.get(char);
    const parameters: [
      string,
      number,
      boolean,
      string,
      string?,
      DisplayCapture?,
      (() => boolean)?,
    ] = [
      content,
      Number((meta as { index?: number })?.index ?? -1),
      Boolean(metadata?.firstMessage),
      char.chaId,
      metadata?.rawContent,
      metadata?.capture,
      metadata?.current,
    ];
    if (metadata?.captured && metadata.capture) {
      const draft = await getDisplayRuntime().defer(...parameters);
      if (draft.failed)
        throw new Error(
          "Display Lua calculation failed; persistent effects were not submitted" +
            (draft.error ? ": " + draft.error : ""),
        );
      (metadata.drafts ??= []).push(draft);
      if (draft.command && Array.isArray(draft.command.edits)) {
        for (const edit of draft.command
          .edits as unknown as import("../runtime/variableCommands").VariableEdit[]) {
          if (
            edit.scope !== "chat" ||
            edit.chatId !== metadata.capture.state.chatId
          )
            throw new Error("Display variable draft outside its pinned chat");
          if (edit.remove) delete metadata.capture.chat.scriptstate[edit.key];
          else metadata.capture.chat.scriptstate[edit.key] = edit.value;
        }
      }
      return draft.output as T;
    }
    return (await getDisplayRuntime().run(...parameters)) as T;
  }
  return getBrowserRuntime().runLuaEditTrigger<T>(char, mode, content, meta);
}

export async function runLuaButtonTrigger(
  char: character | groupChat | simpleCharacterArgument,
  data: string,
): Promise<any> {
  return getBrowserRuntime().runLuaButtonTrigger(char, data);
}

export class PyodideContext {
  worker: Worker;
  apis: Record<string, (...args: any[]) => any> = {};
  inited: boolean = false;
  constructor() {
    this.worker = new Worker(new URL("./pyworker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "call") {
        const { function: func, args, callId } = event.data;
        if (this.apis[func]) {
          this.apis[func](...args)
            .then((result) => {
              this.worker.postMessage({
                type: "functionResult",
                callId: callId,
                result: result,
              });
            })
            .catch((error) => {
              this.worker.postMessage({
                type: "error",
                error: error.message,
                id: callId,
              });
            });
        } else {
          this.worker.postMessage({
            type: "error",
            error: `Function ${func} not found`,
            id: callId,
          });
        }
      }
    };
  }
  declareAPI(name: string, func: (...args: any[]) => any) {
    this.apis[name] = func;
  }
  async init(code: string) {
    if (this.inited) {
      return;
    }
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent) => {
        if (event.data.id !== id) {
          return;
        }

        if (event.data.type === "init") {
          this.inited = true;
          resolve();
        } else if (event.data.type === "error") {
          reject(new Error(event.data.error));
        }
      };
      this.worker.postMessage({
        type: "init",
        code: code,
        id: id,
        moduleFunctions: Object.keys(this.apis),
      });
    });
  }
  async python(call: string) {
    const id = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent) => {
        if (event.data.id !== id) {
          return;
        }

        if (event.data.type === "python") {
          resolve(event.data.call);
        } else if (event.data.type === "error") {
          reject(new Error(event.data.error));
        }
      };
      this.worker.postMessage({
        type: "python",
        call: call,
        id: id,
      });
    });
  }
  close() {
    this.worker.terminate();
  }
}
import {
  createScriptingRuntime,
  type ScriptingRuntimeHost,
} from "./scriptingRuntime";
let browserRuntime: ReturnType<typeof createScriptingRuntime>;
function getBrowserRuntime() {
  return (browserRuntime ??= createScriptingRuntime(getBrowserScriptingHost()));
}
function getBrowserScriptingHost(): ScriptingRuntimeHost {
  return {
    LuaFactory: BrowserLuaFactory,
    getCurrentCharacter,
    setChatVar,
    getChatVar,
    getCurrentChat,
    PyodideContext,
    getGlobalChatVar,
    alertError,
    alertNormal,
    alertInput,
    alertSelect,
    alertConfirm,
    tokenize,
    risuChatParser,
    ReloadGUIPointer,
    ReloadChatPointer,
    HypaProcesser,
    fetchNative,
    generateAIImage,
    writeInlayImage,
    getDatabase,
    selectedCharID,
    readImage,
    asBuffer,
    getUserIcon,
    hasher,
    getInlayAsset,
    requestChatData,
    DBState,
    getUserName,
    getPersonaPrompt,
    getModuleLorebooks,
    loadLoreBookV3Prompt,
    v4,
    getModuleTriggers,
    fetch: (input, init) => fetch(input, init),
    get Image() {
      return Image;
    },
  };
}

import { BrowserDisplayLua, hasDisplayLua } from "../runtime/browserDisplayLua";
import {
  browserRuntime as runtimeBridge,
  entityRuntimeEnabled,
  reportRuntimeError,
  RuntimeUIState,
  VariableOverlays,
} from "../runtime/browserRuntimeState.svelte";
import { displayMetadata } from "../runtime/browserDisplayMetadata";
import { getBrowserCbsHost } from "../parser/parser.svelte";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { createExpressionEvaluator } from "./expressionRuntime";
import { DisplayWorkerExecutor } from "../runtime/displayWorkerExecutor";
import { createDisplayScopeCache } from "../runtime/displayScopeCache.svelte";
import { provisionalDisplayScope } from "../runtime/provisionalDisplayScope";
import type { DisplayCapture } from "../runtime/displayEffects";
import {
  displayReadAdmission,
  mergeDisplayReads,
} from "../runtime/displayReadDependencies";
import { commandJson } from "../runtime/clientProtocol";
let displayRuntime: BrowserDisplayLua;
let displayScopeCache: ReturnType<typeof createDisplayScopeCache>;
let bookmarkDisplayScopeCache: ReturnType<typeof createDisplayScopeCache>;
function displayEnvironment(aiModel: DisplayCapture["database"]["aiModel"]) {
  const host = getBrowserCbsHost();
  return {
    model: host.getModelInfo(aiModel),
    triggerId: host.getCurrentTriggerId(),
    isTauri: host.isTauri,
    isNodeServer: host.isNodeServer,
    isMobile: host.isMobile,
    appVer: host.appVer,
  };
}
function prepareDisplayCapture(capture: DisplayCapture) {
  const cbsHost = getBrowserCbsHost();
  capture.cbsEnvironment = displayEnvironment(capture.database.aiModel);
  capture.cbsModules = cbsHost.getModules();
  capture.cbsLorebooks = cbsHost.getModuleLorebooks();
  capture.triggers = (
    capture.character.type === "group" ? [] : capture.character.triggerscript
  ).concat(
    // The original module accessor annotates DBState triggers in place.
    // Display derivation performs that same annotation on private copies.
    capture.cbsModules.flatMap((module) =>
      (module?.trigger ?? []).map((t) => ({
        ...t,
        lowLevelAccess: module.lowLevelAccess,
        effect: t.effect.map((e) => ({ ...e })),
        conditions: t.conditions.map((c) => ({ ...c })),
      })),
    ),
  );
  return capture;
}
function getBookmarkDisplayCache() {
  if (bookmarkDisplayScopeCache) return bookmarkDisplayScopeCache;
  return (bookmarkDisplayScopeCache = createDisplayScopeCache(
    (fresh) => {
      const capture =
        fresh ??
        runtimeBridge().captureBookmarkDisplay(
          RuntimeUIState.bookmarkList.presentationToken,
        );
      return capture && prepareDisplayCapture(capture);
    },
    () => {
      RuntimeUIState.bookmarkList;
      RuntimeUIState.displayScopeRevision;
      RuntimeUIState.displayRevision;
      RuntimeUIState.scopeReady;
    },
  ));
}
function getDisplayRuntime() {
  if (displayRuntime) return displayRuntime;
  const cache = createDisplayScopeCache(
    (fresh) => {
      const capture = fresh ?? runtimeBridge().captureDisplay(-1, false);
      if (!capture) return;
      return prepareDisplayCapture(capture);
    },
    () => {
      RuntimeUIState.displayScopeRevision;
      RuntimeUIState.displayRevision;
      RuntimeUIState.scopeReady;
      RuntimeUIState.hasEarlier;
    },
  );
  displayScopeCache = cache;
  return (displayRuntime = new BrowserDisplayLua(
    getBrowserScriptingHost,
    {
      capture: (
        index,
        firstMessage,
        expectedCharacterId,
        expectedMessageId,
        bookmarkToken,
      ) => {
        if (bookmarkToken) {
          const header = runtimeBridge().captureBookmarkDisplayHeader(
            bookmarkToken,
            expectedMessageId,
          );
          return (
            header &&
            getBookmarkDisplayCache().capture(
              header,
              displayEnvironment(header.aiModel),
              () =>
                runtimeBridge().captureBookmarkDisplay(
                  bookmarkToken,
                  expectedMessageId,
                ),
            )
          );
        }
        const header = runtimeBridge().captureDisplayHeader(
          index,
          firstMessage,
          expectedCharacterId,
          expectedMessageId,
        );
        if (!header) {
          if (firstMessage || !expectedMessageId) return;
          const preview = runtimeBridge().captureProvisionalDisplayHeader(
            expectedMessageId,
            expectedCharacterId,
          );
          if (!preview) return;
          const base = cache.capture(
            preview.header,
            displayEnvironment(preview.header.aiModel),
            () =>
              runtimeBridge().captureDisplay(-1, false, expectedCharacterId),
          );
          return (
            base &&
            provisionalDisplayScope(base, preview.rows, expectedMessageId)
          );
        }
        return cache.capture(header, displayEnvironment(header.aiModel), () =>
          runtimeBridge().captureDisplay(
            index,
            firstMessage,
            expectedCharacterId,
            expectedMessageId,
          ),
        );
      },
      seen: (key, capture) => runtimeBridge().displaySeen(key, capture),
      pending: (key) => runtimeBridge().pendingDisplay(key),
      submit: (command, capture) =>
        runtimeBridge().submitDisplay(command, capture),
      error: reportRuntimeError,
      parser: (scope) =>
        createCbsRuntime({
          ...getBrowserCbsHost(),
          ...scope.variables,
          ...scope.util,
          calcString: createExpressionEvaluator(scope.variables),
          getDatabase: () => scope.capture.database,
          getSelectedCharID: () => 0,
          getModules: () => scope.capture.cbsModules ?? [],
          getModuleLorebooks: () => scope.capture.cbsLorebooks ?? [],
          findCharacterbyId: (id) => {
            if (
              id !== scope.capture.character.chaId ||
              scope.capture.character.type === "group"
            )
              return scope.proposal.fail(
                "Display character lookup outside its pinned scope is unavailable",
              );
            return scope.capture.character;
          },
        }).parse,
    },
    8,
    (base) => new DisplayWorkerExecutor(base),
  ));
}

export async function commitDisplayScope(character: object) {
  const metadata = displayMetadata.get(character);
  const reads = metadata?.capture && displayReadAdmission(metadata.capture);
  if (!metadata || reads?.provisional) return;
  if (metadata.drafts?.length) {
    for (const draft of metadata.drafts) await draft.commit(reads);
  } else if (reads?.messageEdits?.length) {
    const signature = commandJson(
      mergeDisplayReads({ type: "source-intent", reads: [], edits: [] }, reads),
    );
    if (metadata.admission && metadata.admissionSignature !== signature)
      throw Error("Coalesced display source has different read provenance");
    if (!metadata.admit)
      throw Error("Display source admission owner is unavailable");
    if (!metadata.admission) {
      metadata.admissionSignature = signature;
      metadata.admission = metadata.admit(reads);
    }
    await metadata.admission;
  }
}
export function createDisplayAdmission(capture: DisplayCapture) {
  const owner = getDisplayRuntime();
  return (
    admission: import("../runtime/displayReadDependencies").DisplayReadAdmission,
  ) => owner.admit(capture, admission);
}
export function captureDisplayScope(
  index: number,
  firstMessage: boolean,
  characterId?: string,
  messageId?: string,
  bookmarkToken?: string,
) {
  const capture = getDisplayRuntime().capture(
    index,
    firstMessage,
    characterId,
    messageId,
    bookmarkToken,
  );
  if (capture)
    capture.presentationVariables = untrack(() =>
      [...VariableOverlays].map(([key, value]) => [key, { ...value }] as const),
    );
  return capture;
}
export function closeBookmarkDisplayScopes() {
  bookmarkDisplayScopeCache?.close();
  bookmarkDisplayScopeCache = undefined;
}
export function captureDisplayPresentationIdentity(capture: DisplayCapture) {
  return getDisplayRuntime().presentationIdentity(capture);
}
export function closeDisplayRuntime() {
  displayRuntime?.close();
  displayScopeCache?.close();
  bookmarkDisplayScopeCache?.close();
  displayRuntime = undefined;
  displayScopeCache = undefined;
  bookmarkDisplayScopeCache = undefined;
}
export function displayScopeDiagnostics() {
  return displayScopeCache?.diagnostics();
}
