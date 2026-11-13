"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic provider output UI timeout: " + JSON.stringify(value));
}

test(
  "native output Lua failure survives all-tab exit and service reopen for two authenticated original UI readers",
  {
    timeout: 120000,
    skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
  },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-provider-output-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
    let service, browser, release;
    const held = new Promise((resolve) => (release = resolve)),
      calls = [];
    const raw =
      "<script>window.syntheticProviderExecuted=true</script> Unprocessed synthetic reply";
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        "data: " +
          JSON.stringify({ choices: [{ index: 0, delta: { content: raw } }] }) +
          "\n\n",
      );
      await held;
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      release();
      await browser?.close();
      await service?.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        customTokenizer: "tik",
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        useStreaming: true,
        streamingDisplayOptimizationMode: "strong",
        mainPrompt: "Synthetic",
        maxContext: 8000,
        maxResponse: 100,
      },
      resources: [],
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic output failure",
        desc: "Synthetic",
        firstMessage: "",
        triggerscript: [
          {
            type: "output",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
listenEdit('editOutput', function(id, text)
  setChatVar(id, 'partial', 'must not save')
  setState(id, 'shape', {value = 'synthetic'})
  return getState(id, 'shape'):gsub('x', 'y')
end)`,
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
    });
    store.close();
    await fs.writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-password").digest("hex"),
    );
    async function start() {
      service = await createProductionService({
        file,
        passwordFile,
        staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
        origin: "https://risu.test",
        insecureLocalTest: true,
        host: "127.0.0.1",
        port: 0,
        runtime: {
          eventsPollMs: 20,
          scheduler: { pollMs: 20, progressIntervalMs: 25 },
        },
      });
    }
    await start();
    browser = await launchChromium(root);
    const contexts = [await browser.newContext(), await browser.newContext()],
      errors = [];
    async function open(context) {
      const page = await browser.page(service.url, context, {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
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
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      return page;
    }
    let a = await open(contexts[0]),
      b = await open(contexts[1]);
    const admitted = await a.evaluate(
      "fetch('/api/runtime/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'raw-output',command:{type:'send',chatId:'a',input:'Synthetic input',messageId:'input'}})}).then(r=>r.json())",
    );
    assert.equal(admitted.job.id, "raw-output");
    await until(() => calls.length === 1);
    await until(
      () => service.runtime.store.call("getJobStatus", "raw-output"),
      (job) => job?.result.retained === 1,
    );
    const running = await a.evaluate(
      "fetch('/api/runtime/jobs/raw-output/status').then(r=>r.text())",
    );
    assert.equal(running.includes("Unprocessed synthetic reply"), false);
    await a.close();
    await b.close();
    release();
    const failed = await until(
      () => service.runtime.store.call("getJob", "raw-output"),
      (job) => job?.state === "failed",
    );
    assert.match(failed.result.message, /method 'gsub'/);
    const originalPreview = await service.runtime.store.call(
      "previewJobResult",
      "raw-output",
    );
    assert.equal(originalPreview.canRecover, false);
    assert.equal(originalPreview.providerOutputs[0].complete, true);
    assert.equal(originalPreview.providerOutputs[0].candidates[0].data, raw);
    assert.equal(
      (await service.runtime.store.call("snapshot", "a")).messages.length,
      0,
    );
    assert.equal(
      (await service.runtime.store.call("snapshot", "a")).variables.length,
      0,
    );
    await service.close();
    await start();
    a = await open(contexts[0]);
    b = await open(contexts[1]);
    const cursor = (await service.runtime.store.call("snapshot", "a")).cursor;
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-result=raw-output]')",
        ),
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-provider-output]')",
        ),
        false,
      );
      await page.evaluate(
        "document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=raw-output]').click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-provider-output]')",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-runtime-provider-output]').value",
        ),
        raw,
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-runtime-provider-output]').readOnly",
        ),
        true,
      );
      assert.equal(
        await page.evaluate("!!window.syntheticProviderExecuted"),
        false,
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-recover]')",
        ),
        false,
      );
      const compact = await page.evaluate(
        "fetch('/api/runtime/jobs/raw-output/status').then(r=>r.text())",
      );
      assert.equal(compact.includes("Unprocessed synthetic reply"), false);
    }
    assert.equal(
      (await service.runtime.store.call("snapshot", "a")).cursor,
      cursor,
    );
    assert.deepEqual(
      (await service.runtime.store.call("previewJobResult", "raw-output"))
        .providerOutputs,
      originalPreview.providerOutputs,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(errors, []);
  },
);
