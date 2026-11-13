"use strict";
const { EntityStoreClient } = require("../entity/client.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
let runtime, store, stopping;
const controller = new AbortController();
const reply = (message) => {
  if (process.connected) process.send(message);
};
async function stop() {
  if (stopping) return stopping;
  controller.abort(new Error("Plugin UI supervisor disconnected"));
  stopping = (async () => {
    await runtime?.close().catch(() => {});
    await store?.close();
    if (process.connected) process.disconnect();
  })();
  return stopping;
}
process.once("disconnect", () => {
  void stop().finally(() => process.exit(0));
});
process.on("message", (message) => {
  if (message?.type === "stop") void stop();
});
process.once("message", async (message) => {
  const data = message?.initialize;
  if (!data?.file || !data.sessionId || !data.pluginId || !data.chatId)
    return process.exit(1);
  try {
    store = new EntityStoreClient(data.file);
    await store.ready;
    runtime = await createPluginUIRuntime({
      ...data,
      store,
      signal: controller.signal,
      onLease: (lease) => reply({ lease }),
      onFailure: (error) =>
        reply({ failed: { code: error.code ?? "PLUGIN_UI_FAILED" } }),
    });
    reply({ ready: await runtime.snapshot() });
    process.on("message", async (request) => {
      if (request?.type === "stop") return stop();
      if (typeof request?.requestId !== "string") return;
      try {
        let result;
        if (request.type === "snapshot")
          result = await runtime.snapshot({ whileBusy: true });
        else if (request.type === "dispatch")
          result = await runtime.dispatch(request.event);
        else if (request.type === "resolveEffect")
          result = await runtime.resolveEffect(request.event);
        else if (request.type === "readArtifact")
          result = await runtime.readArtifact(request.event);
        else if (request.type === "cancelEffects")
          result = await runtime.cancelPendingEffects();
        else throw new Error("Unknown plugin UI action");
        reply({ requestId: request.requestId, result });
      } catch (error) {
        reply({
          requestId: request.requestId,
          error: {
            code: error.code ?? "PLUGIN_UI_FAILED",
            message: error.message,
          },
        });
      }
    });
  } catch (error) {
    reply({
      initializationError: {
        code: error.code ?? "PLUGIN_UI_FAILED",
        message: error.message,
      },
    });
    await stop();
  }
});
