import { type memoryVector, HypaProcesser, similarity } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter } from "./taskRateLimiter";
import {
  type EmbeddingText,
  type EmbeddingResult,
  HypaProcessorV2,
} from "./hypamemoryv2";
import { type DisplayMode as ModalDisplayMode } from "src/lib/Others/HypaV3Modal/types";
import { parseChatML } from "src/ts/parser/chatML";
import {
  type Chat,
  type character,
  type groupChat,
  getDatabase,
} from "src/ts/storage/database.svelte";
import { type OpenAIChat } from "../index.svelte";
import { requestChatData } from "../request/request";
import { chatCompletion, unloadEngine } from "../webllm";
import { hypaV3ProgressStore } from "src/ts/stores.svelte";
import { type ChatTokenizer } from "src/ts/tokenizer";
import { inlayTokenRegex } from "src/ts/util/inlayTokens";
import { createHypaPresetRuntime } from "./hypaPresetRuntime";
import { createHypaSummaryRuntime } from "./hypaSummaryRuntime";
import { createHypaV3Runtime } from "./hypaV3Runtime";
export interface HypaV3Preset {
  name: string;
  settings: HypaV3Settings;
}
export interface HypaV3Settings {
  summarizationModel: string;
  summarizationPrompt: string;
  reSummarizationPrompt: string;
  memoryTokensRatio: number;
  extraSummarizationRatio: number;
  maxChatsPerSummary: number;
  recentMemoryRatio: number;
  similarMemoryRatio: number;
  enableSimilarityCorrection: boolean;
  preserveOrphanedMemory: boolean;
  processRegexScript: boolean;
  doNotSummarizeUserMessage: boolean;
  summaryChunkSeparator: string;
  // Experimental
  useExperimentalImpl: boolean;
  summarizationRequestsPerMinute: number;
  summarizationMaxConcurrent: number;
  embeddingRequestsPerMinute: number;
  embeddingMaxConcurrent: number;
  alwaysToggleOn: boolean;
  queryChatCount: number;
}
interface HypaV3Data {
  summaries: Summary[];
  categories?: {
    id: string;
    name: string;
  }[];
  lastSelectedSummaries?: number[]; // legacy
  metrics?: {
    lastImportantSummaries: number[];
    lastRecentSummaries: number[];
    lastSimilarSummaries: number[];
    lastRandomSummaries: number[];
  };
  modalSettings?: {
    displayMode: ModalDisplayMode;
    displayRangeFrom: number;
    displayRangeTo: number;
    displayRecentCount: number;
    displayImportant: boolean;
    displaySelected: boolean;
  };
}
export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
  summaries: SerializableSummary[];
}
interface Summary {
  text: string;
  chatMemos: Set<string>;
  isImportant: boolean;
  categoryId?: string;
  tags?: string[];
}
export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
  chatMemos: string[];
}
export interface HypaV3Result {
  currentTokens: number;
  chats: OpenAIChat[];
  error?: string;
  memory?: SerializableHypaV3Data;
}
const logPrefix = "[HypaV3]";
let summaryRuntime: ReturnType<typeof createHypaSummaryRuntime>;
let memoryRuntime: ReturnType<typeof createHypaV3Runtime>;
const presetRuntime = createHypaPresetRuntime({});
function getSummaryRuntime() {
  return (summaryRuntime ??= createHypaSummaryRuntime({
    getDatabase,
    parseChatML,
    requestChatData,
    chatCompletion,
    inlayTokenRegex,
    logPrefix,
  }));
}
function getMemoryRuntime() {
  return (memoryRuntime ??= createHypaV3Runtime({
    getDatabase,
    getCurrentHypaV3Preset,
    summarize,
    unloadEngine,
    HypaProcesser,
    similarity,
    isContextModel,
    getContextProvider,
    HypaProcessorV2,
    TaskRateLimiter,
    hypaV3ProgressStore,
  }));
}
export async function hypaMemoryV3(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  room: Chat,
  char: character | groupChat,
  tokenizer: ChatTokenizer,
): Promise<HypaV3Result> {
  return getMemoryRuntime().hypaMemoryV3(
    chats,
    currentTokens,
    maxContextTokens,
    room,
    char,
    tokenizer,
  );
}
export async function summarize(
  oaiMessages: OpenAIChat[],
  isResummarize = false,
): Promise<string> {
  return getSummaryRuntime().summarize(oaiMessages, isResummarize);
}
export function getCurrentHypaV3Preset(): HypaV3Preset {
  return getSummaryRuntime().getCurrentHypaV3Preset();
}
export function createHypaV3Preset(
  name = "New Preset",
  existingSettings = {},
): HypaV3Preset {
  return presetRuntime.createHypaV3Preset(name, existingSettings);
}
