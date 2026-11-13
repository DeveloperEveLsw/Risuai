"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;
async function until(read, predicate = Boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw new Error(
    "Display capture condition timed out: " + JSON.stringify(value),
  );
}
const trigger = (name) => ({
  type: "manual",
  conditions: [],
  effect: [
    {
      type: "triggerlua",
      code: `listenEdit('editDisplay', function(id,data)
  if not string.find(data,'${name}-probe',1,true) then return data end
  setChatVar(id,'${name}_seen','1')
  return data .. '<span id="${name}-lua-marker">' .. getChatVar(id,'${name}_seen') .. '</span>'
end)`,
    },
  ],
});
test(
  "original display shares pinned no-Lua history without starting Lua workers and preserves CBS, regex, toggles and navigation",
  { timeout: 180000 },
  async (t) => {
    // Optional reproduction uses the exact prior adapter in an isolated Vite load.
    // It never rewrites the checked-out source or changes the default assertions.
    const baselineSource = process.env.RISU_DISPLAY_CAPTURE_BASELINE_FILE
      ? await readFile(process.env.RISU_DISPLAY_CAPTURE_BASELINE_FILE, "utf8")
      : undefined;
    const directory = await mkdtemp(join(tmpdir(), "risu-display-capture-"));
    let runtime, frontend, browser, releaseToggle;
    t.after(async () => {
      releaseToggle?.();
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
        chatLoadInitialPages: 60,
        syntheticUnused: Array.from({ length: 3200 }, (_, i) => ({
          index: i,
          nested: { text: "Synthetic setting" },
        })),
      },
    });
    await runtime.store.call("applyCommand", "module", {
      type: "put-resource",
      kind: "module",
      resourceId: "synthetic-module",
      expectedRevision: 0,
      payload: {
        id: "synthetic-module",
        name: "Synthetic module",
        trigger: [trigger("module")],
      },
    });
    for (const [id, definition] of [
      [
        "plain",
        {
          firstMessage: "Synthetic no Lua",
          customModuleToggle: "fast=Synthetic capture toggle",
          customscript: [
            {
              in: "synthetic-token",
              out: "synthetic-result",
              type: "editdisplay",
              ableFlag: true,
              flag: "g",
            },
          ],
        },
      ],
      [
        "character",
        {
          firstMessage: "character-probe",
          triggerscript: [trigger("character")],
        },
      ],
      [
        "module",
        { firstMessage: "module-probe", modules: ["synthetic-module"] },
      ],
    ]) {
      await runtime.store.call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        chat: { chatId: "chat-" + id, metadata: { name: "Synthetic " + id } },
        definition: {
          type: "character",
          name: "Synthetic " + id,
          desc: "Synthetic",
          ...definition,
        },
      });
    }
    for (let i = 0; i < 50; i++)
      await runtime.store.call("applyCommand", "message-" + i, {
        type: "append-message",
        chatId: "chat-plain",
        messageId: "plain-" + i,
        message: {
          role: "char",
          data:
            `<section id="capture-row-${i}">synthetic-token {{getglobalvar::toggle_fast}}</section>` +
            " Synthetic neutral text".repeat(24),
        },
      });
    const { createServer } = await import("vite");
    frontend = await createServer({
      plugins: baselineSource
        ? [
            {
              name: "synthetic-prior-display-adapter",
              enforce: "pre",
              load(id) {
                if (
                  id.split("?")[0] === resolve("src/ts/process/scriptings.ts")
                )
                  return baselineSource;
              },
            },
          ]
        : [],
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
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
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    // Observe owner capture on both the full-body and lean header entry points.
    await page.evaluate(
      ui(
        "(()=>{const bridge=r();window.displayCaptures=[];window.displayWorkers=0;const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);window.displayWorkers++}};for(const method of ['captureDisplay','captureDisplayHeader']){if(typeof bridge[method]!=='function')continue;const original=bridge[method].bind(bridge);bridge[method]=(...args)=>{window.displayCaptures.push(args[2]);return original(...args)}};return true})()",
      ),
    );
    const select = async (id) => {
      await until(() =>
        page.evaluate(`!!document.querySelector('[data-character-id=${id}]')`),
      );
      await page.evaluate(
        `document.querySelector('[data-character-id=${id}]').click()`,
      );
      await until(() =>
        page.evaluate(
          ui(`s.scopeReady&&r().model.activeChatId==='chat-${id}'`),
        ),
      );
    };
    await select("plain");
    await until(
      () =>
        page.evaluate("document.querySelectorAll('[id^=capture-row-]').length"),
      (n) => n === 50,
    );
    assert.equal(
      await page.evaluate(
        "[...document.querySelectorAll('[id^=capture-row-]')].every(e=>e.textContent.includes('synthetic-result')&&!e.textContent.includes('{{'))",
      ),
      true,
    );
    await delay(200);
    if (baselineSource)
      assert.ok((await page.evaluate("window.displayCaptures.length")) > 0);
    else assert.equal(await page.evaluate("window.displayWorkers"), 0);
    const toggle =
      "document.querySelector('input[alt=\"Synthetic capture toggle\"]')";
    await until(() => page.evaluate(`!!${toggle}`));
    // Hold the real variable command before its SQLite execution. The pending
    // display must update through original CBS while the canonical value stays
    // unchanged, without constructing a Lua worker.
    const originalCall = runtime.store.call.bind(runtime.store);
    const toggleGate = new Promise((resolve) => (releaseToggle = resolve));
    let toggleHeld = false;
    runtime.store.call = async (method, ...args) => {
      if (
        method === "applyCommand" &&
        args[1]?.type === "change-variables" &&
        args[1].edits?.some(
          (edit) => edit.scope === "global" && edit.key === "toggle_fast",
        )
      ) {
        toggleHeld = true;
        await toggleGate;
      }
      return originalCall(method, ...args);
    };
    const feedbackMs = await page.evaluate(
      `(async()=>{const started=performance.now();${toggle}.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(!${toggle}.checked)throw new Error('Original checkbox did not select');return performance.now()-started})()`,
    );
    await until(() =>
      page.evaluate(
        "[...document.querySelectorAll('[id^=capture-row-]')].every(e=>e.textContent==='synthetic-result 1')",
      ),
    );
    await until(() => toggleHeld);
    assert.equal(await page.evaluate(ui("s.pending.length>0")), true);
    const pendingCanonical = (
      await runtime.store.call("readVariables", [
        { scope: "global", key: "toggle_fast" },
      ])
    ).variables[0];
    assert.equal(pendingCanonical.exists, false);
    releaseToggle();
    runtime.store.call = originalCall;
    await until(() => page.evaluate(ui("s.pending.length===0")));
    if (baselineSource)
      assert.ok((await page.evaluate("window.displayCaptures.length")) > 0);
    else assert.equal(await page.evaluate("window.displayWorkers"), 0);
    assert.equal(
      (
        await runtime.store.call("readVariables", [
          { scope: "global", key: "toggle_fast" },
        ])
      ).variables[0].value,
      "1",
    );
    const noLuaCaptures = await page.evaluate("window.displayCaptures.length");
    const noLuaWorkers = await page.evaluate("window.displayWorkers");
    const noLuaScopePreparations = await page.evaluate(
      "(async()=>{const {displayScopeDiagnostics}=await import('/src/ts/process/scriptings.ts');return displayScopeDiagnostics?.()?.preparations??null})()",
    );
    if (!baselineSource) {
      assert.equal(noLuaWorkers, 0);
      assert.ok(
        noLuaScopePreparations > 0 && noLuaScopePreparations < 50,
        "Pinned history must be shared across the 50 original CBS/regex rows",
      );
    }
    for (const name of ["character", "module"]) {
      await select(name);
      await until(() =>
        page.evaluate(
          `document.querySelector('#${name}-lua-marker')?.textContent==='1'`,
        ),
      );
      await until(
        async () =>
          (await runtime.store.call("snapshot", "chat-" + name)).variables.find(
            (v) => v.key === "$" + name + "_seen",
          )?.value === "1",
      );
      assert.equal(
        await page.evaluate(`window.displayCaptures.includes('${name}')`),
        true,
      );
    }
    await page.evaluate(
      ui(
        "(()=>{r().setField({scope:'character',entityId:'module',key:'modules'},[]);return true})()",
      ),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&(await import('/src/ts/storage/database.svelte.ts')).getCurrentCharacter().modules.length===0",
        ),
      ),
    );
    await until(() =>
      page.evaluate("!document.querySelector('#module-lua-marker')"),
    );
    const disabledCaptures = await page.evaluate(
      "window.displayCaptures.length",
    );
    assert.equal(
      await page.evaluate(
        "(async()=>{const {runLuaEditTrigger}=await import('/src/ts/process/scriptings.ts');const {createSimpleCharacter}=await import('/src/ts/stores.svelte.ts');const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');return runLuaEditTrigger(createSimpleCharacter(getCurrentCharacter()),'editdisplay','Synthetic direct')})()",
      ),
      "Synthetic direct",
    );
    assert.equal(
      await page.evaluate("window.displayCaptures.length"),
      disabledCaptures + (baselineSource ? 1 : 0),
    );
    await page.evaluate(
      ui(
        "(()=>{r().setField({scope:'character',entityId:'module',key:'modules'},['synthetic-module']);return true})()",
      ),
    );
    await until(() =>
      page.evaluate(
        "document.querySelector('#module-lua-marker')?.textContent==='1'",
      ),
    );
    await select("plain");
    await until(
      () =>
        page.evaluate("document.querySelectorAll('[id^=capture-row-]').length"),
      (n) => n === 50,
    );
    const finalCaptures = await page.evaluate("window.displayCaptures.length");
    assert.equal(
      await page.evaluate(
        "(async()=>{const {runLuaEditTrigger}=await import('/src/ts/process/scriptings.ts');const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');return runLuaEditTrigger(getCurrentCharacter(),'editdisplay','Synthetic after navigation')})()",
      ),
      "Synthetic after navigation",
    );
    assert.equal(
      await page.evaluate("window.displayCaptures.length"),
      finalCaptures + (baselineSource ? 1 : 0),
    );
    assert.equal(await page.evaluate(ui("s.error")), "");
    const observations = {
      syntheticDesktopOnly: true,
      adapterBaseline: Boolean(baselineSource),
      adapterSha256: createHash("sha256")
        .update(
          baselineSource ??
            (await readFile("src/ts/process/scriptings.ts", "utf8")),
        )
        .digest("hex"),
      messages: 50,
      nestedSettings: 3200,
      noLuaCaptures,
      noLuaWorkers,
      originalCbsBeforeCanonicalAdmission: true,
      noLuaScopePreparations,
      feedbackMs,
      characterLuaAdmission: true,
      moduleLuaAdmission: true,
      moduleDisableEnable: true,
      returnToNoLua: true,
    };
    t.diagnostic(JSON.stringify(observations));
    if (process.env.RISU_DISPLAY_CAPTURE_OBSERVATIONS)
      await writeFile(
        process.env.RISU_DISPLAY_CAPTURE_OBSERVATIONS,
        JSON.stringify(observations, null, 2) + "\n",
      );
  },
);
