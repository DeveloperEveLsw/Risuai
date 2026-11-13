let browserRuntime: ReturnType<typeof createRequestRuntime>;
import { Ollama } from "ollama/dist/browser.mjs";

import { language } from "../../../lang";

import { fetchNative, globalFetch } from "../../globalApi.svelte";

import {
  getModelInfo,
  LLMFlags,
  LLMFormat,
  type LLMModel,
} from "../../model/modellist";

import {
  risuChatParser,
  risuEscape,
  risuUnescape,
} from "../../parser/parser.svelte";

import { pluginProcess, pluginV2 } from "../../plugins/plugins.svelte";

import {
  getCurrentCharacter,
  getCurrentChat,
  getDatabase,
  type character,
} from "../../storage/database.svelte";

import { tokenizeNum } from "../../tokenizer";

import { sleep } from "../../util";

import type { OpenAIChat } from "../index.svelte";

import { getTools } from "../mcp/mcp";

import type { MCPTool } from "../mcp/mcplib";

import { NovelAIBadWordIds, stringlizeNAIChat } from "../models/nai";

import { OobaParams } from "../prompt";

import {
  getStopStrings,
  stringlizeAINChat,
  unstringlizeAIN,
  unstringlizeChat,
} from "../stringlize";

import { applyChatTemplate } from "../templates/chatTemplate";

import { runTransformers } from "../transformers";

import { runTrigger } from "../triggers";

import { requestClaude } from "./anthropic";

import { requestGoogleCloudVertex } from "./google";

import {
  requestOpenAI,
  requestOpenAILegacyInstruct,
  requestOpenAIResponseAPI,
} from "./openAI/requests";

import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
  type ModelModeExtended,
} from "./shared";

export type ToolCall = {
  name: string;
  arguments: string;
};

interface requestDataArgument {
  formated: OpenAIChat[];
  bias: { [key: number]: number };
  biasString?: [string, number][];
  currentChar?: character;
  temperature?: number;
  maxTokens?: number;
  PresensePenalty?: number;
  frequencyPenalty?: number;
  useStreaming?: boolean;
  forceStreaming?: boolean;
  isGroupChat?: boolean;
  useEmotion?: boolean;
  continue?: boolean;
  chatId?: string;
  noMultiGen?: boolean;
  schema?: string;
  extractJson?: string;
  imageResponse?: boolean;
  previewBody?: boolean;
  staticModel?: string;
  escape?: boolean;
  tools?: MCPTool[];
  rememberToolUsage?: boolean;
  blockPlugins?: boolean;
}

export interface RequestDataArgumentExtended extends requestDataArgument {
  aiModel?: string;
  multiGen?: boolean;
  abortSignal?: AbortSignal;
  modelInfo?: LLMModel;
  customURL?: string;
  mode?: ModelModeExtended;
  key?: string;
  additionalOutput?: string;
  saveSignatures?: boolean;
}

export type requestDataResponse =
  | {
      type: "success" | "fail";
      result: string;
      noRetry?: boolean;
      special?: {
        emotion?: string;
      };
      failByServerError?: boolean;
      model?: string;
    }
  | {
      type: "streaming";
      result: ReadableStream<StreamResponseChunk>;
      special?: {
        emotion?: string;
      };
      model?: string;
    }
  | {
      type: "multiline";
      result: ["user" | "char", string][];
      special?: {
        emotion?: string;
      };
      model?: string;
    };

export interface StreamResponseChunk {
  [key: string]: string;
}

type OllamaThinkMode = boolean | "low" | "medium" | "high";

function getOllamaThinkMode(mode: string): OllamaThinkMode | undefined {
  return getBrowserRuntime().getOllamaThinkMode(mode);
}

function formatThinkingOutput(thinking: string, content: string): string {
  return getBrowserRuntime().formatThinkingOutput(thinking, content);
}

function normalizeFetchHeaders(headers?: HeadersInit): {
  [key: string]: string;
} {
  return getBrowserRuntime().normalizeFetchHeaders(headers);
}

async function ollamaCloudFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return getBrowserRuntime().ollamaCloudFetch(input, init);
}

function normalizeOllamaStreamResponse(response: Response): Response {
  return getBrowserRuntime().normalizeOllamaStreamResponse(response);
}

export async function requestChatData(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestChatData(arg, model, abortSignal);
}

