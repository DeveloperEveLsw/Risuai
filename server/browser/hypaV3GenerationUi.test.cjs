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
  const end = Date.now() + 30000;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(25);
  } while (Date.now() < end);
  throw Error("V3 browser condition timed out: " + JSON.stringify(last));
}

for (const layout of [
  { name: "desktop", mobile: false, beta: false, experimental: false },
  { name: "mobile-general", mobile: true, beta: false, experimental: true },
  { name: "mobile-beta", mobile: true, beta: true, experimental: false },
])
  test(
    `${layout.name}: original composer runs automatic V3, all tabs exit during summarization and two clients reload persisted memory/reply`,
    { timeout: 180000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "risu-v3-browser-"));
      let runtime, frontend, browser, provider, release;
      const held = new Promise((r) => (release = r)),
        requests = [],
        exceptions = [];
      t.after(async () => {
        release();
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
        const body = JSON.parse(text),
          memory = body.messages.some((x) =>
            String(x.content).includes("V3_BROWSER_SUMMARY"),
          );
        requests.push({ body, memory });
        if (memory) await held;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: memory
                    ? "Synthetic V3 browser memory"
                    : "Synthetic V3 final reply",
                },
              },
            ],
          }),
        );
      });
      await new Promise((r) => provider.listen(0, "127.0.0.1", r));
      const origins = [];
      runtime = await createRuntimeService({
        file: join(dir, "synthetic.sqlite"),
        initialize: true,
        origins,
        eventsPollMs: 20,
        scheduler: { pollMs: 20 },
      });
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
          customProxyRequestModel: "synthetic",
          forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          customTokenizer: "tik",
          useStreaming: false,
          maxContext: 1500,
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
                useExperimentalImpl: layout.experimental,
                summarizationModel: "subModel",
                summarizationPrompt: "V3_BROWSER_SUMMARY",
                maxChatsPerSummary: 2,
                recentMemoryRatio: 1,
                similarMemoryRatio: 0,
                queryChatCount: 3,
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
          name: "Synthetic V3",
          firstMessage: "Synthetic greeting",
          supaMemory: true,
        },
        chat: { chatId: "a", metadata: { name: "Synthetic V3", fmIndex: -1 } },
      });
      for (let i = 0; i < 8; i++)
        await runtime.store.call("applyCommand", "history" + i, {
          type: "append-message",
          chatId: "a",
          messageId: "m" + i,
          message: {
            role: i % 2 ? "char" : "user",
            data: ("Synthetic history " + i + " ").repeat(100),
          },
        });
      const { createServer: viteServer } = await import("vite");
      frontend = await viteServer({
        root: resolve(__dirname, "../.."),
        configFile: resolve(__dirname, "../../vite.config.ts"),
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
      browser = await launchChromium(dir);
      const contexts = [await browser.newContext(), await browser.newContext()];
      async function open(context, mobile = false) {
        const page = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        page.on("Runtime.exceptionThrown", (e) =>
          exceptions.push(
            e.exceptionDetails.exception?.description ??
              e.exceptionDetails.text,
          ),
        );
        if (mobile) {
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
          await page.send("Network.setUserAgentOverride", {
            userAgent:
              "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await page.send("Page.navigate", { url });
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-ready=true]')",
          ),
        );
        if (mobile && layout.beta) {
          await page.evaluate(
            "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='캐릭터').click()",
          );
          await until(() =>
            page.evaluate(
              "[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Synthetic V3'))",
            ),
          );
          await page.evaluate(
            "[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Synthetic V3')).click()",
          );
        } else {
          await until(() =>
            page.evaluate("!!document.querySelector('[data-character-id=c]')"),
          );
          await page.evaluate(
            "document.querySelector('[data-character-id=c]').click()",
          );
        }
        await until(() =>
          page.evaluate("!!document.querySelector('textarea.input-text')"),
        );
        return page;
      }
      let a = await open(contexts[0], layout.mobile),
        b = await open(contexts[1]);
      await a.evaluate(
        "(()=>{const e=document.querySelector('textarea.input-text');e.value='Synthetic V3 input';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
      );
      await until(() => requests.some((x) => x.memory));
      const jobs = await runtime.store.call("listJobs", "a", 10);
      const job = jobs.find((x) => x.type === "send");
      assert.ok(job);
      await a.close();
      a = null;
      await b.close();
      b = null;
      release();
      await until(
        () => runtime.store.call("getJob", job.id),
        (x) => !["queued", "running"].includes(x.state),
      );
      assert.equal(
        (await runtime.store.call("getJob", job.id)).state,
        "completed",
      );
      const stored = await runtime.store.call("snapshot", "a");
      assert.equal(stored.messages.length, 10);
      assert.equal(
        stored.messages.at(-1).message.data,
        "Synthetic V3 final reply",
      );
      assert.ok(stored.chat.metadata.hypaV3Data.summaries.length > 0);
      a = await open(contexts[0], layout.mobile);
      b = await open(contexts[1]);
      const read = (page) =>
        page.evaluate(
          "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.characters.find(c=>c.chaId==='c')?.chats.find(c=>c.id==='a')?.hypaV3Data??null;})()",
        );
      await until(
        () => read(a),
        (x) => x?.summaries?.length > 0,
      );
      await until(
        () => read(b),
        (x) => x?.summaries?.length > 0,
      );
      assert.deepEqual(await read(a), stored.chat.metadata.hypaV3Data);
      assert.deepEqual(await read(b), stored.chat.metadata.hypaV3Data);
      for (const page of [a, b])
        await until(() =>
          page.evaluate(
            "document.body.textContent.includes('Synthetic V3 final reply')",
          ),
        );
      assert.equal(requests.filter((x) => !x.memory).length, 1);
      assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    },
  );
