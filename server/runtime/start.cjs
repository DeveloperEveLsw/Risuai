"use strict";
const { createRuntimeService } = require("./service.cjs");

(async () => {
  const runtime = await createRuntimeService({
    initialize: true,
    port: Number(process.env.RISU_RUNTIME_PORT ?? 6174),
    file: process.env.RISU_RUNTIME_DATABASE,
    scheduler: {
      reviewedPlugins: process.env.RISU_REVIEWED_SERVER_PLUGINS === "TRUE",
      concurrency: Number(process.env.RISU_RUNTIME_CONCURRENCY ?? 2),
      onError: (error) =>
        console.error("Runtime scheduler:", error.code ?? error.name),
    },
  });
  console.log("Local Risu runtime:", runtime.url);
  if (process.send) process.send({ ready: true, url: runtime.url });
  const close = () =>
    runtime.close().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
