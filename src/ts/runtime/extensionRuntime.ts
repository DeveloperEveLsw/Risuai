import { get, writable } from "svelte/store";
import { v4 } from "uuid";
import { CCardLib } from "@risuai/ccardlib";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { createChatMLRuntime } from "../parser/chatMLRuntime";
import { assetRegex } from "../parser/assetSyntax";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import { createModuleRuntime } from "../process/moduleRuntime";
import {
  createScriptingRuntime,
  type ScriptingRuntimeHost,
} from "../process/scriptingRuntime";
import {
  createTriggerRuntime,
  type TriggerRuntimeHost,
} from "../process/triggerRuntime";
import { createScriptRuntime } from "../process/scriptRuntime";
import { createLorebookRuntime } from "../process/lorebookRuntime";
import { createModelRuntime } from "../model/modelRuntime";
import { LLMModels } from "../model/modelCatalog";
import {
  LLMFormat,
  LLMProvider,
  LLMTokenizer,
  OpenAIParameters,
  type LLMModel,
} from "../model/types";
import { parseKeyValue, pickHashRand } from "../utilText";
import type { createExecutionContext } from "./executionContext";

type Context = ReturnType<typeof createExecutionContext>;
type CapabilityNames =
  | "LuaFactory"
  | "tokenize"
  | "HypaProcesser"
  | "requestChatData"
  | "fetchNative"
  | "generateAIImage"
  | "writeInlayImage"
  | "getInlayAsset"
  | "readImage"
  | "Image"
  | "PyodideContext"
  | "alertError"
  | "alertNormal"
  | "alertInput"
  | "alertSelect"
  | "alertConfirm"
  | "processMultiCommand";
export type ExtensionCapabilities = Partial<
  Pick<ScriptingRuntimeHost & TriggerRuntimeHost, CapabilityNames>
> & {
  fetch?: typeof fetch;
  appVer: string;
  /** Live native interactions must settle before another external side effect. */
  checkBeforeExternalEffect?: () => void;
  providerMetadata?: LLMModel[];
  editHooks?: Pick<
    typeof import("../plugins/plugins.svelte").pluginV2,
    "editinput" | "editoutput" | "editprocess" | "editdisplay"
  >;
  /** Trusted server admission for a reviewed plugin with no active engine effects. */
  pluginRequiresServerHost?: (
    plugin: import("../plugins/plugins.svelte").RisuPlugin,
    database: ReturnType<Context["getDatabase"]>,
  ) => boolean;
};

