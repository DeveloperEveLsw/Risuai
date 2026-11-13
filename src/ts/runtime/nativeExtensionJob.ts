import {
  createExecutionContext,
  type ExecutionSnapshot,
} from "./executionContext";
import {
  createExtensionRuntime,
  type ExtensionCapabilities,
} from "./extensionRuntime";
import {
  createNativeGenerationRuntime,
  type NativeGenerationOptions,
} from "./nativeGenerationRuntime";
import { normalizeNativeSettings } from "./nativeSettings";
import { v4 } from "uuid";
import { rerollBoundary } from "../process/rerollBoundary";
import type { Database } from "../storage/database.svelte";
import { executeHypaSummary, type HypaSummaryCommand } from "./hypaSummaryJob";

// The isolated plugin UI process uses the same guarded entity context.
export { createExecutionContext } from "./executionContext";
export { createNativeTransport } from "./nativeTransport";

export interface NativeInstalledPluginRuntime {
  /** Exact request-only plugin admission, guarded without claiming its storage. */
  admissionOnly?: true;
  editHooks: NonNullable<NativeGenerationOptions["editHooks"]>;
  requestHooks: NonNullable<NativeGenerationOptions["requestHooks"]>;
  pluginRequiresServerHost: NonNullable<
    NativeGenerationOptions["pluginRequiresServerHost"]
  >;
  /** Await original background work/flush; return one guarded storage checkpoint. */
  complete(): Promise<unknown>;
  /** Release only this realm's resources. Failed work must never be checkpointed. */
  close(): Promise<void>;
}

/** New, isolated runtime defaults; no browser storage or existing save is read. */
export function createInitialRuntimeState() {
  const database = { characters: [] } as Database;
  normalizeNativeSettings(database);
  const state = JSON.parse(JSON.stringify(database));
  const resources: { kind: string; id: string; payload: unknown }[] = [];
  for (const [collection, kind] of [
    ["modules", "module"],
    ["botPresets", "preset"],
    ["personas", "persona"],
    ["plugins", "plugin"],
  ]) {
    const values = state[collection] ?? [];
    state[kind + "Ids"] = values.map((value: Record<string, unknown>) => {
      const id = typeof value.id === "string" && value.id ? value.id : v4();
      resources.push({ kind, id, payload: { ...value, id } });
      return id;
    });
    delete state[collection];
  }
  for (const [id, payload] of Object.entries(state.globalChatVariables ?? {}))
    resources.push({ kind: "global-variable", id, payload });
  delete state.globalChatVariables;
  delete state.characters;
  return { settings: state, resources };
}

