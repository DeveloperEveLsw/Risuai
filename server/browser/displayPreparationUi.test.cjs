"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error(
    "Display preparation condition timed out: " + JSON.stringify(value),
  );
}
test(
  "a small chat retires obsolete row preparations during 300 updates without overflowing Lua admission",
  { timeout: 150000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-display-preparation-"),
    );
    let runtime, frontend, browser, page;
    t.after(async () => {
      if (page) await page.evaluate("window.releaseDigest?.()").catch(() => {});
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
        chatLoadInitialPages: 30,
      },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic preparation" } },
      definition: {
        type: "character",
        name: "Synthetic preparation",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `local calls=0
listenEdit('editDisplay',function(id,data)
  calls=calls+1
  return '<section class="prepared-row">'..data..'<input value="keep"/><span class="prepared-calls">'..tostring(calls)..'</span></section>'
end)`,
              },
            ],
          },
        ],
      },
    });
    for (let i = 0; i < 3; i++)
      await runtime.store.call("applyCommand", "message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m" + i,
        message: { role: "char", data: "Synthetic message " + i },
      });
    const baseline = process.env.RISU_PREPARATION_BASELINE_FILE
      ? await readFile(process.env.RISU_PREPARATION_BASELINE_FILE, "utf8")
      : undefined;
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: baseline
        ? [
            {
              name: "prior-display-preparation",
              enforce: "pre",
              load(id) {
                if (
                  id.split("?")[0] ===
                  resolve("src/lib/ChatScreens/ChatBody.svelte")
                )
                  return baseline;
              },
            },
          ]
        : [],
      define: {
        "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
        "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
      },
      server: {
        host: "127.0.0.1",
        hmr: false,
        port: 0,
        strictPort: false,
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
      page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(
      () =>
        page.evaluate(
          "document.querySelectorAll('.x-risu-prepared-row').length",
        ),
      (n) => n === 4,
    );
    await delay(200);
    const before = await page.evaluate(`(()=>{
    window.keptRow=document.querySelector('[data-message-id=m0]');window.keptInput=window.keptRow.querySelector('input');window.keptInput.value='local text';
    window.beforeCalls=[...document.querySelectorAll('.x-risu-prepared-calls')].map(e=>+e.textContent);
    const original=crypto.subtle.digest.bind(crypto.subtle);let held=true;
    const gate=new Promise(r=>window.releaseDigest=()=>{held=false;r()});
    window.heldDigests=0;
    crypto.subtle.digest=async(...args)=>{if(held){window.heldDigests++;await gate}return original(...args)};
    return window.beforeCalls;
  })()`);
    for (let batch = 0; batch < 10; batch++)
      await page.evaluate(`(async()=>{
    const {ReloadGUIPointer}=await import('/src/ts/stores.svelte.ts');const {tick}=await import('/node_modules/svelte/src/index-client.js');
    for(let i=0;i<30;i++){ReloadGUIPointer.update(v=>v+1);await tick();await new Promise(r=>setTimeout(r,0))}
  })()`);
    const held = await page.evaluate(
      ui(
        `({error:s.error,heldDigests:window.heldDigests,unchangedRow:window.keptRow===document.querySelector('[data-message-id=m0]'),unchangedInput:window.keptInput===window.keptRow.querySelector('input'),localText:window.keptInput.value})`,
      ),
    );
    t.diagnostic(JSON.stringify({ phase: "held", before, ...held }));
    if (process.env.RISU_PREPARATION_OUTPUT)
      await writeFile(
        process.env.RISU_PREPARATION_OUTPUT,
        JSON.stringify({ phase: "held", before, ...held }, null, 2) + "\n",
      );
    assert.equal(
      held.error,
      "",
      "Obsolete presentations must not exhaust preparation capacity",
    );
    assert.equal(held.unchangedRow, true);
    assert.equal(held.unchangedInput, true);
    assert.equal(held.localText, "local text");
    assert.ok(
      held.heldDigests > 0 && held.heldDigests <= 12,
      "Only one active preparation per row reaches hashing",
    );
    await page.evaluate("window.releaseDigest()");
    await until(
      () =>
        page.evaluate(
          "Math.max(...[...document.querySelectorAll('.x-risu-prepared-calls')].map(e=>+e.textContent))",
        ),
      (n) => n === Math.max(...before) + 4,
    );
    const after = await page.evaluate(
      ui(
        `({error:s.error,calls:[...document.querySelectorAll('.x-risu-prepared-calls')].map(e=>+e.textContent),sameInput:window.keptInput===document.querySelector('[data-message-id=m0] input'),localText:window.keptInput.value})`,
      ),
    );
    assert.equal(after.error, "");
    assert.equal(after.sameInput, true);
    assert.equal(after.localText, "local text");
    const snapshot = await runtime.store.call("snapshot", "a");
    assert.equal(snapshot.messages.length, 3);
    assert.equal(snapshot.variables.length, 0);
    const result = {
      syntheticOnly: true,
      actualOriginalUiAndWorker: true,
      controlledSlowDigest: true,
      updates: 300,
      rows: 4,
      before,
      held,
      after,
      canonicalMessages: 3,
      realModelCalls: 0,
    };
    t.diagnostic(JSON.stringify(result));
    if (process.env.RISU_PREPARATION_OUTPUT)
      await writeFile(
        process.env.RISU_PREPARATION_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);
