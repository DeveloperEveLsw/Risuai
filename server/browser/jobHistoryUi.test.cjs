"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  let value;
  const deadline = Date.now() + 30000;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Job history UI condition timed out: " + JSON.stringify(value));
}
async function click(page, selector) {
  await until(() =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled})()`,
    ),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
const rows = (page) =>
  page.evaluate(
    "[...document.querySelectorAll('[data-runtime-history-job]')].map(e=>e.dataset.runtimeHistoryJob)",
  );
async function ready(page) {
  await until(() =>
    page.evaluate(
      "!!document.querySelector('[data-runtime-history-refresh]')&&!document.querySelector('[data-runtime-job-history] [role=status]')",
    ),
  );
}
async function oldest(page) {
  await ready(page);
  let pages = 1;
  while (
    await page.evaluate(
      "!document.querySelector('[data-runtime-history-older]').disabled",
    )
  ) {
    await click(page, "[data-runtime-history-older]");
    await ready(page);
    assert.ok((await rows(page)).length <= 20);
    assert.ok(++pages < 20);
  }
  return pages;
}
test(
  "desktop and mobile original UI reopen an old paid summary, apply once, survive reload and discard late foreign-view responses",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "risu-history-ui-")),
      file = join(dir, "synthetic.sqlite"),
      origins = [],
      requests = [],
      exceptions = [],
      historyRequests = [],
      bodyReads = [];
    let runtime,
      frontend,
      browser,
      provider,
      stage = "setup";
    t.after(async () => {
      console.log(JSON.stringify({ stageAtTeardown: stage, exceptions }));
      await browser?.close();
      await frontend?.close();
      await runtime?.close();
      if (provider)
        await new Promise((r) => {
          provider.close(r);
          provider.closeAllConnections();
        });
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: "Authored historical paid summary" } },
          ],
        }),
      );
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    const options = {
      file,
      initialize: true,
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    };
    runtime = await createRuntimeService(options);
    const settings = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        didFirstSetup: true,
        language: "ko",
        betaMobileGUI: false,
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        customProxyRequestModel: "synthetic",
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        customTokenizer: "tik",
        useStreaming: false,
        hypaV3: true,
        hypaV3PresetId: 0,
        hypaV3Presets: [
          {
            name: "Synthetic",
            settings: {
              ...settings.payload.hypaV3Presets[0].settings,
              processRegexScript: false,
            },
          },
        ],
      },
    });
    await runtime.store.call("applyCommand", "c", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic history",
        firstMessage: "Authored greeting",
      },
      chat: {
        chatId: "a",
        metadata: {
          name: "A",
          hypaV3Data: {
            summaries: [
              { text: "Original summary", chatMemos: [], isImportant: false },
            ],
          },
        },
      },
    });
    await runtime.store.call("applyCommand", "b", {
      type: "create-chat",
      chatId: "b",
      characterId: "c",
      metadata: { name: "B" },
    });
    for (let i = 0; i < 155; i++)
      await runtime.store.call("applyCommand", "message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m" + i,
        message: {
          role: i % 2 ? "char" : "user",
          data: "Authored catalog history " + i,
        },
      });
    const field = (
      await runtime.store.call("readFields", [
        { scope: "chat", entityId: "a", key: "hypaV3Data" },
      ])
    ).fields[0];
    await runtime.store.call("enqueueJob", "paid-memory", {
      type: "memory-summary",
      chatId: "a",
      expectedChatEpoch: field.entityEpoch,
      expectedMemoryRevision: field.revision,
      mode: "single",
      indices: [0],
    });
    runtime.scheduler.kick();
    const completed = await until(
      () => runtime.store.call("getJob", "paid-memory"),
      (job) => !["queued", "running"].includes(job.state),
    );
    assert.equal(
      completed.state,
      "completed",
      JSON.stringify(completed.result),
    );
    assert.equal(requests.length, 1);
    await runtime.close();
    const seed = new EntityStore(file);
    for (let i = 0; i < 136; i++) {
      seed.enqueueJob("history-" + i, {
        type: "send",
        chatId: "a",
        text: "Authored history marker",
      });
      seed.db
        .prepare("UPDATE jobs SET state=?,type=?,result=? WHERE id=?")
        .run(
          i % 9 ? "completed" : "failed",
          i % 2 ? "send" : "memory-summary",
          '{"error":{"code":"SYNTHETIC","message":"Authored old failure"}}',
          "history-" + i,
        );
    }
    assert.ok(!seed.listJobs("a").some((job) => job.id === "paid-memory"));
    seed.close();
    runtime = await createRuntimeService(options);
    const vite = await import("vite");
    frontend = await vite.createServer({
      root: resolve(__dirname, "../.."),
      configFile: resolve(__dirname, "../../vite.config.ts"),
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(dir);
    const pages = [];
    for (let i = 0; i < 2; i++) {
      stage = "open-context-" + i;
      const page = await browser.page(
        "about:blank",
        await browser.newContext(),
        {
          viewport: { width: i ? 390 : 1440, height: i ? 844 : 900 },
          blockHttps: true,
        },
      );
      pages.push(page);
      if (i) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });
        await page.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
      }
      page.on("Runtime.exceptionThrown", (e) =>
        exceptions.push(
          e.exceptionDetails.exception?.description ?? e.exceptionDetails.text,
        ),
      );
      await page.send("Network.enable");
      page.on("Network.requestWillBeSent", (e) => {
        if (e.request.url.includes("/job-history?"))
          historyRequests.push(e.request.url);
        if (/\/jobs\/[^/]+\/(memory-summary|result)$/.test(e.request.url))
          bodyReads.push(e.request.url);
      });
      await page.send("Page.navigate", { url });
      await until(() =>
        page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      await page.evaluate(ui("r().selectCharacter('c','a')"));
      await until(() => page.evaluate(ui("s.scopeReady")));
    }
    const [desktop, mobile] = pages;
    stage = "desktop-pagination";
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    assert.equal((await rows(desktop)).length, 20);
    assert.equal(bodyReads.length, 0);
    const first = await rows(desktop);
    await click(desktop, "[data-runtime-history-older]");
    await ready(desktop);
    await click(desktop, "[data-runtime-history-newer]");
    await ready(desktop);
    assert.deepEqual(await rows(desktop), first);
    assert.equal(await oldest(desktop), 7);
    assert.ok((await rows(desktop)).includes("paid-memory"));
    await click(desktop, "[data-runtime-history-refresh]");
    await ready(desktop);
    await desktop.evaluate(
      "(()=>{const e=document.querySelector('[data-runtime-history-filter]');e.value='memory';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await ready(desktop);
    assert.equal(await oldest(desktop), 4);
    assert.ok((await rows(desktop)).includes("paid-memory"));
    assert.equal(bodyReads.length, 0);
    await desktop.evaluate(ui("r().loadEarlier()"));
    const windowBeforeReview = await desktop.evaluate(
      ui("s.messages.map(m=>m.chatId)"),
    );
    const liveJobsBeforeReview = await desktop.evaluate(
      ui("s.jobs.map(job=>job.id)"),
    );
    stage = "open-old-paid-result";
    await click(desktop, '[data-runtime-history-open="paid-memory"]');
    await until(() =>
      desktop.evaluate(
        "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Authored historical paid summary'",
      ),
    );
    assert.deepEqual(
      await desktop.evaluate(ui("s.messages.map(m=>m.chatId)")),
      windowBeforeReview,
    );
    assert.deepEqual(
      await desktop.evaluate(ui("s.jobs.map(job=>job.id)")),
      liveJobsBeforeReview,
    );
    await click(desktop, "[data-runtime-memory-summary-apply]");
    await until(
      () => runtime.store.call("snapshot", "a"),
      (snapshot) =>
        snapshot.chat.metadata.hypaV3Data.summaries[0].text ===
        "Authored historical paid summary",
    );
    await click(desktop, "[data-runtime-memory-summary-close]");
    stage = "peer-mobile-result";
    await click(mobile, "[data-runtime-history-show]");
    await ready(mobile);
    assert.equal(
      await mobile.evaluate(
        "(()=>{const e=document.querySelector('[data-runtime-history-close]'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()",
      ),
      true,
    );

    assert.equal(await oldest(mobile), 7);
    await click(mobile, '[data-runtime-history-open="paid-memory"]');
    await until(() =>
      mobile.evaluate(
        "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Authored historical paid summary'&&document.querySelector('[data-runtime-memory-summary-apply]').disabled",
      ),
    );
    await click(mobile, "[data-runtime-memory-summary-close]");
    assert.equal(requests.length, 1);
    stage = "reload";
    await desktop.send("Page.reload");
    await until(() =>
      desktop.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    await desktop.evaluate(ui("r().selectCharacter('c','a')"));
    await until(() => desktop.evaluate(ui("s.scopeReady")));
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    assert.equal(await oldest(desktop), 7);
    await click(desktop, '[data-runtime-history-open="paid-memory"]');
    await until(() =>
      desktop.evaluate(
        "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Authored historical paid summary'",
      ),
    );
    await click(desktop, "[data-runtime-memory-summary-close]");
    // Hold an actual response after fetch has completed so abort alone cannot hide
    // a missing view guard. Navigate a -> b -> a while it is delayed.
    stage = "navigation-aba";
    await desktop.evaluate(
      ui(
        `(()=>{const bridge=r(),original=bridge.readJobHistory.bind(bridge);window.historyFetchStarted=false;bridge.readJobHistory=async(...args)=>{const response=await original(...args);bridge.readJobHistory=original;window.historyFetchStarted=true;await new Promise(resolve=>window.releaseHistoryFetch=resolve);return response;};})()`,
      ),
    );
    await click(desktop, "[data-runtime-history-show]");
    await until(() => desktop.evaluate("window.historyFetchStarted"));
    await desktop.evaluate(ui("r().selectCharacter('c','b')"));
    await desktop.evaluate(ui("r().selectCharacter('c','a')"));
    await desktop.evaluate("window.releaseHistoryFetch()");
    await until(() =>
      desktop.evaluate("!document.querySelector('[data-runtime-job-history]')"),
    );
    stage = "closed-view-late-response";
    await desktop.evaluate(
      ui(
        `(()=>{const bridge=r(),original=bridge.readJobHistory.bind(bridge);window.historyFetchStarted=false;bridge.readJobHistory=async(...args)=>{const response=await original(...args);bridge.readJobHistory=original;window.historyFetchStarted=true;await new Promise(resolve=>window.releaseHistoryFetch=resolve);return response;};})()`,
      ),
    );
    await click(desktop, "[data-runtime-history-show]");
    await until(() => desktop.evaluate("window.historyFetchStarted"));
    await click(desktop, "[data-runtime-history-close]");
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    const reopenedRows = await rows(desktop);
    await desktop.evaluate("window.releaseHistoryFetch()");
    await delay(100);
    assert.deepEqual(await rows(desktop), reopenedRows);
    await click(desktop, "[data-runtime-history-close]");
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    await desktop.evaluate(
      "(()=>{const e=document.querySelector('[data-runtime-history-filter]');e.value='failed';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await ready(desktop);
    assert.ok((await rows(desktop)).includes("history-9"));
    stage = "closed-detail-late-response";
    await desktop.evaluate(
      ui(
        `(()=>{const bridge=r(),original=bridge.observeJob.bind(bridge);window.historyDetailStarted=false;bridge.observeJob=async(...args)=>{const response=await original(...args);bridge.observeJob=original;window.historyDetailStarted=true;await new Promise(resolve=>window.releaseHistoryDetail=resolve);return response;};})()`,
      ),
    );
    await click(desktop, '[data-runtime-history-open="history-9"]');
    await until(() => desktop.evaluate("window.historyDetailStarted"));
    await click(desktop, "[data-runtime-history-close]");
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    await oldest(desktop);
    await click(desktop, '[data-runtime-history-open="paid-memory"]');
    await until(() =>
      desktop.evaluate(
        "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Authored historical paid summary'",
      ),
    );
    await desktop.evaluate("window.releaseHistoryDetail()");
    await delay(100);
    assert.equal(
      await desktop.evaluate(ui("s.historyResultJob?.id")),
      "paid-memory",
    );
    await click(desktop, "[data-runtime-memory-summary-close]");
    assert.equal(await desktop.evaluate(ui("s.historyResultJob")), null);
    await click(desktop, "[data-runtime-history-show]");
    await ready(desktop);
    await desktop.evaluate(
      "(()=>{const e=document.querySelector('[data-runtime-history-filter]');e.value='failed';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await ready(desktop);
    const errorBeforeReview = await desktop.evaluate(ui("s.error"));
    await click(desktop, '[data-runtime-history-open="history-9"]');
    await until(() =>
      desktop.evaluate(
        "document.body.textContent.includes('RESULT_NOT_RECOVERABLE')",
      ),
    );
    assert.equal(requests.length, 1);
    assert.equal(await desktop.evaluate(ui("s.error")), errorBeforeReview);
    assert.deepEqual(exceptions, []);
    assert.ok(historyRequests.length > 20);
    assert.ok(historyRequests.every((path) => path.includes("limit=20")));
    console.log(
      JSON.stringify({
        authoredHistoricalJobs: 137,
        pageSize: 20,
        desktopAndMobile: true,
        contexts: 2,
        loopbackProviderCalls: requests.length,
        historyReads: historyRequests.length,
        onDemandBodyReads: bodyReads.length,
        lateNavigationAbaIgnored: true,
        lateDetailAfterCloseIgnored: true,
        reloadVerified: true,
        privateData: false,
      }),
    );
  },
);
