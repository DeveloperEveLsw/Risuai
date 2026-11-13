"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { createNativeProcessWorker } = require("../native/processWorker.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Memory editor condition timed out: " + JSON.stringify(value));
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function click(page, selector) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
}
async function write(page, selector, value) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function textButton(page, text) {
  const expression = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  await until(() => page.evaluate(`!!(${expression})`));
  await page.evaluate(`(${expression}).click()`);
}
for (const layout of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${layout.name}: original Supa/HypaV2 memory editing persists, stays with its captured chat and replays after all tabs exit`,
    { timeout: 180000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-memory-ui-"));
      let runtime, frontend, browser, a, b, worker, provider;
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              teardown: await a
                .evaluate("document.body.textContent.slice(-1200)")
                .catch(() => null),
            }),
          );
        await worker?.terminate();
        await browser?.close();
        await frontend?.close();
        await runtime?.close();
        if (provider)
          await new Promise((resolve) => {
            provider.close(resolve);
            provider.closeAllConnections();
          });
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
      const requests = [];
      provider = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "Synthetic memory reply" } }],
          }),
        );
      });
      await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const origins = [];
      runtime = await createRuntimeService({
        file: join(directory, "synthetic.sqlite"),
        origins,
        eventsPollMs: 20,
      });
      await runtime.scheduler.close();
      await runtime.store.call("applyCommand", "settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: 0,
        payload: {
          didFirstSetup: true,
          language: "ko",
          betaMobileGUI: layout.beta,
          aiModel: "reverse_proxy",
          customProxyRequestModel: "synthetic-memory",
          forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          customTokenizer: "tik",
          useStreaming: false,
          maxContext: 8000,
          maxResponse: 100,
          supaModelType: "none",
          hypav2: false,
          hypaV3: false,
        },
      });
      const originalMemory = {
        lastMainChunkID: 7,
        mainChunks: [
          {
            text: "Authored main",
            chatMemos: ["neutral-memo"],
            unknown: { keep: true },
          },
        ],
        chunks: [
          { text: "Authored chunk", mainChunkID: 7, unknown: { keep: true } },
        ],
        unknown: { keep: true },
      };
      for (const id of ["c", "d"])
        await runtime.store.call("applyCommand", "create-" + id, {
          type: "create-character",
          characterId: id,
          definition: {
            type: "character",
            name: "Synthetic memory " + id,
            desc: "Authored neutral fixture",
            firstMessage: "Authored greeting",
            supaMemory: true,
          },
          chat: {
            chatId: "chat-" + id,
            metadata: {
              name: "Authored memory",
              fmIndex: -1,
              hypaV2Data: originalMemory,
              supaMemoryData: "Authored Supa " + id,
              unknown: { keep: true },
            },
          },
        });
      await runtime.store.call("applyCommand", "chat-c2", {
        type: "create-chat",
        characterId: "c",
        chatId: "chat-c2",
        metadata: { name: "Absent memory", fmIndex: -1 },
      });
      await runtime.store.call("applyCommand", "memory-group", {
        type: "create-character",
        characterId: "g",
        definition: {
          type: "group",
          name: "Authored memory group",
          characters: ["c", "d"],
          characterTalks: [1, 1],
          characterActive: [true, true],
          orderByOrder: false,
          autoMode: false,
          supaMemory: true,
        },
        chat: {
          chatId: "chat-g",
          metadata: {
            name: "Authored group memory",
            supaMemoryData: "Authored group Supa",
          },
        },
      });
      const settings = async () =>
        await runtime.store.call("getResource", "settings", "global");
      const changeSettings = async (values) => {
        const current = await settings();
        await runtime.store.call(
          "applyCommand",
          "settings-" + crypto.randomUUID(),
          {
            type: "put-resource",
            kind: "settings",
            resourceId: "global",
            expectedRevision: current.revision,
            payload: { ...current.payload, ...values },
          },
        );
      };
      const metadata = async (id = "chat-c") =>
        (await runtime.store.call("snapshot", id)).chat.metadata;
      const vite = await import("vite");
      frontend = await vite.createServer({
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
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      browser = await launchChromium(directory);
      const contexts = [await browser.newContext(), await browser.newContext()],
        exceptions = [],
        commands = [];
      async function open(context) {
        const p = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        p.on("Runtime.exceptionThrown", (e) =>
          exceptions.push(
            e.exceptionDetails.exception?.description ??
              e.exceptionDetails.text,
          ),
        );
        await p.send("Network.enable");
        p.on("Network.requestWillBeSent", (e) => {
          if (
            e.request.url.endsWith("/api/runtime/commands") &&
            e.request.postData
          )
            commands.push(JSON.parse(e.request.postData).command);
        });
        if (layout.mobile && context === contexts[0]) {
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
      async function select(p, id = "c", chat = "chat-c") {
        await p.evaluate(
          `(async()=>{const st=await import('/src/ts/stores.svelte.ts');st.settingsOpen.set(false);const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter(${JSON.stringify(id)},${JSON.stringify(chat)});st.botMakerMode.set(true);st.sideBarStore.set(true);st.MobileSideBar.set(2);st.CharConfigSubMenu.set(2)})()`,
        );
      }
      async function hypa(p) {
        await until(() =>
          p.evaluate(
            "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='하이파 V2 모달')",
          ),
        );
        await textButton(p, "하이파 V2 모달");
        await until(() =>
          p.evaluate(
            "!!document.querySelector('[data-runtime-memory-editor=hypa-v2]')",
          ),
        );
      }
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await select(a);
      await select(b);
      await until(() =>
        a.evaluate("!!document.getElementById('runtime-supa-memory')"),
      );
      await delay(100);
      assert.equal(
        commands.length,
        0,
        "Opening the editor must not save control defaults",
      );
      await write(a, "#runtime-supa-memory", "UI edited Supa");
      await until(metadata, (v) => v.supaMemoryData === "UI edited Supa");
      await until(() =>
        b.evaluate(
          "document.getElementById('runtime-supa-memory').value==='UI edited Supa'",
        ),
      );
      assert.equal(
        (await metadata("chat-d")).supaMemoryData,
        "Authored Supa d",
      );
      await select(a, "c", "chat-c2");
      await until(() =>
        a.evaluate(
          "document.getElementById('runtime-supa-memory')?.value===''",
        ),
      );
      const openingCount = commands.length;
      await delay(100);
      assert.equal(commands.length, openingCount);
      assert.equal((await metadata("chat-c2")).supaMemoryData, undefined);
      await a.evaluate(
        `(()=>{const e=document.getElementById('runtime-supa-memory');e.value='Navigation Supa';e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await select(a, "d", "chat-d");
      await until(
        () => metadata("chat-c2"),
        (v) => v.supaMemoryData === "Navigation Supa",
      );
      assert.equal(
        (await metadata("chat-d")).supaMemoryData,
        "Authored Supa d",
      );
      await select(a, "g", "chat-g");
      await select(b, "g", "chat-g");
      await write(a, "#runtime-supa-memory", "Group Supa edited");
      await until(
        () => metadata("chat-g"),
        (v) => v.supaMemoryData === "Group Supa edited",
      );
      await until(() =>
        b.evaluate(
          "document.getElementById('runtime-supa-memory')?.value==='Group Supa edited'",
        ),
      );
      assert.equal((await metadata()).supaMemoryData, "UI edited Supa");
      await changeSettings({
        supaModelType: "subModel",
        hypav2: true,
        showMenuHypaMemoryModal: true,
      });
      await select(a);
      await select(b);
      await hypa(a);
      await hypa(b);
      await write(a, "[data-memory-chunk='0'] textarea", "Edited chunk");
      await until(
        metadata,
        (v) => v.hypaV2Data.chunks[0].text === "Edited chunk",
      );
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-memory-chunk=\"0\"] textarea').value==='Edited chunk'",
        ),
      );
      await textButton(a, "Summarized");
      await textButton(b, "Summarized");
      await write(a, "[data-memory-main-chunk='0'] textarea", "Edited main");
      await until(
        metadata,
        (v) => v.hypaV2Data.mainChunks[0].text === "Edited main",
      );
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-memory-main-chunk=\"0\"] textarea').value==='Edited main'",
        ),
      );
      assert.equal(
        (await metadata()).hypaV2Data.chunks[0].text,
        "Edited chunk",
      );
      assert.deepEqual((await metadata()).hypaV2Data.unknown, { keep: true });
      assert.deepEqual((await metadata()).hypaV2Data.mainChunks[0].unknown, {
        keep: true,
      });
      await select(a, "d", "chat-d");
      await write(
        a,
        "[data-memory-main-chunk='0'] textarea",
        "Captured old chat",
      );
      await until(
        metadata,
        (v) => v.hypaV2Data.mainChunks[0].text === "Captured old chat",
      );
      assert.equal(
        (await metadata("chat-d")).hypaV2Data.mainChunks[0].text,
        "Authored main",
      );
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(a, "[data-memory-main-chunk='0'] textarea", "Offline loses");
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await write(b, "[data-memory-main-chunk='0'] textarea", "Peer wins");
      await until(
        metadata,
        (v) => v.hypaV2Data.mainChunks[0].text === "Peer wins",
      );
      await a.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await until(() =>
        a.evaluate(ui("s.pending.some(e=>e.state==='blocked')")),
      );
      await textButton(a, "서버 값 사용");
      await until(() => a.evaluate(ui("s.pending.length===0")));
      assert.equal(
        (await metadata()).hypaV2Data.mainChunks[0].text,
        "Peer wins",
      );
      await textButton(a, "✖");
      await textButton(b, "✖");
      await select(a, "c", "chat-c2");
      await hypa(a);
      await delay(100);
      assert.equal((await metadata("chat-c2")).hypaV2Data, undefined);
      assert.equal(
        await a.evaluate(
          "document.querySelectorAll('[data-memory-chunk], [data-memory-main-chunk]').length",
        ),
        0,
      );
      await textButton(a, "✖");
      // The original composer entry must also avoid creating absent memory.
      await a.evaluate(
        "(async()=>{const s=await import('/src/ts/stores.svelte.ts');s.botMakerMode.set(false);s.sideBarStore.set(false);s.MobileSideBar.set(0)})()",
      );
      await until(() =>
        a.evaluate(
          "(()=>{const e=document.querySelector('button.rounded-r-md svg.lucide-menu')?.closest('button');if(!e)return false;e.click();return true})()",
        ),
      );
      await until(() =>
        a.evaluate(
          "(()=>{const e=[...document.querySelectorAll('span')].find(e=>e.textContent.trim()==='하이파 V2 모달');if(!e)return false;e.parentElement.click();return true})()",
        ),
      );
      await until(() =>
        a.evaluate(
          "!!document.querySelector('[data-runtime-memory-editor=hypa-v2]')",
        ),
      );
      await delay(100);
      assert.equal((await metadata("chat-c2")).hypaV2Data, undefined);
      await textButton(a, "✖");
      await select(a);
      await hypa(a);
      await textButton(a, "Summarized");
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(
        a,
        "[data-memory-main-chunk='0'] textarea",
        "Offline replay main",
      );
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await a.close();
      await b.close();
      a = b = undefined;
      assert.equal(
        (await metadata()).hypaV2Data.mainChunks[0].text,
        "Peer wins",
      );
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await until(
        metadata,
        (v) => v.hypaV2Data.mainChunks[0].text === "Offline replay main",
      );
      await until(() => a.evaluate(ui("s.pending.length===0")));
      await select(a);
      await hypa(a);
      await textButton(a, "Summarized");
      assert.equal(
        await a.evaluate(
          "document.querySelector('[data-memory-main-chunk=\"0\"] textarea').value",
        ),
        "Offline replay main",
      );
      assert.deepEqual(exceptions, []);
      const stored = await metadata();
      assert.deepEqual(stored.unknown, { keep: true });
      assert.equal((await runtime.store.call("listJobs", "chat-c")).length, 0);
      let nativeConsumedEditedMemory = false;
      if (!layout.mobile) {
        await a.close();
        await b.close();
        a = b = undefined;
        await changeSettings({
          supaModelType: "subModel",
          hypav2: false,
          hypaMemory: false,
          removePunctuationHypa: true,
          subModel: "reverse_proxy",
          maxContext: 1500,
          mainPrompt: "Authored neutral system",
        });
        for (let i = 0; i < 8; i++)
          await runtime.store.call("applyCommand", "history-" + i, {
            type: "append-message",
            chatId: "chat-c",
            messageId: "history-" + i,
            message: {
              role: i % 2 ? "char" : "user",
              data: ("Authored neutral history " + i + " ").repeat(100),
            },
          });
        // Use the actual textarea/outbox for the memory consumed by native generation.
        a = await open(contexts[0]);
        await select(a);
        await write(a, "#runtime-supa-memory", "history-6\nUI_SAVED_MEMORY");
        await until(
          metadata,
          (v) => v.supaMemoryData === "history-6\nUI_SAVED_MEMORY",
        );
        await a.close();
        a = undefined;
        await runtime.store.call("enqueueJob", "memory-send", {
          type: "send",
          chatId: "chat-c",
          input: "Authored neutral input",
          messageId: "native-input",
        });
        const claimed = await runtime.store.call("claimJob", "memory-test");
        worker = createNativeProcessWorker({
          file: join(directory, "synthetic.sqlite"),
          claimed,
          diagnostics: true,
        });
        const done = await new Promise((resolve, reject) => {
          worker.on("message", (e) => {
            if (e.completed) resolve(e.completed);
            if (e.error) reject(Error(e.error.message));
          });
          worker.on("error", reject);
        });
        assert.equal(done.state, "completed", JSON.stringify(done.result));
        if (
          !requests
            .at(-1)
            .messages.some((m) => String(m.content).includes("UISAVEDMEMORY"))
        ) {
          console.log(
            JSON.stringify({
              nativeMemoryDiagnostic: true,
              characterMemoryEnabled: (
                await runtime.store.call("getCharacter", "c")
              ).definition.supaMemory,
              savedMemory: (await metadata()).supaMemoryData,
              lastMemory: (await metadata()).lastMemory,
              providerCalls: requests.length,
              messages: requests.at(-1).messages.map((m) => ({
                role: m.role,
                length: String(m.content).length,
                prefix: String(m.content).slice(0, 70),
              })),
            }),
          );
        }
        assert.ok(
          requests
            .at(-1)
            .messages.some((m) => String(m.content).includes("UISAVEDMEMORY")),
        );
        assert.equal(
          (await metadata()).supaMemoryData,
          "history-6\nUI_SAVED_MEMORY",
          "Native punctuation processing must not rewrite the persisted source",
        );
        assert.equal(
          (await runtime.store.call("snapshot", "chat-c")).messages.at(-1)
            .message.data,
          "Synthetic memory reply",
        );
        nativeConsumedEditedMemory = true;
      }
      console.log(
        JSON.stringify({
          layout: layout.name,
          supaStoredAndPeer: true,
          groupSupaStoredAndPeer: true,
          hypaV2StoredAndPeer: true,
          originalMainChunkIndependence: true,
          unknownFieldsPreserved: true,
          noWritesOnAbsentMemoryOpen: true,
          composerAbsentMemoryOpenDoesNotWrite: true,
          capturedModalOwner: true,
          sameFieldConflictVisible: true,
          allTabsOfflineReplay: true,
          nativeConsumedEditedMemory,
          originalNativePunctuationProcessing: nativeConsumedEditedMemory,
          syntheticProviderCalls: requests.length,
          realProviderRequests: 0,
          physicalDevice: false,
          uncaughtBrowserExceptions: 0,
        }),
      );
    },
  );
