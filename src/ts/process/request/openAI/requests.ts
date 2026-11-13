let browserRuntime: ReturnType<typeof createCompletionRuntime>;
import { language } from "src/lang";

import { alertError } from "src/ts/alert";

import { getDatabase } from "src/ts/storage/database.svelte";

import { LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";

import { strongBan, tokenizeNum } from "src/ts/tokenizer";

import { getFreeOpenRouterModels } from "src/ts/model/openrouter";

import {
  addFetchLog,
  fetchNative,
  globalFetch,
  textifyReadableStream,
} from "src/ts/globalApi.svelte";

import { isNodeServer, isTauri } from "src/ts/platform";

import { simplifySchema } from "src/ts/util";

import { extractJSON, getOpenAIJSONSchema } from "../../templates/jsonSchema";

import { applyChatTemplate } from "../../templates/chatTemplate";

import { supportsInlayImage } from "../../files/inlays";

import { callTool, decodeToolCall, encodeToolCall } from "../../mcp/mcp";

import type {
  RequestDataArgumentExtended,
  requestDataResponse,
  StreamResponseChunk,
} from "../request";

import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
} from "../shared";

import type {
  Contents,
  OpenAIChatExtra,
  OpenAIChatFull,
  ToolCall,
} from "./types";

import {
  getLocalNetworkRequestOptions,
  type LocalNetworkRequestOptions,
} from "./shared";

export { requestOpenAIResponseAPI, __testResponsesAPI } from "./responses";

function isOfficialOpenAIURL(url: string): boolean {
  return getBrowserRuntime().isOfficialOpenAIURL(url);
}

function shouldUseOpenAIFlexProcessing(
  aiModel: string,
  url: string,
  provider: LLMProvider,
): boolean {
  return getBrowserRuntime().shouldUseOpenAIFlexProcessing(
    aiModel,
    url,
    provider,
  );
}

export async function requestOpenAI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOpenAI(arg);
}

export async function requestHTTPOpenAI(
  replacerURL: string,
  body: any,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestHTTPOpenAI(
    replacerURL,
    body,
    headers,
    arg,
    networkOptions,
  );
}

export async function requestOpenAILegacyInstruct(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOpenAILegacyInstruct(arg);
}

function getTranStream(
  arg: RequestDataArgumentExtended,
): TransformStream<Uint8Array, StreamResponseChunk> {
  return getBrowserRuntime().getTranStream(arg);
}

function wrapToolStream(
  stream: ReadableStream<StreamResponseChunk>,
  body: any,
  headers: Record<string, string>,
  replacerURL: string,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions = {},
): ReadableStream<StreamResponseChunk> {
  return getBrowserRuntime().wrapToolStream(
    stream,
    body,
    headers,
    replacerURL,
    arg,
    networkOptions,
  );
}
import { createCompletionRuntime } from "./completionRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createCompletionRuntime({
    get LLMProvider() {
      return LLMProvider;
    },
    get getDatabase() {
      return getDatabase;
    },
    get decodeToolCall() {
      return decodeToolCall;
    },
    get LLMFlags() {
      return LLMFlags;
    },
    get strongBan() {
      return strongBan;
    },
    get tokenizeNum() {
      return tokenizeNum;
    },
    get getFreeOpenRouterModels() {
      return getFreeOpenRouterModels;
    },
    get LLMFormat() {
      return LLMFormat;
    },
    get getLocalNetworkRequestOptions() {
      return getLocalNetworkRequestOptions;
    },
    get applyParameters() {
      return applyParameters;
    },
    get globalFetch() {
      return globalFetch;
    },
    get language() {
      return language;
    },
    get getOpenAIJSONSchema() {
      return getOpenAIJSONSchema;
    },
    get applyChatTemplate() {
      return applyChatTemplate;
    },
    get simplifySchema() {
      return simplifySchema;
    },
    get supportsInlayImage() {
      return supportsInlayImage;
    },
    get applyAdditionalParameters() {
      return applyAdditionalParameters;
    },
    get getAdditionalParameters() {
      return getAdditionalParameters;
    },
    get isTauri() {
      return isTauri;
    },
    get isNodeServer() {
      return isNodeServer;
    },
    get fetchNative() {
      return fetchNative;
    },
    get textifyReadableStream() {
      return textifyReadableStream;
    },
    get addFetchLog() {
      return addFetchLog;
    },
    get extractJSON() {
      return extractJSON;
    },
    get callTool() {
      return callTool;
    },
    get encodeToolCall() {
      return encodeToolCall;
    },
    get alertError() {
      return alertError;
    },
    get safeStructuredClone() {
      return safeStructuredClone;
    },
  }));
}
