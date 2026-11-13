"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
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
  throw Error("Synthetic choice UI timeout: " + JSON.stringify(value));
}

test(
  "built original response arrows synchronize cached choices and admit one fallback across lost receipts and all-tab exit",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-choice-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
    let service, browser, provider;
    let releaseProvider,
      releaseReceipts,
      releaseHeaders,
      releaseEarlyHeaders,
      releaseEarlyReceipt;
    const providerHeld = new Promise((resolve) => (releaseProvider = resolve)),
      receiptsHeld = new Promise((resolve) => (releaseReceipts = resolve)),
      headersHeld = new Promise((resolve) => (releaseHeaders = resolve));
    const earlyHeadersHeld = new Promise(
        (resolve) => (releaseEarlyHeaders = resolve),
      ),
      earlyReceiptHeld = new Promise(
        (resolve) => (releaseEarlyReceipt = resolve),
      );
    t.after(async () => {
      releaseProvider();
      releaseReceipts();
      releaseHeaders();
      releaseEarlyHeaders();
      releaseEarlyReceipt();
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
    let providerCalls = 0,
      seedCalls = 0;
    provider = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      providerCalls++;
      res.setHeader("content-type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "raw-fallback" } }],
          }) +
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
        aiModel: "gpt4o",
        genTime: 3,
        openAIKey: "synthetic-key",
        mainPrompt: "Synthetic",
        maxContext: 8000,
        maxResponse: 100,
        useStreaming: false,
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
              in: "raw-",
              out: "processed-",
              comment: "Synthetic regex",
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
    store.enqueueJob("seed", {
      type: "send",
      chatId: "a",
      messageId: "input",
      input: "Synthetic",
    });
    const claimed = store.claimJob("seed-worker");
    const { executeExtensionJob } = await import(
      pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href
    );
    const execution = await executeExtensionJob(claimed, {
      appVer: "2026.8.250",
      fetch: async (path) =>
        new Response(
          await fs.readFile(join(__dirname, "../../public", path.slice(1))),
        ),
      providerFetch: async (url, init) => {
        seedCalls++;
        assert.equal(JSON.parse(init.body).n, 3);
        return Response.json({
          choices: ["zero", "one", "two"].map((text) => ({
            message: { content: "raw-" + text },
          })),
        });
      },
    });
    store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
      state: "completed",
      ...execution,
    });
    const seeded = store.snapshot("a"),
      reply = seeded.messages.at(-1);
    assert.equal(reply.message.data, "processed-zero");
    assert.equal(seeded.variables.find((v) => v.key === "$seen").value, "1");
    const settings = store.getResource("settings", "global");
    store.applyCommand("local-provider", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        aiModel: "reverse_proxy",
        genTime: 1,
        customProxyRequestModel: "synthetic-model",
        customTokenizer: "tik",
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        useStreaming: true,
      },
    });
    const statisticsBefore = store.getResource("settings", "global").payload
      .statics;
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
    const original = service.runtime.store.call.bind(service.runtime.store),
      observed = [];
    let holdHeaders = false,
      headerCount = 0,
      holdReceipts = false,
      receiptCount = 0;
    let holdEarlyHeaders = false,
      holdEarlyReceipt = false,
      earlyHeaderCount = 0;
    service.runtime.store.call = async (method, ...args) => {
      if (method === "readReplyChoices" && holdEarlyHeaders) {
        const value = await original(method, ...args);
        earlyHeaderCount++;
        await earlyHeadersHeld;
        return value;
      }
      if (method === "readReplyChoices" && holdHeaders) {
        const value = await original(method, ...args);
        headerCount++;
        await headersHeld;
        return value;
      }
      if (method === "applyCommand" && args[1]?.type === "move-reply-choice") {
        observed.push({ id: args[0], command: structuredClone(args[1]) });
        try {
          const value = await original(method, ...args);
          if (holdEarlyReceipt) await earlyReceiptHeld;
          if (holdReceipts) {
            receiptCount++;
            await receiptsHeld;
          }
          return value;
        } catch (error) {
          if (holdReceipts) {
            receiptCount++;
            await receiptsHeld;
          }
          throw error;
        }
      }
      return original(method, ...args);
    };
    browser = await launchChromium(root);
    const ca = await browser.newContext(),
      cb = await browser.newContext(),
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
      )
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
      return page;
    }
    let a = await open(ca),
      b = await open(cb);
    const has = (text) =>
      `Array.from(document.querySelectorAll('[data-message-id] .chattext')).some(el=>el.textContent.includes(${JSON.stringify(text)}))`;
    async function shown(text) {
      for (const page of [a, b]) await until(() => page.evaluate(has(text)));
    }
    const arrow = (page, direction) =>
      page.evaluate(
        `Array.from(document.querySelectorAll('[data-message-id] .button-icon-${direction === "next" ? "reroll" : "unreroll"}')).at(-1).click()`,
      );
    await shown("processed-zero");
    for (const page of [a, b])
      await page.evaluate(
        `window.choiceRow=document.querySelector('[data-message-id="${reply.id}"]')`,
      );
    holdEarlyHeaders = true;
    holdEarlyReceipt = true;
    const firstFeedback = await a.evaluate(`(async()=>{
      const button=Array.from(document.querySelectorAll('[data-message-id] .button-icon-reroll')).at(-1);
      const start=performance.now();
      for(let i=0;i<10;i++)button.click();
      await new Promise(requestAnimationFrame);
      const status=document.querySelector('[data-runtime-reply-phase]');
      return {elapsedMs:performance.now()-start,disabled:button.disabled,phase:status?.dataset.runtimeReplyPhase,
        text:status?.textContent,visible:!!status&&status.getBoundingClientRect().height>0&&getComputedStyle(status).visibility!=='hidden',oldBodyRetained:Array.from(document.querySelectorAll('.chattext')).some(el=>el.textContent.includes('processed-zero'))};
    })()`);
    assert.equal(firstFeedback.disabled, true);
    assert.equal(firstFeedback.phase, "preparing");
    assert.equal(firstFeedback.visible, true);
    assert.equal(firstFeedback.oldBodyRetained, true);
    assert.ok(firstFeedback.elapsedMs < 250, JSON.stringify(firstFeedback));
    await until(() => earlyHeaderCount === 1);
    assert.equal(observed.length, 0);
    await a.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await until(() =>
      a.evaluate(
        "!document.querySelector('[data-runtime-reply-phase]')&&!document.querySelector('[data-message-id]')",
      ),
    );
    assert.equal(earlyHeaderCount, 1);
    await a.evaluate("document.querySelector('[data-character-id=c]').click()");
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-reply-phase]')?.dataset.runtimeReplyPhase==='preparing'",
      ),
    );
    for (const page of [a, b])
      await page.evaluate(
        `window.choiceRow=document.querySelector('[data-message-id="${reply.id}"]')`,
      );
    holdEarlyHeaders = false;
    releaseEarlyHeaders();
    await shown("processed-one");
    await until(() => observed.length === 1);
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-reply-phase]')?.dataset.runtimeReplyPhase==='pending'",
      ),
    );
    assert.equal(
      await a.evaluate(
        "Array.from(document.querySelectorAll('.button-icon-reroll,.button-icon-unreroll')).every(el=>el.disabled)",
      ),
      true,
    );
    await a.evaluate(
      "for(let i=0;i<10;i++)Array.from(document.querySelectorAll('.button-icon-reroll')).at(-1).click()",
    );
    assert.equal(observed.length, 1);
    assert.equal(earlyHeaderCount, 1);
    holdEarlyReceipt = false;
    releaseEarlyReceipt();
    await until(() =>
      a.evaluate(
        "!document.querySelector('[data-runtime-reply-phase]')&&Array.from(document.querySelectorAll('.button-icon-reroll')).every(el=>!el.disabled)",
      ),
    );
    t.diagnostic(
      "reply-selection-feedback: " +
        JSON.stringify({
          ...firstFeedback,
          attemptedClicks: 20,
          admittedCommands: 1,
          earlyHeaders: earlyHeaderCount,
          navigationRestoresPending: true,
        }),
    );
    await arrow(b, "previous");
    await shown("processed-zero");
    await arrow(a, "next");
    await shown("processed-one");
    for (const page of [a, b])
      assert.equal(
        await page.evaluate(
          `window.choiceRow===document.querySelector('[data-message-id="${reply.id}"]')&&window.choiceRow.isConnected`,
        ),
        true,
      );
    assert.equal(providerCalls, 0);
    const beforeReload = await original("snapshot", "a");
    assert.deepEqual(beforeReload.variables, seeded.variables);
    assert.deepEqual(beforeReload.chat.metadata, seeded.chat.metadata);
    assert.deepEqual(
      (await original("getResource", "settings", "global")).payload.statics,
      statisticsBefore,
    );
    await b.close();
    b = await open(cb);
    await shown("processed-one");
    await arrow(b, "next");
    await shown("processed-two");
    const current = await original("snapshot", "a");
    assert.equal(current.messages.at(-1).id, reply.id);
    assert.deepEqual(current.messages.at(-1).message, {
      ...reply.message,
      data: "processed-two",
    });
    const pending =
      "(async()=>{const out=[];for(const name of (await indexedDB.databases()).filter(x=>x.name.startsWith('risu-runtime-outbox:'))){const db=await new Promise(ok=>{const r=indexedDB.open(name.name);r.onsuccess=()=>ok(r.result)});const rows=await new Promise(ok=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>ok(r.result)});out.push(...rows.map(x=>({id:x.requestId,type:x.command.type,state:x.state})));db.close();}return out;})()";
    // Visible text can precede receipt projection and release of the local click guard.
    for (const page of [a, b])
      await until(
        () => page.evaluate(pending),
        (rows) => rows.every((x) => x.type !== "move-reply-choice"),
      );
    const offset = observed.length;
    holdHeaders = true;
    holdReceipts = true;
    await Promise.all([arrow(a, "next"), arrow(b, "next")]);
    await until(
      () => headerCount,
      (n) => n === 2,
    );
    holdHeaders = false;
    releaseHeaders();
    await until(() => receiptCount === 2);
    await until(() => providerCalls === 1);
    const parents = structuredClone(observed.slice(offset));
    assert.equal(parents.length, 2);
    assert.deepEqual(parents[0].command, parents[1].command);
    const jobs = await original("listJobs", "a");
    assert.equal(jobs.length, 2);
    const child = jobs.find((job) => job.id !== "seed").id;
    for (const page of [a, b])
      assert.equal(
        (await page.evaluate(pending)).filter(
          (x) => x.type === "move-reply-choice" && x.state === "pending",
        ).length,
        1,
      );
    await a.close();
    await b.close();
    releaseProvider();
    const complete = await until(
      () => original("getJob", child),
      (job) => ["completed", "failed", "interrupted"].includes(job?.state),
    );
    assert.equal(complete.state, "completed", JSON.stringify(complete.result));
    const saved = await original("snapshot", "a");
    assert.equal(saved.messages.length, 2);
    assert.notEqual(saved.messages.at(-1).id, reply.id);
    assert.equal(saved.messages.at(-1).message.data, "processed-fallback");
    assert.equal(saved.variables.find((v) => v.key === "$seen").value, "2");
    assert.equal((await original("snapshot", "b")).messages.length, 0);
    a = await open(ca);
    b = await open(cb);
    await shown("processed-fallback");
    await until(() =>
      parents.every(
        (parent) => observed.filter((x) => x.id === parent.id).length >= 2,
      ),
    );
    for (const page of [a, b])
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-reply-phase]')&&Array.from(document.querySelectorAll('.button-icon-reroll,.button-icon-unreroll')).every(el=>el.disabled)",
        ),
        true,
      );
    holdReceipts = false;
    releaseReceipts();
    for (const parent of parents)
      for (const repeat of observed.filter((x) => x.id === parent.id))
        assert.deepEqual(repeat.command, parent.command);
    for (const page of [a, b])
      await until(
        () => page.evaluate(pending),
        (rows) => rows.every((x) => x.state !== "pending"),
      );
    const states = [
      ...(await a.evaluate(pending)),
      ...(await b.evaluate(pending)),
    ];
    assert.equal(
      states.filter(
        (x) => x.type === "move-reply-choice" && x.state === "blocked",
      ).length,
      1,
    );
    // A rejected peer command intentionally holds later intents for its chat.
    // Resolve that visible conflict through the actual status UI before browsing.
    for (const page of [a, b]) {
      if ((await page.evaluate(pending)).some((x) => x.state === "blocked")) {
        await until(() =>
          page.evaluate(
            "document.querySelector('[data-runtime-reply-phase]')?.dataset.runtimeReplyPhase==='blocked'&&!!document.querySelector('[data-runtime-reply-discard]')",
          ),
        );
        await page.evaluate(
          "document.querySelector('[data-runtime-reply-discard]').click()",
        );
        await until(
          () => page.evaluate(pending),
          (rows) => rows.length === 0,
        );
      }
    }
    assert.equal(providerCalls, 1);
    assert.equal(seedCalls, 1);
    assert.equal((await original("listJobs", "a")).length, 2);
    const settle = async () => {
      for (const page of [a, b])
        await until(
          () => page.evaluate(pending),
          (rows) => rows.every((x) => x.state !== "pending"),
        );
    };
    const prefix = saved.messages[0].id;
    for (const page of [a, b])
      await page.evaluate(
        `window.batchPrefix=document.querySelector('[data-message-id="${prefix}"]')`,
      );
    // The streaming fallback has no preceding provider candidate. Previous
    // restores the immutable manual snapshot, including the original metadata.
    await arrow(a, "previous");
    await shown("processed-zero");
    await settle();
    const manual = await original("snapshot", "a");
    assert.deepEqual(
      manual.messages.map((row) => row.message),
      seeded.messages.map((row) => row.message),
    );
    assert.deepEqual(manual.variables, saved.variables);
    assert.equal(manual.messages.at(-1).revision > reply.revision, true);
    // The first next now misses A's exhausted provider cache and selects B.
    await arrow(b, "next");
    await shown("processed-fallback");
    await settle();
    assert.deepEqual(
      (await original("snapshot", "a")).messages.map((row) => row.message),
      saved.messages.map((row) => row.message),
    );
    for (const page of [a, b])
      assert.equal(
        await page.evaluate(
          `window.batchPrefix===document.querySelector('[data-message-id="${prefix}"]')&&window.batchPrefix.isConnected`,
        ),
        true,
      );
    await a.close();
    a = await open(ca);
    await shown("processed-fallback");
    await arrow(a, "previous");
    await shown("processed-zero");
    await settle();
    assert.equal(providerCalls, 1);
    assert.equal(seedCalls, 1);
    assert.equal((await original("listJobs", "a")).length, 2);
    assert.deepEqual(
      (await original("snapshot", "a")).variables,
      saved.variables,
    );
    assert.deepEqual(errors, []);
  },
);
