"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const dev = resolve(__dirname, "../..");
const { createRuntimeService } = require(
  join(dev, "server/runtime/service.cjs"),
);
const { launchChromium } = require(join(dev, "server/browser/chromium.cjs"));
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Stream handoff condition timed out: " + JSON.stringify(value));
}
test(
  "strong streaming retains visible text through actual final Markdown asset preparation and one canonical server completion",
  { timeout: 150000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-stream-handoff-"));
    let runtime, frontend, browser, provider, page, release;
    let calls = 0;
    const gate = new Promise((resolve) => (release = resolve));
    t.after(async () => {
      release();
      if (page)
        try {
          await page.evaluate("window.releaseAssetGate?.()");
        } catch {}
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      if (runtime) await runtime.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      for await (const chunk of req) {
      }
      calls++;
      res.setHeader("content-type", "text/event-stream");
      const delta = (text) =>
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: text } }] }) +
        "\n\n";
      res.write(delta("Synthetic streamed text"));
      await gate;
      res.end(delta(" final {{image::hero}}") + "data: [DONE]\n\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20, progressIntervalMs: 25 },
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        sendWithEnter: true,
        streamingDisplayOptimizationMode: "strong",
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        forceReplaceUrl:
          "http://127.0.0.1:" +
          provider.address().port +
          "/v1/chat/completions",
        customTokenizer: "tik",
        useStreaming: true,
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic",
      },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic stream" } },
      definition: {
        type: "character",
        name: "Synthetic stream",
        desc: "Synthetic",
        supaMemory: false,
        firstMessage: "Synthetic greeting",
      },
    });
    const { createServer: createVite } = await import("vite");
    frontend = await createVite({
      configFile: resolve(dev, "vite.config.ts"),
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
    browser = await launchChromium(directory);
    page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(() => page.evaluate(ui("s.scopeReady")));
    await page.evaluate(
      ui(
        `(async()=>{const bridge=r(),canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,2,2);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));window.streamImagePath=await bridge.uploadAsset(bytes,'Synthetic.png');bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['hero',window.streamImagePath,'png']]);return true;})()`,
      ),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(-1,true,'c')?.character.additionalAssets?.length===1",
        ),
      ),
    );
    await page.evaluate(
      ui(
        `(()=>{const bridge=r(),original=bridge.assetUrl.bind(bridge);window.assetGateStarts=0;window.assetGate=new Promise(resolve=>window.releaseAssetGate=resolve);bridge.assetUrl=path=>{const value=original(path);if(path===window.streamImagePath){window.assetGateStarts++;return window.assetGate.then(()=>value)}return value;};})()`,
      ),
    );
    await page.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic user input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.messages.some(m=>m.role==='char'&&m.data==='Synthetic streamed text')",
        ),
      ),
    );
    const progressId = await page.evaluate(
      ui(
        "s.messages.find(m=>m.role==='char'&&m.data==='Synthetic streamed text').chatId",
      ),
    );
    await until(() =>
      page.evaluate(
        `document.querySelector('[data-message-id="${progressId}"] .whitespace-pre-wrap')?.textContent==='Synthetic streamed text'`,
      ),
    );
    await page.evaluate(
      `window.handoffRow=document.querySelector('[data-message-id="${progressId}"]');window.handoffRaw=window.handoffRow.querySelector('.whitespace-pre-wrap');window.handoffSamples=[];window.handoffSampling=true;const sample=()=>{if(!window.handoffSampling)return;window.handoffSamples.push({at:performance.now(),text:window.handoffRow.querySelector('.chattext')?.textContent??'',connected:window.handoffRow.isConnected});requestAnimationFrame(sample);};requestAnimationFrame(sample);`,
    );
    const before = await page.evaluate(
      "({text:window.handoffRow.querySelector('.chattext').textContent,connected:window.handoffRow.isConnected})",
    );
    release();
    await until(() => page.evaluate("window.assetGateStarts>0"));
    await until(() =>
      page.evaluate(ui("s.jobs.some(j=>j.state==='completed')")),
    );
    await delay(250);
    const preparing = await page.evaluate(
      `({sameRaw:window.handoffRaw===window.handoffRow.querySelector('.whitespace-pre-wrap'),text:window.handoffRow.querySelector('.chattext').textContent,sameRow:window.handoffRow===document.querySelector('[data-message-id="${progressId}"]'),connected:window.handoffRow.isConnected})`,
    );
    await page.evaluate("window.releaseAssetGate()");
    await until(() =>
      page.evaluate("!!window.handoffRow.querySelector('.chattext img')"),
    );
    await page.evaluate(
      "window.handoffRow.querySelector('.chattext img').decode()",
    );
    await delay(50);
    const after = await page.evaluate(
      `({rawSpans:window.handoffRow.querySelectorAll('.whitespace-pre-wrap').length,text:window.handoffRow.querySelector('.chattext').textContent,sameRow:window.handoffRow===document.querySelector('[data-message-id="${progressId}"]'),width:window.handoffRow.querySelector('.chattext img').naturalWidth})`,
    );
    const samples = await page.evaluate(
      "(window.handoffSampling=false,window.handoffSamples)",
    );
    const job = await runtime.store.call(
      "getJob",
      await page.evaluate(ui("s.jobs.find(j=>j.state==='completed').id")),
    );
    const sources = [
      "src/lib/ChatScreens/ChatBody.svelte",
      "src/lib/ChatScreens/Chat.svelte",
      "src/lib/ChatScreens/Chats.svelte",
      "src/ts/parser/parser.svelte.ts",
      "server/browser/displayStreamingHandoffUi.test.cjs",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sources.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(join(dev, path)))
            .digest("hex"),
        ]),
      ),
    );
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualNativeGeneration: true,
      strongStreaming: true,
      actualUploadHttpAndDecode: true,
      delayedUrlCapability: true,
      progressId,
      jobState: job.state,
      calls,
      before,
      preparing,
      after,
      samples,
      blankFrames: samples.filter((s) => !s.text.trim()).length,
      fixed:
        preparing.text.includes("Synthetic streamed text") &&
        samples.every((s) => s.text.trim() && s.connected),
      sourceHashes,
    };
    if (process.env.RISU_STREAM_HANDOFF_OUTPUT)
      await writeFile(
        process.env.RISU_STREAM_HANDOFF_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
    assert.equal(calls, 1);
    assert.equal(job.state, "completed");
    assert.equal(after.width, 2);
    assert.equal(preparing.sameRow, true);
    assert.equal(after.sameRow, true);
    assert.match(after.text, /Synthetic streamed text final/);
    if (process.env.RISU_STREAM_HANDOFF_BASELINE === "TRUE") {
      assert.equal(result.fixed, false);
      assert.equal(preparing.text, "");
      assert.ok(result.blankFrames > 0);
    } else {
      assert.equal(result.fixed, true);
      assert.equal(result.blankFrames, 0);
      assert.equal(preparing.sameRaw, true);
      assert.equal(after.rawSpans, 0);
    }
  },
);
