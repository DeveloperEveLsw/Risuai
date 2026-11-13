"use strict";
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { RuntimeError } = require("../entity/errors.cjs");
const {
  describePluginProviderFailure,
} = require("./pluginProviderDiagnostic.cjs");
const {
  matchesWygloreRelease,
  getWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const {
  instrumentWygloreUIConfirmations,
} = require("./wygloreUIConfirmation.cjs");
const {
  createWyglorePresentationStorage,
} = require("./wygloreServerPresentation.cjs");
const {
  instrumentWygloreUIConfiguration,
  PORT: UI_CONFIGURATION_PORT,
} = require("./wygloreUIConfiguration.cjs");
const {
  instrumentWygloreTransportCancellation,
} = require("./wygloreTransportCancellation.cjs");
const {
  instrumentWygloreVertexEndpoint,
} = require("./wygloreVertexEndpoint.cjs");
const {
  PORT: INDEX_DEADLINE_PORT,
  instrumentWygloreIndexDeadline,
  createWygloreIndexDeadlineRegistry,
} = require("./wygloreIndexDeadline.cjs");

/** A trusted, pinned plugin in the already isolated native job process.
 * vm is a realm, not a security sandbox for arbitrary installed JavaScript.
 * Admission stays separate until UI, storage and the job lifecycle are wired.
 */
async function createServerPluginHost(options) {
  const { plugin, context, storage, signal } = options;
  if (!plugin.enabled || !matchesWygloreRelease(plugin))
    throw new RuntimeError(
      "PLUGIN_UNSUPPORTED",
      "This server host requires an exact reviewed WygLore Leaf bundle",
    );
  const release = getWygloreRelease(plugin.script);
  let failure,
    closed = false,
    externalCalls = 0,
    activeNetwork = 0,
    configuration,
    persistence;
  const uiConfigurationEnabled =
    !!options.dom?.window &&
    typeof options.dom?.capabilityGlobals?.__RISU_PLUGIN_UI_CONFIRM ===
      "function";
  const indexDeadlines = createWygloreIndexDeadlineRegistry({
    enabled: options.isolateProviderFailure === true && !options.dom,
    signal,
  });
  const timers = new Set(),
    unload = new Set(),
    settings = [],
    buttons = [];
  const sets = {
    editinput: new Set(),
    editoutput: new Set(),
    editdisplay: new Set(),
    editprocess: new Set(),
    replacerbeforeRequest: new Set(),
    replacerafterRequest: new Set(),
  };
  function healthy() {
    if (failure) throw failure;
    if (closed)
      throw new RuntimeError("PLUGIN_HOST_CLOSED", "Plugin host is closed");
    signal?.throwIfAborted();
    context.ensureHealthy();
    storage.ensureHealthy?.();
    options.dom?.assertHealthy();
    configuration?.assertHealthy();
    persistence?.assertPersistenceHealthy();
  }
  function fail(message, code = "PLUGIN_CAPABILITY_REQUIRED", details = {}) {
    failure ??= new RuntimeError(code, message, details);
    try {
      context.fail(message);
    } catch {}
    throw failure;
  }
  function checked(action) {
    healthy();
    try {
      return action();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  }
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function scope(characterIndex, chatIndex) {
    const current = currentIndices();
    if (
      characterIndex !== current.characterIndex ||
      (chatIndex !== undefined && chatIndex !== current.chatIndex)
    )
      fail(
        "A plugin cannot switch the admitted native job to another character or chat",
      );
  }
  function currentIndices() {
    options.reads?.observeCurrentScope?.();
    const current = options.currentIndices?.() ?? {
      characterIndex: 0,
      chatIndex: 0,
    };
    if (
      ![current.characterIndex, current.chatIndex].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      fail("Current-garden index projection is invalid");
    return current;
  }
  async function network(url, init = {}) {
    healthy();
    await options.checkBeforeExternalEffect?.();
    if (!options.fetch)
      return fail("Server plugin network transport is required");
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol))
      return fail("Plugin transport requires HTTP or HTTPS");
    const expiredIndex = indexDeadlines.beforeRequest(init.signal, target);
    if (expiredIndex) throw expiredIndex;
    // This exact author manifest is a public, unpaid update check. Its offline
    // fallback is independent from the strict paid-generation uncertainty rule.
    if (
      String(target) ===
        "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/main/version.json" &&
      (init.method ?? "GET").toUpperCase() === "GET" &&
      init.body == null &&
      !new Headers(init.headers).has("authorization")
    )
      return options.fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, init.signal].filter(Boolean)),
        credentials: "omit",
      });
    externalCalls++;
    activeNetwork++;
    const startedAt = Date.now(),
      call = externalCalls;
    let phase = "request",
      status;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        activeNetwork--;
      }
    };
    const uncertain = (error) => {
      finish();
      const indexDeadline = indexDeadlines.failure(error, init.signal, target);
      if (indexDeadline) {
        // Keep host/context health checks authoritative. The coordinator and
        // atomic commit independently retain their source and lease guards.
        healthy();
        throw indexDeadline;
      }
      const details = describePluginProviderFailure(error, {
        phase,
        startedAt,
        status,
        call,
        signal,
        requestSignal: init.signal,
        endpoint: target,
      });
      if (options.isolateProviderFailure === true) {
        failure ??= new RuntimeError(
          "PLUGIN_PROVIDER_UNCERTAIN",
          "Plugin provider outcome is uncertain; automatic replay is disabled",
          details,
        );
        throw failure;
      }
      return fail(
        "Plugin provider outcome is uncertain; automatic replay is disabled",
        "PLUGIN_PROVIDER_UNCERTAIN",
        details,
      );
    };
    options.onProgress?.({
      type: "plugin-provider-started",
      pluginId: plugin.id,
      call: externalCalls,
    });
    try {
      const response = await options.fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, init.signal].filter(Boolean)),
      });
      phase = "response";
      status = response.status;
      healthy();
      if (!response.body) {
        finish();
        return response;
      }
      const reader = response.body.getReader();
      phase = "body";
      let cancelledIndexBody = false;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            healthy();
            const next = await reader.read();
            if (cancelledIndexBody) return;
            if (next.done) {
              finish();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            try {
              uncertain(error);
            } catch (failure) {
              controller.error(failure);
            }
          }
        },
        async cancel(reason) {
          finish();
          try {
            if (indexDeadlines.isExpected(init.signal, target)) {
              healthy();
              // The original consumer cancels its body when its own timer
              // expires. A pending read may then resolve done:true; closing
              // an already cancelled wrapper would fabricate a TypeError.
              cancelledIndexBody = true;
            }
          } finally {
            try {
              await reader.cancel(reason);
            } catch (error) {
              // Original cleanup sites may discard their cancellation promise.
              // Retain any genuine uncertainty in host state without creating
              // an unobserved second rejection from that cleanup path.
              try {
                uncertain(error);
              } catch {}
            }
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // The plugin has its own fallbacks. Poison all of them after uncertainty;
      // a transport error never proves that a paid request did not execute.
      return uncertain(error);
    }
  }
  const api = {
    log: () => {}, // Plugin logs may include private model payloads; no durable log sink.
    pluginStorage: storage.pluginStorage,
    getRuntimeInfo: async () => ({
      platform: "server-native",
      saveMethod: "entity",
      apiVersion: "3.0",
      ...(options.readCharacterCatalog
        ? {
            capabilities: {
              characterCatalog: "wyglore-live-gardens-v1",
              crossChatWrites: false,
            },
          }
        : {}),
    }),
    getCurrentCharacterIndex: async () =>
      checked(() => currentIndices().characterIndex),
    getCurrentChatIndex: async () => checked(() => currentIndices().chatIndex),
    getCharacter: async (ci) =>
      checked(() => {
        if (ci !== undefined) scope(ci);
        if (options.currentIndices) currentIndices();
        options.reads?.observeCharacter();
        const value = clone(
          options.readCurrentCharacter?.() ?? context.getCurrentCharacter(),
        );
        context.trackPluginCharacter?.(value);
        return value;
      }),
    getChatFromIndex: async (ci, pi) =>
      checked(() => {
        scope(ci, pi);
        options.reads?.observeChat();
        return context.clonePluginChat
          ? context.clonePluginChat()
          : clone(context.getCurrentChat());
      }),
    setChatToIndex: async (ci, pi, chat) =>
      checked(() => {
        scope(ci, pi);
        options.reads?.observeChat();
        if (!chat || chat.id !== context.getCurrentChat().id)
          fail("Plugin chat update has a different stable identity");
        if (context.stagePluginChat) context.stagePluginChat(chat);
        else context.setCurrentChat(clone(chat));
      }),
    getDatabase: async (fields) =>
      checked(() => {
        if (
          !Array.isArray(fields) ||
          fields.some((field) => typeof field !== "string")
        )
          fail("Server plugin database reads must name their fields");
        const db = context.getDatabase(),
          result = {};
        options.reads?.observeDatabaseFields(fields);
        for (const field of fields) {
          if (field === "characters" && options.readCharacterCatalog) {
            result.characters = clone(options.readCharacterCatalog());
            continue;
          }
          if (
            ![
              "modules",
              "enabledModules",
              "moduleIntergration",
              "globalChatVariables",
              "personas",
              "selectedPersona",
              "mainPrompt",
              "globalNote",
              "maxContext",
              "maxResponse",
              "aiModel",
              "plugins",
              // Original providers-tab getBotCacheConfig: cache hints only.
              // observeDatabaseFields above guards the captured settings row.
              "automaticCachePoint",
              "claude1HourCaching",
              "claudeRetrivalCaching",
              "promptTemplate",
            ].includes(field)
          )
            fail(
              `Server plugin database field capability is required: ${field}`,
            );
          const value = db[field];
          context.readResourceValue?.(value);
          result[field] = clone(value);
        }
        return result;
      }),
    getArgument: async (key) =>
      checked(() => clone(plugin.realArg?.[key] ?? "")),
    registerSetting: async (...args) =>
      checked(() => {
        settings.push(args);
      }),
    registerButton: async (...args) =>
      checked(() => {
        buttons.push(args);
      }),
    addRisuReplacer: async (name, callback) =>
      checked(() => {
        const set = sets["replacer" + name];
        if (!set || typeof callback !== "function")
          fail("Unsupported plugin replacer registration");
        set.add(callback);
      }),
    // Deregistration is cleanup, including after a sticky execution failure.
    removeRisuReplacer: (name, callback) =>
      sets["replacer" + name]?.delete(callback),
    addRisuScriptHandler: async (name, callback) =>
      checked(() => {
        const set = sets["edit" + name];
        if (!set || typeof callback !== "function")
          fail("Unsupported plugin script handler registration");
        set.add(callback);
      }),
    onUnload: async (callback) => checked(() => unload.add(callback)),
    nativeFetch: network,
    toast: async () =>
      checked(() =>
        options.onProgress?.({ type: "plugin-notice", pluginId: plugin.id }),
      ),
  };
  if (options.dom) {
    api.showContainer = options.dom.showContainer;
    api.hideContainer = options.dom.hideContainer;
    api.getRootDocument = async () => checked(() => options.dom.document);
  }
  // Some original notification/unload call sites do not await API promises.
  // Observe rejection without changing the promise returned to awaited callers.
  for (const [name, method] of Object.entries(api)) {
    if (typeof method !== "function") continue;
    api[name] = (...args) => {
      const result = method(...args);
      result?.catch?.((error) => {
        if (!indexDeadlines.isHandled(error)) failure ??= error;
      });
      return result;
    };
  }
  const sandbox = {
    risuai: api,
    console: { log() {}, info() {}, warn() {}, error() {} },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    Request,
    Headers,
    Blob,
    ReadableStream,
    WritableStream,
    TransformStream,
    CompressionStream,
    DecompressionStream,
    crypto: webcrypto,
    structuredClone,
    performance,
    atob,
    btoa,
    fetch: network,
    navigator: { userAgent: "Risu server native" },
    ...(options.dom ? { document: options.dom.document } : {}),
    setTimeout(callback, ms, ...args) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (closed || signal?.aborted) return;
        try {
          Promise.resolve(callback(...args)).catch((error) => {
            failure ??= error;
          });
        } catch (error) {
          failure ??= error;
        }
      }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
    setInterval(callback, ms, ...args) {
      const timer = setInterval(() => {
        if (closed || signal?.aborted) return;
        try {
          Promise.resolve(callback(...args)).catch((error) => {
            failure ??= error;
          });
        } catch (error) {
          failure ??= error;
        }
      }, ms);
      timers.add(timer);
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer);
      timers.delete(timer);
    },
  };
  if (options.dom?.window) {
    const window = options.dom.window;
    window.fetch = network;
    Object.assign(sandbox, {
      window,
      HTMLElement: window.HTMLElement,
      DOMParser: window.DOMParser,
      Node: window.Node,
      Event: window.Event,
      CustomEvent: window.CustomEvent,
      MutationObserver: window.MutationObserver,
      ResizeObserver: window.ResizeObserver,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      localStorage: window.localStorage,
    });
  }
  if (options.dom?.capabilityGlobals)
    Object.assign(sandbox, options.dom.capabilityGlobals);
  Object.defineProperty(sandbox, INDEX_DEADLINE_PORT, {
    value: indexDeadlines.executionPort,
    configurable: true,
  });
  if (options.dom) {
    const presentationStorage = createWyglorePresentationStorage(
      sandbox.localStorage,
      fail,
    );
    sandbox.localStorage = presentationStorage;
    if (sandbox.window)
      Object.defineProperty(sandbox.window, "localStorage", {
        configurable: true,
        value: presentationStorage,
      });
  }
  const realm = vm.createContext(sandbox);
  const cleanup = () => {
    indexDeadlines.close();
    configuration?.close();
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
  };
  function lifecycle() {
    if (!sandbox.__WL_SERVER_LIFECYCLE)
      fail("The plugin lifecycle adapter did not initialize");
    return sandbox.__WL_SERVER_LIFECYCLE;
  }
  async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    while (true) {
      healthy();
      const port = lifecycle();
      // Native SQLite checkpoints need no browser background debounce. Invoke
      // the original flush function, preserving its queue/resolver ordering.
      const flushed = port.flushPendingPersistence();
      flushed?.promise?.catch((error) => {
        failure ??= error;
      });
      const status = port.status();
      if (predicate(status)) {
        if (++stable >= 2) return status;
      } else stable = 0;
      if (Date.now() >= deadline)
        fail(
          "Plugin lifecycle did not settle within its execution budget",
          "PLUGIN_TIMEOUT",
        );
      await delay(10, undefined, { signal });
    }
  }
  try {
    let executable =
      typeof options.dom?.capabilityGlobals?.__RISU_PLUGIN_UI_CONFIRM ===
      "function"
        ? instrumentWygloreUIConfirmations(plugin.script)
        : instrumentWygloreLifecycle(plugin.script);
    if (uiConfigurationEnabled)
      executable = instrumentWygloreUIConfiguration(plugin.script, executable);
    executable = instrumentWygloreTransportCancellation(
      plugin.script,
      executable,
    );
    executable = instrumentWygloreVertexEndpoint(plugin.script, executable);
    executable = instrumentWygloreIndexDeadline(plugin.script, executable);
    new vm.Script(executable, {
      filename: `WygLoreLeaf-${release.version}.server.js`,
    }).runInContext(realm, { timeout: 5000 });
    persistence = lifecycle();
    if (uiConfigurationEnabled) {
      configuration = sandbox[UI_CONFIGURATION_PORT];
      if (!configuration || typeof configuration.flush !== "function")
        fail("The original UI configuration adapter did not initialize");
    }
    await waitUntil(
      (status) =>
        status.ready &&
        sets.replacerbeforeRequest.size === 1 &&
        sets.replacerafterRequest.size === 1,
      options.bootTimeoutMs ?? 30000,
    );
  } catch (error) {
    closed = true;
    cleanup();
    storage.discard?.();
    throw error;
  }
  async function settle() {
    healthy();
    await lifecycle().settlePanel();
    healthy();
    await lifecycle().settlePersistence(signal);
    healthy();
    // These are the original model/provider save queues, not all DOM timers.
    // Their debounce cannot outlive the event's durable checkpoint and ACK.
    if (configuration) {
      await configuration.flush();
      healthy();
      await lifecycle().settlePanel();
    }
    const idle = (status) =>
      !status.coldStart &&
      !status.indexBuild &&
      !status.providerActive &&
      !status.providerQueued &&
      !status.persistPending &&
      !status.persistActive &&
      !status.backgroundActive &&
      !status.swapPending &&
      (!configuration || configuration.pending() === 0) &&
      !activeNetwork;
    await waitUntil(idle, options.settleTimeoutMs ?? 300000);
    if (!(await lifecycle().flush()))
      fail("Original plugin persistence failed", "PLUGIN_PERSIST_FAILED");
    await lifecycle().settlePanel();
    await lifecycle().settlePersistence(signal);
    // A caller awaiting the original flush may enqueue another save. Drain its
    // debounce and observe idle again before capturing a durable checkpoint.
    await waitUntil(idle, options.settleTimeoutMs ?? 300000);
    healthy();
  }
  async function replace(name, value, type) {
    healthy();
    if (!options.dom && lifecycle().parameters().coldStartAuto !== false)
      fail(
        "WygLore catch-up requires a server interaction DOM bridge; headless automatic consent is disabled",
      );
    try {
      for (const handler of sets["replacer" + name])
        value = await handler(clone(value), type);
      healthy();
      return clone(value);
    } catch (error) {
      failure ??= error;
      throw error;
    }
  }
  return {
    /** Hook wrapper checks failure even when the original plugin catches it. */
    hooks: {
      ...sets,
      replacerbeforeRequest: new Set([
        (value, type) => replace("beforeRequest", value, type),
      ]),
      replacerafterRequest: new Set([
        (value, type) => replace("afterRequest", value, type),
      ]),
    },
    settle,
    async settlePanel() {
      await lifecycle().settlePanel();
      healthy();
    },
    status: () => checked(() => clone(lifecycle().status())),
    parameters: () => checked(() => clone(lifecycle().parameters())),
    unitsCount: () => checked(() => lifecycle().unitsCount()),
    registrations: { settings, buttons },
    ensureHealthy: healthy,
    async close({ success = false } = {}) {
      if (closed) return;
      try {
        if (success) await settle();
        for (const callback of unload) {
          const pending = callback();
          if (success) await pending;
          else Promise.resolve(pending).catch(() => {});
        }
        if (success) healthy();
      } finally {
        closed = true;
        cleanup();
        if (!success) storage.discard?.();
      }
    },
  };
}
module.exports = { createServerPluginHost };
