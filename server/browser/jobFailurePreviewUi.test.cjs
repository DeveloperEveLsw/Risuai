"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (value) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic failure preview timeout: " + JSON.stringify(value));
}

test(
  "result modal separates the original failure from recovery limits and does not invent partial output or execute error markup",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), "risu-failure-preview-ui-"),
    );
    const file = join(directory, "synthetic.sqlite");
    let runtime, production, frontend, browser;
    t.after(async () => {
      await browser?.close();
      await frontend?.close();
      await (production ?? runtime)?.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const failure =
      "<script>window.syntheticFailureExecuted=true</script> A complete server plugin host is required for native generation";
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
      },
      resources: [],
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic failure preview",
        desc: "Synthetic",
        firstMessage: "",
      },
      chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
    });
    store.enqueueJob("empty-failure", {
      type: "send",
      chatId: "a",
      input: "Synthetic input",
      messageId: "synthetic-input",
    });
    const failed = store.claimJob("worker").job;
    store.finishJob(failed.id, "worker", failed.fence, {
      state: "failed",
      result: {
        code: "ENGINE_ERROR",
        message: failure,
        uncommitted: {
          snapshot: { settings: "synthetic-private-config-do-not-show" },
          result: { prompt: "synthetic-private-prompt-do-not-show" },
        },
      },
    });
    store.enqueueJob("partial-failure", {
      type: "button",
      chatId: "a",
      data: "synthetic-button",
    });
    const partial = store.claimJob("worker").job;
    store.writeJobProgress(partial.id, "worker", partial.fence, {
      messages: [
        { role: "char", chatId: "partial", data: "Synthetic partial message" },
      ],
    });
    store.interruptJob(
      partial.id,
      "worker",
      partial.fence,
      "Synthetic interruption",
    );
    const before = store.snapshot("a"),
      cursor = store.cursor();
    store.close();
    let url;
    if (process.env.RISU_DISPLAY_WORKER_BUILD_PATH) {
      const passwordFile = join(directory, "password");
      await fs.writeFile(
        passwordFile,
        createHash("sha256").update("synthetic-password").digest("hex"),
      );
      production = await createProductionService({
        file,
        passwordFile,
        staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
        origin: "https://risu.test",
        insecureLocalTest: true,
        host: "127.0.0.1",
        port: 0,
        runtime: { eventsPollMs: 20 },
      });
      runtime = production.runtime;
      url = production.url;
    } else {
      const origins = [];
      runtime = await createRuntimeService({ file, origins, eventsPollMs: 20 });
      const { createServer } = await import("vite");
      frontend = await createServer({
        configFile: resolve("vite.config.ts"),
        logLevel: "error",
        define: {
          "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
          "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
        },
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          hmr: false,
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      await frontend.listen();
      url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
    }
    browser = await launchChromium(directory);
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1100, height: 900 },
      blockHttps: true,
    });
    const errors = [];
    page.on("Runtime.exceptionThrown", (event) =>
      errors.push(
        event.exceptionDetails.exception?.description ??
          event.exceptionDetails.text,
      ),
    );
    await until(() =>
      page.evaluate(
        "!!document.querySelector('input[name=password]')||!!document.querySelector('[data-runtime-ready=true]')",
      ),
    );
    if (
      await page.evaluate("!!document.querySelector('input[name=password]')")
    ) {
      await page.evaluate(
        "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
      );
    }
    await until(() =>
      page.evaluate("!!document.querySelector('[data-character-id=c]')"),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-result=empty-failure]')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=empty-failure]').click()",
    );
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-result-failure]')",
      ),
    );
    const preview = await page.evaluate(
      "fetch('/api/runtime/jobs/empty-failure/result').then(r=>r.json())",
    );
    assert.deepEqual(preview.failure, {
      code: "ENGINE_ERROR",
      message: failure,
    });
    assert.equal(preview.blocked.code, "RESULT_NOT_RECOVERABLE");
    assert.equal(preview.canRecover, false);
    assert.equal(preview.canRetry, true);
    assert.equal(JSON.stringify(preview).includes("do-not-show"), false);
    const text = await page.evaluate(
      "document.querySelector('[data-runtime-result-review]').textContent",
    );
    assert.ok(
      text.indexOf("ENGINE_ERROR") < text.indexOf("RESULT_NOT_RECOVERABLE"),
    );
    assert.ok(text.includes(failure));
    assert.ok(
      text.includes(
        "저장 가능한 전체 스크립트 처리 결과가 남아 있지 않습니다.",
      ),
    );
    assert.equal(text.includes("부분 출력"), false);
    assert.equal(text.includes("do-not-show"), false);
    assert.equal(
      await page.evaluate(
        "document.querySelector('[data-runtime-result-review]').querySelectorAll('script,img').length",
      ),
      0,
    );
    assert.equal(
      await page.evaluate("!!window.syntheticFailureExecuted"),
      false,
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-runtime-recover]')"),
      false,
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-runtime-retry]')"),
      true,
    );
    await page.evaluate(
      "Array.from(document.querySelector('[data-runtime-result-review]').querySelectorAll('button')).find(el=>el.textContent==='닫기').click();document.querySelector('[data-runtime-result=partial-failure]').click()",
    );
    await until(() =>
      page.evaluate(
        "document.querySelector('[data-runtime-result-review] textarea')?.value==='Synthetic partial message'",
      ),
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('[data-runtime-result-failure]').textContent.includes('Synthetic interruption')",
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('[data-runtime-result-review]').textContent.includes('실패·중단 시 보존된 메시지입니다.')",
      ),
      true,
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-runtime-recover]')"),
      false,
    );
    assert.deepEqual(await runtime.store.call("snapshot", "a"), before);
    assert.equal((await runtime.store.call("snapshot", "a")).cursor, cursor);
    assert.equal((await runtime.store.call("listJobs", "a")).length, 2);
    assert.deepEqual(errors, []);
  },
);
