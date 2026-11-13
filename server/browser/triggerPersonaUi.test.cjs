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
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Synthetic trigger persona UI timeout: " + JSON.stringify(value));
}

test(
  "built two-device original trigger fences a replaced selected persona after all tabs close and retains reviewable output",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-trigger-persona-ui-"));
    const file = join(root, "entity.sqlite"),
      passwordFile = join(root, "password");
    let service, browser, provider, release;
    let held = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const requests = [];
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
      const n = requests.length;
      if (held) await gate;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Synthetic persona reply " + n } }],
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
        mainPrompt: "Synthetic settings",
        personaPrompt: "",
        selectedPersona: 1,
        personaIds: ["bound", "selected", "unused"],
      },
      resources: ["bound", "selected", "unused"].map((id) => ({
        kind: "persona",
        id,
        payload: { id, name: id, personaPrompt: "Synthetic " + id + " prompt" },
      })),
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic trigger persona",
        desc: "Synthetic bound user {{user}}",
        firstMessage: "",
        triggerscript: [
          {
            type: "input",
            conditions: [],
            effect: [
              { type: "v2GetPersonaDesc", indent: 0, outputVar: "derived" },
            ],
          },
        ],
      },
      chat: {
        chatId: "a",
        metadata: {
          name: "Synthetic chat",
          localLore: [],
          bindedPersona: "bound",
        },
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
    const call = (...args) => service.runtime.store.call(...args);
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
      "window.personaPrefix=document.querySelector('[data-message-id=prefix]');window.personaBody=window.personaPrefix.querySelector('.chattext')",
    );
    await send(a);
    await until(
      () => call("listJobs", "a"),
      (rows) => rows.length === 1 && rows[0].state === "completed",
    );
    const baseline = await call("snapshot", "a");
    assert.equal(
      baseline.variables.find((row) => row.key === "$derived").value,
      "Synthetic selected prompt",
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Synthetic bound user bound/,
    );
    assert.doesNotMatch(
      JSON.stringify(requests[0].messages),
      /Synthetic selected prompt/,
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "document.body.textContent.includes('Synthetic persona reply 1')",
        ),
      );
    held = true;
    await send(a);
    await until(
      () => requests.length,
      (n) => n === 2,
    );
    const job = (await call("listJobs", "a")).find(
      (row) => row.state === "running",
    );
    assert.ok(job);
    const before = await call("getResource", "persona", "selected");
    async function peer(command) {
      const status = await b.evaluate(
        `(async()=>{const r=await fetch('/api/runtime/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),command:${JSON.stringify(command)}})});return r.status;})()`,
      );
      assert.equal(status, 200);
    }
    await peer({
      type: "delete-library-resource",
      kind: "persona",
      resourceId: "selected",
      expectedRevision: before.revision,
      expectedEpoch: before.entityEpoch,
    });
    await peer({
      type: "put-resource",
      kind: "persona",
      resourceId: "selected",
      expectedRevision: before.revision + 1,
      payload: {
        ...before.payload,
        personaPrompt: "Synthetic replacement prompt",
      },
    });
    assert.equal(
      await b.evaluate(
        "window.personaPrefix===document.querySelector('[data-message-id=prefix]')&&window.personaBody===window.personaPrefix.querySelector('.chattext')&&window.personaPrefix.isConnected",
      ),
      true,
    );
    await a.close();
    await b.close();
    release();
    const failed = await until(
      () => call("getJob", job.id),
      (row) => ["failed", "completed"].includes(row.state),
    );
    assert.equal(failed.state, "failed");
    assert.equal(failed.result.code, "REVISION_CONFLICT");
    const saved = await call("snapshot", "a");
    assert.deepEqual(saved.messages, baseline.messages);
    assert.deepEqual(saved.variables, baseline.variables);
    assert.ok(
      failed.result.uncommitted.writeSet.resourceReads.some(
        (read) =>
          read.kind === "persona" &&
          read.id === "selected" &&
          read.expectedEpoch === before.entityEpoch,
      ),
    );
    const preview = await call("previewJobResult", job.id);
    assert.equal(preview.canRecover, false);
    assert.equal(preview.blocked.code, "REVISION_CONFLICT");
    assert.ok(
      preview.messages.some(
        (message) => message.data === "Synthetic persona reply 2",
      ),
    );
    a = await open();
    b = await open();
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          `!!document.querySelector('[data-runtime-result="${job.id}"]')`,
        ),
      );
      const ids = await page.evaluate(
        "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
      );
      assert.deepEqual(ids, baseline.messages.map((row) => row.id).reverse());
      await page.evaluate(
        `document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result="${job.id}"]').click()`,
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-result-review]')",
        ),
      );
      assert.equal(
        await page.evaluate(
          "Array.from(document.querySelectorAll('[data-runtime-result-review] textarea')).some(el=>el.value==='Synthetic persona reply 2')",
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-recover]')",
        ),
        false,
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-runtime-result-review]').textContent.includes('REVISION_CONFLICT')",
        ),
        true,
      );
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
    console.log(
      "trigger-persona-ui-observation:",
      JSON.stringify({
        providerCalls: requests.length,
        allTabsClosed: true,
        beforeMessages: baseline.messages.length,
        afterMessages: saved.messages.length,
        state: failed.state,
        code: failed.result.code,
        selectedEpoch: before.entityEpoch,
        twoDeviceReview: true,
        prefixRetainedDuringPeerChange: true,
      }),
    );
  },
);
