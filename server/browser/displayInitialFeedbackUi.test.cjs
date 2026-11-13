"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const dev = resolve(__dirname, "../..");
async function until(read, predicate = Boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Initial display condition timed out: " + JSON.stringify(value));
}
const probe = `
window.initialProbe={hold:false,held:[],events:[],samples:[],running:false};
const NativeWorker=window.Worker;
window.Worker=class extends NativeWorker {
 constructor(url,options){super(url,options);this.display=options?.name==='risu-display-lua';
  if(this.display)this.addEventListener('message',e=>{const m=e.data;if(m?.type==='result'||m?.type==='error')window.initialProbe.events.push({type:m.type,id:m.id})});
 }
 postMessage(m,...args){const p=window.initialProbe;
  if(this.display&&m?.type==='execute'){
   p.events.push({type:'execute',id:m.id,content:m.input.content});
   if(p.hold&&m.input.content.includes('Pending')){p.held.push(()=>super.postMessage(m,...args));return;}
  }
  return super.postMessage(m,...args);
 }
};
window.releaseInitialWorker=()=>{const p=window.initialProbe;p.hold=false;for(const send of p.held.splice(0))send()};
window.observeInitial=()=>{const p=window.initialProbe;p.started=performance.now();p.running=true;
 const prior=new Set([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId));
 function frame(){if(!p.running)return;
  const row=[...document.querySelectorAll('[data-message-id]')].find(e=>!prior.has(e.dataset.messageId));
  if(row){window.initialUserRow??=row;const body=row.querySelector('.chattext'),status=body?.querySelector('[data-display-preparation]');
   p.samples.push({at:performance.now(),id:row.dataset.messageId,text:body?.textContent??'',status:status?.dataset.displayPreparation,role:status?.getAttribute('role'),busy:status?.getAttribute('aria-busy')});
  }
  requestAnimationFrame(frame);
 }requestAnimationFrame(frame);
 document.querySelector('.button-icon-send').click();
};`;

