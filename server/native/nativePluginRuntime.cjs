"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginDom } = require("./pluginDom.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");
const {
  matchesWygloreRelease,
  getWygloreRelease,
} = require("./wygloreContract.cjs");
const { RuntimeError } = require("../entity/errors.cjs");
const {
  createPluginReadDependencies,
} = require("./pluginReadDependencies.cjs");
const { createWygloreJobContext } = require("./wygloreJobContext.cjs");
const { reviewButtonPlugins } = require("./buttonPluginPolicy.cjs");
const {
  reviewBrowserGenerationPlugins,
} = require("./browserGenerationPluginPolicy.cjs");

/** Opt-in coordinator. The default production worker still uses strict admission. */
function createNativePluginCoordinator(options) {
  let lease, host, session, dom, renewal, pendingRenewal, failure;
  let executionSnapshot = options.snapshot;
  let buttonAdmission;
  let generationAdmission;
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abort.signal])
    : abort.signal;
  function poison(error) {
    failure ??= error;
    abort.abort(error);
    options.onFailure?.(error);
  }
  async function renew() {
    if (!lease || pendingRenewal) return pendingRenewal;
    pendingRenewal = options.store
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
  function check() {
    if (failure) throw failure;
    signal.throwIfAborted();
  }
  async function acquire(source) {
    const namespace = {
      pluginId: source.id,
      bundleSha: getWygloreRelease(source.payload.script).sha256,
      pluginEpoch: source.entityEpoch,
    };
    if (!Number.isSafeInteger(namespace.pluginEpoch))
      throw new RuntimeError(
        "PLUGIN_NAMESPACE_CHANGED",
        "Plugin incarnation is absent",
      );
    const job = options.job;
    const deadline = Date.now() + (options.acquireTimeoutMs ?? 120000);
    while (!lease) {
      check();
      try {
        lease = await options.store.call("claimPluginStorage", {
          namespace,
          writerId: "native-plugin:" + job.id,
          authority: {
            kind: "job",
            jobId: job.id,
            owner: job.owner,
            fence: job.fence,
          },
        });
      } catch (error) {
        if (error.code !== "PLUGIN_STORAGE_BUSY" || Date.now() >= deadline)
          throw error;
        await delay(100, undefined, { signal });
      }
    }
    if (
      lease.namespace.pluginId !== namespace.pluginId ||
      lease.namespace.pluginEpoch !== namespace.pluginEpoch
    )
      throw new RuntimeError(
        "PLUGIN_NAMESPACE_CHANGED",
        "Plugin changed while waiting for its writer",
      );
    renewal ??= setInterval(renew, 5000);
    return namespace;
  }
  return {
    /** Wait before constructing a realm/context. Then capture current settings and
     * sources once, under the still-owned job's original content revision guard. */
    async prepareSnapshot(snapshot) {
      executionSnapshot = snapshot;
      if (options.job.type === "button") {
        buttonAdmission = reviewButtonPlugins(snapshot);
        // The reviewed originals register only generation request hooks. Their
        // private boot/cache maintenance can wait for generation or settings UI;
        // a character button never reads or writes that memory namespace.
        if (buttonAdmission) return snapshot;
      }
      generationAdmission = reviewBrowserGenerationPlugins(
        snapshot,
        options.job.type,
      );
      // createExecutionContext reconstructs db.plugins from every captured
      // plugin resource. pluginIds is a client collection index, not native
      // admission; enabled controls execution in both preparation and open.
      const active = (snapshot.resources ?? []).filter(
        (row) =>
          row.kind === "plugin" &&
          row.payload?.enabled &&
          matchesWygloreRelease(row.payload),
      );
      if (!active.length) return snapshot;
      if (active.length !== 1)
        throw new RuntimeError(
          "PLUGIN_UNSUPPORTED",
          "Only one WygLore instance can own a native job",
        );
      await acquire(active[0]);
      executionSnapshot = await options.store.call(
        "readPluginJobSnapshot",
        options.job.id,
        options.job.owner,
        options.job.fence,
      );
      return executionSnapshot;
    },
    async open(context) {
      generationAdmission = reviewBrowserGenerationPlugins(
        executionSnapshot,
        options.job.type,
      );
      if (options.job.type === "button") {
        buttonAdmission ??= reviewButtonPlugins(executionSnapshot);
        if (buttonAdmission)
          return {
            admissionOnly: true,
            editHooks: Object.fromEntries(
              ["editinput", "editoutput", "editprocess", "editdisplay"].map(
                (name) => [name, new Set()],
              ),
            ),
            requestHooks: {
              replacerbeforeRequest: new Set(),
              replacerafterRequest: new Set(),
            },
            pluginRequiresServerHost: buttonAdmission.pluginRequiresServerHost,
            async complete() {
              check();
              context.ensureHealthy();
              return {
                pluginId: buttonAdmission.pluginId,
                reads: buttonAdmission.reads,
              };
            },
            async close() {},
          };
      }
      const active = context
        .getDatabase()
        .plugins.filter(
          (plugin) => plugin.enabled && matchesWygloreRelease(plugin),
        );
      if (!active.length) {
        if (!generationAdmission) return undefined;
        return {
          admissionOnly: true,
          editHooks: Object.fromEntries(
            ["editinput", "editoutput", "editprocess", "editdisplay"].map(
              (name) => [name, new Set()],
            ),
          ),
          requestHooks: {
            replacerbeforeRequest: new Set(),
            replacerafterRequest: new Set(),
          },
          pluginRequiresServerHost:
            generationAdmission.pluginRequiresServerHost,
          async complete() {
            check();
            context.ensureHealthy();
            return generationAdmission.checkpoint;
          },
          async close() {},
        };
      }
      if (active.length !== 1)
        throw new RuntimeError(
          "PLUGIN_UNSUPPORTED",
          "Only one WygLore instance can own a native job",
        );
      const plugin = active[0];
      const reads = createPluginReadDependencies(executionSnapshot);
      reads.observePlugin(plugin.id);
      if (generationAdmission) reads.observeDatabaseFields(["plugins"]);
      reads.observeCharacter();
      reads.observeChat();
      reads.observeDatabaseFields(["mainPrompt"]);
      reads.observeCurrentScope();
      const source = executionSnapshot.resources.find(
        (row) => row.kind === "plugin" && row.id === plugin.id,
      );
      if (!source || !Number.isSafeInteger(source.entityEpoch))
        throw new RuntimeError(
          "PLUGIN_NAMESPACE_CHANGED",
          "The native plugin has no captured incarnation",
        );
      const namespace = await acquire(source);
      const job = options.job;
      const isolated = ["send", "continue", "reroll"].includes(job.type);
      const staged = isolated ? createWygloreJobContext(context) : undefined;
      const pluginContext = staged?.context ?? context;
      const pluginAbort = new AbortController();
      const pluginSignal = isolated
        ? AbortSignal.any([signal, pluginAbort.signal])
        : signal;
      let degraded = false;
      const snapshot = await options.store.call(
        "readAllPluginStorage",
        namespace,
      );
      session = createPluginStorageSession(snapshot, lease, { signal, check });
      // Keep the admitted namespace/lease/revision even when optional memory
      // work is discarded. finishJob must still validate all plugin reads.
      const cleanCheckpoint = session.checkpoint("plugin-job:" + job.id);
      dom = createPluginDom({
        signal: pluginSignal,
        alertSelect: options.alertSelect,
        onFailure: poison,
        onProgress: options.onProgress,
      });
      async function isolate(error) {
        if (!isolated || error?.code !== "PLUGIN_PROVIDER_UNCERTAIN")
          throw error;
        check();
        context.ensureHealthy();
        pluginContext.ensureHealthy();
        session.ensureHealthy();
        dom.check();
        await pendingRenewal;
        check();
        // A network error must not disguise job cancellation, a lost writer,
        // or a changed plugin incarnation while the request was in flight.
        await renew();
        check();
        context.ensureHealthy();
        pluginContext.ensureHealthy();
        session.ensureHealthy();
        dom.check();
        if (degraded) return;
        degraded = true;
        staged.discard();
        // DOM aborts are normally fatal. Remove its listener before aborting
        // only this quarantined plugin; the main job signal remains live.
        dom.stop();
        pluginAbort.abort(error);
        try {
          await host?.close();
        } catch (cleanupError) {
          if (cleanupError?.code !== "PLUGIN_PROVIDER_UNCERTAIN")
            throw cleanupError;
        } finally {
          session.discard();
        }
        options.onWarning?.({
          code: "PLUGIN_PROVIDER_UNCERTAIN",
          diagnostic: error.details,
        });
      }
      host = await createServerPluginHost({
        plugin,
        context: pluginContext,
        reads,
        storage: session,
        signal: pluginSignal,
        isolateProviderFailure: isolated,
        dom,
        currentIndices: () => {
          const scope = executionSnapshot.pluginCurrentScope;
          return {
            characterIndex: scope.characterIndex,
            chatIndex: scope.chatIndex,
          };
        },
        readCurrentCharacter: () => {
          const scope = executionSnapshot.pluginCurrentScope;
          return {
            ...pluginContext.getCurrentCharacter(),
            chatPage: scope.chatIndex,
            chats: scope.chats.map((chat, index) =>
              index === scope.chatIndex ? pluginContext.getCurrentChat() : chat,
            ),
          };
        },
        fetch: options.createFetch?.(pluginContext) ?? options.fetch,
        checkBeforeExternalEffect: options.checkBeforeExternalEffect,
        onProgress: options.onProgress,
      });
      const hooks = Object.fromEntries(
        Object.entries(host?.hooks ?? {}).map(([name, handlers]) => [
          name,
          new Set(
            [...handlers].map((handler) => async (...args) => {
              check();
              context.ensureHealthy();
              if (degraded) return args[0];
              try {
                return await handler(...args);
              } catch (error) {
                await isolate(error);
                return args[0];
              }
            }),
          ),
        ]),
      );
      const matches = (candidate) =>
        candidate.id === plugin.id && matchesWygloreRelease(candidate);
      return {
        editHooks: hooks,
        requestHooks: hooks,
        pluginRequiresServerHost: (candidate, database) =>
          matches(candidate)
            ? false
            : generationAdmission
              ? generationAdmission.pluginRequiresServerHost(
                  candidate,
                  database,
                )
              : pluginRequiresServerHost(candidate, database),
        async complete() {
          check();
          context.ensureHealthy();
          if (!degraded) {
            try {
              await host.close({ success: true });
            } catch (error) {
              await isolate(error);
            }
          }
          if (!degraded) dom.check();
          await pendingRenewal;
          check();
          context.ensureHealthy();
          const checkpoint = {
            ...(degraded
              ? cleanCheckpoint
              : session.checkpoint("plugin-job:" + job.id)),
            reads: reads.snapshot(),
          };
          if (!degraded) staged?.commit();
          return checkpoint;
        },
        async close() {
          await pendingRenewal;
          try {
            await host?.close();
          } finally {
            dom.stop();
            session.discard();
            staged?.discard();
          }
        },
      };
    },
    /** Release after finishJob, never before its atomic graph/chat transaction. */
    async release() {
      clearInterval(renewal);
      await pendingRenewal;
      try {
        await host?.close();
      } finally {
        dom?.stop();
        session?.discard();
        abort.abort(new Error("Plugin runtime closed"));
        if (lease) await options.store.call("releasePluginStorage", lease);
        lease = undefined;
      }
    },
    dispatchAction: (id) => {
      check();
      return dom.dispatchAction(id);
    },
  };
}
module.exports = { createNativePluginCoordinator };
