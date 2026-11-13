let browserRuntime: ReturnType<typeof createResponsesRuntime>;
import { language } from "src/lang";

import { alertError } from "src/ts/alert";

import { getDatabase } from "src/ts/storage/database.svelte";

import { LLMFlags } from "src/ts/model/modellist";

import {
  addFetchLog,
  fetchNative,
  globalFetch,
  textifyReadableStream,
} from "src/ts/globalApi.svelte";

import { simplifySchema } from "src/ts/util";

import {
  NANOGPT_RESPONSES_ENDPOINT,
  NANOGPT_SUBSCRIPTION_RESPONSES_ENDPOINT,
} from "src/ts/model/providers/nanogpt";

import { extractJSON, getOpenAIJSONSchema } from "../../templates/jsonSchema";

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
  isReasoningCapabilityParameter,
} from "../shared";

import type {
  OpenAIChatExtra,
  ResponseFunctionCallItem,
  ResponseInputItem,
  ResponseItem,
  ResponseOutputItem,
} from "./types";

import {
  getLocalNetworkRequestOptions,
  type LocalNetworkRequestOptions,
} from "./shared";

function responseTextContentToString(content: any): string {
  return getBrowserRuntime().responseTextContentToString(content);
}

async function decodeRememberedToolCallsForResponses(
  text: string,
): Promise<ResponseItem[]> {
  return getBrowserRuntime().decodeRememberedToolCallsForResponses(text);
}

async function buildResponseInputItems(
  arg: RequestDataArgumentExtended,
): Promise<ResponseItem[]> {
  return getBrowserRuntime().buildResponseInputItems(arg);
}

function getResponsesRequestURL(arg: RequestDataArgumentExtended): {
  requestURL: string;
  risuIdentify: boolean;
} {
  return getBrowserRuntime().getResponsesRequestURL(arg);
}

function buildResponsesHeaders(
  arg: RequestDataArgumentExtended,
  risuIdentify: boolean,
): Record<string, string> {
  return getBrowserRuntime().buildResponsesHeaders(arg, risuIdentify);
}

function getResponsesRequestModel(arg: RequestDataArgumentExtended): string {
  return getBrowserRuntime().getResponsesRequestModel(arg);
}

function sanitizeResponsesContinuationItem(item: any): ResponseItem | null {
  return getBrowserRuntime().sanitizeResponsesContinuationItem(item);
}

function cloneResponsesBodyForRequest<T>(value: T): T {
  return getBrowserRuntime().cloneResponsesBodyForRequest(value);
}

function toExternalResponsesBody(
  body: Record<string, any>,
): Record<string, any> {
  return getBrowserRuntime().toExternalResponsesBody(body);
}

async function buildResponsesBody(
  arg: RequestDataArgumentExtended,
): Promise<Record<string, any>> {
  return getBrowserRuntime().buildResponsesBody(arg);
}

function collectResponsesReasoningText(value: any): string[] {
  return getBrowserRuntime().collectResponsesReasoningText(value);
}

function extractResponsesReasoningTexts(item: any): string[] {
  return getBrowserRuntime().extractResponsesReasoningTexts(item);
}

function extractResponsesText(
  data: any,
  arg: RequestDataArgumentExtended,
): string {
  return getBrowserRuntime().extractResponsesText(data, arg);
}

function extractResponsesFunctionCalls(data: any): ResponseFunctionCallItem[] {
  return getBrowserRuntime().extractResponsesFunctionCalls(data);
}

async function appendResponsesToolOutputs(
  body: any,
  calls: ResponseFunctionCallItem[],
  arg: RequestDataArgumentExtended,
  assistantText: string,
): Promise<string> {
  return getBrowserRuntime().appendResponsesToolOutputs(
    body,
    calls,
    arg,
    assistantText,
  );
}

async function requestHTTPResponsesAPI(
  requestURL: string,
  body: any,
  headers: Record<string, string>,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestHTTPResponsesAPI(
    requestURL,
    body,
    headers,
    arg,
    networkOptions,
  );
}

function getResponsesTranStream(
  arg: RequestDataArgumentExtended,
): TransformStream<Uint8Array, StreamResponseChunk> {
  return getBrowserRuntime().getResponsesTranStream(arg);
}
export const __testResponsesAPI = getBrowserRuntime().__testResponsesAPI;

function wrapResponsesToolStream(
  stream: ReadableStream<StreamResponseChunk>,
  body: any,
  headers: Record<string, string>,
  requestURL: string,
  arg: RequestDataArgumentExtended,
  networkOptions: LocalNetworkRequestOptions,
): ReadableStream<StreamResponseChunk> {
  return getBrowserRuntime().wrapResponsesToolStream(
    stream,
    body,
    headers,
    requestURL,
    arg,
    networkOptions,
  );
}

export async function requestOpenAIResponseAPI(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  return getBrowserRuntime().requestOpenAIResponseAPI(arg);
}
import { createResponsesRuntime } from "./responsesRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createResponsesRuntime({
    get decodeToolCall() {
      return decodeToolCall;
    },
    get LLMFlags() {
      return LLMFlags;
    },
    get getDatabase() {
      return getDatabase;
    },
    get NANOGPT_SUBSCRIPTION_RESPONSES_ENDPOINT(): typeof NANOGPT_SUBSCRIPTION_RESPONSES_ENDPOINT {
      return NANOGPT_SUBSCRIPTION_RESPONSES_ENDPOINT;
    },
    get NANOGPT_RESPONSES_ENDPOINT(): typeof NANOGPT_RESPONSES_ENDPOINT {
      return NANOGPT_RESPONSES_ENDPOINT;
    },
    get simplifySchema() {
      return simplifySchema;
    },
    get isReasoningCapabilityParameter() {
      return isReasoningCapabilityParameter;
    },
    get applyParameters() {
      return applyParameters;
    },
    get getOpenAIJSONSchema() {
      return getOpenAIJSONSchema;
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
    get globalFetch() {
      return globalFetch;
    },
    get language() {
      return language;
    },
    get fetchNative() {
      return fetchNative;
    },
    get alertError() {
      return alertError;
    },
    get addFetchLog() {
      return addFetchLog;
    },
    get applyAdditionalParameters() {
      return applyAdditionalParameters;
    },
    get getAdditionalParameters() {
      return getAdditionalParameters;
    },
    get getLocalNetworkRequestOptions() {
      return getLocalNetworkRequestOptions;
    },
    get textifyReadableStream() {
      return textifyReadableStream;
    },
  }));
}
