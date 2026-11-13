"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, mkdir, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { createNativeProcessWorker } = require("../native/processWorker.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Memory settings condition timed out: " + JSON.stringify(value));
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function write(page, selector, value) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}
async function click(page, selector) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
}
async function textButton(page, text) {
  await until(() =>
    page.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`,
    ),
  );
}
const modeSelector = '[data-memory-field="mode"] select';
const preset = (key) => `[data-memory-preset-setting="${key}"]`;
const field = (key) => `[id="runtime-memory-${key}"]`;
const action = (key) => `[data-memory-preset-action="${key}"]`;
const modeKeys = [
  "supaModelType",
  "memoryAlgorithmType",
  "hypav2",
  "hanuraiEnable",
  "hypaV3",
];
for (const layout of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${layout.name}: original memory settings and Hypa V3 presets persist atomic dependencies, fence awaited actions and replay after every tab closes`,
    { timeout: 180000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-memory-settings-"));
      let runtime, frontend, browser, a, b, worker, provider;
      let stage = "setup";
      const exceptions = [],
        requests = [],
        commands = [];
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              stage,
              teardown: await a
                .evaluate("document.body.textContent.slice(-1000)")
                .catch(() => null),
              pending: await a
                .evaluate(
                  ui(
                    "JSON.parse(JSON.stringify(s.pending.map(e=>({state:e.state,error:e.error,command:e.command}))))",
                  ),
                )
                .catch(() => null),
              peerPending: await b
                ?.evaluate(
                  ui(
                    "JSON.parse(JSON.stringify(s.pending.map(e=>({state:e.state,error:e.error,command:e.command}))))",
                  ),
                )
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
      provider = createServer(async (req, res) => {
        let body = "";
        for await (const part of req) body += part;
        const data = JSON.parse(body);
        requests.push(data);
        const isSummary = JSON.stringify(data).includes(
          "AUTHORED_SUMMARY_INSTRUCTION",
        );
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: isSummary
                    ? "Authored short memory summary"
                    : "Authored native final reply",
                },
              },
            ],
          }),
        );
      });
      await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const { createInitialRuntimeState } = await import(
        pathToFileURL(resolve("server/native/dist/extensionJob.mjs")).href
      );
      const initial = createInitialRuntimeState().settings;
      const basePreset = initial.hypaV3Presets[0];
      const originalPreset = {
        ...basePreset,
        name: "Authored portable",
        unknown: { keep: true },
        settings: {
          ...basePreset.settings,
          unknown: { keep: true },
          recentMemoryRatio: 0.9,
          similarMemoryRatio: 0.7,
        },
      };
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
          ...initial,
          didFirstSetup: true,
          language: "en",
          betaMobileGUI: layout.beta,
          aiModel: "reverse_proxy",
          customProxyRequestModel: "synthetic-memory-config",
          forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          customTokenizer: "tik",
          useStreaming: false,
          supaModelType: "none",
          memoryAlgorithmType: "none",
          hypav2: false,
          hanuraiEnable: false,
          hypaV3: false,
          hypaV3PresetId: 0,
          hypaV3Presets: [originalPreset],
          hypaCustomSettings: {
            url: "",
            key: "",
            model: "",
            unknown: { keep: true },
          },
          unrelatedSetting: { keep: true },
        },
      });
      await runtime.store.call("applyCommand", "character", {
        type: "create-character",
        characterId: "c",
        definition: {
          type: "character",
          name: "Authored memory configuration",
          desc: "Authored neutral description",
          firstMessage: "Authored greeting",
          supaMemory: true,
        },
        chat: {
          chatId: "chat-c",
          metadata: { name: "Authored configuration chat", fmIndex: -1 },
        },
      });
      const settings = async () =>
        (await runtime.store.call("getResource", "settings", "global")).payload;
      const settle = async (p) =>
        until(() => p.evaluate(ui("s.pending.length===0")));
      async function projected(p, key) {
        const target = {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        };
        const field = (await runtime.store.call("readFields", [target]))
          .fields[0];
        await until(() =>
          p.evaluate(
            ui(
              `(()=>{const h=r().fieldHeader(${JSON.stringify(target)});return h.revision===${field.revision}&&h.epoch===${field.entityEpoch}})()`,
            ),
          ),
        );
      }
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
      const contexts = [await browser.newContext(), await browser.newContext()];
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
      async function panel(p) {
        await p.evaluate(
          "(async()=>{const s=await import('/src/ts/stores.svelte.ts');await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('c','chat-c');s.botMakerMode.set(false);s.MobileSideBar.set(0);s.SettingsMenuIndex.set(2);s.settingsOpen.set(true)})()",
        );
        await until(() =>
          p.evaluate(
            "!!document.querySelector('[data-runtime-memory-settings]')",
          ),
        );
      }
      const mode = async (p, value) => write(p, modeSelector, value);
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await panel(a);
      await panel(b);
      const before = await settings();
      await delay(100);
      assert.deepEqual(await settings(), before);
      assert.equal(commands.length, 0);
      await mode(a, "hanuraiMemory");
      await until(
        settings,
        (v) => v.hanuraiEnable && v.memoryAlgorithmType === "hanuraiMemory",
      );
      assert.deepEqual(
        commands
          .at(-1)
          .edits.map((e) => e.key)
          .sort(),
        [...modeKeys].sort(),
      );
      await until(() =>
        b.evaluate(
          `document.querySelector('${modeSelector}').value==='hanuraiMemory'`,
        ),
      );
      await write(a, field("hanuraiTokens"), 640);
      await click(a, '[data-memory-field="hanuraiSplit"] input');
      await until(
        settings,
        (v) => v.hanuraiTokens === 640 && v.hanuraiSplit === true,
      );
      await mode(a, "hypaV2");
      await until(
        settings,
        (v) => v.hypav2 && v.memoryAlgorithmType === "hypaMemoryV2",
      );
      await write(
        a,
        '[data-memory-field="supaModelType"] select',
        "instruct35",
      );
      await write(a, field("supaMemoryKey"), "authored-fake-key");
      await write(a, field("supaMemoryPrompt"), "Authored V2 prompt");
      await write(a, field("hypaChunkSize"), 350);
      await write(a, field("hypaAllocatedTokens"), 700);
      await until(
        settings,
        (v) =>
          v.hypaChunkSize === 350 &&
          v.hypaAllocatedTokens === 700 &&
          v.supaMemoryPrompt === "Authored V2 prompt",
      );
      await mode(a, "supaMemory");
      await until(
        settings,
        (v) => !v.hypav2 && !v.hypaV3 && v.memoryAlgorithmType === "supaMemory",
      );
      await write(a, field("maxSupaChunkSize"), 5000);
      await click(a, '[data-memory-field="hypaMemory"] input');
      await until(
        settings,
        (v) => v.maxSupaChunkSize === 5000 && v.hypaMemory === true,
      );
      await write(a, '[data-memory-field="hypaModel"] select', "custom");
      for (const [key, value] of [
        ["url", "http://127.0.0.1/synthetic-embedding"],
        ["key", "authored-embedding-key"],
        ["model", "authored-embedding-model"],
      ])
        await write(a, field("hypaCustomSettings." + key), value);
      await until(
        settings,
        (v) => v.hypaCustomSettings.model === "authored-embedding-model",
      );
      assert.deepEqual((await settings()).hypaCustomSettings.unknown, {
        keep: true,
      });
      await write(
        a,
        '[data-memory-field="hypaModel"] select',
        "voyageContext3",
      );
      await write(a, field("voyageApiKey"), "authored-voyage-key");
      await until(settings, (v) => v.voyageApiKey === "authored-voyage-key");
      await mode(a, "hypaV3");
      await until(
        settings,
        (v) => v.hypaV3 && v.memoryAlgorithmType === "hypaMemoryV3",
      );
      await until(() =>
        b.evaluate(
          `document.querySelector('${modeSelector}').value==='hypaV3'`,
        ),
      );
      await delay(100);
      assert.deepEqual(
        (await settings()).hypaV3Presets,
        [originalPreset],
        "Opening ratios must not normalize persisted data",
      );
      await a.evaluate(
        `document.querySelector('${preset("recentMemoryRatio")} [role=slider]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`,
      );
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.recentMemoryRatio === 1 &&
          v.hypaV3Presets[0].settings.similarMemoryRatio === 0,
      );
      assert.deepEqual(
        commands
          .at(-1)
          .edits.map((e) => e.key)
          .sort(),
        ["hypaV3PresetId", "hypaV3Presets"],
      );
      await write(
        a,
        preset("summarizationPrompt") + " textarea",
        "Authored original summary prompt",
      );
      await write(
        a,
        preset("reSummarizationPrompt") + " textarea",
        "Authored original re-summary prompt",
      );
      await write(a, preset("maxChatsPerSummary") + " input", 9);
      await write(a, preset("queryChatCount") + " input", 4);
      await write(
        a,
        preset("summaryChunkSeparator") + " input",
        "Authored separator",
      );
      for (const key of [
        "preserveOrphanedMemory",
        "processRegexScript",
        "doNotSummarizeUserMessage",
      ])
        await click(a, preset(key) + " input");
      await a.evaluate(
        "[...document.querySelector('[data-runtime-memory-settings]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Advanced Settings').click()",
      );
      await click(a, preset("enableSimilarityCorrection") + " input");
      await click(a, preset("useExperimentalImpl") + " input");
      await click(a, preset("alwaysToggleOn") + " input");
      for (const [key, value] of [
        ["summarizationRequestsPerMinute", 25],
        ["summarizationMaxConcurrent", 2],
        ["embeddingRequestsPerMinute", 120],
        ["embeddingMaxConcurrent", 3],
      ])
        await write(a, preset(key) + " input", value);
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.embeddingMaxConcurrent === 3 &&
          v.hypaV3Presets[0].settings.alwaysToggleOn === true,
      );
      await settle(a);
      for (const [key, end, expected] of [
        ["extraSummarizationRatio", "End", 0.8],
        ["extraSummarizationRatio", "Home", 0],
        ["memoryTokensRatio", "End", 1],
        ["similarMemoryRatio", "End", 1],
      ]) {
        await a.evaluate(
          `document.querySelector('${preset(key)} [role=slider]').dispatchEvent(new KeyboardEvent('keydown',{key:'${end}',bubbles:true}))`,
        );
        await until(
          settings,
          (v) => v.hypaV3Presets[0].settings[key] === expected,
        );
        await settle(a);
      }
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.memoryTokensRatio === 1 &&
          v.hypaV3Presets[0].settings.similarMemoryRatio === 1 &&
          v.hypaV3Presets[0].settings.recentMemoryRatio === 0 &&
          v.hypaV3Presets[0].settings.enableSimilarityCorrection === true,
      );
      assert.deepEqual((await settings()).hypaV3Presets[0].unknown, {
        keep: true,
      });
      assert.deepEqual((await settings()).hypaV3Presets[0].settings.unknown, {
        keep: true,
      });
      await click(a, action("add"));
      await until(
        settings,
        (v) => v.hypaV3Presets.length === 2 && v.hypaV3PresetId === 1,
      );
      await settle(a);
      await click(a, action("rename"));
      await write(a, "#alert-input", "Authored added preset");
      await textButton(a, "OK");
      await until(
        settings,
        (v) => v.hypaV3Presets[1].name === "Authored added preset",
      );
      await settle(a);
      // Awaited rename retains both the array and selected-index clocks, including ABA.
      stage = "rename ABA";
      await until(() =>
        b.evaluate(
          "[...document.querySelector('[data-memory-preset-selector]').options].map(o=>o.textContent).join('|')==='Authored portable|Authored added preset'",
        ),
      );
      await write(b, "[data-memory-preset-selector]", 0);
      await until(settings, (v) => v.hypaV3PresetId === 0);
      await settle(b);
      await until(() =>
        a.evaluate(
          "Number(document.querySelector('[data-memory-preset-selector]').value) === 0",
        ),
      );
      await click(a, action("rename"));
      await until(() => a.evaluate("!!document.querySelector('#alert-input')"));
      await write(
        b,
        preset("summarizationPrompt") + " textarea",
        "Peer ABA prompt",
      );
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.summarizationPrompt === "Peer ABA prompt",
      );
      await settle(b);
      await write(
        b,
        preset("summarizationPrompt") + " textarea",
        "Authored original summary prompt",
      );
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.summarizationPrompt ===
          "Authored original summary prompt",
      );
      await settle(b);
      await projected(a, "hypaV3Presets");
      await write(a, "#alert-input", "Stale rename must lose");
      await textButton(a, "OK");
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('changed while waiting')",
        ),
      );
      assert.equal(
        (await settings()).hypaV3Presets[0].name,
        "Authored portable",
      );
      await textButton(a, "OK");
      await until(() =>
        a.evaluate(
          `document.querySelector('${preset("summarizationPrompt")} textarea').value==='Authored original summary prompt'`,
        ),
      );
      // A stale deletion confirmation cannot delete whichever preset became selected.
      stage = "deletion selection";
      await write(a, "[data-memory-preset-selector]", 1);
      await until(settings, (v) => v.hypaV3PresetId === 1);
      await settle(a);
      await until(() =>
        b.evaluate(
          "Number(document.querySelector('[data-memory-preset-selector]').value) === 1",
        ),
      );
      await click(a, action("remove"));
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='YES')",
        ),
      );
      await write(b, "[data-memory-preset-selector]", 0);
      await until(settings, (v) => v.hypaV3PresetId === 0);
      await settle(b);
      await projected(a, "hypaV3PresetId");
      await textButton(a, "YES");
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('changed while waiting')",
        ),
      );
      assert.equal((await settings()).hypaV3Presets.length, 2);
      await textButton(a, "OK");
      const importPath = join(directory, "authored-memory.json");
      stage = "import ABA";
      const imported = {
        type: "risu",
        ver: 1,
        data: {
          name: "Authored imported preset",
          unknown: "Original import drops unknown outer members",
          settings: {
            maxChatsPerSummary: 12,
            memoryTokensRatio: 0.3,
            unknown: "Original constructor drops this",
            queryChatCount: "Original constructor rejects this type",
          },
        },
      };
      await writeFile(importPath, JSON.stringify(imported));
      let chooser;
      a.on("Page.fileChooserOpened", (e) => {
        chooser = e;
      });
      await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
      async function beginImport() {
        chooser = undefined;
        const p = await a.evaluate(
          `(()=>{const e=document.querySelector('${action("import")}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await a.send("Input.dispatchMouseEvent", {
            type,
            ...p,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
        await until(() => chooser);
      }
      const supply = () =>
        a.send("DOM.setFileInputFiles", {
          files: [importPath],
          backendNodeId: chooser.backendNodeId,
        });
      await beginImport();
      await write(b, preset("maxChatsPerSummary") + " input", 10);
      await until(
        settings,
        (v) => v.hypaV3Presets[0].settings.maxChatsPerSummary === 10,
      );
      await settle(b);
      await write(b, preset("maxChatsPerSummary") + " input", 9);
      await until(
        settings,
        (v) => v.hypaV3Presets[0].settings.maxChatsPerSummary === 9,
      );
      await settle(b);
      await projected(a, "hypaV3Presets");
      await supply();
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('changed while waiting')",
        ),
      );
      assert.equal((await settings()).hypaV3Presets.length, 2);
      await textButton(a, "OK");
      await beginImport();
      await supply();
      await until(
        settings,
        (v) => v.hypaV3Presets.length === 3 && v.hypaV3PresetId === 2,
      );
      await textButton(a, "OK");
      await settle(a);
      const savedImported = (await settings()).hypaV3Presets[2];
      assert.equal(savedImported.settings.maxChatsPerSummary, 12);
      assert.equal(savedImported.settings.queryChatCount, 3);
      assert.equal(savedImported.settings.unknown, undefined);
      assert.equal(savedImported.unknown, undefined);
      const downloads = join(directory, "downloads");
      await mkdir(downloads);
      await browser.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        browserContextId: contexts[0],
        downloadPath: downloads,
      });
      await click(a, action("export"));
      const exported = await until(async () => {
        try {
          return JSON.parse(
            await readFile(
              join(downloads, "hypaV3_export_Authored imported preset.json"),
              "utf8",
            ),
          );
        } catch {
          return null;
        }
      });
      assert.deepEqual(exported, { type: "risu", ver: 1, data: savedImported });
      await textButton(a, "OK");
      await click(a, action("remove"));
      await textButton(a, "YES");
      await until(
        settings,
        (v) => v.hypaV3Presets.length === 2 && v.hypaV3PresetId === 0,
      );
      await settle(a);
      // Explicit concurrent edits of the same aggregate retain a visible losing intent.
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(
        a,
        preset("summarizationPrompt") + " textarea",
        "Offline loses",
      );
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await write(b, preset("summarizationPrompt") + " textarea", "Peer wins");
      await until(
        settings,
        (v) => v.hypaV3Presets[0].settings.summarizationPrompt === "Peer wins",
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
      await settle(a);
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(
        a,
        preset("reSummarizationPrompt") + " textarea",
        "Offline replay re-summary",
      );
      await until(() => a.evaluate(ui("s.pending.length>0")));
      await a.close();
      await b.close();
      a = b = undefined;
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await until(
        settings,
        (v) =>
          v.hypaV3Presets[0].settings.reSummarizationPrompt ===
          "Offline replay re-summary",
      );
      await panel(a);
      await panel(b);
      await until(() =>
        b.evaluate(
          `document.querySelector('${preset("reSummarizationPrompt")} textarea').value==='Offline replay re-summary'`,
        ),
      );
      await a.send("Page.reload");
      await until(() =>
        a.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      await panel(a);
      assert.deepEqual((await settings()).hypaV3Presets[0].unknown, {
        keep: true,
      });
      assert.deepEqual((await settings()).unrelatedSetting, { keep: true });
      assert.deepEqual(exceptions, []);
      let nativeConsumesUiSettings = false;
      if (!layout.mobile) {
        await mode(a, "supaMemory");
        await write(
          a,
          '[data-memory-field="supaModelType"] select',
          "subModel",
        );
        await write(
          a,
          field("supaMemoryPrompt"),
          "AUTHORED_SUMMARY_INSTRUCTION",
        );
        await until(() =>
          a.evaluate(
            "!!document.querySelector('[data-memory-field=hypaMemory] input')",
          ),
        );
        if (
          await a.evaluate(
            "document.querySelector('[data-memory-field=hypaMemory] input').checked",
          )
        )
          await click(a, "[data-memory-field=hypaMemory] input");
        await settle(a);
        await a.close();
        await b.close();
        a = b = undefined;
        const current = await runtime.store.call(
          "getResource",
          "settings",
          "global",
        );
        await runtime.store.call("applyCommand", "native-owned-settings", {
          type: "put-resource",
          kind: "settings",
          resourceId: "global",
          expectedRevision: current.revision,
          payload: {
            ...current.payload,
            subModel: "reverse_proxy",
            maxContext: 1500,
            maxResponse: 100,
            mainPrompt: "Authored neutral system",
          },
        });
        for (let i = 0; i < 8; i++)
          await runtime.store.call("applyCommand", "history-" + i, {
            type: "append-message",
            chatId: "chat-c",
            messageId: "history-" + i,
            message: {
              role: i % 2 ? "char" : "user",
              data: ("Authored history " + i + " ").repeat(100),
            },
          });
        await runtime.store.call("enqueueJob", "native-memory-settings", {
          type: "send",
          chatId: "chat-c",
          input: "Authored neutral input",
          messageId: "native-settings-input",
        });
        const claimed = await runtime.store.call(
          "claimJob",
          "memory-settings-test",
        );
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
        assert.ok(
          requests.some((r) =>
            JSON.stringify(r).includes("AUTHORED_SUMMARY_INSTRUCTION"),
          ),
        );
        assert.equal(
          (await runtime.store.call("snapshot", "chat-c")).messages.at(-1)
            .message.data,
          "Authored native final reply",
        );
        nativeConsumesUiSettings = true;
      }
      console.log(
        JSON.stringify({
          layout: layout.name,
          memoryFields: 18,
          atomicModeDependencyFields: 5,
          atomicPresetCollectionAndSelection: true,
          existingUnknownMembersPreserved: true,
          noOpeningWrites: true,
          ratioClampOnlyOnEdit: true,
          originalPresetCrud: true,
          originalJsonImportExport: true,
          originalImportTypeFiltering: true,
          awaitedRenameAbaRejected: true,
          awaitedRemovalSelectionGuarded: true,
          awaitedImportAbaRejected: true,
          sameAggregateConflictVisible: true,
          allTabsOfflineReplay: true,
          reloadRetained: true,
          nativeConsumesUiSettings,
          syntheticProviderCalls: requests.length,
          realProviderRequests: 0,
          uncaughtBrowserExceptions: 0,
          physicalDevice: false,
        }),
      );
    },
  );
