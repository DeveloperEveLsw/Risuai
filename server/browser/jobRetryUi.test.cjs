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
  throw Error("Synthetic retry UI timeout: " + JSON.stringify(value));
}

test(
  "built authenticated retry admits one native child across two devices, lost receipts and all-tab exit",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-retry-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
    let service, browser, provider, releaseProvider, releaseReceipt;
    const providerHeld = new Promise((resolve) => (releaseProvider = resolve)),
      receiptHeld = new Promise((resolve) => (releaseReceipt = resolve));
    t.after(async () => {
      releaseProvider();
      releaseReceipt();
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
    const calls = [];
    provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push(JSON.parse(body));
      res.setHeader("content-type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({ choices: [{ delta: { content: "raw-retry" } }] }) +
          "\n\n",
      );
      await providerHeld;
      res.end("data: [DONE]\n\n");
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
        mainPrompt: "Synthetic context {{getvar::context}}",
        maxContext: 8000,
        maxResponse: 100,
      },
      resources: [],
    });
    for (const id of ["c", "other"])
      store.applyCommand(id, {
        type: "create-character",
        characterId: id,
        definition: {
          type: "character",
          name: "Synthetic " + id,
          desc: "Synthetic",
          firstMessage: "",
          customscript: [
            {
              type: "editoutput",
              in: "raw-retry",
              out: "processed-retry",
              comment: "Synthetic original output regex",
            },
          ],
          triggerscript: [
            {
              type: "output",
              conditions: [],
              effect: [
                { type: "setvar", var: "seen", operator: "+=", value: "1" },
              ],
            },
          ],
        },
        chat: {
          chatId: id === "c" ? "a" : "b",
          metadata: { name: "Synthetic", localLore: [] },
        },
      });
    store.enqueueJob("source", {
      type: "send",
      chatId: "a",
      input: "Synthetic original input",
      messageId: "original-input",
      expectedChatEpoch: 0,
    });
    const source = store.claimJob("old-worker").job;
    store.writeJobProgress(source.id, "old-worker", source.fence, {
      messages: [
        {
          role: "char",
          chatId: "partial",
          data: "Synthetic partial original output",
        },
      ],
    });
    store.interruptJob(
      source.id,
      "old-worker",
      source.fence,
      "Synthetic interrupted original request",
    );
    store.applyCommand("context-fresh", {
      type: "set-chat-variable",
      chatId: "a",
      key: "$context",
      value: "fresh-context",
    });
    const originalSource = store.getJob("source");
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
    const observed = [];
    let hold = true,
      held = 0;
    const original = service.runtime.store.call.bind(service.runtime.store);
    service.runtime.store.call = async (method, ...args) => {
      if (method === "applyCommand" && args[1]?.type === "retry-job-result") {
        observed.push({
          requestId: args[0],
          command: structuredClone(args[1]),
        });
        const result = await original(method, ...args);
        if (hold) {
          held++;
          await receiptHeld;
        }
        return result;
      }
      return original(method, ...args);
    };
    browser = await launchChromium(root);
    const errors = [];
    const ca = await browser.newContext(),
      cb = await browser.newContext();
    async function open(context, review = true) {
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
      if (review) {
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-result=source]')",
          ),
        );
        await page.evaluate(
          "document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=source]').click()",
        );
        await until(() =>
          page.evaluate("!!document.querySelector('[data-runtime-retry]')"),
        );
        assert.equal(
          await page.evaluate(
            "document.querySelector('#runtime-retry-input').value",
          ),
          "Synthetic original input",
        );
      }
      return page;
    }
    let a = await open(ca),
      b = await open(cb);
    await b.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await Promise.all([
      a.evaluate("document.querySelector('[data-runtime-retry]').click()"),
      b.evaluate("document.querySelector('[data-runtime-retry]').click()"),
    ]);
    await until(() => held === 2);
    await until(() => calls.length === 1);
    const disposition = (await original("getJobStatus", "source")).disposition;
    assert.equal(disposition.action, "retry");
    const child = disposition.resultJobId;
    assert.equal((await original("listJobs", "a")).length, 2);
    assert.equal((await original("listJobs", "b")).length, 0);
    assert.equal((await original("snapshot", "a")).messages.length, 0);
    assert.ok(JSON.stringify(calls[0]).includes("fresh-context"));
    assert.ok(JSON.stringify(calls[0]).includes("Synthetic original input"));
    assert.equal(
      JSON.stringify(calls[0]).includes("Synthetic partial original output"),
      false,
    );
    const requestsBeforeClose = structuredClone(observed);
    const pendingEntries =
      "(async()=>{const names=(await indexedDB.databases()).filter(x=>x.name.startsWith('risu-runtime-outbox:'));const values=[];for(const item of names){const db=await new Promise((ok,no)=>{const r=indexedDB.open(item.name);r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});const rows=await new Promise((ok,no)=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});values.push(...rows.map(x=>({id:x.requestId,state:x.state,type:x.command.type})));db.close();}return values;})()";
    for (const page of [a, b])
      assert.equal(
        (await page.evaluate(pendingEntries)).filter(
          (x) => x.type === "retry-job-result" && x.state === "pending",
        ).length,
        1,
      );
    await a.close();
    await b.close();
    releaseProvider();
    await until(
      () => original("getJob", child),
      (job) => ["completed", "failed", "interrupted"].includes(job?.state),
    );
    assert.equal((await original("getJob", child)).state, "completed");
    const saved = await original("snapshot", "a");
    assert.equal(saved.messages.length, 2);
    assert.notEqual(saved.messages[0].id, "original-input");
    assert.equal(saved.messages[1].message.data, "processed-retry");
    assert.equal(saved.variables.find((v) => v.key === "$seen").value, "1");
    assert.deepEqual(await original("getJob", "source"), originalSource);
    a = await open(ca, false);
    b = await open(cb, false);
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "Array.from(document.querySelectorAll('[data-message-id] .chattext')).some(el=>el.textContent.includes('processed-retry'))",
        ),
      );
    await until(
      async () => ({
        count: observed.length,
        left: await a.evaluate(pendingEntries),
        right: await b.evaluate(pendingEntries),
      }),
      (value) => value.count >= 4,
    );
    hold = false;
    releaseReceipt();
    for (const before of requestsBeforeClose) {
      const repeats = observed.filter((x) => x.requestId === before.requestId);
      assert.ok(repeats.length >= 2);
      for (const repeat of repeats)
        assert.deepEqual(repeat.command, before.command);
    }
    assert.equal(calls.length, 1);
    assert.equal((await original("snapshot", "a")).messages.length, 2);
    assert.deepEqual(errors, []);
  },
);
