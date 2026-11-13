import { get, writable } from "svelte/store";
import {
  type character,
  type MessageGenerationInfo,
  type Chat,
  type MessagePresetInfo,
  changeToPreset,
  setCurrentChat,
  type Message,
  type StreamingDisplayOptimizationMode,
} from "../storage/database.svelte";
import { DBState } from "../stores.svelte";
import { CharEmotion, selectedCharID } from "../stores.svelte";
import { ChatTokenizer, tokenize, tokenizeNum } from "../tokenizer";
import { language } from "../../lang";
import { alertError, alertToast } from "../alert";
import { parseChatML } from "../parser/chatML";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import {
  findCharacterbyId,
  getAuthorNoteDefaultText,
  getPersonaPrompt,
  getUserName,
  isLastCharPunctuation,
  trimUntilPunctuation,
  parseToggleSyntax,
  prebuiltAssetCommand,
} from "../util";
import { requestChatData } from "./request/request";
import { stableDiff } from "./stableDiff";
import { processScript, processScriptFull, risuChatParser } from "./scripts";
import { exampleMessage } from "./exampleMessages";
import { sayTTS } from "./tts";
import { supaMemory } from "./memory/supaMemory";
import { v4 } from "uuid";
import { groupOrder } from "./group";
import { runTrigger } from "./triggers";
import { HypaProcesser } from "./memory/hypamemory";
import { additionalInformations } from "./embedding/addinfo";
import { getInlayAsset } from "./files/inlays";
import { getGenerationModelString } from "./models/modelString";
import {
  connectionOpen,
  peerRevertChat,
  peerSafeCheck,
  peerSync,
} from "../sync/multiuser";
import { runInlayScreen } from "./inlayScreen";
import { addRerolls } from "./prereroll";
import { runImageEmbedding } from "./transformers";
import { hanuraiMemory } from "./memory/hanuraiMemory";
import { hypaMemoryV2 } from "./memory/hypav2";
import { runLuaEditTrigger } from "./scriptings";
import { getModelInfo, LLMFlags } from "../model/modellist";
import { hypaMemoryV3 } from "./memory/hypav3";
import { getModuleAssets, getModuleToggles } from "./modules";
import { readImage } from "../globalApi.svelte";
import { pluginV2 } from "../plugins/plugins.svelte";
import { createGenerationRuntime } from "./generationRuntime";
export type {
  OpenAIChat,
  MultiModal,
  requestTokenPart,
} from "./generationRuntime";
import type {
  OpenAIChat,
  MultiModal,
  requestTokenPart,
} from "./generationRuntime";

export const doingChat = writable(false);
export const chatProcessStage = writable(0);
export const abortChat = writable(false);
export let requestTokenParts: { [key: string]: requestTokenPart[] } = {};
export let previewFormated: OpenAIChat[] = [];
export let previewBody: string = "";

let browserGenerationRuntime: ReturnType<typeof createGenerationRuntime>;
function getBrowserGenerationRuntime() {
  return (browserGenerationRuntime ??= createGenerationRuntime({
    readGlobalVariable: (key) => DBState.db.globalChatVariables[key],
    incrementMessageCount: () => {
      DBState.db.statics.messages += 1;
    },
    recordCharacterInteraction: (character, timestamp) => {
      character.lastInteraction = timestamp;
    },
    changeToPreset,
    setCurrentChat,
    DBState,
    CharEmotion,
    selectedCharID,
    ChatTokenizer,
    tokenize,
    tokenizeNum,
    get language() {
      return language;
    },
    alertError,
    alertToast,
    parseChatML,
    loadLoreBookV3Prompt,
    findCharacterbyId,
    getAuthorNoteDefaultText,
    getPersonaPrompt,
    getUserName,
    isLastCharPunctuation,
    trimUntilPunctuation,
    parseToggleSyntax,
    prebuiltAssetCommand,
    requestChatData,
    stableDiff,
    processScript,
    processScriptFull,
    risuChatParser,
    exampleMessage,
    sayTTS,
    supaMemory,
    v4,
    groupOrder,
    runTrigger,
    HypaProcesser,
    additionalInformations,
    getInlayAsset,
    getGenerationModelString,
    peerRevertChat,
    peerSafeCheck,
    peerSync,
    runInlayScreen,
    addRerolls,
    runImageEmbedding,
    hanuraiMemory,
    hypaMemoryV2,
    runLuaEditTrigger,
    getModelInfo,
    LLMFlags,
    hypaMemoryV3,
    getModuleAssets,
    getModuleToggles,
    readImage,
    pluginV2,
    get connectionOpen() {
      return connectionOpen;
    },
    doingChat,
    chatProcessStage,
    abortChat,
    get requestTokenParts() {
      return requestTokenParts;
    },
    set requestTokenParts(value) {
      requestTokenParts = value;
    },
    get previewFormated() {
      return previewFormated;
    },
    set previewFormated(value) {
      previewFormated = value;
    },
    get previewBody() {
      return previewBody;
    },
    set previewBody(value) {
      previewBody = value;
    },
    snapshot: (value) => $state.snapshot(value),
    safeStructuredClone: (value) => safeStructuredClone(value),
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => cancelAnimationFrame(id),
    async notify(text) {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        const notification = new Notification("Risuai", { body: text });
        notification.onclick = () => window.focus();
      }
    },
  }));
}

export async function sendChat(
  ...args: Parameters<ReturnType<typeof createGenerationRuntime>["sendChat"]>
) {
  return await getBrowserGenerationRuntime().sendChat(...args);
}
