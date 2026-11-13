"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
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
  throw Error("Task turn condition timed out: " + JSON.stringify(value));
}
test(
  "actual original parser pins configuration before a held task turn, retains finalizer cancellation and supports timer fallback",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-task-turn-"));
    let runtime, frontend, browser, page;
    t.after(async () => {
      if (page)
        try {
          await page.evaluate(
            "window.releaseTaskGate?.();window.restoreTaskScheduler?.()",
          );
        } catch {}
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
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        customQuotes: true,
        customQuotesData: ["«", "»", "‹", "›"],
        hideAllImages: false,
      },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic task" } },
      definition: {
        type: "character",
        name: "Synthetic task",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
      },
    });
    await runtime.store.call("applyCommand", "message", {
      type: "append-message",
      chatId: "a",
      messageId: "m",
      message: { role: "char", data: "Synthetic task owner" },
    });
    const { createServer } = await import("vite");
    frontend = await createServer({
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
        `(async()=>{const bridge=r(),canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,2,2);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));window.taskAssetPath=await bridge.uploadAsset(bytes,'Synthetic.png');bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['hero',window.taskAssetPath,'png']]);return true;})()`,
      ),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(0,false,'c','m')?.character.additionalAssets?.length===1",
        ),
      ),
    );
    await page.evaluate(
      `(async()=>{const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');window.taskParser=ParseMarkdown;const descriptor=Object.getOwnPropertyDescriptor(window,'scheduler'),scheduler=window.scheduler;const original=scheduler?.yield?.bind(scheduler)??(()=>new Promise(resolve=>setTimeout(resolve,0)));window.restoreTaskScheduler=()=>{if(descriptor)Object.defineProperty(window,'scheduler',descriptor);else delete window.scheduler;};window.taskGate=new Promise(resolve=>window.releaseTaskGate=resolve);window.taskGateStarts=0;let arm=true;Object.defineProperty(window,'scheduler',{configurable:true,value:{yield(){if(arm){arm=false;window.taskGateStarts++;return window.taskGate;}return original();}}});window.taskPresentation={};window.taskInput='"Synthetic quote" {{image::hero}}';window.taskParsing=ParseMarkdown(window.taskInput,'c','notrim',0,{messageId:'m'},window.taskPresentation);return true;})()`,
    );
    assert.equal(await page.evaluate("window.taskGateStarts"), 1);
    await page.evaluate(
      ui(
        "r().setFields([{target:{scope:'resource',resourceKind:'settings',entityId:'global',key:'customQuotesData'},value:['[',']','{','}']},{target:{scope:'resource',resourceKind:'settings',entityId:'global',key:'hideAllImages'},value:true}])",
      ),
    );
    await until(
      () =>
        page.evaluate(
          ui(
            "({pending:s.pending.map(p=>({state:p.state,command:p.command,error:p.error})),error:s.error,scopeReady:s.scopeReady,capturedHide:r().captureDisplay(0,false,'c','m')?.database.hideAllImages})",
          ),
        ),
      (value) => value.pending.length === 0 && value.capturedHide === true,
    );
    const during = await page.evaluate(
      ui(
        "({source:s.messages.find(m=>m.chatId==='m').data,hide:r().captureDisplay(0,false,'c','m').database.hideAllImages,quotes:[...r().captureDisplay(0,false,'c','m').database.customQuotesData]})",
      ),
    );
    await page.evaluate("window.releaseTaskGate()");
    await page.evaluate(
      "(async()=>{window.taskOldHtml=await window.taskParsing;})()",
    );
    assert.equal(
      await page.evaluate(
        "(async()=>await window.taskPresentation.finalize(window.taskOldHtml,()=>false))()",
      ),
      undefined,
    );
    const old = await page.evaluate(
      `(async()=>{const html=await window.taskPresentation.finalize(window.taskOldHtml,()=>true);const box=document.createElement('div');box.innerHTML=html;return {text:box.textContent,images:box.querySelectorAll('img').length,src:box.querySelector('img')?.getAttribute('src'),html};})()`,
    );
    // Force the existing setTimeout path, independent of Scheduler API support.
    await page.evaluate(
      "(()=>{Object.defineProperty(window,'scheduler',{configurable:true,value:undefined});return true;})()",
    );
    const fresh = await page.evaluate(
      `(async()=>{const presentation={};const html=await window.taskParser(window.taskInput,'c','notrim',0,{messageId:'m'},presentation);const final=await presentation.finalize(html,()=>true);const box=document.createElement('div');box.innerHTML=final;return {text:box.textContent,images:box.querySelectorAll('img').length,html:final};})()`,
    );
    await page.evaluate("window.restoreTaskScheduler()");
    assert.match(old.text, /«Synthetic quote»/);
    assert.equal(old.images, 1);
    assert.match(old.src, /\/api\/runtime\/assets\//);
    assert.match(fresh.text, /\[Synthetic quote\]/);
    assert.equal(fresh.images, 0);
    assert.equal(during.source, "Synthetic task owner");
    assert.equal(during.hide, true);
    assert.deepEqual(during.quotes, ["[", "]", "{", "}"]);
    const after = await page.evaluate(
      ui(
        "({source:s.messages.find(m=>m.chatId==='m').data,revision:r().captureDisplay(0,false,'c','m').message.revision,pending:s.pending.length,error:s.error})",
      ),
    );
    assert.deepEqual(after, {
      source: "Synthetic task owner",
      revision: 1,
      pending: 0,
      error: "",
    });
    await page.evaluate(
      ui(
        `r().setField({scope:'character',entityId:'c',key:'triggerscript'},[{type:'manual',conditions:[],effect:[{type:'triggerlua',code:"local calls=0; listenEdit('editDisplay',function(id,data) if data=='Synthetic canceled probe' or data=='Synthetic live probe' then calls=calls+1;return 'Synthetic calls '..calls end;return data end)"}]}])`,
      ),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(0,false,'c','m')?.triggers.length===1",
        ),
      ),
    );
    await page.evaluate(
      `(()=>{const scheduler=window.scheduler,original=scheduler?.yield?.bind(scheduler)??(()=>new Promise(r=>setTimeout(r,0)));let arm=true;window.ownerGate=new Promise(r=>window.releaseTaskGate=r);window.ownerGateStarts=0;window.ownerRetired=false;Object.defineProperty(window,'scheduler',{configurable:true,value:{yield(){if(arm){arm=false;window.ownerGateStarts++;return window.ownerGate;}return original();}}});window.ownerPresentation={current:()=>!window.ownerRetired};window.ownerParsing=window.taskParser('Synthetic canceled probe','c','notrim',0,{messageId:'m'},window.ownerPresentation);return true;})()`,
    );
    assert.equal(await page.evaluate("window.ownerGateStarts"), 1);
    await page.evaluate("window.ownerRetired=true;window.releaseTaskGate()");
    assert.equal(await page.evaluate("window.ownerParsing"), "");
    assert.equal(
      await page.evaluate(
        "(async()=>window.ownerPresentation.finalize(await window.ownerParsing,()=>true))()",
      ),
      undefined,
    );
    const live = await page.evaluate(
      `(async()=>{const presentation={current:()=>true};const html=await window.taskParser('Synthetic live probe','c','notrim',0,{messageId:'m'},presentation);const box=document.createElement('div');box.innerHTML=await presentation.finalize(html,()=>true);return box.textContent;})()`,
    );
    assert.equal(live, "Synthetic calls 1\n");
    await page.evaluate("window.restoreTaskScheduler()");
    const paths = [
      "src/ts/parser/parser.svelte.ts",
      "src/ts/runtime/displayScheduling.ts",
      "server/browser/displayTaskTurnUi.test.cjs",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]),
      ),
    );
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualOriginalParser: true,
      heldSchedulerCapability: true,
      pinnedPoliciesBeforeTask: true,
      currentGuardRetained: true,
      timerFallback: true,
      retiredBeforeLuaNotExecuted: true,
      retiredFinalizerCannotAdmit: true,
      subsequentOriginalLuaCallCount: live,
      during,
      old,
      fresh,
      after,
      sourceHashes,
    };
    if (process.env.RISU_DISPLAY_TASK_TURN_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_TASK_TURN_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