for (const options of [
  { name: "desktop", mobile: false, beta: false, language: "en" },
  { name: "mobile-general", mobile: true, beta: false, language: "en" },
  { name: "mobile-beta", mobile: true, beta: true, language: "ko" },
])
  test(
    `${options.name}: first body gives safe feedback while actual display Lua waits; empty results, existing DOM and original transformations remain intact`,
    { timeout: 150000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-initial-display-"));
      let runtime, frontend, browser, page, admission;
      t.after(async () => {
        if (page) {
          console.log(
            JSON.stringify({
              fixtureTeardown: options.name,
              diagnostic: await page
                .evaluate(
                  "({failure:document.querySelector('[data-message-id=lua-failure] .chattext')?.textContent,status:document.querySelector('[data-message-id=lua-failure] [data-display-preparation]')?.dataset.displayPreparation,luaEvents:window.initialProbe?.events.filter(e=>e.content?.includes('LuaFailure')),runtimeErrors:document.body.textContent.includes('Display Lua calculation failed')})",
                )
                .catch(() => null),
            }),
          );
          await page
            .evaluate("window.releaseInitialWorker?.()")
            .catch(() => {});
          // Keep admission paused until its target closes. Failing the request
          // first gives the durable outbox a live window in which to retry it.
          await page.close().catch(() => {});
          page = undefined;
          admission = undefined;
        }
        if (browser) await browser.close();
        if (frontend) await frontend.close();
        if (runtime) await runtime.close();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
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
          language: options.language,
          betaMobileGUI: options.beta,
          autoTranslate: false,
          sendWithEnter: true,
          chatLoadInitialPages: 30,
          streamingDisplayOptimizationMode: "off",
          username: "Synthetic user",
        },
      });
      const image =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      await runtime.store.call("applyCommand", "character", {
        type: "create-character",
        characterId: "c",
        chat: { chatId: "a", metadata: { name: "Synthetic initial display" } },
        definition: {
          type: "character",
          name: "Synthetic initial display",
          desc: "Authored neutral fixture",
          firstMessage: `<input id="initial-kept-input" value="Original"><img id="initial-kept-image" src="${image}"><span class="greeting-tone">{{getvar::tone}}</span>`,
          defaultVariables: "tone=before",
          customscript: [
            { in: "SYNTHETIC_SECRET", out: "REDACTED", type: "editdisplay" },
          ],
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `listenEdit('editDisplay',function(id,data)
 if data=='Empty' then return '' end
 if data=='Failure' then setChatVar(id,'failure_effect','1'); return '<strong class="recovered-body">Recovered '..getChatVar(id,'tone')..'</strong>' end
 if string.find(data,'LuaFailure',1,true) then
  if getChatVar(id,'tone')~='lua-recovered' then error('Synthetic display Lua failure') end
  return '<strong class="lua-recovered-body">Recovered Lua</strong>'
 end
 if string.find(data,'Pending',1,true) then return '<strong class="ready-body">'..data:gsub('LUA_SECRET','LUA_HIDDEN')..' LUA:ready</strong>' end
 return data
end)`,
                },
              ],
            },
          ],
        },
      });
      const vite = await import("vite");
      let admissionGateInstalled = false,
        admissionAttempts = 0;
      const holdAdmission = (server) => {
        admissionGateInstalled = true;
        server.middlewares.use((request, response, next) => {
          if (
            request.method === "POST" &&
            request.url?.split("?")[0] === "/api/runtime/jobs"
          ) {
            admissionAttempts++;
            request.resume();
            request.on("aborted", () => response.destroy());
            return;
          }
          next();
        });
      };
      const common = {
        configFile: resolve(dev, "vite.config.ts"),
        logLevel: "error",
        plugins: [
          {
            name: "initial-display-owned-admission-gate",
            configureServer: holdAdmission,
            configurePreviewServer: holdAdmission,
          },
        ],
        define: {
          "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
          "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
        },
      };
      if (process.env.RISU_INITIAL_DISPLAY_BUILD)
        frontend = await vite.preview({
          ...common,
          build: { outDir: process.env.RISU_INITIAL_DISPLAY_BUILD },
          preview: {
            host: "127.0.0.1",
            port: 0,
            strictPort: false,
            proxy: {
              "/api/runtime": { target: runtime.url, changeOrigin: true },
            },
          },
        });
      else {
        frontend = await vite.createServer({
          ...common,
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
      }
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      browser = await launchChromium(directory);
      page = await browser.page("about:blank", await browser.newContext(), {
        blockHttps: true,
      });
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: options.mobile ? 390 : 1280,
        height: options.mobile ? 844 : 900,
        deviceScaleFactor: options.mobile ? 3 : 1,
        mobile: options.mobile,
      });
      if (options.mobile) {
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
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: probe,
      });
      await page.send("Page.navigate", { url });
      await page.send("Page.bringToFront");
      await until(() =>
        page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      if (options.beta) {
        await page.evaluate(
          "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='캐릭터').click()",
        );
        await until(() =>
          page.evaluate(
            "[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Synthetic initial display'))",
          ),
        );
        await page.evaluate(
          "[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Synthetic initial display')).click()",
        );
      } else
        await page.evaluate(
          "document.querySelector('[data-character-id=c]').click()",
        );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('#initial-kept-input')&&document.querySelector('#initial-kept-image')?.naturalWidth===1",
        ),
      );
      const betaActual = await page.evaluate(
        "!![...document.querySelectorAll('div.h-16.px-4')].find(e=>e.querySelector('svg.lucide-arrow-left')&&e.querySelector('svg.lucide-menu')&&e.textContent.trim()==='Synthetic initial display')",
      );
      assert.equal(betaActual, options.beta);
      await until(() =>
        page.evaluate(
          "document.querySelectorAll('[data-display-preparation]').length===0",
        ),
      );
      await page.evaluate(
        "window.keptInput=document.querySelector('#initial-kept-input');window.keptImage=document.querySelector('#initial-kept-image');window.keptInput.value='Local typing';window.initialProbe.hold=true;",
      );
      page.on("Fetch.requestPaused", (event) => {
        admission = event.requestId;
      });
      await page.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/jobs", requestStage: "Request" },
        ],
      });
      await page.evaluate(
        "(()=>{const input=document.querySelector('textarea.input-text');input.value='Pending SYNTHETIC_SECRET LUA_SECRET {{getvar::tone}}';input.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('.button-icon-send')"),
      );
      await page.evaluate("window.observeInitial()");
      await until(() => admission);
      await until(() => page.evaluate("window.initialProbe.held.length>0"));
      await page.evaluate(
        "new Promise(resolve=>{let n=0;function f(){if(++n===18)resolve();else requestAnimationFrame(f)}requestAnimationFrame(f)})",
      );
      const held = await page.evaluate(
        "({started:window.initialProbe.started,samples:window.initialProbe.samples,composerEmpty:document.querySelector('textarea.input-text').value==='',sameInput:window.keptInput===document.querySelector('#initial-kept-input'),sameImage:window.keptImage===document.querySelector('#initial-kept-image'),localValue:window.keptInput.value})",
      );
      assert.ok(held.samples.length >= 10);
      assert.ok(
        held.samples.every(
          (s) =>
            s.status === "pending" && s.role === "status" && s.busy === "true",
        ),
      );
      assert.ok(
        held.samples.every(
          (s) =>
            !s.text.includes("SYNTHETIC_SECRET") &&
            !s.text.includes("LUA_SECRET"),
        ),
      );
      const label =
        options.language === "ko"
          ? "메시지 표시 준비 중…"
          : "Preparing message display…";
      assert.ok(held.samples.every((s) => s.text.trim() === label));
      assert.equal(new Set(held.samples.map((s) => s.id)).size, 1);
      assert.ok(held.composerEmpty && held.sameInput && held.sameImage);
      assert.equal(held.localValue, "Local typing");
      if (process.env.RISU_INITIAL_DISPLAY_SCREENSHOTS) {
        const shot = await page.send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          join(
            process.env.RISU_INITIAL_DISPLAY_SCREENSHOTS,
            `initial-display-${options.name}.png`,
          ),
          Buffer.from(shot.data, "base64"),
        );
      }
      await page.evaluate("window.releaseInitialWorker()");
      await until(() =>
        page.evaluate(
          "window.initialUserRow?.querySelector('.x-risu-ready-body')?.textContent==='Pending REDACTED LUA_HIDDEN before LUA:ready'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "window.initialUserRow.querySelectorAll('[data-display-preparation]').length",
        ),
        0,
      );
      await page.evaluate("window.initialProbe.hold=true;");
      await runtime.store.call("applyCommand", "variable", {
        type: "set-chat-variable",
        chatId: "a",
        key: "$tone",
        value: "after",
        expectedRevision: 0,
      });
      await until(() => page.evaluate("window.initialProbe.held.length>0"));
      assert.equal(
        await page.evaluate(
          "window.initialUserRow.querySelector('.chattext').textContent.trim()",
        ),
        "Pending REDACTED LUA_HIDDEN before LUA:ready",
      );
      assert.equal(
        await page.evaluate(
          "window.initialUserRow.querySelectorAll('[data-display-preparation]').length",
        ),
        0,
      );
      await page.evaluate("window.releaseInitialWorker()");
      await until(() =>
        page.evaluate(
          "window.initialUserRow.querySelector('.x-risu-ready-body')?.textContent==='Pending REDACTED LUA_HIDDEN after LUA:ready'",
        ),
      );
      assert.ok(
        await page.evaluate(
          "window.keptInput===document.querySelector('#initial-kept-input')&&window.keptImage===document.querySelector('#initial-kept-image')&&window.keptInput.value==='Local typing'",
        ),
      );
      await runtime.store.call("applyCommand", "empty", {
        type: "append-message",
        chatId: "a",
        messageId: "empty",
        message: { role: "char", data: "Empty" },
      });
      await until(() =>
        page.evaluate(
          "window.initialProbe.events.some(e=>e.type==='execute'&&e.content==='Empty')",
        ),
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-message-id=empty] .chattext')&&document.querySelector('[data-message-id=empty] .chattext').querySelectorAll('[data-display-preparation]').length===0",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=empty] .chattext').textContent.trim()",
        ),
        "",
      );
      await page.evaluate(
        "window.originalOutboxAdd=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(value,...args){if(value?.command?.type==='apply-display-effects')throw Error('Synthetic finalizer persistence failure');return window.originalOutboxAdd.call(this,value,...args)}",
      );
      await runtime.store.call("applyCommand", "failure", {
        type: "append-message",
        chatId: "a",
        messageId: "failure",
        message: { role: "char", data: "Failure" },
      });
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-message-id=failure] [data-display-preparation]')?.dataset.displayPreparation==='failed'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=failure] [data-display-preparation]').getAttribute('aria-busy')",
        ),
        "false",
      );
      const failedLabel =
        options.language === "ko"
          ? "메시지를 표시하지 못했습니다."
          : "Could not display this message.";
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=failure] .chattext').textContent.trim()",
        ),
        failedLabel,
      );
      assert.ok(
        !(await runtime.store.call("snapshot", "a")).variables.some(
          (row) => row.key === "$failure_effect",
        ),
      );
      await page.evaluate(
        "IDBObjectStore.prototype.add=window.originalOutboxAdd",
      );
      await runtime.store.call("applyCommand", "recovery", {
        type: "set-chat-variable",
        chatId: "a",
        key: "$tone",
        value: "recovered",
        expectedRevision: 1,
      });
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-message-id=failure] .x-risu-recovered-body')?.textContent==='Recovered recovered'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=failure]').querySelectorAll('[data-display-preparation]').length",
        ),
        0,
      );
      await runtime.store.call("applyCommand", "lua-failure", {
        type: "append-message",
        chatId: "a",
        messageId: "lua-failure",
        message: { role: "char", data: "LuaFailure SYNTHETIC_SECRET" },
      });
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-message-id=lua-failure] [data-display-preparation]')?.dataset.displayPreparation==='failed'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=lua-failure] .chattext').textContent.trim()",
        ),
        failedLabel,
      );
      const luaAttempts = await page.evaluate(
        "window.initialProbe.events.filter(e=>e.type==='execute'&&e.content.includes('LuaFailure')).length",
      );
      assert.ok(
        luaAttempts >= 4,
        "Original display retry attempts must still execute before failing closed",
      );
      await runtime.store.call("applyCommand", "lua-recovery", {
        type: "set-chat-variable",
        chatId: "a",
        key: "$tone",
        value: "lua-recovered",
        expectedRevision: 2,
      });
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-message-id=lua-failure] .x-risu-lua-recovered-body')?.textContent==='Recovered Lua'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-message-id=lua-failure]').querySelectorAll('[data-display-preparation]').length",
        ),
        0,
      );
      await page.evaluate("window.initialProbe.running=false");
      // Target shutdown can release a CDP-held transport. The fixture's server
      // gate also prevents that request or a retry from reaching job admission.
      await page.close();
      page = undefined;
      admission = undefined;
      await delay(25);
      assert.equal(admissionGateInstalled, true);
      assert.equal((await runtime.store.call("listJobs", "a")).length, 0);
      assert.equal(
        (await runtime.store.call("snapshot", "a")).messages.length,
        3,
      );
      console.log(
        JSON.stringify({
          layout: options.name,
          mobileEmulation: options.mobile,
          betaBranch: betaActual,
          language: options.language,
          heldFrames: held.samples.length,
          statusDelayMs: held.samples[0].at - held.started,
          rawSuppressed: true,
          originalCbsRegexLua: true,
          emptyResultIsReady: true,
          finalizerFailureVisibleAndRecoverable: true,
          luaFailureDoesNotPublishRawSource: true,
          luaFailureAttempts: luaAttempts,
          luaFailureRecoveredOnFreshScope: true,
          existingDomPreserved: true,
          postTeardownJobs: 0,
          admissionGateInstalled,
          postTeardownAdmissionAttempts: admissionAttempts,
          nativeSchedulerStopped: true,
          realDevices: false,
        }),
      );
    },
  );
