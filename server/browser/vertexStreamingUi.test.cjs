"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Vertex streaming UI timeout: " + JSON.stringify(value));
}

test(
  "chat streaming switch persists across devices; native Vertex previews Unicode before completion and finishes after all tabs close",
  { timeout: 150000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-vertex-stream-"));
    let runtime, frontend, browser, provider;
    let finishStream, finishBatch;
    const streamGate = new Promise((resolve) => (finishStream = resolve));
    const batchGate = new Promise((resolve) => (finishBatch = resolve));
    const requests = [];
    t.after(async () => {
      finishStream();
      finishBatch();
      await browser?.close();
      await frontend?.close();
      await runtime?.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });
    const packet = (text) => ({
      candidates: [{ content: { parts: [{ text }] } }],
    });
    const event = (text) =>
      "data: " + JSON.stringify(packet(text)) + "\r\n\r\n";
    provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body: JSON.parse(body) });
      if (req.url.includes(":streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const bytes = Buffer.from(event("중간 {{getvar::tone}} 표시 🌟"));
        const split = bytes.indexOf(Buffer.from("중간")) + 1;
        res.write(bytes.subarray(0, split));
        await delay(25);
        res.write(bytes.subarray(split));
        await streamGate;
        res.end(event(" 완료"));
      } else {
        res.setHeader("content-type", "application/json");
        await batchGate;
        res.end(JSON.stringify(packet("일괄 완료")));
      }
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
        language: "ko",
        autoTranslate: false,
        sendWithEnter: true,
        useStreaming: false,
        aiModel: "reverse_proxy",
        customAPIFormat: 6,
        customProxyRequestModel: "gemini-3.1-pro-preview",
        forceReplaceUrl: "http://127.0.0.1:" + provider.address().port + "/v1/",
        google: {
          projectId: "synthetic-project",
          accessToken: "synthetic-key",
        },
        vertexAccessToken: "synthetic-token",
        vertexAccessTokenExpires: Date.now() + 60000,
        customTokenizer: "tik",
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic",
      },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic Vertex" } },
      definition: {
        type: "character",
        name: "Synthetic Vertex",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        defaultVariables: "tone=가나다",
        customscript: [
          { in: "표시", out: "출력", type: "editdisplay" },
          { in: "완료", out: "저장됨", type: "editoutput" },
        ],
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay',function(id,data) return '<strong>'..data..' 화면Lua</strong>' end)
listenEdit('editOutput',function(id,data) setChatVar(id,'saved','yes') return data..' 출력Lua' end)`,
              },
            ],
          },
        ],
      },
    });
    const { createServer: createVite } = await import("vite");
    frontend = await createVite({
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    async function open() {
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      return page;
    }
    const a = await open(),
      b = await open();
    const control = "document.querySelector('[data-runtime-streaming]')";
    assert.equal(await a.evaluate(`${control}.checked`), false);
    assert.equal(await b.evaluate(`${control}.checked`), false);
    await a.evaluate(`${control}.click()`);
    await until(() => b.evaluate(`${control}.checked`));
    await until(() => a.evaluate(ui("s.pending.length===0")));
    const send = (page, text) =>
      page.evaluate(
        `(()=>{const input=document.querySelector('textarea.input-text');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
      );
    await send(a, "Synthetic Vertex request");
    const jobId = await until(() =>
      a.evaluate(ui("s.jobs.find(j=>j.state==='running')?.id")),
    );
    const messageId = await until(() =>
      a.evaluate(
        ui(
          "s.messages.find(m=>m.role==='char'&&m.data.startsWith('중간'))?.chatId",
        ),
      ),
    );
    const shown = `document.querySelector('[data-message-id="${messageId}"] .chattext')?.textContent`;
    await until(
      () => a.evaluate(shown),
      (text) =>
        text?.includes("중간 가나다 출력 🌟") && text.includes("화면Lua"),
    );
    await until(
      () => b.evaluate(shown),
      (text) => text?.includes("중간 가나다 출력 🌟"),
    );
    assert.equal(await a.evaluate(`${control}.disabled`), true);
    assert.equal(
      (await runtime.store.call("snapshot", "a")).messages.length,
      0,
    );
    assert.equal(
      (await runtime.store.call("snapshot", "a")).variables.some(
        (v) => v.key === "$saved",
      ),
      false,
    );
    assert.equal(requests.length, 1);
    assert.match(
      requests[0].path,
      /gemini-3\.1-pro-preview:streamGenerateContent/,
    );
    assert.ok(Array.isArray(requests[0].body.contents));
    await b.send("Page.reload");
    await until(() =>
      b.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    await b.evaluate("document.querySelector('[data-character-id=c]').click()");
    await until(
      () => b.evaluate(shown),
      (text) => text?.includes("중간 가나다 출력 🌟"),
    );
    await a.close();
    await b.close();
    finishStream();
    const completed = await until(
      () => runtime.store.call("getJob", jobId),
      (j) => j.state === "completed" || j.state === "failed",
    );
    assert.equal(
      completed.state,
      "completed",
      JSON.stringify(completed.result),
    );
    const final = await runtime.store.call("snapshot", "a");
    assert.equal(final.messages.length, 2);
    assert.equal(final.messages[1].id, messageId);
    assert.match(final.messages[1].message.data, /중간.*🌟 저장됨 출력Lua/);
    assert.equal(final.variables.find((v) => v.key === "$saved")?.value, "yes");
    assert.equal(requests.length, 1);
    const c = await open();
    await until(
      () => c.evaluate(shown),
      (text) => text?.includes("저장됨 출력Lua"),
    );
    assert.equal(await c.evaluate(`${control}.checked`), true);
    await c.evaluate(`${control}.click()`);
    await until(() => c.evaluate(ui("s.pending.length===0")));
    await send(c, "Synthetic batch request");
    await until(() => requests.length === 2);
    assert.match(requests[1].path, /:generateContent\?/);
    assert.equal(
      await c.evaluate(ui("s.messages.some(m=>m.data.startsWith('일괄'))")),
      false,
    );
    assert.equal(
      (await runtime.store.call("snapshot", "a")).messages.length,
      2,
    );
    finishBatch();
    await until(() =>
      c.evaluate(
        ui(
          "s.jobs.filter(j=>j.state==='completed').length===2&&s.pending.length===0",
        ),
      ),
    );
    const saved = await runtime.store.call("snapshot", "a");
    assert.equal(saved.messages.length, 4);
    assert.equal(saved.messages[3].message.data, "일괄 저장됨 출력Lua");
    assert.equal(await c.evaluate(`${control}.checked`), false);
    const result = {
      streamingEnabledByOriginalChatControl: true,
      twoIndependentContexts: true,
      vertexRequestFormatAndEndpoint: true,
      fragmentedKoreanAndEmoji: true,
      partialVisibleBeforeProviderFinish: true,
      originalCbsRegexDisplayLua: true,
      noCanonicalWriteBeforeCompletion: true,
      peerReloadShowsSameProgressId: true,
      allTabsClosedBeforeCompletion: true,
      originalOutputRegexLuaSaved: true,
      stableFinalMessageId: true,
      newDeviceSeesFinal: true,
      explicitStreamingOffUsesBatch: true,
      syntheticProviderCalls: requests.length,
      canonicalMessages: saved.messages.length,
    };
    t.diagnostic(JSON.stringify(result));
    if (process.env.RISU_VERTEX_STREAM_OUTPUT)
      await writeFile(
        process.env.RISU_VERTEX_STREAM_OUTPUT,
        JSON.stringify(result, null, 2),
      );
  },
);