export function reformater(
  formated: OpenAIChat[],
  modelInfo: LLMModel | LLMFlags[],
) {
  return getBrowserRuntime().reformater(formated, modelInfo);
}

export async function requestChatDataMain(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestChatDataMain(arg, model, abortSignal);
}

async function requestNovelAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestNovelAI(arg);
}

async function requestOobaLegacy(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOobaLegacy(arg);
}

async function requestOoba(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOoba(arg);
}

async function requestPlugin(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestPlugin(arg);
}

async function requestEcho(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestEcho(arg);
}

async function requestKobold(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestKobold(arg);
}

async function requestNovelList(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestNovelList(arg);
}

async function requestOllama(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOllama(arg);
}

async function requestCohere(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestCohere(arg);
}

async function requestHorde(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestHorde(arg);
}

async function requestWebLLM(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestWebLLM(arg);
}

export interface KoboldSamplerSettingsSchema {
  rep_pen?: number;
  rep_pen_range?: number;
  rep_pen_slope?: number;
  top_k?: number;
  top_a?: number;
  top_p?: number;
  tfs?: number;
  typical?: number;
  temperature?: number;
}

export interface KoboldGenerationInputSchema
  extends KoboldSamplerSettingsSchema {
  prompt: string;
  use_memory?: boolean;
  use_story?: boolean;
  use_authors_note?: boolean;
  use_world_info?: boolean;
  use_userscripts?: boolean;
  soft_prompt?: string;
  max_length?: number;
  max_context_length?: number;
  n: number;
  disable_output_formatting?: boolean;
  frmttriminc?: boolean;
  frmtrmblln?: boolean;
  frmtrmspch?: boolean;
  singleline?: boolean;
  disable_input_formatting?: boolean;
  frmtadsnsp?: boolean;
  quiet?: boolean;
  sampler_order?: number[];
  sampler_seed?: number;
  sampler_full_determinism?: boolean;
}
import { createRequestRuntime } from "./requestRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createRequestRuntime({
    get fetchNative() {
      return fetchNative;
    },
    get getDatabase() {
      return getDatabase;
    },
    get getTools() {
      return getTools;
    },
    get risuUnescape() {
      return risuUnescape;
    },
    get pluginV2() {
      return pluginV2;
    },
    get getCurrentCharacter() {
      return getCurrentCharacter;
    },
    get runTrigger() {
      return runTrigger;
    },
    get getCurrentChat() {
      return getCurrentChat;
    },
    get risuEscape() {
      return risuEscape;
    },
    get sleep() {
      return sleep;
    },
    get LLMFlags() {
      return LLMFlags;
    },
    get getModelInfo() {
      return getModelInfo;
    },
    get LLMFormat() {
      return LLMFormat;
    },
    get requestOpenAI() {
      return requestOpenAI;
    },
    get requestOpenAIResponseAPI() {
      return requestOpenAIResponseAPI;
    },
    get requestClaude() {
      return requestClaude;
    },
    get requestOpenAILegacyInstruct() {
      return requestOpenAILegacyInstruct;
    },
    get requestGoogleCloudVertex() {
      return requestGoogleCloudVertex;
    },
    get language() {
      return language;
    },
    get stringlizeNAIChat() {
      return stringlizeNAIChat;
    },
    get tokenizeNum() {
      return tokenizeNum;
    },
    get NovelAIBadWordIds() {
      return NovelAIBadWordIds;
    },
    get applyAdditionalParameters() {
      return applyAdditionalParameters;
    },
    get getAdditionalParameters() {
      return getAdditionalParameters;
    },
    get globalFetch() {
      return globalFetch;
    },
    get unstringlizeChat() {
      return unstringlizeChat;
    },
    get applyChatTemplate() {
      return applyChatTemplate;
    },
    get getStopStrings() {
      return getStopStrings;
    },
    get risuChatParser() {
      return risuChatParser;
    },
    get OobaParams() {
      return OobaParams;
    },
    get applyParameters() {
      return applyParameters;
    },
    get pluginProcess() {
      return pluginProcess;
    },
    get stringlizeAINChat() {
      return stringlizeAINChat;
    },
    get unstringlizeAIN() {
      return unstringlizeAIN;
    },
    get Ollama() {
      return Ollama;
    },
    get runTransformers() {
      return runTransformers;
    },
    get safeStructuredClone() {
      return safeStructuredClone;
    },
    get fetch() {
      return fetch;
    },
  }));
}
