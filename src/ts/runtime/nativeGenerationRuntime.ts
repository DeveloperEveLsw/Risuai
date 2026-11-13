import { writable } from "svelte/store";
import { LRUMap } from "mnemonist";
import { Template } from "@huggingface/jinja";
import { Ollama } from "ollama/dist/browser.mjs";
import { languageEnglish } from "../../lang/en";
import { createTokenizerRuntime } from "../tokenizerRuntime";
import { createGenerationRuntime } from "../process/generationRuntime";
import { createGroupOrderRuntime } from "../process/groupOrderRuntime";
import shuffle from "lodash/shuffle";
import { createParameterRuntime } from "../process/request/parameterRuntime";
import { parseAdditionalParamJsonValue } from "../process/request/additionalParams";
import { createNetworkRuntime } from "../process/request/openAI/networkRuntime";
import { createCompletionRuntime } from "../process/request/openAI/completionRuntime";
import { createResponsesRuntime } from "../process/request/openAI/responsesRuntime";
import { createRequestRuntime } from "../process/request/requestRuntime";
import { createGoogleRuntime } from "../process/request/googleRuntime";
import { createUtilBinaryRuntime } from "../utilBinaryRuntime";
import { createExampleMessageRuntime } from "../process/exampleMessageRuntime";
import { createModelStringRuntime } from "../process/models/modelStringRuntime";
import { createChatTemplateRuntime } from "../process/templates/chatTemplateRuntime";
import { createJsonSchemaRuntime } from "../process/templates/jsonSchemaRuntime";
import { createInlayScreenRuntime } from "../process/inlayScreenRuntime";
import { createEmbeddingRuntime } from "../process/memory/embeddingRuntime";
import { createEmbeddingV2Runtime } from "../process/memory/embeddingV2Runtime";
import { createContextualEmbeddingRuntime } from "../process/memory/contextualEmbeddingRuntime";
import { createHypaV3Runtime } from "../process/memory/hypaV3Runtime";
import { TaskRateLimiter } from "../process/memory/taskRateLimiter";
import { createSupaMemoryRuntime } from "../process/memory/supaMemoryRuntime";
import { createHypaSummaryRuntime } from "../process/memory/hypaSummaryRuntime";
import { inlayTokenRegex } from "../util/inlayTokens";
import { createStringlizeRuntime } from "../process/stringlizeRuntime";
import { createAddinfoRuntime } from "../process/embedding/addinfoRuntime";
import {
  createExtensionRuntime,
  type ExtensionCapabilities,
} from "./extensionRuntime";
import { isLocalNetworkUrl } from "../network/localNetwork";
import { risuEscape, risuUnescape } from "../parser/cbsText";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from "../model/types";
import * as text from "../utilText";
import * as nano from "../model/providers/nanogpt";
import type { createExecutionContext } from "./executionContext";
import { createNativeTransport } from "./nativeTransport";
import { createPresetRuntime } from "../storage/presetRuntime";
import { createPromptTemplateRuntime } from "../storage/promptTemplateRuntime";
import { v4 } from "uuid";
import {
  createProviderOutputRuntime,
  type ProviderOutput,
} from "./providerOutputRuntime";

export interface NativeGenerationOptions extends ExtensionCapabilities {
  requestHooks?: Pick<
    typeof import("../plugins/plugins.svelte").pluginV2,
    "replacerbeforeRequest" | "replacerafterRequest"
  >;
  signal?: AbortSignal;
  providerFetch?: typeof fetch;
  onProgress?: (event: { type: string; [key: string]: unknown }) => void;
  loadWebTokenizers?: () => Promise<typeof import("@mlc-ai/web-tokenizers")>;
  /** Private, ownership-fenced retention. This is not live browser progress. */
  retainProviderOutput?: (output: ProviderOutput) => Promise<void>;
}

