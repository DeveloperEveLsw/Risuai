"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os"),
  { createHash } = require("node:crypto"),
  { createServer } = require("node:http"),
  { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs"),
  { createProductionService } = require("../runtime/production.cjs"),
  { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic preset UI timeout: " + JSON.stringify(value));
}
test(
  "built original preset-chain generation synchronizes two devices, preserves prefix DOM and completes after all tabs close",
  { timeout: 90000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-preset-chain-ui-")),
      file = join(root, "entity.sqlite"),
      passwordFile = join(root, "password");
    let browser, service, provider, release;
    const requests = [];
    let held = new Promise((resolve) => {
      release = resolve;
    });
    t.after(async () => {
      release();
      await browser?.close();
      await service?.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const count = requests.length;
      await held;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: "Synthetic preset reply " + count } },
          ],
        }),
      );
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        sendWithEnter: true,
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        customTokenizer: "tik",
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        useStreaming: false,
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic current settings",
        presetChain: "Target",
        presetIds: ["active", "target"],
        botPresetsId: 0,
      },
      resources: [
        {
          kind: "preset",
          id: "active",
          payload: {
            id: "active",
            name: "Active",
            mainPrompt: "Previously saved",
            unknownField: { preserved: true },
          },
        },
        {
          kind: "preset",
          id: "target",
          payload: {
            id: "target",
            name: "Target",
            mainPrompt: "Synthetic target preset",
          },
        },
      ],
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic preset",
        desc: "Synthetic plain definition",
        firstMessage: "",
      },
      chat: {
        chatId: "a",
        metadata: { name: "Synthetic chat", localLore: [] },
      },
    });
    store.applyCommand("prefix", {
      type: "append-message",
      chatId: "a",
      messageId: "prefix",
      message: { role: "char", data: "Stable synthetic prefix" },
    });
    store.close();
    await fs.writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-password").digest("hex"),
    );
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
    browser = await launchChromium(root);
    const errors = [];
    async function open() {
      const page = await browser.page(service.url, await browser.newContext(), {
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
        page.evaluate("!!document.querySelector('input[name=password]')"),
      );
      await page.evaluate(
        "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('textarea.input-text')&&!document.querySelector('textarea.input-text').disabled&&!!document.querySelector('[data-message-id=prefix]')",
        ),
      );
      return page;
    }
    async function send(page) {
      await until(() =>
        page.evaluate("!!document.querySelector('.button-icon-send')"),
      );
      await page.evaluate(
        "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
      );
    }
    let a = await open(),
      b = await open();
    await b.evaluate(
      "window.presetPrefix=document.querySelector('[data-message-id=prefix]');window.presetPrefixBody=window.presetPrefix.querySelector('.chattext')",
    );
    await send(a);
    await until(
      () => requests.length,
      (n) => n === 1,
    );
    assert.match(JSON.stringify(requests[0]), /Synthetic target preset/);
    release();
    await until(
      () => service.runtime.store.call("listJobs", "a"),
      (rows) => rows.length === 1 && rows[0].state === "completed",
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "document.body.textContent.includes('Synthetic preset reply 1')",
        ),
      );
    assert.equal(
      await b.evaluate(
        "window.presetPrefix===document.querySelector('[data-message-id=prefix]')&&window.presetPrefixBody===window.presetPrefix.querySelector('.chattext')&&window.presetPrefix.isConnected",
      ),
      true,
    );
    let settings = await service.runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    assert.equal(settings.payload.botPresetsId, 1);
    assert.equal(settings.payload.mainPrompt, "Synthetic target preset");
    const active = await service.runtime.store.call(
      "getResource",
      "preset",
      "active",
    );
    assert.equal(active.payload.id, "active");
    assert.equal(active.payload.mainPrompt, "Synthetic current settings");
    assert.deepEqual(active.payload.unknownField, { preserved: true });
    held = new Promise((resolve) => {
      release = resolve;
    });
    await send(a);
    await until(
      () => requests.length,
      (n) => n === 2,
    );
    await a.close();
    await b.close();
    release();
    const jobs = await until(
      () => service.runtime.store.call("listJobs", "a"),
      (rows) =>
        rows.length === 2 && rows.every((row) => row.state === "completed"),
    );
    assert.equal(jobs.length, 2);
    assert.equal(requests.length, 2);
    const saved = await service.runtime.store.call("snapshot", "a");
    assert.equal(saved.messages.length, 5);
    assert.equal(saved.messages[0].id, "prefix");
    assert.equal(
      saved.messages.at(-1).message.data,
      "Synthetic preset reply 2",
    );
    a = await open();
    b = await open();
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.body.textContent.includes('Synthetic preset reply 2')",
        ),
      );
      const ids = await page.evaluate(
        "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
      );
      assert.deepEqual(ids, saved.messages.map((row) => row.id).reverse());
    }
    assert.deepEqual(errors, []);
  },
);
