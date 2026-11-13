"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("V3 modal condition timed out: " + JSON.stringify(value));
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function click(p, selector) {
  await until(() =>
    p.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled})()`,
    ),
  );
  await p.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
}
async function write(p, selector, value) {
  await until(() =>
    p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await p.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function select(p, characterId = "c", chatId = "chat-c") {
  await p.evaluate(
    `(async()=>{const st=await import('/src/ts/stores.svelte.ts');st.settingsOpen.set(false);const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter(${JSON.stringify(characterId)},${JSON.stringify(chatId)});st.botMakerMode.set(true);st.sideBarStore.set(true);st.MobileSideBar.set(2);st.CharConfigSubMenu.set(2)})()`,
  );
}
async function modal(p) {
  const expression =
    "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='하이파 V3 모달')";
  await until(() => p.evaluate(`!!(${expression})`));
  await p.evaluate(`(${expression}).click()`);
  await until(() =>
    p.evaluate("!!document.querySelector('[data-hypa-v3-modal]')"),
  );
}
async function settled(p) {
  await until(() => p.evaluate(ui("s.pending.length===0")));
}
async function fixture(t, layout) {
  const dir = await mkdtemp(join(tmpdir(), "risu-v3-modal-")),
    origins = [],
    requests = [],
    exceptions = [],
    commands = [],
    sourceReads = [],
    moduleResponses = [];
  let runtime,
    frontend,
    browser,
    provider,
    hold = null;
  const pages = [];
  t.after(async () => {
    hold?.release();
    if (exceptions.length) console.log(JSON.stringify({ exceptions }));
    if (moduleResponses.some((r) => r.status >= 400))
      console.log(JSON.stringify({ moduleResponses }));
    for (const p of pages) {
      const diagnostic = await p
        .evaluate("document.body.textContent.slice(-1400)")
        .catch(() => null);
      if (diagnostic)
        console.log(JSON.stringify({ syntheticUiTeardown: diagnostic }));
    }
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
    const gate = hold;
    if (gate) await gate.promise;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "Synthetic generated memory" } }],
      }),
    );
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const file = join(dir, "synthetic.sqlite");
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
      betaMobileGUI: layout.beta,
      aiModel: "reverse_proxy",
      subModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-memory",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      customTokenizer: "tik",
      useStreaming: false,
      maxContext: 8000,
      maxResponse: 100,
      supaModelType: "subModel",
      hypaV3: true,
      hypav2: false,
      hanuraiEnable: false,
      hypaV3PresetId: 0,
      hypaV3Presets: [
        {
          name: "Synthetic",
          settings: {
            ...settings.payload.hypaV3Presets[0].settings,
            summarizationModel: "subModel",
            summarizationPrompt: "V3_MODAL_SUMMARY",
            processRegexScript: false,
          },
        },
      ],
    },
  });
  const originalMemory = {
    unknown: { keep: true },
    summaries: [
      {
        text: "First summary",
        chatMemos: [null, "m0"],
        isImportant: false,
        tags: ["seed"],
        unknown: { keep: 1 },
      },
      { text: "Second summary", chatMemos: ["m1", "m2"], isImportant: false },
      { text: "Third summary", chatMemos: ["m3"], isImportant: false },
      { text: "Orphan summary", chatMemos: ["missing"], isImportant: false },
    ],
  };
  for (const characterId of ["c", "d"])
    await runtime.store.call("applyCommand", "create-" + characterId, {
      type: "create-character",
      characterId,
      definition: {
        type: "character",
        name: "Synthetic modal " + characterId,
        firstMessage: "Authored greeting",
        supaMemory: true,
      },
      chat: {
        chatId: "chat-" + characterId,
        metadata: {
          name: "Authored V3",
          fmIndex: -1,
          hypaV3Data: originalMemory,
        },
      },
    });
  const v2 = {
    lastMainChunkID: 1,
    mainChunks: [
      { text: "Authored V2", chatMemos: ["m0"], unknown: { keep: true } },
    ],
    chunks: [],
    unknown: { keep: true },
  };
  await runtime.store.call("applyCommand", "c2", {
    type: "create-chat",
    characterId: "c",
    chatId: "chat-c2",
    metadata: { name: "Absent V3", fmIndex: -1, hypaV2Data: v2 },
  });
  for (let i = 0; i < 155; i++)
    await runtime.store.call("applyCommand", "history" + i, {
      type: "append-message",
      chatId: "chat-c",
      messageId: "m" + i,
      message: {
        role: i % 2 ? "char" : "user",
        data: "Authored original " + i,
      },
    });
  const vite = await import("vite");
  frontend = await vite.createServer({
    root: resolve(__dirname, "../.."),
    configFile: resolve(__dirname, "../../vite.config.ts"),
    // A lazy tokenizer must be optimized before the first modal request. Late
    // discovery invalidates already served dev-module URLs with HTTP 504.
    cacheDir: join(dir, "vite-cache"),
    optimizeDeps: { include: ["@dqbd/tiktoken"] },
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
  // Finish optimization of the public module graph before opening test pages;
  // otherwise a late dev-only optimization invalidates their lazy import URLs.
  const client = frontend.environments.client;
  await client.warmupRequest("/src/main.ts");
  await client.warmupRequest("/src/ts/tokenizer.ts");
  await client.waitForRequestsIdle();
  await client.depsOptimizer.scanProcessing;
  await Promise.all(
    Object.values(client.depsOptimizer.metadata.discovered).map(
      (dependency) => dependency.processing,
    ),
  );
  const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
  origins.push(url);
  browser = await launchChromium(dir);
  const contexts = [await browser.newContext(), await browser.newContext()];
  async function open(index) {
    const p = await browser.page("about:blank", contexts[index], {
      viewport: { width: 1440, height: 900 },
      blockHttps: true,
    });
    pages.push(p);
    p.on("Runtime.exceptionThrown", (e) =>
      exceptions.push(
        e.exceptionDetails.exception?.description ?? e.exceptionDetails.text,
      ),
    );
    await p.send("Network.enable");
    p.on("Network.requestWillBeSent", (e) => {
      if (e.request.url.endsWith("/api/runtime/commands") && e.request.postData)
        commands.push(JSON.parse(e.request.postData).command);
      if (e.request.url.endsWith("/memory-source") && e.request.postData)
        sourceReads.push(JSON.parse(e.request.postData));
    });
    p.on("Network.responseReceived", (e) => {
      if (e.response.url.includes("tiktoken"))
        moduleResponses.push({
          url: e.response.url,
          status: e.response.status,
          headers: e.response.headers,
        });
    });
    if (layout.mobile && index === 0) {
      await p.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await p.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      await p.send("Network.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
        platform: "Android",
      });
    }
    await p.send("Page.navigate", { url });
    await until(() =>
      p.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    return p;
  }
  return {
    open,
    requests,
    exceptions,
    commands,
    sourceReads,
    v2,
    originalMemory,
    get runtime() {
      return runtime;
    },
    metadata: async (id = "chat-c") =>
      (await runtime.store.call("snapshot", id)).chat.metadata,
    async changeField(chatId, key, value) {
      const target = { scope: "chat", entityId: chatId, key };
      const field = (await runtime.store.call("readFields", [target]))
        .fields[0];
      return runtime.store.call("applyCommand", crypto.randomUUID(), {
        type: "change-fields",
        edits: [
          {
            ...target,
            expectedEpoch: field.entityEpoch,
            expectedRevision: field.revision,
            value,
          },
        ],
      });
    },
    hold() {
      let release;
      const promise = new Promise((r) => (release = r));
      hold = { promise, release };
      return () => {
        release();
        hold = null;
      };
    },
    async restart() {
      const port = new URL(runtime.url).port;
      await runtime.close();
      runtime = await createRuntimeService({ ...options, port: Number(port) });
    },
  };
}
for (const layout of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${layout.name}: original V3 editing, bounded old sources, durable single/bulk result editing and reopen after all tabs exit`,
    { timeout: 180000 },
    async (t) => {
      const f = await fixture(t, layout);
      let a = await f.open(0),
        b = await f.open(1);
      await select(a);
      await select(b);
      await modal(a);
      await modal(b);
      await delay(100);
      assert.equal(
        f.commands.length,
        0,
        "Opening must not write absent categories or other defaults",
      );
      assert.equal(
        await a.evaluate(
          "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.characters.find(c=>c.chaId==='c').chats.find(c=>c.id==='chat-c').message.some(m=>m.chatId==='m0')})()",
        ),
        false,
      );
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-hypa-summary-reroll=\"0\"]')?.disabled===false",
        ),
      );
      assert.equal(
        await a.evaluate(
          "document.querySelector('[data-hypa-summary-reroll=\"3\"]').disabled",
        ),
        true,
      );
      assert.ok(
        f.sourceReads.some(
          (r) => r.mode === "membership" && r.memos.includes("m0"),
        ),
      );
      assert.ok(
        f.sourceReads
          .filter((r) => r.mode === "membership")
          .every((r) => r.memos.length <= 256),
      );
      await write(a, '[data-hypa-summary-text="0"]', "UI edited first");
      await until(
        f.metadata,
        (v) => v.hypaV3Data.summaries[0].text === "UI edited first",
      );
      await settled(a);
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-hypa-summary-text=\"0\"]').value==='UI edited first'",
        ),
      );
      assert.deepEqual((await f.metadata()).hypaV3Data.summaries[0].unknown, {
        keep: 1,
      });
      await click(a, '[data-hypa-summary-tags="0"]');
      await write(a, "[data-hypa-tag-manager] input", "UI tag");
      await click(a, "[data-hypa-tag-add]");
      await until(f.metadata, (v) =>
        v.hypaV3Data.summaries[0].tags.includes("UI tag"),
      );
      await settled(a);
      await click(a, "[data-hypa-tag-close]");
      await click(a, "[data-hypa-v3-categories]");
      await click(a, "[data-hypa-category-add]");
      await write(a, "[data-hypa-category-manager] input", "UI category");
      await click(a, "[data-hypa-category-save]");
      await until(f.metadata, (v) =>
        v.hypaV3Data.categories?.some((c) => c.name === "UI category"),
      );
      await settled(a);
      await click(a, "[data-hypa-category-close]");
      const category = (await f.metadata()).hypaV3Data.categories.find(
        (c) => c.name === "UI category",
      );
      await click(a, "[data-hypa-v3-categories]");
      await click(a, `[data-hypa-category-edit="${category.id}"]`);
      await write(a, "[data-hypa-category-manager] input", "Renamed category");
      await click(a, "[data-hypa-category-save]");
      await until(f.metadata, (v) =>
        v.hypaV3Data.categories.some((c) => c.name === "Renamed category"),
      );
      await settled(a);
      await click(a, "[data-hypa-category-close]");
      await click(a, "[data-hypa-v3-bulk-mode]");
      await write(a, 'input[placeholder="1,3,5-8"]', "1,2");
      await click(a, "[data-hypa-bulk-select]");
      await a.evaluate(
        `(()=>{const e=document.querySelector('[data-hypa-v3-modal] select');e.value=${JSON.stringify(category.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await click(a, "[data-hypa-bulk-category-apply]");
      await until(f.metadata, (v) =>
        v.hypaV3Data.summaries
          .slice(0, 2)
          .every((s) => s.categoryId === category.id),
      );
      await settled(a);
      await click(a, "[data-hypa-v3-categories]");
      await a.evaluate(
        "[...document.querySelectorAll('[data-hypa-category-manager] button')].find(e=>e.textContent.trim().startsWith('전체')).click()",
      );
      await write(a, 'input[placeholder="1,3,5-8"]', "1,2");
      await click(a, "[data-hypa-bulk-select]");
      await click(a, "[data-hypa-bulk-important]");
      await until(f.metadata, (v) =>
        v.hypaV3Data.summaries.slice(0, 2).every((s) => s.isImportant),
      );
      await settled(a);
      assert.deepEqual(
        (await f.metadata("chat-d")).hypaV3Data,
        f.originalMemory,
      );
      await click(a, "[data-hypa-v3-close]");
      await select(a, "c", "chat-c2");
      await modal(a);
      const openingCount = f.commands.length;
      await delay(100);
      assert.equal(f.commands.length, openingCount);
      assert.equal((await f.metadata("chat-c2")).hypaV3Data, undefined);
      await click(a, "[data-hypa-v3-convert]");
      await until(
        () => f.metadata("chat-c2"),
        (v) => v.hypaV3Data?.summaries[0]?.text === "Authored V2",
      );
      await settled(a);
      assert.deepEqual((await f.metadata("chat-c2")).hypaV2Data, f.v2);
      const conversion = f.commands.find(
        (c) =>
          c.type === "change-fields" &&
          c.edits.some(
            (e) => e.entityId === "chat-c2" && e.key === "hypaV3Data",
          ),
      );
      assert.deepEqual(conversion.edits.map((e) => e.key).sort(), [
        "hypaV2Data",
        "hypaV3Data",
      ]);
      await a.evaluate(
        "(async()=>{const st=await import('/src/ts/stores.svelte.ts');st.alertStore.set({type:'none',msg:''})})()",
      );
      await click(a, "[data-hypa-v3-close]");
      await select(a);
      await modal(a);
      const beforeSingle = (await f.metadata()).hypaV3Data,
        release = f.hold();
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-hypa-summary-reroll=\"0\"]')?.disabled===false",
        ),
      );
      await click(a, '[data-hypa-summary-reroll="0"]');
      await until(() => f.requests.length > 0);
      const single = (await f.runtime.store.call("listJobs", "chat-c", 10))[0];
      assert.equal(single.type, "memory-summary");
      await a.close();
      a = null;
      await b.close();
      b = null;
      release();
      await until(
        () => f.runtime.store.call("getJob", single.id),
        (j) => j.state === "completed",
      );
      assert.deepEqual((await f.metadata()).hypaV3Data, beforeSingle);
      await f.restart();
      a = await f.open(0);
      b = await f.open(1);
      await select(a);
      await select(b);
      await click(a, `[data-runtime-memory-result="${single.id}"]`);
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Synthetic generated memory'",
        ),
      );
      await write(
        a,
        "[data-runtime-memory-summary-text]",
        "Edited generated single",
      );
      await click(a, "[data-runtime-memory-summary-apply]");
      await until(
        f.metadata,
        (v) => v.hypaV3Data.summaries[0].text === "Edited generated single",
      );
      await settled(a);
      assert.equal(
        (await f.runtime.store.call("previewMemorySummary", single.id)).text,
        "Synthetic generated memory",
      );
      assert.equal(
        (await f.runtime.store.call("previewMemorySummary", single.id))
          .appliedText,
        "Edited generated single",
      );
      await click(a, "[data-runtime-memory-summary-close]");
      await modal(a);
      await click(a, "[data-hypa-v3-categories]");
      await a.evaluate(
        "[...document.querySelectorAll('[data-hypa-category-manager] button')].find(e=>e.textContent.trim().startsWith('전체')).click()",
      );
      await click(a, "[data-hypa-v3-bulk-mode]");
      await write(a, 'input[placeholder="1,3,5-8"]', "1,2");
      await click(a, "[data-hypa-bulk-select]");
      const beforeBulk = (await f.metadata()).hypaV3Data;
      await click(a, "[data-hypa-bulk-summarize]");
      await until(
        () => f.runtime.store.call("listJobs", "chat-c", 10),
        (j) => j[0].id !== single.id && j[0].state === "completed",
      );
      const bulk = (await f.runtime.store.call("listJobs", "chat-c", 10))[0];
      assert.deepEqual((await f.metadata()).hypaV3Data, beforeBulk);
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Synthetic generated memory'",
        ),
      );
      await write(
        a,
        "[data-runtime-memory-summary-text]",
        "Edited generated bulk",
      );
      await click(a, "[data-runtime-memory-summary-apply]");
      await until(
        f.metadata,
        (v) =>
          v.hypaV3Data.summaries.length === 3 &&
          v.hypaV3Data.summaries[0].text === "Edited generated bulk",
      );
      await settled(a);
      const merged = (await f.metadata()).hypaV3Data.summaries[0];
      assert.deepEqual(merged.chatMemos, [null, "m0", "m1", "m2"]);
      assert.deepEqual(merged.tags, ["seed", "UI tag"]);
      assert.deepEqual(merged.unknown, { keep: 1 });
      await click(a, "[data-runtime-memory-summary-close]");
      await click(a, "[data-hypa-v3-close]");
      await a.close();
      a = null;
      await b.close();
      b = null;
      await f.restart();
      a = await f.open(0);
      await select(a);
      // Older completed results must remain discoverable after a newer job and restart.
      await click(a, `[data-runtime-memory-result="${single.id}"]`);
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Edited generated single'",
        ),
      );
      assert.equal(
        await a.evaluate(
          "document.querySelector('[data-runtime-memory-summary-text]').readOnly",
        ),
        true,
      );
      await click(a, "[data-runtime-memory-summary-close]");
      await click(a, `[data-runtime-memory-result="${bulk.id}"]`);
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-runtime-memory-summary-text]')?.value==='Edited generated bulk'",
        ),
      );
      assert.equal(f.requests.length, 2);
      assert.equal(f.exceptions.length, 0, JSON.stringify(f.exceptions));
    },
  );

async function answer(p, value = "YES") {
  const expression = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(value)})`;
  await until(() => p.evaluate(`!!(${expression})`));
  await p.evaluate(`(${expression}).click()`);
}
async function network(p, offline) {
  await p.send("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}
for (const layout of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${layout.name}: V3 edits guard peer changes, confirmation owners and conversion reads, and replay after offline all-tab exit`,
    { timeout: 180000 },
    async (t) => {
      const f = await fixture(t, layout);
      let a = await f.open(0),
        b = await f.open(1);
      await select(a);
      await select(b);
      await modal(a);
      await modal(b);
      await click(a, '[data-hypa-summary-tags="0"]');
      await f.changeField("chat-c", "hypaV3Data", {
        ...f.originalMemory,
        summaries: [],
      });
      await until(() =>
        a.evaluate("!document.querySelector('[data-hypa-tag-manager]')"),
      );
      assert.equal(
        f.exceptions.length,
        0,
        "Removing the selected summary must close its tag manager safely",
      );
      await f.changeField("chat-c", "hypaV3Data", f.originalMemory);
      await until(() =>
        a.evaluate(
          "!!document.querySelector('[data-hypa-summary-text=\"0\"]')",
        ),
      );
      await network(a, true);
      await write(a, '[data-hypa-summary-text="0"]', "Offline loses");
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await write(b, '[data-hypa-summary-text="0"]', "Peer wins");
      await until(
        f.metadata,
        (v) => v.hypaV3Data.summaries[0].text === "Peer wins",
      );
      await settled(b);
      await network(a, false);
      await until(() =>
        a.evaluate(ui("s.pending.some(e=>e.state==='blocked')")),
      );
      await answer(a, "서버 값 사용");
      await settled(a);
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-hypa-summary-text=\"0\"]')?.value==='Peer wins'",
        ),
      );
      await click(a, '[data-hypa-summary-delete="0"]');
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='YES')",
        ),
      );
      const changed = structuredClone((await f.metadata()).hypaV3Data);
      changed.summaries[0].tags.push("Peer during confirmation");
      await f.changeField("chat-c", "hypaV3Data", changed);
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('[data-hypa-summary=\"0\"] button')].some(e=>e.textContent.includes('Peer during confirmation'))",
        ),
      );
      await answer(a);
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('changed while waiting')",
        ),
      );
      assert.deepEqual((await f.metadata()).hypaV3Data, changed);
      await click(a, "[data-hypa-v3-categories]");
      await click(a, "[data-hypa-category-add]");
      await write(a, "[data-hypa-category-manager] input", "Stale category");
      const categoryPeer = structuredClone(changed);
      categoryPeer.summaries[1].text = "Peer category race";
      await f.changeField("chat-c", "hypaV3Data", categoryPeer);
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-hypa-summary-text=\"1\"]')?.value==='Peer category race'",
        ),
      );
      await click(a, "[data-hypa-category-save]");
      await until(() =>
        a.evaluate(ui("s.error.includes('changed while waiting')")),
      );
      assert.equal((await f.metadata()).hypaV3Data.categories, undefined);
      await answer(a, "확인");
      await click(a, "[data-hypa-category-close]");
      await b.close();
      b = null;
      await network(a, true);
      await write(a, '[data-hypa-summary-text="0"]', "Offline retained");
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await a.close();
      a = null;
      a = await f.open(0);
      await select(a);
      await until(
        f.metadata,
        (v) => v.hypaV3Data.summaries[0].text === "Offline retained",
      );
      await settled(a);
      await modal(a);
      await click(a, '[data-hypa-summary-delete="0"]');
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='YES')",
        ),
      );
      const captured = (await f.metadata()).hypaV3Data;
      await select(a, "d", "chat-d");
      await answer(a);
      await delay(100);
      assert.deepEqual((await f.metadata()).hypaV3Data, captured);
      assert.deepEqual(
        (await f.metadata("chat-d")).hypaV3Data,
        f.originalMemory,
      );
      assert.equal(
        await a.evaluate("!!document.querySelector('[data-hypa-v3-modal]')"),
        false,
      );
      await select(a, "c", "chat-c2");
      await modal(a);
      const held = [];
      const stop = a.on("Fetch.requestPaused", (e) => {
        held.push(e.requestId);
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await click(a, "[data-hypa-v3-convert]");
      await until(() => held.length > 0);
      const newV2 = structuredClone(f.v2);
      newV2.mainChunks[0].text = "Peer V2 source";
      await f.changeField("chat-c2", "hypaV2Data", newV2);
      for (const requestId of held)
        await a.send("Fetch.continueRequest", { requestId });
      await a.send("Fetch.disable");
      stop();
      await until(() =>
        a.evaluate(ui("s.pending.some(e=>e.state==='blocked')")),
      );
      assert.equal((await f.metadata("chat-c2")).hypaV3Data, undefined);
      assert.deepEqual((await f.metadata("chat-c2")).hypaV2Data, newV2);
      await a.evaluate(
        "(async()=>{const st=await import('/src/ts/stores.svelte.ts');st.alertStore.set({type:'none',msg:''})})()",
      );
      await answer(a, "서버 값 사용");
      await settled(a);
      await click(a, "[data-hypa-v3-close]");
      await select(a);
      await modal(a);
      await click(a, '[data-hypa-summary-delete="0"]');
      await answer(a);
      await until(f.metadata, (v) => v.hypaV3Data.summaries.length === 3);
      await settled(a);
      await click(a, "[data-hypa-v3-options]");
      await click(a, "[data-hypa-v3-reset]");
      await answer(a);
      await answer(a);
      await until(f.metadata, (v) => v.hypaV3Data.summaries.length === 0);
      await settled(a);
      assert.equal(f.requests.length, 0);
      assert.equal(f.exceptions.length, 0, JSON.stringify(f.exceptions));
    },
  );