/** Real upstream generation and provider algorithms in one independent server job. */
export function createNativeGenerationRuntime(
  context: ReturnType<typeof createExecutionContext>,
  options: NativeGenerationOptions,
) {
  if (
    context
      .getDatabase()
      .plugins.some(
        (plugin) =>
          plugin.enabled &&
          (options.pluginRequiresServerHost?.(plugin, context.getDatabase()) ??
            true),
      )
  )
    context.fail(
      "A complete server plugin host is required for native generation",
    );
  const missing = new Map<PropertyKey, Function>();
  const cache = new Map<string, string>();
  const embeddingCache = new Map<string, unknown>();
  const rerolls: Record<string, string[]> = {};
  const groupInitialIds =
    context.getCurrentCharacter().type === "group"
      ? new Set(
          context.getCurrentChat().message.map((message) => message.chatId),
        )
      : undefined;
  const emit = (
    event: Parameters<NonNullable<NativeGenerationOptions["onProgress"]>>[0],
  ) => options.onProgress?.(event);
  const transport = createNativeTransport(context, options);
  let extensions: ReturnType<typeof createExtensionRuntime>;
  const pluginV2 = {
    ...options.editHooks,
    editinput: options.editHooks?.editinput ?? new Set(),
    editoutput: options.editHooks?.editoutput ?? new Set(),
    editdisplay: options.editHooks?.editdisplay ?? new Set(),
    editprocess: options.editHooks?.editprocess ?? new Set(),
    providerOptions: new Map(),
    replacerbeforeRequest:
      options.requestHooks?.replacerbeforeRequest ?? new Set(),
    replacerafterRequest:
      options.requestHooks?.replacerafterRequest ?? new Set(),
    chatOutput: new Set(),
  };
  const ports: any = new Proxy(
    {
      ...options,
      ...context,
      ...context.util,
      ...context.variables,
      ...createGroupOrderRuntime({
        findCharacterbyId: context.util.findCharacterbyId,
        shuffle,
      }),
      setDatabase: (database: ReturnType<typeof context.getDatabase>) => {
        if (database !== context.getDatabase())
          context.fail("Replacing a native job database is not supported");
        context.invalidate();
      },
      ...text,
      ...createUtilBinaryRuntime(),
      ...nano,
      ...transport,
      LLMFlags,
      LLMFormat,
      LLMProvider,
      LLMTokenizer,
      LRUMap,
      Template,
      Ollama,
      safeStructuredClone: context.cloneResourceValue,
      snapshot: context.cloneResourceValue,
      isTauri: false,
      isNodeServer: true,
      language: languageEnglish,
      getModelInfo: (id?: string) => extensions.getModelInfo(id),
      risuChatParser: (
        ...args: Parameters<
          ReturnType<typeof createExtensionRuntime>["risuChatParser"]
        >
      ) => extensions.risuChatParser(...args),
      risuEscape,
      risuUnescape,
      pluginV2,
      // Only reviewed request/script hooks supplied by the server host run here.
      // General body interceptors still require a separate explicit capability.
      bodyIntercepterStore: [],
      crypto: globalThis.crypto,
      window: { crypto: globalThis.crypto },
      isLocalNetworkUrl,
      parseAdditionalParamJsonValue,
      supportsInlayImage: () =>
        extensions
          .getModelInfo(context.getDatabase().aiModel)
          .flags.includes(LLMFlags.hasImageInput),
      localStorage: {
        getItem: (key: string) => cache.get(key) ?? null,
        setItem: (key: string, value: string) => {
          cache.set(key, value);
        },
      },
      loadWebTokenizers: () =>
        options.loadWebTokenizers
          ? options.loadWebTokenizers()
          : context.fail("Native tokenizer module loader is required"),
      // This is a derived embedding cache, never a replacement for authoritative chat state.
      localforage: {
        createInstance: () => ({
          getItem: async (key: string) =>
            structuredClone(embeddingCache.get(key) ?? null),
          setItem: async (key: string, value: unknown) => {
            embeddingCache.set(key, structuredClone(value));
            return value;
          },
        }),
      },
      isContextModel: (model: string) => model === "voyageContext3",
      TaskRateLimiter,
      isMobile: false,
      navigator: { hardwareConcurrency: 1 },
      hypaV3ProgressStore: {
        set: (progress: {
          open: boolean;
          miniMsg: string;
          msg: string;
          subMsg: string;
        }) => emit({ type: "memory-progress", ...progress }),
      },
      connectionOpen: false,
      doingChat: writable(false),
      chatProcessStage: writable(0),
      abortChat: writable(new AbortController()),
      requestTokenParts: writable([]),
      previewFormated: [],
      previewBody: "",
      CharEmotion: writable({}),
      v4,
      alertError: (message: string) => context.fail(message),
      alertToast: (message: string) => emit({ type: "notice", message }),
      peerSync: () => emit({ type: "state-updated" }),
      addRerolls: (id: string, values: string[]) => {
        rerolls[id] = structuredClone(values);
      },
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => {
          callback(performance.now());
          emitMessages();
        }, 0),
      cancelAnimationFrame: clearTimeout,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      getTools: async () =>
        context.getDatabase().modelTools?.length
          ? context.fail("Server MCP tool capability is required")
          : [],
    },
    {
      get(target, key, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        if (!missing.has(key))
          missing.set(key, function () {
            return context.fail(
              `Server generation capability is required: ${String(key)}`,
            );
          });
        return missing.get(key);
      },
    },
  );
  const presetRuntime = createPresetRuntime({
    DBState: context.DBState,
    readResourceValue: context.readResourceValue,
    safeStructuredClone: context.cloneResourceValue,
    ...createPromptTemplateRuntime({
      safeStructuredClone: context.cloneResourceValue,
    }),
    LLMFormat,
  });
  ports.changeToPreset = (id = 0, savecurrent = true) => {
    context.ensureHealthy();
    const db = context.getDatabase(),
      previousIndex = db.botPresetsId,
      previous = db.botPresets[previousIndex];
    presetRuntime.changeToPreset(id, savecurrent);
    // Match the library capture boundary: preserve stable identity and unknown imported fields.
    if (
      savecurrent &&
      previousIndex !== -1 &&
      previous &&
      db.botPresets[previousIndex]
    )
      db.botPresets[previousIndex] = {
        ...previous,
        ...db.botPresets[previousIndex],
        id: previous.id,
      };
    context.invalidate();
  };
  function emitMessages() {
    const chat = context.getCurrentChat();
    // Stable message IDs are emitted independently of the temporary HTTP connection.
    emit({
      type: "messages",
      // Each progress checkpoint replaces the previous one. Keep every new
      // group reply visible while the next member streams, without copying
      // the already confirmed history into progress or committing early.
      messages: structuredClone(
        groupInitialIds
          ? chat.message.filter(
              (message) => !groupInitialIds.has(message.chatId),
            )
          : chat.message.slice(-1),
      ),
      streaming: Boolean(chat.isStreaming),
    });
  }
  const tokenizer = createTokenizerRuntime(ports);
  Object.assign(
    ports,
    tokenizer,
    createParameterRuntime(ports),
    createNetworkRuntime(ports),
  );
  const responses = createResponsesRuntime(ports),
    completions = createCompletionRuntime(ports);
  Object.assign(
    ports,
    responses,
    completions,
    createGoogleRuntime(ports),
    createJsonSchemaRuntime(ports),
    createChatTemplateRuntime(ports),
  );
  const requests = createRequestRuntime(ports);
  const providerOutput = createProviderOutputRuntime(
    requests.requestChatData,
    options.retainProviderOutput,
  );
  Object.assign(
    ports,
    requests,
    createExampleMessageRuntime(ports),
    createModelStringRuntime(ports),
    createInlayScreenRuntime(ports),
  );
  ports.requestChatData = providerOutput.requestChatData;
  Object.assign(
    ports,
    createEmbeddingRuntime(ports),
    createAddinfoRuntime(ports),
  );
  Object.assign(ports, createContextualEmbeddingRuntime(ports));
  Object.assign(ports, createEmbeddingV2Runtime(ports));
  extensions = createExtensionRuntime(context, {
    ...options,
    tokenize: tokenizer.tokenize,
    requestChatData: providerOutput.requestChatData,
    fetchNative: transport.fetchNative as any,
  });
  Object.assign(ports, extensions);
  Object.assign(
    ports,
    createStringlizeRuntime(ports),
    createSupaMemoryRuntime(ports),
  );
  const summaries = createHypaSummaryRuntime({
    getDatabase: context.getDatabase,
    parseChatML: extensions.parseChatML,
    requestChatData: providerOutput.requestChatData,
    chatCompletion: async () =>
      context.fail("Server capability is required: WebGPU local summary model"),
    inlayTokenRegex,
    logPrefix: "[HypaV3]",
  });
  Object.assign(ports, summaries, {
    // GPU/WebLLM summaries fail in the explicit summary capability above;
    // there is no browser engine to unload in a native job.
    unloadEngine: async () => {},
  });
  Object.assign(ports, createHypaV3Runtime(ports));
  const generation = createGenerationRuntime(ports);
  const unsubscribeStage = ports.chatProcessStage.subscribe((stage: number) =>
    emit({ type: "stage", stage }),
  );
  let presentationTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribePresentation = context.onPresentationChange(() => {
    if (!presentationTimer)
      presentationTimer = setTimeout(() => {
        presentationTimer = undefined;
        emitMessages();
      }, 25);
  });
  return {
    ...generation,
    summarizeMemory: summaries.summarize,
    memoryPreset: summaries.getCurrentHypaV3Preset,
    parseMemoryMessage: extensions.risuChatParser,
    processMemoryMessage: extensions.processScriptFull,
    async prepareInput(input: string, messageId: string) {
      const char = context.getCurrentCharacter();
      let chat = context.getCurrentChat();
      if (char.type === "character") {
        const changed = await extensions.runTrigger(char, "input", { chat });
        if (changed?.chat) {
          context.setCurrentChat(changed.chat);
          chat = context.getCurrentChat();
        }
        input = await extensions.processScript(char, input, "editinput");
      }
      chat.message.push({
        role: "user",
        data: input,
        time: Date.now(),
        chatId: messageId,
      });
    },
    async generate(arg: Parameters<typeof generation.sendChat>[1] = {}) {
      context.ensureHealthy();
      const completed = await generation.sendChat(-1, {
        ...arg,
        signal: options.signal,
      });
      context.ensureHealthy();
      if (!completed) context.fail("Upstream generation did not complete");
      clearTimeout(presentationTimer);
      presentationTimer = undefined;
      emitMessages();
      return { rerolls, providerCalls: transport.calls() };
    },
    async close() {
      clearTimeout(presentationTimer);
      await providerOutput.close();
      unsubscribePresentation();
      unsubscribeStage();
      extensions.close();
      tokenizer.close();
    },
  };
}
