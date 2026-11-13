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
const dev = resolve(__dirname, "../..");
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
  throw Error(
    "Provisional display condition timed out: " + JSON.stringify(value),
  );
}

for (const mode of ["off", "balanced"])
  test(
    `${mode} displays owned pending input and native progress with original CBS regex Lua and assets before canonical persistence`,
    { timeout: 150000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-provisional-"));
      let runtime, frontend, browser, provider, page, peer;
      let calls = 0,
        admission;
      let advance, finish;
      const next = new Promise((resolve) => (advance = resolve));
      const final = new Promise((resolve) => (finish = resolve));
      t.after(async () => {
        advance();
        finish();
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
        const delta = (content) =>
          "data: " +
          JSON.stringify({ choices: [{ delta: { content } }] }) +
          "\n\n";
        res.write(delta("Progress [DISPLAY] {{getvar::tone}} {{image::hero}}"));
        await next;
        res.write(delta(" next"));
        await final;
        res.end(delta(" final") + "data: [DONE]\n\n");
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
          chatLoadInitialPages: 30,
          streamingDisplayOptimizationMode: mode,
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
        chat: { chatId: "a", metadata: { name: "Synthetic provisional" } },
        definition: {
          type: "character",
          name: "Synthetic provisional",
          desc: "Synthetic",
          supaMemory: false,
          firstMessage: "Synthetic greeting",
          defaultVariables: "tone=before\npreview_effect=0",
          customModuleToggle: "provisional=Provisional toggle",
          customscript: [
            { in: "\\[DISPLAY\\]", out: "REGEX", type: "editdisplay" },
          ],
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `local canonicalCalls=0
listenEdit('editDisplay', function(id,data,meta)
  if data=='Synthetic greeting' then
    canonicalCalls=canonicalCalls+1
    return '<span class="canonical-calls">Synthetic greeting '..tostring(canonicalCalls)..'</span>'
  end
  if string.find(data,'Pending',1,true) or string.find(data,'Progress',1,true) then
    setChatVar(id,'preview_effect','1')
    return '<strong>'..data..' LUA:'..cbs('{{getvar::preview_effect}}')..' INDEX:'..tostring(meta.index)..'</strong>'
  end
  return data
end)`,
                },
              ],
            },
          ],
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
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
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
          `(async()=>{const bridge=r(),canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));const path=await bridge.uploadAsset(bytes,'Synthetic.png');bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['hero',path,'png']]);})()`,
        ),
      );
      await until(() =>
        page.evaluate(
          ui(
            "s.pending.length===0&&r().captureDisplay(-1,true,'c')?.character.additionalAssets?.length===1",
          ),
        ),
      );
      peer = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        peer.evaluate(
          "!!document.querySelector('[data-runtime-ready=\"true\"]')",
        ),
      );
      await peer.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => peer.evaluate(ui("s.scopeReady")));
      page.on("Fetch.requestPaused", (event) => {
        admission = event.requestId;
      });
      await page.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/jobs", requestStage: "Request" },
        ],
      });
      const draft =
        "Pending [DISPLAY] {{getvar::tone}}\nSynthetic second line\nSynthetic third line\nSynthetic fourth line";
      const composer = "document.querySelector('textarea.input-text')";
      const emptyComposerHeight = await page.evaluate(
        `${composer}.getBoundingClientRect().height`,
      );
      await page.evaluate(
        `(()=>{const input=${composer};input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await until(() =>
        page.evaluate(
          `${composer}.getBoundingClientRect().height>${emptyComposerHeight + 40}`,
        ),
      );
      await page.evaluate(
        mode === "off"
          ? `${composer}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`
          : "document.querySelector('.button-icon-send').click()",
      );
      await until(() => admission);
      await until(() => page.evaluate(`${composer}.value===''`));
      const clearedComposer = await page.evaluate(
        `(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const input=${composer};return {value:input.value,height:input.getBoundingClientRect().height};})()`,
      );
      assert.equal(clearedComposer.value, "");
      assert.ok(
        clearedComposer.height <= emptyComposerHeight + 1,
        "The four-line composer must shrink while server admission is held",
      );
      const inputId = await until(() =>
        page.evaluate(ui("s.messages.find(m=>m.role==='user')?.chatId")),
      );
      const row = (id) => `document.querySelector('[data-message-id="${id}"]')`;
      try {
        await until(
          () =>
            page.evaluate(
              `${row(inputId)}?.querySelector('.chattext strong')?.textContent`,
            ),
          (text) =>
            text?.startsWith("Pending REGEX before") &&
            text.includes("LUA:1 INDEX:0"),
          10000,
        );
      } catch (error) {
        const diagnostic = await page.evaluate(
          ui(
            `({pending:s.pending.length,messages:s.messages,display:${row(inputId)}?.querySelector('.chattext')?.textContent,canonical:r().captureDisplay(-1,false)?.chat.message.length})`,
          ),
        );
        t.diagnostic(
          JSON.stringify({ mode, phase: "pending_input", diagnostic, calls }),
        );
        if (process.env.RISU_PROVISIONAL_OUTPUT)
          await writeFile(
            process.env.RISU_PROVISIONAL_OUTPUT + "-" + mode + "-failure.json",
            JSON.stringify(diagnostic, null, 2),
          );
        throw error;
      }
      assert.equal(calls, 0);
      let chat = await runtime.store.call("snapshot", "a");
      assert.equal(chat.messages.length, 0);
      assert.equal(
        chat.variables.find((row) => row.key === "$preview_effect")?.value,
        undefined,
      );
      await page.evaluate(`window.pendingRow=${row(inputId)}`);
      await page.send("Fetch.continueRequest", { requestId: admission });
      await page.send("Fetch.disable");
      const progressId = await until(() =>
        page.evaluate(
          ui(
            "s.messages.find(m=>m.role==='char'&&m.data.startsWith('Progress'))?.chatId",
          ),
        ),
      );
      await until(
        () =>
          page.evaluate(
            `({strong:!!${row(progressId)}?.querySelector('.chattext strong'),text:${row(progressId)}?.querySelector('.chattext')?.textContent})`,
          ),
        (value) =>
          value.strong &&
          value.text?.includes("Progress REGEX before") &&
          value.text.includes("LUA:1 INDEX:1"),
      );
      await until(() =>
        page.evaluate(
          `${row(progressId)}?.querySelector('.chattext img')?.naturalWidth===2`,
        ),
      );
      await until(
        () =>
          peer.evaluate(
            `${row(progressId)}?.querySelector('.chattext')?.textContent`,
          ),
        (text) => text?.includes("LUA:1 INDEX:1"),
      );
      await until(() =>
        peer.evaluate(
          `${row(progressId)}?.querySelector('.chattext img')?.naturalWidth===2`,
        ),
      );
      const toggle =
        "document.querySelector('input[alt=\"Provisional toggle\"]')";
      await until(() => page.evaluate(`!!${toggle}`));
      const canonicalCalls =
        "document.querySelector('.x-risu-canonical-calls')?.textContent";
      const priorCalls = await until(() => page.evaluate(canonicalCalls));
      await page.evaluate(`${toggle}.click()`);
      await until(() => peer.evaluate(`${toggle}.checked`));
      // A real input/clock change still starts the stateful original callback.
      await until(
        () => page.evaluate(canonicalCalls),
        (value) => value && value !== priorCalls,
      );
      await until(() => peer.evaluate(ui("s.pending.length===0")));
      // Quiesce existing input/admission work before the next provider delta.
      const baseCalls = await until(async () => {
        const first = await page.evaluate(canonicalCalls),
          second = await peer.evaluate(canonicalCalls);
        await delay(200);
        return first &&
          second &&
          first === (await page.evaluate(canonicalCalls)) &&
          second === (await peer.evaluate(canonicalCalls))
          ? { first, second }
          : undefined;
      });
      await page.evaluate(
        `window.progressRow=${row(progressId)};window.progressImage=window.progressRow.querySelector('.chattext img')`,
      );
      chat = await runtime.store.call("snapshot", "a");
      assert.equal(chat.messages.length, 0);
      assert.equal(
        chat.variables.find((row) => row.key === "$preview_effect")?.value,
        undefined,
      );
      advance();
      await until(
        () =>
          page.evaluate(
            "window.progressRow.querySelector('.chattext')?.textContent",
          ),
        (text) => /\bnext\b/.test(text ?? ""),
      );
      await until(
        () =>
          peer.evaluate(
            `window.document.querySelector('[data-message-id="${progressId}"] .chattext')?.textContent`,
          ),
        (text) => /\bnext\b/.test(text ?? ""),
      );
      assert.equal(
        await page.evaluate(canonicalCalls),
        baseCalls.first,
        "Pure progress must retain the canonical stateful Lua owner",
      );
      assert.equal(
        await peer.evaluate(canonicalCalls),
        baseCalls.second,
        "A peer must retain its own canonical Lua owner",
      );
      assert.equal(
        await page.evaluate(
          `window.progressRow===${row(progressId)}&&window.pendingRow===${row(inputId)}&&window.progressImage===window.progressRow.querySelector('.chattext img')`,
        ),
        true,
      );
      finish();
      try {
        await until(() =>
          page.evaluate(
            ui("s.jobs.some(j=>j.state==='completed')&&s.pending.length===0"),
          ),
        );
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            mode,
            phase: "completion",
            diagnostic: await page.evaluate(
              ui("({jobs:s.jobs,pending:s.pending,errors:s.errors})"),
            ),
          }),
        );
        throw error;
      }
      await until(
        () =>
          page.evaluate(
            "window.progressRow.querySelector('.chattext')?.textContent",
          ),
        (text) => text?.includes(" final"),
      );
      await until(
        async () =>
          (await runtime.store.call("snapshot", "a")).variables.find(
            (row) => row.key === "$preview_effect",
          )?.value === "1",
      );
      chat = await runtime.store.call("snapshot", "a");
      assert.equal(chat.messages.length, 2);
      assert.equal(calls, 1);
      assert.equal(
        await page.evaluate(
          `window.progressRow===${row(progressId)}&&window.pendingRow===${row(inputId)}&&window.progressImage===window.progressRow.querySelector('.chattext img')`,
        ),
        true,
      );
      assert.equal(
        chat.messages.find((m) => m.id === inputId).message.data,
        draft.replace("{{getvar::tone}}", "before"),
      );
      const jobId = await page.evaluate(
        ui("s.jobs.find(j=>j.state==='completed').id"),
      );
      assert.equal(
        (await runtime.store.call("getJobCommand", jobId)).input,
        draft,
      );
      const result = {
        mode,
        pendingInputVisibleBeforeAdmission: true,
        composerShrinksBeforeAdmission: true,
        composerSubmission: mode === "off" ? "Enter" : "send button",
        emptyComposerHeight,
        clearedComposerHeight: clearedComposer.height,
        progressProcessedBeforeCompletion: true,
        privateEffectsUntilCanonical: true,
        originalCbsRegexLua: true,
        twoIndependentBrowserContexts: true,
        peerToggleWhileProviderHeld: true,
        stableRowsAndDecodedImage: true,
        calls,
        canonicalMessages: chat.messages.length,
      };
      t.diagnostic(JSON.stringify(result));
      if (process.env.RISU_PROVISIONAL_OUTPUT)
        await writeFile(
          process.env.RISU_PROVISIONAL_OUTPUT + "-" + mode + ".json",
          JSON.stringify(result, null, 2),
        );
    },
  );
