"use strict";
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

// The API is a separate process: Vite compilation must not block command admission.
(async () => {
  let frontend,
    closing = false;
  const backend = spawn(process.execPath, [resolve(__dirname, "start.cjs")], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const ready = new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.once("exit", (code) =>
      reject(new Error("Runtime exited before startup (" + code + ")")),
    );
    backend.once("message", resolve);
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    if (frontend) await frontend.close();
    if (backend.exitCode === null) backend.kill("SIGTERM");
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  backend.once("exit", (code) => {
    if (!closing && code) process.exitCode = code;
    void close();
  });
  try {
    const { url } = await ready;
    if (closing) return;
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      // CLI and browser acceptance may compile the same checkout separately.
      // Keep their optimized Svelte dependency graphs in separate caches.
      cacheDir: resolve(
        process.env.RISU_RUNTIME_UI_CACHE_DIRECTORY ??
          "node_modules/.vite-entity-runtime",
      ),
      define: {
        "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
        "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
      },
      server: {
        host: "127.0.0.1",
        port: 5174,
        strictPort: true,
        proxy: { "/api/runtime": { target: url, changeOrigin: true } },
      },
    });
    if (closing) {
      await frontend.close();
      return;
    }
    await frontend.listen();
    console.log("Local Risu UI: http://127.0.0.1:5174");
    console.log(
      "Development integration; complete configuration/import workflows are still under development.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    await close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