export async function executeExtensionJob(
  claimed: {
    job: { id: string };
    command: {
      type: string;
      data?: string;
      manualName?: string;
      triggerId?: string;
      input?: string;
      messageId?: string;
      expectedRevision?: number;
      mode?: "single" | "bulk";
      indices?: number[];
      expectedChatEpoch?: number;
      expectedMemoryRevision?: number;
    };
    snapshot: ExecutionSnapshot;
  },
  options: NativeGenerationOptions & {
    preparePluginSnapshot?: (
      snapshot: ExecutionSnapshot,
    ) => Promise<ExecutionSnapshot>;
    openPluginRuntime?: (
      context: ReturnType<typeof createExecutionContext>,
    ) => Promise<NativeInstalledPluginRuntime | undefined>;
    resolveCharacter?: Parameters<
      typeof createExecutionContext
    >[1]["resolveCharacter"];
  },
) {
  const button = claimed.command.type === "button";
  const timed = async <T>(phase: string, action: () => Promise<T>) => {
    const started = performance.now();
    try {
      return await action();
    } finally {
      if (button)
        options.onProgress?.({
          type: "button-timing",
          phase,
          durationMs: performance.now() - started,
        });
    }
  };
  if (options.preparePluginSnapshot)
    claimed.snapshot = await timed("plugin-prepare", () =>
      options.preparePluginSnapshot!(claimed.snapshot),
    );
  const contextStarted = performance.now();
  const context = createExecutionContext(claimed.snapshot, {
    jobId: claimed.job.id,
    resolveCharacter: options.resolveCharacter,
    normalizeSettings:
      claimed.command.type === "button" ? undefined : normalizeNativeSettings,
  });
  if (button)
    options.onProgress?.({
      type: "button-timing",
      phase: "context",
      durationMs: performance.now() - contextStarted,
    });
  const installed = await timed("plugin-open", async () =>
    options.openPluginRuntime?.(context),
  );
  const capabilities = installed
    ? {
        ...options,
        editHooks: installed.editHooks,
        requestHooks: installed.requestHooks,
        pluginRequiresServerHost: installed.pluginRequiresServerHost,
      }
    : options;
  let engine:
    | ReturnType<typeof createExtensionRuntime>
    | ReturnType<typeof createNativeGenerationRuntime>;
  const extensionStarted = performance.now();
  try {
    engine =
      claimed.command.type === "button"
        ? createExtensionRuntime(context, capabilities)
        : createNativeGenerationRuntime(context, capabilities);
  } catch (error) {
    await installed?.close();
    throw error;
  } finally {
    if (button)
      options.onProgress?.({
        type: "button-timing",
        phase: "extension",
        durationMs: performance.now() - extensionStarted,
      });
  }
  async function completed<T>(result: T) {
    const pluginStorage = await timed("plugin-complete", async () =>
      installed?.complete(),
    );
    context.ensureHealthy();
    const writeStarted = performance.now();
    const writeSet = context.writeSet();
    if (button)
      options.onProgress?.({
        type: "button-timing",
        phase: "write-set",
        durationMs: performance.now() - writeStarted,
      });
    return {
      writeSet,
      result,
      ...(pluginStorage === undefined
        ? {}
        : installed?.admissionOnly
          ? { pluginAdmission: pluginStorage }
          : { pluginStorage }),
    };
  }
  let reportedStateChange = false;
  const unsubscribeActivity = context.onInvalidate(() => {
    if (!reportedStateChange) {
      reportedStateChange = true;
      options.onProgress?.({ type: "state-updated" });
    }
  });
  try {
    if (claimed.command.type !== "button") {
      const { command } = claimed;
      if (command.type === "memory-summary") {
        const result = await executeHypaSummary(
          context,
          engine as ReturnType<typeof createNativeGenerationRuntime>,
          command as HypaSummaryCommand,
          claimed.snapshot,
        );
        return await completed(result);
      }
      if (!["send", "continue", "reroll"].includes(command.type))
        context.fail("Unsupported native job command");
      const chat = context.getCurrentChat();
      if (command.type === "send") {
        if (typeof command.input !== "string")
          context.fail("Send input must be a string");
        await (
          engine as ReturnType<typeof createNativeGenerationRuntime>
        ).prepareInput(command.input, command.messageId ?? v4());
      } else {
        const target = chat.message.at(-1);
        const row = claimed.snapshot.messages.at(-1);
        if (
          !target ||
          target.role !== "char" ||
          !command.messageId ||
          target.chatId !== command.messageId ||
          row?.revision !== command.expectedRevision
        )
          context.fail("Continue/reroll target is absent or has changed");
        if (command.type === "reroll")
          chat.message.splice(rerollBoundary(chat.message));
      }
      const result = await (
        engine as ReturnType<typeof createNativeGenerationRuntime>
      ).generate({ continue: command.type === "continue" });
      return await completed(result);
    }
    if (
      claimed.command.data !== undefined &&
      typeof claimed.command.data !== "string"
    )
      context.fail("Button data must be a string");
    const extension = engine as ReturnType<typeof createExtensionRuntime>;
    if (
      claimed.command.manualName !== undefined &&
      typeof claimed.command.manualName !== "string"
    )
      context.fail("Manual trigger name must be a string");
    if (
      claimed.command.triggerId != null &&
      typeof claimed.command.triggerId !== "string"
    )
      context.fail("Trigger ID must be a string");
    const character = context.getCurrentCharacter();
    if (character.type === "group")
      context.fail("Group buttons require an explicit member context");
    const output = await timed("lua", async () =>
      claimed.command.manualName
        ? await extension.runTrigger(
            character as import("../storage/database.svelte").character,
            "manual",
            {
              chat: context.getCurrentChat(),
              manualName: claimed.command.manualName,
              triggerId: claimed.command.triggerId || undefined,
            },
          )
        : await extension.runLuaButtonTrigger(
            context.getCurrentCharacter(),
            claimed.command.data ?? "",
          ),
    );
    if (output?.chat) context.setCurrentChat(output.chat);
    return await completed({
      value: output?.res ?? null,
      stopSending: output?.stopSending ?? false,
    });
  } finally {
    unsubscribeActivity();
    const closeStarted = performance.now();
    try {
      await engine.close();
    } finally {
      await installed?.close();
      if (button)
        options.onProgress?.({
          type: "button-timing",
          phase: "engine-close",
          durationMs: performance.now() - closeStarted,
        });
    }
  }
}
