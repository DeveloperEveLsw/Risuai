"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(40);
  } while (Date.now() < end);
  throw new Error("Display UI condition timed out: " + JSON.stringify(last));
}
test(
  "original browser Lua display effects: two devices, repeated display, reload and durable pending work after all tabs close",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-ui-"));
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
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "state.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: { didFirstSetup: true, language: "en", autoTranslate: false },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic display fixture",
        desc: "Synthetic",
        defaultVariables: "counter=0",
        firstMessage:
          'Display fixture <span id="display-marker">{{getvar::counter}}</span>',
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay', function(id,data)
      if not string.find(data,'Display fixture',1,true) then return data end
      local n=tonumber(getChatVar(id,'counter'))+1
      setChatVar(id,'counter',tostring(n))
      setState(id,'display_cache',{count=n})
      return data .. '<span id="display-lua-value">' .. getChatVar(id,'counter') .. '</span>'
    end)`,
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic chat" } },
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const frontUrl = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(frontUrl);
    browser = await launchChromium(directory);
    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    const open = async (context) => {
      const page = await browser.page(frontUrl, context, {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await until(
        () =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-ready=\"true\"]')",
          ),
        Boolean,
        90000,
      );
      await until(() =>
        page.evaluate("!!document.querySelector('[data-character-id=c]')"),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      return page;
    };
    let [a, b] = await Promise.all([open(contextA), open(contextB)]);
    const variables = async () =>
      (await runtime.store.call("snapshot", "a")).variables;
    const counter = async () =>
      (await variables()).find((row) => row.key === "$counter");
    await until(counter, (row) => row?.value === "1");
    await until(
      () =>
        a.evaluate("document.querySelector('#display-lua-value')?.textContent"),
      (value) => value === "1",
    );
    await until(
      () =>
        b.evaluate("document.querySelector('#display-lua-value')?.textContent"),
      (value) => value === "1",
    );
    const canonical = ui(
      "JSON.parse(JSON.stringify((await import('/src/ts/storage/database.svelte.ts')).getCurrentChat().scriptstate))",
    );
    await until(
      () => a.evaluate(canonical),
      (state) => state?.$counter === "1",
    );
    await until(
      () => b.evaluate(canonical),
      (state) => state?.$counter === "1",
    );
    const receiptState = await runtime.store.call("displayState", "a");
    assert.equal(receiptState.applied.length, 1);
    const before = await counter();
    await a.evaluate(ui("(s.displayRevision++,true)"));
    await b.evaluate(ui("(s.displayRevision++,true)"));
    await delay(150);
    assert.deepEqual(await counter(), before);
    await a.close();
    a = await open(contextA);
    await until(
      () =>
        a.evaluate("document.querySelector('#display-lua-value')?.textContent"),
      (value) => value === "1",
    );
    assert.deepEqual(await counter(), before);
    await until(
      () =>
        a.evaluate("document.querySelector('#display-marker')?.textContent"),
      (value) => value === "1",
    );
    await until(
      () =>
        b.evaluate("document.querySelector('#display-marker')?.textContent"),
      (value) => value === "1",
    );

    // Block admission only. Display preparation must return while HTTP admission is unavailable.
    await a.send("Network.enable");
    await a.send("Network.setBlockedURLs", { urls: ["*api/runtime/commands"] });
    const prepared = await a.evaluate(`(async()=>{
    const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    const {RuntimeUIState}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');
    const started=performance.now(); const output=await ParseMarkdown('Display fixture offline',getCurrentCharacter(),'normal',-1);
    return JSON.parse(JSON.stringify({elapsed:performance.now()-started,output,pending:RuntimeUIState.pending.filter(e=>e.command.type==='apply-display-effects').map(e=>({requestId:e.requestId,command:e.command}))}));
  })()`);
    assert.match(prepared.output, /display-lua-value[^>]*>2/);
    assert.equal(prepared.pending.length, 1);
    assert.ok(
      prepared.elapsed < 2000,
      "Preparation waited for admission: " + prepared.elapsed,
    );
    assert.equal((await a.evaluate(canonical)).$counter, "1");
    assert.deepEqual(await counter(), before);
    const offlineCommand = prepared.pending[0].command;
    await a.close();
    await b.close();
    a = await open(contextA);
    await until(counter, (row) => row?.value === "2");
    await until(
      () => a.evaluate(ui("s.pending.length")),
      (n) => n === 0,
    );
    b = await open(contextB);
    await until(
      () => b.evaluate(canonical),
      (state) => state?.$counter === "2",
    );
    assert.equal((await counter()).revision, before.revision + 1);
    const json = (await variables()).find(
      (row) => row.key === "$__display_cache",
    );
    assert.deepEqual(JSON.parse(json.value), { count: 2 });
    await a.evaluate(ui(`r().enqueue(${JSON.stringify(offlineCommand)})`));
    await until(
      () => a.evaluate(ui("s.pending.length")),
      (n) => n === 0,
    );
    assert.equal((await counter()).revision, before.revision + 1);
    assert.equal(
      (await runtime.store.call("displayState", "a")).applied.length,
      2,
    );
    const errors = await Promise.all([
      a.evaluate(ui("s.error")),
      b.evaluate(ui("s.error")),
    ]);
    assert.match(errors[0], /^(|Failed to fetch)$/);
    assert.equal(errors[1], "");
    const renderPreview = (page, text) =>
      page.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      return ParseMarkdown(${JSON.stringify(text)},getCurrentCharacter(),'normal',-1);
    })()`);
    await a.send("Network.enable");
    await a.send("Network.setBlockedURLs", { urls: ["*api/runtime/commands"] });
    assert.match(
      await renderPreview(a, "Display fixture rejected"),
      /display-lua-value[^>]*>3/,
    );
    const rejectedId = await a.evaluate(
      ui(
        "s.pending.find(e=>e.command.type==='apply-display-effects')?.requestId",
      ),
    );
    assert.ok(rejectedId);
    await renderPreview(b, "Display fixture rival");
    await until(counter, (row) => row?.value === "3");
    await until(
      () => a.evaluate(canonical),
      (state) => state?.$counter === "3",
    );
    await a.send("Network.setBlockedURLs", { urls: [] });
    await until(
      () =>
        a.evaluate(
          ui(
            `s.pending.find(e=>e.requestId===${JSON.stringify(rejectedId)})?.state`,
          ),
        ),
      (state) => state === "blocked",
    );
    assert.match(
      await a.evaluate(ui("s.error")),
      /Display change was rejected/,
    );
    // Rejected overlays cannot pretend to be confirmed or repeatedly resubmit their occurrence.
    assert.match(
      await renderPreview(a, "Display fixture rejected"),
      /display-lua-value[^>]*>3/,
    );
    await a.evaluate(ui(`r().discardCommand(${JSON.stringify(rejectedId)})`));
    assert.match(
      await renderPreview(a, "Display fixture rejected"),
      /display-lua-value[^>]*>3/,
    );
    assert.equal(await a.evaluate(ui("s.pending.length")), 0);
    assert.equal((await counter()).revision, 3);
    assert.equal(
      (await runtime.store.call("displayState", "a")).applied.length,
      3,
    );
    t.diagnostic(
      JSON.stringify({
        syntheticDesktopOnly: true,
        admissionBlockedPreparationMs: prepared.elapsed,
        counter: "3",
        counterRevision: (await counter()).revision,
        displayReceipts: 3,
        rejectedDisplayRetainedAndDiscarded: true,
        allTabsClosedPendingReplay: true,
      }),
    );
  },
);
