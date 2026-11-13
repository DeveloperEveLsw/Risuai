let browserRuntime: ReturnType<typeof createTokenizerRuntime>;
import type { Tiktoken } from "@dqbd/tiktoken";

import type { Tokenizer } from "@mlc-ai/web-tokenizers";

import {
  type groupChat,
  type character,
  type Chat,
  getCurrentCharacter,
  getDatabase,
} from "./storage/database.svelte";

import type { MultiModal, OpenAIChat } from "./process/index.svelte";

import { supportsInlayImage } from "./process/files/inlays";

import { risuChatParser } from "./parser/parser.svelte";

import { tokenizeGGUFModel } from "./process/models/local";

import { globalFetch } from "./globalApi.svelte";

import { getModelInfo, LLMTokenizer, type LLMModel } from "./model/modellist";

import { pluginV2 } from "./plugins/plugins.svelte";

import type { GemmaTokenizer } from "@huggingface/transformers";

import { LRUMap } from "mnemonist";

function getHash(
  data: string,
  aiModel: string,
  customTokenizer: string,
  currentPluginProvider: string,
  googleClaudeTokenizing: boolean,
  modelInfo: LLMModel,
  pluginTokenizer: string,
): string {
  return getBrowserRuntime().getHash(
    data,
    aiModel,
    customTokenizer,
    currentPluginProvider,
    googleClaudeTokenizing,
    modelInfo,
    pluginTokenizer,
  );
}
export const tokenizerList = getBrowserRuntime().tokenizerList;

export async function encodeWithTokenizer(
  data: string,
  tokenizerType: string,
): Promise<number[] | Uint32Array | Int32Array> {
  return getBrowserRuntime().encodeWithTokenizer(data, tokenizerType);
}

export async function encode(
  data: string,
): Promise<number[] | Uint32Array | Int32Array> {
  return getBrowserRuntime().encode(data);
}

type tokenizerType =
  | "novellist"
  | "claude"
  | "novelai"
  | "llama"
  | "mistral"
  | "llama3"
  | "gemma"
  | "cohere"
  | "googleCloud"
  | "DeepSeek"
  | "DeepSeekV4"
  | "GLM4"
  | "GLM5";

async function tokenizeGoogleCloud(text: string) {
  return getBrowserRuntime().tokenizeGoogleCloud(text);
}

async function gemmaTokenize(text: string) {
  return getBrowserRuntime().gemmaTokenize(text);
}

async function tikJS(text: string, model = "cl100k_base") {
  return getBrowserRuntime().tikJS(text, model);
}

async function geminiTokenizer(text: string) {
  return getBrowserRuntime().geminiTokenizer(text);
}

async function tokenizeWebTokenizers(text: string, type: tokenizerType) {
  return getBrowserRuntime().tokenizeWebTokenizers(text, type);
}

export async function tokenizerChar(char: character) {
  return getBrowserRuntime().tokenizerChar(char);
}

export async function tokenize(data: string) {
  return getBrowserRuntime().tokenize(data);
}

export async function tokenizeAccurate(data: string, consistantChar?: boolean) {
  return getBrowserRuntime().tokenizeAccurate(data, consistantChar);
}

export const ChatTokenizer = getBrowserRuntime().ChatTokenizer;
export type ChatTokenizer = InstanceType<typeof ChatTokenizer>;

export async function tokenizeNum(data: string) {
  return getBrowserRuntime().tokenizeNum(data);
}

export async function strongBan(
  data: string,
  bias: {
    [key: number]: number;
  },
) {
  return getBrowserRuntime().strongBan(data, bias);
}

export async function getCharToken(char?: character | groupChat | null) {
  return getBrowserRuntime().getCharToken(char);
}

export async function getChatToken(chat: Chat) {
  return getBrowserRuntime().getChatToken(chat);
}
import { createTokenizerRuntime } from "./tokenizerRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createTokenizerRuntime({
    loadWebTokenizers: () => import("@mlc-ai/web-tokenizers"),
    get LRUMap() {
      return LRUMap;
    },
    get getDatabase() {
      return getDatabase;
    },
    get getModelInfo() {
      return getModelInfo;
    },
    get pluginV2() {
      return pluginV2;
    },
    get LLMTokenizer() {
      return LLMTokenizer;
    },
    get tokenizeGGUFModel() {
      return tokenizeGGUFModel;
    },
    get globalFetch() {
      return globalFetch;
    },
    get risuChatParser() {
      return risuChatParser;
    },
    get supportsInlayImage() {
      return supportsInlayImage;
    },
    get getCurrentCharacter() {
      return getCurrentCharacter;
    },
    get fetch() {
      return fetch;
    },
    get localStorage() {
      return localStorage;
    },
  }));
}