/** Bind the original extension engines to one private job, without loading browser stores. */
export function createExtensionRuntime(
  context: Context,
  capabilities: ExtensionCapabilities,
) {
  if (
    context
      .getDatabase()
      .plugins.some(
        (plugin) =>
          plugin.enabled &&
          (capabilities.pluginRequiresServerHost?.(
            plugin,
            context.getDatabase(),
          ) ??
            true),
      ) &&
    !capabilities.editHooks
  )
    context.fail(
      "Server plugin execution capability is required for installed plugins",
    );
  const CurrentTriggerIdStore = writable<string | null>(null);
  const ReloadGUIPointer = writable(0),
    ReloadChatPointer = writable(0);
  const modules = createModuleRuntime({ ...context, ...context.util });
  const calcString = createExpressionEvaluator(context.variables);
  const models = createModelRuntime({
    ...context,
    LLMFormat,
    LLMProvider,
    LLMTokenizer,
    OpenAIParameters,
    LLMModels: structuredClone(LLMModels),
    customV3ProviderMetaStore: structuredClone(
      capabilities.providerMetadata ?? [],
    ),
    safeStructuredClone: context.cloneResourceValue,
  });
  const getModelInfo = (id?: string | null) => {
    if (id?.startsWith("pluginmodel:::") && !capabilities.providerMetadata)
      context.fail(
        "Server provider metadata capability is required for this plugin model",
      );
    return models.getModelInfo(id);
  };
  const cbs = createCbsRuntime({
    ...context,
    ...context.util,
    ...context.variables,
    ...modules,
    getModelInfo,
    calcString,
    pickHashRand,
    safeStructuredClone: context.cloneResourceValue,
    getSelectedCharID: () => get(context.selectedCharID),
    getCurrentTriggerId: () => get(CurrentTriggerIdStore),
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: capabilities.appVer,
    callInternalFunction: () =>
      context.fail("Internal CBS function capability is required"),
  });
  const chatML = createChatMLRuntime({ risuChatParser: cbs.parse });
  const unsupported = new Map<PropertyKey, Function>();
  const ports: any = new Proxy(
    {
      ...capabilities,
      ...context,
      ...context.util,
      ...context.variables,
      ...modules,
      onScriptError: (error: unknown) => {
        // Record without throwing inside upstream's fallback catch. The outer guard
        // rejects the job and every later provider call through ensureHealthy().
        try {
          context.fail("Lua execution failed: " + String(error));
        } catch {}
      },
      // A prepared one-shot native process may supply its already loaded WASM
      // factory. Every runtime still creates and closes fresh Lua globals.
      LuaFactory: capabilities.LuaFactory,
      CurrentTriggerIdStore,
      ReloadGUIPointer,
      ReloadChatPointer,
      getModelInfo,
      calcString,
      parseKeyValue,
      pickHashRand,
      CCardLib,
      v4,
      risuChatParser: cbs.parse,
      risuChatParserOrg: cbs.parse,
      parseChatML: chatML.parseChatML,
      safeStructuredClone: context.cloneResourceValue,
      assetRegex: new RegExp(assetRegex.source, assetRegex.flags),
      CharEmotion: writable({}),
      pluginV2: capabilities.editHooks ?? {
        editinput: new Set(),
        editoutput: new Set(),
        editprocess: new Set(),
        editdisplay: new Set(),
      },
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      asBuffer: (data: Uint8Array) => new Uint8Array(data).buffer,
      hasher: async (data: Uint8Array) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
          ),
        )
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
    },
    {
      get(target, key, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        if (!unsupported.has(key))
          unsupported.set(key, function () {
            return context.fail(
              `Server capability is required: ${String(key)}`,
            );
          });
        return unsupported.get(key);
      },
    },
  );
  // Script error alerts are notifications, just like the original browser API.
  // A failure to deliver either notification must still poison the transaction.
  for (const name of ["alertNormal", "alertError"] as const) {
    const notify = capabilities[name];
    if (notify)
      ports[name] = (message: string) => {
        context.ensureHealthy();
        try {
          notify(message);
        } catch (error) {
          context.fail("Notification delivery failed: " + String(error));
        }
      };
  }
  // Provider/image/network side effects must never start after a swallowed capability failure.
  for (const name of ["alertInput", "alertSelect", "alertConfirm"] as const) {
    if (capabilities[name])
      ports[name] = (...args: any[]) => {
        const operation = (async () => {
          context.ensureHealthy();
          try {
            const result = await (capabilities[name] as Function)(...args);
            context.ensureHealthy();
            return result;
          } catch (error) {
            return context.fail(
              "Interactive delivery failed: " + String(error),
            );
          }
        })();
        // Observe rejection without changing the Promise returned to an awaited caller.
        // The native host rejects unawaited Lua before another side effect/final save.
        operation.catch(() => {});
        return operation;
      };
  }
  for (const name of [
    "requestChatData",
    "fetchNative",
    "generateAIImage",
    "writeInlayImage",
  ] as const) {
    if (capabilities[name])
      ports[name] = (...args: any[]) => {
        context.ensureHealthy();
        try {
          capabilities.checkBeforeExternalEffect?.();
        } catch (error) {
          return context.fail(
            "Interactive execution is incomplete: " + String(error),
          );
        }
        return (capabilities[name] as Function)(...args);
      };
  }
  const scripting = createScriptingRuntime(ports);
  async function guarded<T>(action: () => Promise<T>) {
    context.ensureHealthy();
    try {
      const result = await action();
      context.ensureHealthy();
      return result;
    } finally {
      context.invalidate();
    }
  }
  ports.runScripted = (...args: Parameters<typeof scripting.runScripted>) =>
    guarded(() => scripting.runScripted(...args));
  ports.runLuaEditTrigger = (
    ...args: Parameters<typeof scripting.runLuaEditTrigger>
  ) => guarded(() => scripting.runLuaEditTrigger(...args));
  const triggers = createTriggerRuntime(ports);
  ports.runTrigger = (...args: Parameters<typeof triggers.runTrigger>) =>
    guarded(() => {
      const [character, mode, arg] = args;
      const current = context.getCurrentCharacter();
      if (
        current.type === "group" &&
        current.characters.includes(character.chaId) &&
        arg.chat
      ) {
        // Upstream clones the whole member before using the explicit group chat.
        // Provide that admitted chat, without evaluating a member's guarded
        // individual-history getter or granting cross-chat reads.
        const definition = Object.fromEntries(
          Object.keys(character)
            .filter((key) => key !== "chats")
            .map((key) => [key, character[key]]),
        );
        return triggers.runTrigger(
          { ...definition, chats: [arg.chat], chatPage: 0 } as typeof character,
          mode,
          arg,
        );
      }
      return triggers.runTrigger(...args);
    });
  const lorebook = createLorebookRuntime(ports);
  const scripts = createScriptRuntime(ports);
  const unsubscribe = context.onInvalidate(() => {
    scripts.resetScriptCache();
    modules.refreshModules();
  });
  return {
    ...modules,
    getModelInfo,
    calcString,
    risuChatParser: cbs.parse,
    parseChatML: chatML.parseChatML,
    runTrigger: ports.runTrigger as typeof triggers.runTrigger,
    runScripted: ports.runScripted as typeof scripting.runScripted,
    runLuaEditTrigger:
      ports.runLuaEditTrigger as typeof scripting.runLuaEditTrigger,
    runLuaButtonTrigger: (
      ...args: Parameters<typeof scripting.runLuaButtonTrigger>
    ) => guarded(() => scripting.runLuaButtonTrigger(...args)),
    processScript: (...args: Parameters<typeof scripts.processScript>) =>
      guarded(() => scripts.processScript(...args)),
    processScriptFull: (
      ...args: Parameters<typeof scripts.processScriptFull>
    ) => guarded(() => scripts.processScriptFull(...args)),
    loadLoreBookV3Prompt: () => guarded(() => lorebook.loadLoreBookV3Prompt()),
    CurrentTriggerIdStore,
    ReloadGUIPointer,
    ReloadChatPointer,
    close: () => {
      unsubscribe();
      scripting.close();
    },
  };
}
