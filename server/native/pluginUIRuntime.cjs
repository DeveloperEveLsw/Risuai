"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const {
  createPluginReadDependencies,
} = require("./pluginReadDependencies.cjs");
const { createPluginUISession } = require("./pluginUISession.cjs");
const { createPluginUICapabilities } = require("./pluginUICapabilities.cjs");
const { createPluginUIEffects } = require("./pluginUIEffects.cjs");
const {
  matchesWygloreRelease,
  getWygloreRelease,
} = require("./wygloreContract.cjs");
const { RuntimeError } = require("../entity/errors.cjs");

/** The original UI and engine share one isolated server owner. No plugin source
 * executes in the browser. Each accepted UI event has an atomic graph/chat proof.
 * The parent HTTP process must authorize access and supervise this process.
 */
async function createPluginUIRuntime(options) {
  const store = options.store;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const sessionId = options.sessionId ?? randomUUID();
  let captured,
    context,
    reads,
    lease,
    host,
    remote,
    capabilities,
    window,
    renewal,
    pendingRenewal;
  let failure,
    closed = false,
    visible = false;
  let externalCalls = 0,
    eventExternalStart = 0,
    cancelledCheckpoint = false;
  function poison(error) {
    failure ??= error;
    controller.abort(error);
    options.onFailure?.(error);
  }
  function check() {
    if (failure) throw failure;
    if (closed)
      throw new RuntimeError(
        "PLUGIN_UI_CLOSED",
        "Plugin settings owner is closed",
      );
    signal.throwIfAborted();
    context?.ensureHealthy();
    capabilities?.assertHealthy();
  }
  const contextPort = new Proxy({}, { get: (_target, key) => context[key] });
  const readPort = new Proxy({}, { get: (_target, key) => reads[key] });
  async function guard() {
    check();
    const { characterReads, resourceReads, variableReads } = context.writeSet();
    await store.call("checkPluginUI", {
      scope: captured.scope,
      lease,
      reads: { characterReads, resourceReads, variableReads },
      pluginReads: reads.snapshot(),
    });
    check();
  }
  async function renew() {
    if (closed || pendingRenewal) return pendingRenewal;
    pendingRenewal = store
      .call("renewPluginStorage", { lease })
      .then((value) => {
        lease = value;
      })
      .catch(poison)
      .finally(() => {
        pendingRenewal = undefined;
      });
    return pendingRenewal;
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(renewal);
    controller.abort(
      new RuntimeError("PLUGIN_UI_CLOSED", "Plugin UI owner closed"),
    );
    remote?.close();
    try {
      await host?.close();
    } finally {
      await pendingRenewal;
      storage?.discard();
      capabilities?.close();
      if (window) {
        await window.happyDOM.cancelAsync();
        window.close();
      }
      if (lease) await store.call("releasePluginStorage", lease);
    }
  }
  let storage;
  try {
    const native = await import(
      pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
    );
    captured = await store.call("capturePluginUI", options.chatId);
    if (captured.scope.chatEpoch !== options.expectedChatEpoch)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Plugin UI chat incarnation changed before opening",
      );
    function rebase(value) {
      captured = value;
      context = native.createExecutionContext(captured.snapshot, {
        jobId: "plugin-ui:" + sessionId,
      });
      reads = createPluginReadDependencies(captured.snapshot);
      reads.observeCharacter();
      reads.observeChat();
      reads.observePlugin(options.pluginId);
      reads.observeDatabaseFields(["mainPrompt"]);
    }
    rebase(captured);
    const plugin = context
      .getDatabase()
      .plugins.find((plugin) => plugin.id === options.pluginId);
    if (!plugin?.enabled || !matchesWygloreRelease(plugin))
      throw new RuntimeError(
        "PLUGIN_UNSUPPORTED",
        "This UI requires an exact reviewed WygLore Leaf release",
      );
    const release = getWygloreRelease(plugin.script);
    const row = captured.snapshot.resources.find(
      (row) => row.kind === "plugin" && row.id === options.pluginId,
    );
    lease = await store.call("claimPluginUIStorage", {
      namespace: {
        pluginId: options.pluginId,
        bundleSha: release.sha256,
        pluginEpoch: row.entityEpoch,
      },
      writerId: "plugin-ui:" + sessionId,
      authority: { kind: "browser" },
    });
    options.onLease?.(lease);
    renewal = setInterval(renew, 5000);
    storage = createPluginStorageSession(
      await store.call("readAllPluginStorage", lease.namespace),
      lease,
      { signal, check },
    );
    const { Window } = await import(
      pathToFileURL(require.resolve("happy-dom")).href
    );
    window = new Window({
      url: "https://risu-plugin.invalid",
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
        disableIframePageLoading: true,
      },
    });
    capabilities = createPluginUICapabilities(window, {
      effects: createPluginUIEffects({ check }),
    });
    const scope = {
      sessionId,
      pluginId: options.pluginId,
      bundleSha: release.sha256,
      pluginEpoch: row.entityEpoch,
      characterId: captured.scope.characterId,
      chatId: options.chatId,
      chatEpoch: captured.scope.chatEpoch,
      writerId: lease.writerId,
      writerFence: lease.fence,
    };
    function eventInput(request) {
      return { ...request, sessionId };
    }
    async function checkpoint(request) {
      check();
      // Opening/closing also runs original persistence. Give it its own proof,
      // with no raw field values or rendered HTML in the durable command row.
      if (!request) {
        const eventId = "plugin-ui:" + randomUUID();
        request = {
          eventId,
          requestHash: createHash("sha256").update(eventId).digest("hex"),
          appliedRevision: 0,
        };
        await store.call("admitPluginUIEvent", {
          ...eventInput(request),
          lease,
          scope: captured.scope,
        });
      }
      const prepared = {
        ...storage.checkpoint(request.eventId),
        reads: reads.snapshot(),
      };
      await capabilities.prepareEvent(request.eventId);
      const writeSet = context.writeSet();
      const cancelled = capabilities.cancelledEvent(request.eventId);
      if (cancelled) {
        const guards = [
          "chatId",
          "expectedRevision",
          "expectedContentRevision",
          "characterReads",
          "variableReads",
          "resourceReads",
        ];
        if (
          externalCalls !== eventExternalStart ||
          Object.entries(writeSet).some(
            ([key, value]) =>
              !guards.includes(key) &&
              value !== undefined &&
              !(Array.isArray(value) && value.length === 0),
          )
        )
          throw new RuntimeError(
            "PLUGIN_UI_CANCEL_UNSAFE",
            "A cancelled import already changed canonical state or made an external request; the operation was not saved",
          );
        // Only a reviewed file/confirmation cancellation before original import
        // mutations can complete a metadata-only receipt. Close this realm after
        // the event: its forced original flush buffer must never be reused.
        prepared.writes = [];
        cancelledCheckpoint = true;
      }
      const saved = await store.call("completePluginUIEvent", {
        ...eventInput(request),
        pluginStorage: prepared,
        writeSet,
      });
      if (!cancelled) storage.acknowledge(saved.pluginStorage, prepared);
      rebase({ scope: saved.scope, snapshot: saved.snapshot });
      capabilities.commitEvent(request.eventId);
      return saved;
    }
    remote = createPluginUISession(window, {
      scope,
      guard,
      signal,
      onFailure: poison,
      visible: () => visible,
      prepareEvent: async () => host?.settlePanel(),
      settle: async () => host?.settle(),
      checkpoint,
      receipts: {
        read: (_scope, eventId) =>
          store.call("readPluginUIEvent", { eventId, sessionId }),
        admit: (_scope, request) =>
          store.call("admitPluginUIEvent", {
            ...eventInput(request),
            lease,
            scope: captured.scope,
          }),
        complete: (_scope, request) =>
          store.call("readPluginUIEvent", eventInput(request)),
        fail: (_scope, request) =>
          store.call("failPluginUIEvent", eventInput(request)),
      },
    });
    const dom = {
      window,
      document: window.document,
      capabilityGlobals: capabilities.globals,
      assertHealthy: () => {
        capabilities.assertHealthy();
        remote.assertHealthy();
      },
      showContainer: () => {
        visible = true;
      },
      hideContainer: () => {
        visible = false;
      },
    };
    host = await createServerPluginHost({
      plugin,
      context: contextPort,
      reads: readPort,
      storage,
      signal,
      dom,
      fetch: (...args) => {
        externalCalls++;
        return (options.providerFetch ?? fetch)(...args);
      },
      checkBeforeExternalEffect: guard,
      readCharacterCatalog: () => captured.snapshot.pluginCatalog.characters,
      currentIndices: () => {
        const characters = captured.snapshot.pluginCatalog.characters;
        const characterIndex = characters.findIndex(
          (character) => character.chaId === captured.scope.characterId,
        );
        const chatIndex = characters[characterIndex]?.chats.findIndex(
          (chat) => chat.id === options.chatId,
        );
        if (characterIndex < 0 || chatIndex < 0)
          throw new RuntimeError(
            "PLUGIN_UI_SCOPE_CHANGED",
            "The plugin catalog target disappeared",
          );
        return { characterIndex, chatIndex };
      },
      readCurrentCharacter: () => {
        const current = context.getCurrentCharacter();
        const header = captured.snapshot.pluginCatalog.characters.find(
          (character) => character.chaId === captured.scope.characterId,
        );
        const chatPage = header.chats.findIndex(
          (chat) => chat.id === options.chatId,
        );
        return {
          ...current,
          chatPage,
          chats: header.chats.map((chat, index) =>
            index === chatPage ? context.getCurrentChat() : chat,
          ),
        };
      },
    });
    const setting = host.registrations.settings[0];
    if (typeof setting?.[1] !== "function")
      throw new RuntimeError(
        "PLUGIN_UI_UNAVAILABLE",
        "Original setting registration is absent",
      );
    await setting[1]();
    await host.settle();
    await guard();
    await checkpoint();
    function withEffects(snapshot) {
      return { ...snapshot, effects: capabilities.snapshot() };
    }
    return {
      snapshot: async (request = {}) =>
        withEffects(await remote.snapshot({ ...request, whileBusy: true })),
      async dispatch(request) {
        check();
        capabilities.beginEvent(request?.eventId);
        eventExternalStart = externalCalls;
        cancelledCheckpoint = false;
        try {
          const result = await remote.dispatch(request);
          capabilities.endEvent(request.eventId);
          const output = { ...result, snapshot: withEffects(result.snapshot) };
          if (cancelledCheckpoint) {
            output.snapshot = {
              ...output.snapshot,
              visible: false,
              busy: false,
              effects: [],
            };
            await close();
            options.onFailure?.(
              new RuntimeError(
                "PLUGIN_UI_CLOSED",
                "The cancelled file interaction completed safely; reopen the plugin window to continue",
              ),
            );
          }
          return output;
        } catch (error) {
          capabilities.failEvent(request.eventId);
          throw error;
        } finally {
          capabilities.endEvent(request.eventId);
        }
      },
      async resolveEffect(input) {
        await guard();
        return capabilities.resolve(input);
      },
      async readArtifact(input) {
        await guard();
        return capabilities.readArtifact(input);
      },
      cancelPendingEffects: () => capabilities.cancelPending(),
      close,
      scope,
      parameters: host.parameters,
      ensureHealthy: check,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
module.exports = { createPluginUIRuntime };
