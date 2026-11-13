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
  throw Error("Synthetic removal probe timed out: " + JSON.stringify(value));
}
test(
  "original single/range removal is durable, keeps pending presentation coherent and pins confirmation across edits/navigation",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-message-removal-probe-"),
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
          name: "synthetic-removal-gate",
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
    const open = async () => {
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await ready(page);
      return page;
    };
    const a = await open(),
      b = await open();
    const errors = new Set();
    for (const page of [a, b]) {
      page.on("Runtime.exceptionThrown", (event) => {
        const value =
          event.exceptionDetails.exception?.description ??
          event.exceptionDetails.text;
        if (value?.includes("Invalid canonical display history window"))
          errors.add(value);
      });
      page.on("Runtime.consoleAPICalled", (event) => {
        for (const arg of event.args ?? []) {
          const value = arg.description ?? arg.value;
          if (
            typeof value === "string" &&
            value.includes("Invalid canonical display history window")
          )
            errors.add(value);
        }
      });
    }
    const observe = (page) =>
      page.evaluate(
        ui(
          "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');const msgs=DBState.db.characters.find(c=>c.chaId==='c')?.chats.find(c=>c.id==='a')?.message;return {modelCount:s.messages.length,facadeCount:msgs?.length,pending:s.pending.length,error:s.error,ids:s.messages.map(m=>m.chatId)};})()",
        ),
      );
    const snapshot = () => runtime.store.call("snapshot", "a", { limit: 1000 });
    const ask = () =>
      a.evaluate(
        "(async()=>{const {alertStore}=await import('/src/ts/stores.svelte.ts');let current;const off=alertStore.subscribe(value=>current=value);off();return current.type;})()",
      );
    const answer = async (value) => {
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='" +
            value +
            "')",
        ),
      );
      await a.evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='" +
          value +
          "').click()",
      );
    };
    const click = async (id, shift = false) => {
      await until(() =>
        a.evaluate(
          "!!document.querySelector('[data-message-id=" +
            id +
            "] .button-icon-remove')",
        ),
      );
      await a.evaluate(
        "document.querySelector('[data-message-id=" +
          id +
          "] .button-icon-remove').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:" +
          shift +
          "}))",
      );
    };
    await a.evaluate(
      "window.removalSurvivor=document.querySelector('[data-message-id=m108]')",
    );
    const before = await observe(a),
      initial = (await snapshot()).cursor;
    assert.equal(before.facadeCount, 100);
    assert.equal(before.modelCount, 100);
    holdRequest = true;
    await click("m109");
    await until(() => heldRequests === 1);
    const held = await a.evaluate(
      ui(
        "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');const button=document.querySelector('[data-message-id=m109] .button-icon-remove');return {modelCount:s.messages.length,facadeCount:DBState.db.characters[0].chats[0].message.length,pending:s.pending.filter(p=>p.command.type==='remove-message').length,disabled:button.disabled,busy:button.getAttribute('aria-busy'),visible:!!document.querySelector('[data-message-id=m109]')};})()",
      ),
    );
    assert.deepEqual(held, {
      modelCount: 100,
      facadeCount: 100,
      pending: 1,
      disabled: true,
      busy: "true",
      visible: true,
    });
    assert.equal((await snapshot()).cursor, initial);
    releaseRequest();
    await until(() => a.evaluate(ui("s.pending.length===0")));
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          ui("!s.messages.some(m=>m.chatId==='m109')&&s.messages.length===99"),
        ),
      );
    assert.equal((await snapshot()).messages.length, 109);
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-message-id=m108]')===window.removalSurvivor",
      ),
      true,
    );
    await until(() =>
      a.evaluate("!document.querySelector('[data-message-id=m109]')"),
    );
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    const afterReload = await observe(a);
    assert.equal(afterReload.modelCount, 100);
    assert.ok(!afterReload.ids.includes("m109"));
    await b.evaluate(
      ui(
        "r().setField({scope:'resource',resourceKind:'settings',entityId:'global',key:'askRemoval'},true)",
      ),
    );
    await until(() =>
      a.evaluate(
        ui(
          "r().captureDisplay(0,false,'c','m108')?.database.askRemoval===true",
        ),
      ),
    );
    await click("m108");
    await until(ask, (v) => v === "ask");
    await b.evaluate(ui("r().editMessage('m108','Synthetic confirmed edit')"));
    await until(() =>
      a.evaluate(
        ui(
          "s.messages.find(m=>m.chatId==='m108')?.data==='Synthetic confirmed edit'",
        ),
      ),
    );
    await answer("YES");
    const rejected = await until(
      () =>
        a.evaluate(
          ui(
            "s.pending.filter(p=>p.command.type==='remove-message'&&p.state==='blocked').map(p=>({id:p.requestId,code:p.error.code}))",
          ),
        ),
      (v) => v.length === 1,
    );
    assert.equal(rejected[0].code, "REVISION_CONFLICT");
    assert.equal(
      (await snapshot()).messages.find((m) => m.id === "m108").message.data,
      "Synthetic confirmed edit",
    );
    await a.evaluate(
      ui("r().discardCommand(" + JSON.stringify(rejected[0].id) + ")"),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    const cancelCursor = (await snapshot()).cursor;
    await click("m108");
    await until(ask, (v) => v === "ask");
    await answer("NO");
    await until(() =>
      a.evaluate(
        "!document.querySelector('[data-message-id=m108] .button-icon-remove').disabled",
      ),
    );
    assert.equal((await snapshot()).cursor, cancelCursor);
    await runtime.store.call("applyCommand", "other-chat", {
      type: "create-chat",
      characterId: "c",
      chatId: "b",
      metadata: { name: "Synthetic other" },
    });
    await runtime.store.call("applyCommand", "other-message", {
      type: "append-message",
      chatId: "b",
      messageId: "other",
      message: { role: "char", data: "Synthetic other scope" },
    });
    await click("m108");
    await until(ask, (v) => v === "ask");
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    await until(() =>
      a.evaluate("!!document.querySelector('[data-message-id=other]')"),
    );
    await answer("YES");
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(
      async () => !(await snapshot()).messages.some((m) => m.id === "m108"),
    );
    assert.equal(await a.evaluate(ui("r().model.activeChatId")), "b");
    assert.deepEqual(await a.evaluate(ui("s.messages.map(m=>m.chatId)")), [
      "other",
    ]);
    assert.equal(
      (await runtime.store.call("snapshot", "b")).messages.length,
      1,
    );
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    await until(() => a.evaluate(ui("s.scopeReady")));
    const first = await a.evaluate(ui("s.messages[0].chatId"));
    assert.equal(first, "m8");
    const rangeCursor = (await snapshot()).cursor,
      pageStart = pages.length;
    // Original UI only mounts its recent visible rows. Use its existing scroll
    // helper to expose the first already-loaded row without fetching old pages.
    await a.evaluate(
      "(async()=>{const {ScrollToMessageStore}=await import('/src/ts/stores.svelte.ts');ScrollToMessageStore.value=0;})()",
    );
    await click(first, true);
    for (const page of [a, b])
      await until(() =>
        page.evaluate(ui("s.messages.length===8&&s.messages[0].chatId==='m0'")),
      );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    const canonical = await snapshot();
    assert.equal(canonical.messages.length, 8);
    assert.equal(canonical.cursor, rangeCursor + 1);
    const tailReads = pages.length - pageStart;
    assert.equal(tailReads, 2);
    assert.deepEqual(
      canonical.messages.map((m) => m.id),
      Array.from({ length: 8 }, (_, i) => "m" + i),
    );
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    const final = await observe(a);
    assert.equal(final.facadeCount, 8);
    assert.equal(final.modelCount, 8);
    assert.equal(errors.size, 0);
    const paths = [
      "src/lib/ChatScreens/Chat.svelte",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/ts/runtime/risuReadModel.ts",
      "server/entity/store.cjs",
      "server/entity/messages.cjs",
      "server/browser/messageRemovalUi.test.cjs",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        paths.map(async (p) => [
          p,
          createHash("sha256")
            .update(await readFile(p))
            .digest("hex"),
        ]),
      ),
    );
    const result = {
      syntheticOnly: true,
      actualOriginalUi: true,
      independentBrowserContexts: true,
      realReload: true,
      pendingPresentationRetained: true,
      stableSurvivor: true,
      staleConfirmationRejected: true,
      cancelledConfirmationNoWrite: true,
      confirmationOwnerPinnedAcrossNavigation: true,
      canonicalRangeBeyondPartialPage: true,
      compactRangeEvent: true,
      tailReads,
      invalidHistoryErrors: [...errors],
      held,
      rejected,
      final,
      canonicalCount: canonical.messages.length,
      sourceHashes,
    };
    if (process.env.RISU_MESSAGE_REMOVAL_UI_OUTPUT)
      await writeFile(
        process.env.RISU_MESSAGE_REMOVAL_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
