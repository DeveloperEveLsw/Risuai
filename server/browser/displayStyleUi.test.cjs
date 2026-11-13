"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Style condition timed out: " + JSON.stringify(value));
}

test(
  "original UI CSS history failure cannot save the preceding Lua proposal before final sanitization",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-style-"));
    const file = join(directory, "synthetic.sqlite");
    let runtime, frontend, browser;
    t.after(async () => {
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
    const source = "Synthetic style boundary source";
    const css = ".style-probe{content:'{{history::role}}';}";
    const hex = Buffer.from(css).toString("hex");
    const returnedMarkup =
      "<risu-style>" +
      hex +
      '</risu-style><span id="synthetic-style-probe">Synthetic style probe</span>';
    const seed = new EntityStore(file);
    try {
      seed.applyCommand("settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: 0,
        payload: {
          didFirstSetup: true,
          language: "en",
          autoTranslate: false,
          returnCSSError: true,
        },
      });
      seed.applyCommand("character", {
        type: "create-character",
        characterId: "c",
        chat: { chatId: "a", metadata: { name: "Synthetic style chat" } },
        definition: {
          type: "character",
          name: "Synthetic style fixture",
          desc: "Synthetic",
          firstMessage: "Synthetic greeting",
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `listenEdit('editDisplay', function(id,data)
            if data == 'Synthetic cancelled style source' then
              setChatVar(id,'style_cancel_observed','unsafe')
              return '<span id="synthetic-cancel-probe">Synthetic cancel probe</span>'
            end
            if data == '${source}' then
              setChatVar(id,'style_boundary_observed','unsafe')
              return ${JSON.stringify(returnedMarkup)}
            end
            return data
          end)`,
                },
              ],
            },
          ],
        },
      });
      for (let i = 0; i < 110; i++)
        seed.applyCommand("append-" + i, {
          type: "append-message",
          chatId: "a",
          messageId: "m-" + i,
          message: {
            role: "char",
            data: i === 109 ? source : "Synthetic style message " + i,
          },
        });
    } finally {
      seed.close();
    }
    const origins = [];
    runtime = await createRuntimeService({
      file,
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 600000 },
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
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await until(() =>
      page.evaluate("!!document.querySelector('[data-character-id=c]')"),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    const capture = await until(() =>
      page.evaluate(
        ui(
          "(()=>{const c=r().captureDisplay(99,false,'c','m-109');return c&&{loaded:r().model.activeChat.message.length,count:c.history.count,ordinal:c.history.ordinal,partial:r().model.hasEarlier}})()",
        ),
      ),
    );
    assert.deepEqual(capture, {
      loaded: 100,
      count: 110,
      ordinal: 109,
      partial: true,
    });
    const parsed = await page.evaluate(`(async()=>{
    const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    try {return {output:await ParseMarkdown(${JSON.stringify(source)},getCurrentCharacter(),'normal',99,{messageId:'m-109'})};}
    catch(error){return {error:String(error)};}
  })()`);
    await until(() => page.evaluate(ui("s.pending.length===0")));
    const stored =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$style_boundary_observed",
      ) ?? null;
    const dom = await page.evaluate(
      "({probe:!!document.querySelector('#synthetic-style-probe'),styles:[...document.querySelectorAll('.chattext style')].map(s=>s.textContent)})",
    );
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualController: true,
      actualLuaWorker: true,
      actualIdbAndSQLite: true,
      actualMobileOS: false,
      hotModuleReload: false,
      capture,
      parsed,
      stored,
      dom,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/ts/parser/parser.svelte.ts",
            "src/lib/ChatScreens/ChatBody.svelte",
            "src/ts/process/scriptings.ts",
            "server/browser/displayStyleUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_STYLE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_STYLE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
    assert.match(parsed.error ?? "", /unloaded history/);
    assert.equal(
      stored,
      null,
      "Actual original UI must not admit Lua before its later CSS/CBS/sanitizer succeeds",
    );
    await page.evaluate(ui("r().model.loadEarlier()"));
    await until(() => page.evaluate(ui("!r().model.hasEarlier")));
    const recovered = await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$style_boundary_observed",
      ),
    );
    const recoveredDom = await until(() =>
      page.evaluate(
        "(()=>{const probe=document.querySelector('#synthetic-style-probe');return probe&&{probe:true,styles:[...document.querySelectorAll('.chattext style')].map(s=>s.textContent)}})()",
      ),
    );
    assert.equal(recovered.value, "unsafe");
    assert.equal(
      recovered.revision,
      1,
      "Successful full-history presentation admits the occurrence once",
    );
    assert.ok(
      recoveredDom.styles.some((style) =>
        style.includes("Synthetic style message 0"),
      ),
    );
    assert.ok(
      recoveredDom.styles.some((style) =>
        style.startsWith(".chattext .x-risu-style-probe"),
      ),
    );
    result.recoveredFullHistory = { stored: recovered, dom: recoveredDom };
    // A fresh ordinary input clock keeps the manual presentation independent
    // of the already accepted full-history occurrence. UI renders of the old
    // source do not change its already equal variable value.
    await runtime.store.call("applyCommand", "fresh-cancel-clock", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$cancel_epoch",
          expectedRevision: 0,
          value: "1",
        },
      ],
    });
    await until(() =>
      page.evaluate(
        ui(
          "r().captureDisplay(109,false,'c','m-109')?.chat.scriptstate.$cancel_epoch==='1'",
        ),
      ),
    );
    const cancelled = await page.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const presentation={};
      const html=await ParseMarkdown('Synthetic cancelled style source',getCurrentCharacter(),'notrim',109,{messageId:'m-109'},presentation);
      window.syntheticPendingStylePresentation={html,presentation};
      return {html,hasFinalizer:typeof presentation.finalize==='function',closed:await presentation.finalize(html,()=>false)};
    })()`);
    const beforeAdmission =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$style_cancel_observed",
      ) ?? null;
    assert.equal(cancelled.hasFinalizer, true);
    assert.equal(cancelled.closed, undefined);
    assert.equal(
      beforeAdmission,
      null,
      "Closed presentation cannot admit its actual Lua proposal",
    );
    const completedMarkup = await page.evaluate(
      "window.syntheticPendingStylePresentation.presentation.finalize(window.syntheticPendingStylePresentation.html,()=>true)",
    );
    assert.match(completedMarkup, /synthetic-cancel-probe/);
    const afterAdmission = await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$style_cancel_observed",
      ),
    );
    assert.equal(afterAdmission.value, "unsafe");
    assert.equal(afterAdmission.revision, 1);
    await page.evaluate(
      "window.syntheticPendingStylePresentation.presentation.finalize(window.syntheticPendingStylePresentation.html,()=>true)",
    );
    await until(() => page.evaluate(ui("s.pending.length===0")));
    const repeated = (await runtime.store.call("snapshot", "a")).variables.find(
      (row) => row.key === "$style_cancel_observed",
    );
    assert.equal(repeated.revision, 1);
    result.presentationCancellation = {
      cancelled,
      beforeAdmission,
      completedMarkup,
      afterAdmission,
      repeated,
    };
    // Hold only the original asset URL capability. The upload, confirmed
    // settings/variable edits, original parser/worker and SQLite remain real.
    const initialSettings = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await runtime.store.call("applyCommand", "style-settings-before", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: initialSettings.revision,
      payload: {
        ...initialSettings.payload,
        hideAllImages: false,
        customQuotes: true,
        customQuotesData: ["OLD-OPEN", "OLD-CLOSE", "OLD-SINGLE", "OLD-END"],
        unformatQuotes: true,
      },
    });
    await runtime.store.call("applyCommand", "style-variable-before", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$style_value",
          expectedRevision: 0,
          value: "before",
        },
      ],
    });
    await page.evaluate(
      ui(`(async()=>{
      const bridge=r(),canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
      canvas.getContext('2d').fillRect(0,0,2,2);
      const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
      window.styleAssetPath=await bridge.uploadAsset(bytes,'Synthetic-style-delay.png');
      bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['synthetic-style-delay',window.styleAssetPath,'png']]);
      return true;
    })()`),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(109,false,'c','m-109')?.character.additionalAssets?.[0]?.[1]===window.styleAssetPath&&r().model.database.hideAllImages===false&&r().model.activeChat.scriptstate.$style_value==='before'",
        ),
      ),
    );
    await page.evaluate(
      ui(`(()=>{
      const bridge=r(),original=bridge.assetUrl.bind(bridge);
      const gate=new Promise(resolve=>window.releaseStyleAsset=resolve);
      window.restoreStyleAsset=()=>bridge.assetUrl=original;
      bridge.assetUrl=path=>{const result=original(path);if(path===window.styleAssetPath){window.styleAssetStarted=true;return gate.then(()=>result)}return result};
      return true;
    })()`),
    );
    const pinnedCss = Buffer.from(
      '.settings-probe{content:"{{getvar::style_value}}";}',
    ).toString("hex");
    const pinnedSource =
      'Synthetic settings boundary {{raw::synthetic-style-delay}} "Synthetic quote" <risu-style>' +
      pinnedCss +
      '</risu-style><img src="https://synthetic.invalid/image.png" style="background-image:url(https://synthetic.invalid/background.png)" />';
    await page.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const presentation={};
      void ParseMarkdown(${JSON.stringify(pinnedSource)},getCurrentCharacter(),'notrim',109,{messageId:'m-109'},presentation)
        .then(async html=>window.pinnedStyleOutput=await presentation.finalize(html))
        .catch(error=>window.pinnedStyleError=String(error)).finally(()=>window.pinnedStyleDone=true);
      return true;
    })()`);
    await until(() => page.evaluate("window.styleAssetStarted===true"));
    assert.equal(await page.evaluate("!!window.pinnedStyleDone"), false);
    const changedSettings = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await runtime.store.call("applyCommand", "style-settings-after", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: changedSettings.revision,
      payload: {
        ...changedSettings.payload,
        hideAllImages: true,
        customQuotesData: ["NEW-OPEN", "NEW-CLOSE", "NEW-SINGLE", "NEW-END"],
      },
    });
    await runtime.store.call("applyCommand", "style-variable-after", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$style_value",
          expectedRevision: 1,
          value: "after",
        },
      ],
    });
    await until(() =>
      page.evaluate(
        ui(
          "r().model.database.hideAllImages===true&&r().model.activeChat.scriptstate.$style_value==='after'",
        ),
      ),
    );
    await page.evaluate(
      "window.releaseStyleAsset();window.restoreStyleAsset();true",
    );
    await until(() => page.evaluate("window.pinnedStyleDone===true"));
    const pinned = await page.evaluate(`(async()=>{
      const {trimMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const probe=document.createElement('div');probe.innerHTML=window.pinnedStyleOutput??'';
      return {error:window.pinnedStyleError??null,html:window.pinnedStyleOutput,
        css:probe.querySelector('style')?.textContent,image:probe.querySelector('img')?.getAttribute('src'),
        background:probe.querySelector('img')?.getAttribute('style'),
        live:trimMarkdown('<img src="https://synthetic.invalid/live.png" style="background-image:url(https://synthetic.invalid/live.png)" />')};
    })()`);
    assert.equal(pinned.error, null);
    assert.match(pinned.css, /content:\s*"before"/);
    assert.match(pinned.html, /OLD-OPENSynthetic quoteOLD-CLOSE/);
    assert.equal(pinned.image, "https://synthetic.invalid/image.png");
    assert.match(pinned.background, /background-image/);
    assert.doesNotMatch(pinned.live, /https:\/\/synthetic\.invalid/);
    result.asyncPinnedSettings = pinned;
    result.sourceHashes["server/browser/displayStyleUi.test.cjs"] = createHash(
      "sha256",
    )
      .update(await readFile("server/browser/displayStyleUi.test.cjs"))
      .digest("hex");
    if (process.env.RISU_DISPLAY_STYLE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_STYLE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);
