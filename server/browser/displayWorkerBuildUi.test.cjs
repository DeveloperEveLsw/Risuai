"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < end);
  throw new Error("Built worker condition timed out: " + JSON.stringify(value));
}
test(
  "optimized original UI bundle loads display WASM worker; infinite script cannot block checkbox or persist partial effects",
  { timeout: 180000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-built-display-worker-"),
    );
    let runtime, frontend, browser;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend) {
        frontend.httpServer.closeAllConnections();
        await new Promise((resolve) => frontend.httpServer.close(resolve));
      }
      if (runtime) await runtime.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: { didFirstSetup: true, language: "en", autoTranslate: false },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic built worker" } },
      definition: {
        type: "character",
        name: "Synthetic built worker",
        desc: "Synthetic",
        firstMessage: "Synthetic built worker",
        customModuleToggle: "heavy=Synthetic heavy toggle",
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay',function(id,data)
  if not string.find(data,'Synthetic built worker',1,true) then return data end
  setChatVar(id,'worker_ready','1')
  if cbs('{{getglobalvar::toggle_heavy}}')=='1' then
    setChatVar(id,'partial','must-not-persist')
    while true do end
  end
  return data..'<span id="built-worker-ready">Ready</span>'
end)`,
              },
            ],
          },
        ],
      },
    });
    const { preview } = await import("vite");
    let jsonResourceRequests = 0;
    const jsonLua = await readFile("public/lua/json.lua", "utf8");
    frontend = await preview({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-slow-worker-resource",
          configurePreviewServer(server) {
            server.middlewares.use((request, response, next) => {
              if (request.url !== "/lua/json.lua") return next();
              jsonResourceRequests++;
              setTimeout(() => {
                response.setHeader("Content-Type", "text/plain; charset=utf-8");
                response.end(jsonLua);
              }, 2200);
            });
          },
        },
      ],
      build: { outDir: process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
      preview: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await until(() =>
      page.evaluate("!!document.querySelector('[data-character-id=c]')"),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    const initializationStart = Date.now();
    await until(
      () =>
        page.evaluate(
          "document.querySelector('#built-worker-ready')?.textContent",
        ),
      (value) => value === "Ready",
    );
    const initializationMs = Date.now() - initializationStart;
    assert.ok(
      initializationMs >= 2200,
      "resource initialization has a separate budget from the 2000 ms invocation",
    );
    assert.equal(jsonResourceRequests, 1);
    await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.some(
        (v) => v.key === "$worker_ready" && v.value === "1",
      ),
    );
    assert.equal(
      await page.evaluate(
        "[...document.scripts].every(s=>!s.src.includes('/src/'))",
      ),
      true,
    );
    await page.evaluate(
      "window.builtWorkerFrames=[];window.builtWorkerLast=performance.now();window.builtWorkerSampling=true;const sample=now=>{window.builtWorkerFrames.push(now-window.builtWorkerLast);window.builtWorkerLast=now;if(window.builtWorkerSampling)requestAnimationFrame(sample)};requestAnimationFrame(sample)",
    );
    const feedback = await page.evaluate(
      `(async()=>{const start=performance.now();const checkbox=document.querySelector('input[alt="Synthetic heavy toggle"]');checkbox.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {ms:performance.now()-start,checked:checkbox.checked}})()`,
    );
    assert.equal(feedback.checked, true);
    assert.ok(feedback.ms < 400);
    await until(
      async () =>
        (
          await runtime.store.call("readVariables", [
            { scope: "global", key: "toggle_heavy" },
          ])
        ).variables[0],
      (v) => v.value === "1",
    );
    await until(
      () =>
        page.evaluate(
          "document.querySelector('[data-runtime-ready]')?.textContent",
        ),
      (value) => value?.includes("2000 ms execution budget"),
      10000,
    );
    const maxFrameGap = await page.evaluate(
      "window.builtWorkerSampling=false;Math.max(...window.builtWorkerFrames)",
    );
    assert.ok(
      maxFrameGap < 400,
      "RAF during actual original UI infinite display: " + maxFrameGap,
    );
    const snapshot = await runtime.store.call("snapshot", "a");
    assert.equal(
      snapshot.variables.some((v) => v.key === "$partial"),
      false,
    );
    assert.equal(
      snapshot.variables.find((v) => v.key === "$worker_ready").value,
      "1",
    );
    const evidence = {
      optimizedBundle: true,
      syntheticDesktopOnly: true,
      originalUI: true,
      realDisplayWorker: true,
      wasmResourceLoaded: true,
      realIdbServerAdmission: true,
      infiniteLuaBudgetMs: 2000,
      delayedJsonResourceMs: 2200,
      initializationMs,
      feedback,
      maxFrameGap,
      partialEffectsPersisted: false,
    };
    t.diagnostic(JSON.stringify(evidence));
    if (process.env.RISU_DISPLAY_WORKER_BUILD_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_WORKER_BUILD_OUTPUT,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
