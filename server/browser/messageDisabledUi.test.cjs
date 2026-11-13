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
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic flag UI timed out: " + JSON.stringify(value));
}
test(
  "original disable/allBefore controls provide local feedback, durable two-device/reload state, conflict rollback and all-tab pending replay",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-message-disabled-ui-"),
    );
    let runtime, frontend, browser, releaseRequest;
    let holdRequest = false,
      heldRequests = 0;
    const pages = [];
    t.after(async () => {
      releaseRequest?.();
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
        askRemoval: false,
        instantRemove: false,
      },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: {
        chatId: "a",
        metadata: { name: "Synthetic removal", unknown: { retained: true } },
      },
      definition: {
        type: "character",
        name: "Synthetic removal",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
      },
    });
    for (let i = 0; i < 110; i++)
      await runtime.store.call("applyCommand", "message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m" + i,
        message: {
          role: "char",
          data: "Synthetic message " + i,
          unknown: { retained: true },
        },
      });
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-flag-gate",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (
                req.method === "GET" &&
                req.url.startsWith("/api/runtime/chats/a?")
              )
                pages.push(req.url);
              if (
                holdRequest &&
                req.method === "POST" &&
                req.url === "/api/runtime/commands"
              ) {
                holdRequest = false;
                heldRequests++;
                new Promise((resolve) => (releaseRequest = resolve)).then(() =>
                  next(),
                );
              } else next();
            });
          },
        },
      ],
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
    const ready = async (page) => {
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=\"true\"]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      if (await page.evaluate(ui("r().model.activeChatId!=='a'")))
        await page.evaluate(ui("r().selectCharacter('c','a')"));
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-message-id] .button-icon-remove')",
        ),
      );
    };
    const open = async (context) => {
      const page = await browser.page(url, context, {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await ready(page);
      return page;
    };

    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    let a = await open(contextA),
      b = await open(contextB);
    const errors = [];
    const watch = (page) =>
      page.on("Runtime.exceptionThrown", (event) =>
        errors.push(
          event.exceptionDetails.exception?.description ??
            event.exceptionDetails.text,
        ),
      );
    watch(a);
    watch(b);
    const snapshot = () => runtime.store.call("snapshot", "a", { limit: 1000 });
    const observed = (page) =>
      page.evaluate(
        ui(
          "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');const chat=DBState.db.characters.find(c=>c.chaId==='c').chats.find(c=>c.id==='a');return {pending:s.pending.length,error:s.error,ids:s.messages.map(m=>m.chatId),confirmed:s.messages.map(m=>({id:m.chatId,disabled:m.disabled??false})),facade:chat.message.map(m=>({id:m.chatId,disabled:m.disabled??false}))};})()",
        ),
      );
    const openMenu = async (page, id) => {
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-message-id=" +
            id +
            "] .button-icon-menu')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-message-id=" +
          id +
          "] .button-icon-menu').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('.button-icon-disable')"),
      );
    };
    const click = async (id, above = false) => {
      await openMenu(a, id);
      await a.evaluate(
        "document.querySelector('.button-icon-disable" +
          (above ? "-above" : "") +
          "').click()",
      );
    };
    const confirmed = async (id, value) => {
      for (const page of [a, b])
        await until(() =>
          page.evaluate(
            ui(
              "s.messages.find(m=>m.chatId===" +
                JSON.stringify(id) +
                ")?.disabled===" +
                JSON.stringify(value),
            ),
          ),
        );
      await until(() => a.evaluate(ui("s.pending.length===0")));
    };
    const original = await snapshot();
    await a.evaluate(
      "window.flagRow=document.querySelector('[data-message-id=m109]');window.flagNeighbor=document.querySelector('[data-message-id=m108]')",
    );
    await openMenu(a, "m109");
    holdRequest = true;
    const feedback = await a.evaluate(
      "(async()=>{const start=performance.now();document.querySelector('.button-icon-disable').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {feedbackMs:performance.now()-start,border:!!document.querySelector('[data-message-id=m109] .border-blue-500'),menuClosed:!document.querySelector('.button-icon-disable')};})()",
    );
    assert.equal(feedback.border, true);
    assert.equal(feedback.menuClosed, true);
    await openMenu(a, "m109");
    const pendingControl = await a.evaluate(
      "(()=>{const b=document.querySelector('.button-icon-disable');return {pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy'),disabled:b.disabled};})()",
    );
    assert.deepEqual(pendingControl, {
      pressed: "true",
      busy: "true",
      disabled: true,
    });
    await until(() => heldRequests === 1);
    const held = await observed(a);
    assert.equal(held.pending, 1);
    assert.equal(held.confirmed.find((m) => m.id === "m109").disabled, false);
    assert.equal(held.facade.find((m) => m.id === "m109").disabled, false);
    assert.equal((await snapshot()).cursor, original.cursor);
    await openMenu(b, "m109");
    assert.equal(
      await b.evaluate(
        "document.querySelector('.button-icon-disable').getAttribute('aria-pressed')",
      ),
      "false",
    );
    await b.evaluate("document.body.click()");
    releaseRequest();
    await confirmed("m109", true);
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-message-id=m109]')===window.flagRow&&document.querySelector('[data-message-id=m108]')===window.flagNeighbor",
      ),
      true,
    );
    await click("m108", true);
    await confirmed("m108", "allBefore");
    await openMenu(a, "m108");
    assert.equal(
      await a.evaluate(
        "document.querySelector('.button-icon-disable-above').getAttribute('aria-pressed')",
      ),
      "true",
    );
    await a.evaluate("document.body.click()");
    await click("m108");
    await confirmed("m108", false);
    await click("m109", true);
    await confirmed("m109", "allBefore");
    await click("m109", true);
    await confirmed("m109", false);
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    watch(a);
    assert.equal(
      await a.evaluate(ui("s.messages.find(m=>m.chatId==='m109').disabled")),
      false,
    );
    holdRequest = true;
    await click("m107");
    await until(() => heldRequests === 2);
    await b.evaluate(
      ui("r().editMessage('m107','Synthetic remote flag edit')"),
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.messages.find(m=>m.chatId==='m107').data==='Synthetic remote flag edit'",
        ),
      ),
    );
    releaseRequest();
    const conflicts = await until(
      () =>
        a.evaluate(
          ui(
            "s.pending.filter(e=>e.command.type==='set-message-disabled'&&e.state==='blocked').map(e=>({id:e.requestId,code:e.error.code}))",
          ),
        ),
      (v) => v.length === 1,
    );
    assert.equal(conflicts[0].code, "REVISION_CONFLICT");
    await openMenu(a, "m107");
    await until(() =>
      a.evaluate(
        "document.querySelector('.button-icon-disable').getAttribute('aria-pressed')==='false'",
      ),
    );
    assert.equal(
      (await snapshot()).messages.find((m) => m.id === "m107").message
        .disabled ?? false,
      false,
    );
    await a.evaluate(
      ui("r().discardCommand(" + JSON.stringify(conflicts[0].id) + ")"),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    const replayCursor = (await snapshot()).cursor;
    holdRequest = true;
    await click("m106");
    await until(() => heldRequests === 3);
    const queued = await a.evaluate(
      ui(
        "s.pending.filter(e=>e.command.type==='set-message-disabled').map(e=>e.requestId)",
      ),
    );
    assert.equal(queued.length, 1);
    await a.close();
    await b.close();
    releaseRequest();
    await delay(50);
    a = await open(contextA);
    watch(a);
    b = await open(contextB);
    watch(b);
    await confirmed("m106", true);
    const canonical = await snapshot();
    assert.equal(canonical.cursor, replayCursor + 1);
    assert.equal(canonical.messages.length, 110);
    assert.equal(
      canonical.messages.find((m) => m.id === "m106").message.disabled,
      true,
    );
    assert.equal(
      canonical.messages.find((m) => m.id === "m107").message.data,
      "Synthetic remote flag edit",
    );
    assert.ok(canonical.messages.every((m) => m.message.unknown.retained));
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    const final = await observed(a);
    assert.equal(final.pending, 0);
    assert.equal(final.error, "");
    assert.equal(final.ids.length, 100);
    assert.equal(final.confirmed.find((m) => m.id === "m106").disabled, true);
    assert.deepEqual(final.facade, final.confirmed);
    assert.equal(errors.length, 0);
    const paths = [
      "src/lib/ChatScreens/Chat.svelte",
      "src/lib/UI/PopupList.svelte",
      "src/ts/runtime/risuReadModel.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "server/entity/messages.cjs",
      "server/entity/store.cjs",
      "server/browser/messageDisabledUi.test.cjs",
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
      actualOriginalUi: true,
      independentBrowserContexts: true,
      partialHistory: { canonical: 110, loaded: 100 },
      immediateLocalPresentation: true,
      confirmedFacadesNotMutated: true,
      stableRows: true,
      originalPowerAndCutoffSemantics: true,
      conflictRollback: true,
      realReload: true,
      allTabsClosedPendingReplay: true,
      onceAfterReplay: true,
      feedback,
      pendingControl,
      originalPopupRepeatedOpen: true,
      held,
      conflicts,
      replayedRequestId: queued[0],
      final,
      errors,
      sourceHashes,
    };
    if (process.env.RISU_MESSAGE_DISABLED_UI_OUTPUT)
      await writeFile(
        process.env.RISU_MESSAGE_DISABLED_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
