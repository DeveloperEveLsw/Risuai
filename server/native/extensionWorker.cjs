"use strict";
const { parentPort, workerData } = require("./jobChannel.cjs").jobChannel();
const { DatabaseSync } = require("node:sqlite");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStoreClient } = require("../entity/client.cjs");
const { loadWebTokenizers } = require("./tokenizerLoader.cjs");
const {
  readExecutionSnapshot,
  readCharacterSnapshot,
} = require("./readSnapshot.cjs");
const { createProgressCheckpoint } = require("./progress.cjs");
const { createNoticePublisher } = require("./notices.cjs");
const { createInteractionHost } = require("./interactions.cjs");
const { AssetStorage } = require("../runtime/assets.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const {
  sanitizePluginProviderDiagnostic,
  pluginProviderWarning,
} = require("./pluginProviderDiagnostic.cjs");

(async () => {
  const started = performance.now();
  const store = new EntityStoreClient(workerData.file);
  const { job } = workerData.claimed;
  const checkpoint = createProgressCheckpoint(store, job, {
    intervalMs: workerData.progressIntervalMs,
  });
  const timing = (phase, start) => {
    if (job.type !== "button") return;
    checkpoint.receive({
      type: "button-timing",
      phase,
      durationMs: performance.now() - start,
    });
  };
  if (job.type === "button" && Number.isFinite(workerData.dispatchedAt))
    checkpoint.receive({
      type: "button-timing",
      phase: "startup",
      durationMs: Math.max(0, Date.now() - workerData.dispatchedAt),
    });
  if (
    job.type === "button" &&
    Number.isFinite(workerData.claimed.buttonQueueMs)
  )
    checkpoint.receive({
      type: "button-timing",
      phase: "queue",
      durationMs: workerData.claimed.buttonQueueMs,
    });
  let reader,
    pluginRuntime,
    ownershipError,
    heartbeat,
    heartbeatPending = false;
  const abort = new AbortController();
  const notices = createNoticePublisher(store, job, (error) =>
    abort.abort(error),
  );
  let resume;
  const interactions = createInteractionHost(store, job, {
    signal: abort.signal,
    onWaiting: (interaction) =>
      parentPort.postMessage({
        interactionWaiting: { jobId: job.id, interactionId: interaction.id },
      }),
    onResume: () => {
      if (!workerData.nativeSupervisor) return;
      return new Promise((resolve, reject) => {
        const stop = () => {
          resume = undefined;
          reject(abort.signal.reason);
        };
        resume = () => {
          abort.signal.removeEventListener("abort", stop);
          resume = undefined;
          resolve();
        };
        abort.signal.addEventListener("abort", stop, { once: true });
        if (abort.signal.aborted) return stop();
        parentPort.postMessage({ interactionResume: { jobId: job.id } });
      });
    },
  });
  parentPort.on("message", (message) => {
    if (message?.type === "cancel" && message.jobId === job.id)
      abort.abort(new Error("Cancellation requested"));
    if (message?.type === "resume-interaction" && message.jobId === job.id)
      resume?.();
  });
  try {
    await store.ready;
    timing("store-ready", started);
    reader = new DatabaseSync(workerData.file, { readOnly: true });
    reader.exec("PRAGMA busy_timeout=5000;");
    const assets = new AssetStorage(
      workerData.file,
      store,
      reader.prepare("SELECT id FROM runtime_identity WHERE singleton=1").get()
        .id,
    );
    const loadStarted = performance.now();
    const { executeExtensionJob, createNativeTransport } = await import(
      pathToFileURL(
        workerData.bundlePath ?? join(__dirname, "dist/extensionJob.mjs"),
      ).href
    );
    timing("engine-load", loadStarted);
    const updateLease = async () => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      try {
        const current = await store.call(
          "heartbeat",
          job.id,
          job.owner,
          job.fence,
          30000,
        );
        if (current.cancelRequested)
          abort.abort(new Error("Cancellation requested"));
      } catch (error) {
        ownershipError = error;
        abort.abort(error);
      } finally {
        heartbeatPending = false;
      }
    };
    await updateLease();
    if (ownershipError) throw ownershipError;
    if (abort.signal.aborted) throw abort.signal.reason;
    heartbeat = setInterval(updateLease, 5000);
    const snapshotStarted = performance.now();
    if (!workerData.claimed.snapshot)
      workerData.claimed.snapshot = readExecutionSnapshot(reader, job);
    timing("snapshot", snapshotStarted);
    parentPort.postMessage({ executing: job.id });
    if (workerData.reviewedPlugins === true)
      pluginRuntime = createNativePluginCoordinator({
        store,
        job,
        snapshot: workerData.claimed.snapshot,
        signal: abort.signal,
        alertSelect: interactions.alertSelect,
        checkBeforeExternalEffect: interactions.check,
        onFailure: (error) => abort.abort(error),
        createFetch: (context) =>
          createNativeTransport(context, {
            signal: abort.signal,
            checkBeforeExternalEffect: interactions.check,
            isolateProviderFailure: true,
          }).fetch,
        onWarning: ({ diagnostic }) =>
          notices.receive(pluginProviderWarning(diagnostic)),
        onProgress: (event) =>
          parentPort.postMessage({
            progress: { jobId: job.id, ...event },
          }),
      });
    let execution;
    try {
      execution = await executeExtensionJob(workerData.claimed, {
        pluginRequiresServerHost,
        openPluginRuntime: pluginRuntime?.open,
        preparePluginSnapshot: pluginRuntime?.prepareSnapshot,
        readImage: (path) => assets.read(path, abort.signal),
        appVer: "2026.8.250",
        ...(job.type === "button" && workerData.buttonPrewarmed
          ? { LuaFactory: require("./buttonPrewarm.cjs").takeFactory() }
          : {}),
        signal: abort.signal,
        alertNormal: notices.receive,
        alertError: notices.receiveError,
        alertInput: interactions.alertInput,
        alertSelect: interactions.alertSelect,
        alertConfirm: interactions.alertConfirm,
        checkBeforeExternalEffect: interactions.check,
        loadWebTokenizers,
        retainProviderOutput: checkpoint.retainProviderOutput,
        onProgress: (event) => {
          checkpoint.receive(event);
          parentPort.postMessage({ progress: { jobId: job.id, ...event } });
        },
        fetch: async (path) => {
          if (
            typeof path !== "string" ||
            !(
              /^\/lua\/[a-zA-Z0-9_-]+\.lua$/.test(path) ||
              /^\/token\/[a-zA-Z0-9_/-]+\.(json|model)$/.test(path)
            )
          )
            throw new Error("Invalid public engine resource");
          return new Response(
            await readFile(join(__dirname, "../../public", path.slice(1))),
            { headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        },
        resolveCharacter: (id) => readCharacterSnapshot(reader, id),
      });
      try {
        interactions.check();
      } catch (error) {
        execution = undefined;
        throw error;
      }
      await notices.flush();
      timing("precommit", started);
      await checkpoint.flush();
      if (ownershipError) throw ownershipError;
      const current = await store.call("getJob", job.id);
      const outcome = current.cancelRequested
        ? { state: "cancelled", result: { reason: "Cancellation requested" } }
        : { state: "completed", ...execution };
      const saved = await store.call(
        "finishJob",
        job.id,
        job.owner,
        job.fence,
        outcome,
      );
      parentPort.postMessage({ completed: saved.job });
    } catch (error) {
      if (workerData.diagnostics) console.error(error.stack);
      await notices.flush().catch(() => {});
      await checkpoint.flush().catch(() => {});
      // Retain an already computed result on commit conflict; never repeat the script/provider call.
      const cancelled = (await store.call("getJob", job.id))?.cancelRequested;
      const saved = await store.call(
        "finishJob",
        job.id,
        job.owner,
        job.fence,
        {
          state: cancelled ? "cancelled" : "failed",
          result: {
            code: error.code ?? "ENGINE_ERROR",
            message: error.message,
            ...(error.code === "PLUGIN_PROVIDER_UNCERTAIN"
              ? { diagnostic: sanitizePluginProviderDiagnostic(error.details) }
              : {}),
            ...(execution ? { uncommitted: execution } : {}),
          },
        },
      );
      parentPort.postMessage({ completed: saved.job });
    }
  } catch (error) {
    // Initialization failures are known failures, not uncertain provider calls.
    // Ownership checks still fence a worker whose lease has already expired.
    try {
      const saved = await store.call(
        "finishJob",
        job.id,
        job.owner,
        job.fence,
        {
          state: (await store.call("getJob", job.id))?.cancelRequested
            ? "cancelled"
            : "failed",
          result: {
            code: error.code ?? "WORKER_ERROR",
            message: error.message,
          },
        },
      );
      parentPort.postMessage({ completed: saved.job });
    } catch (reportError) {
      parentPort.postMessage({
        error: {
          code: reportError.code ?? "WORKER_ERROR",
          message: reportError.message,
        },
      });
    }
  } finally {
    // The atomic chat/graph finish must precede releasing the writer lease.
    await pluginRuntime?.release().catch(() => {});
    abort.abort(new Error("Native execution closed"));
    interactions.stop();
    notices.stop();
    checkpoint.stop();
    clearInterval(heartbeat);
    reader?.close();
    await store.close();
    parentPort.close();
  }
})().catch((error) => {
  parentPort.postMessage({
    error: { code: error.code ?? "WORKER_ERROR", message: error.message },
  });
  parentPort.close();
});
