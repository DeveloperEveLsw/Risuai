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
  throw Error(
    "Synthetic bookmark protocol timed out: " + JSON.stringify(value),
  );
}
test(
  "canonical bookmark commands project in two original UIs and replay once after all tabs close",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-bookmark-protocol-ui-"),
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
        enableBookmark: true,
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
          name: "synthetic-bookmark-gate",
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

    const errors = [];
    const watch = (page) =>
      page.on("Runtime.exceptionThrown", (value) =>
        errors.push(value.exceptionDetails?.text),
      );
    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    let a = await open(contextA),
      b = await open(contextB);
    watch(a);
    watch(b);
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(() => b.evaluate(ui("s.pending.length===0")));
    const observed = (page) =>
      page.evaluate(
        ui(
          "JSON.parse(JSON.stringify({pending:s.pending.length,error:s.error,bookmarks:r().model.activeChat.bookmarks??[],names:r().model.activeChat.bookmarkNames??{},modelCount:r().model.activeChat.message.length,facadeCount:s.messages.length}))",
        ),
      );
    const snapshot = () => runtime.store.call("snapshot", "a", { limit: 1000 });
    const target = async (id, action, name) => {
      const h = await runtime.store.call("readBookmark", "a", id);
      return {
        type: "set-bookmark",
        chatId: "a",
        messageId: id,
        expectedRevision: h.revision,
        expectedMessageRevision: h.messageRevision,
        expectedChatEpoch: h.entityEpoch,
        action,
        ...(action === "remove" ? {} : { name }),
      };
    };
    const enqueue = (page, command) =>
      page.evaluate(ui("r().enqueue(" + JSON.stringify(command) + ")"));
    const confirmed = async (ids, names) => {
      for (const page of [a, b])
        await until(
          () => observed(page),
          (v) =>
            JSON.stringify(v.bookmarks) === JSON.stringify(ids) &&
            JSON.stringify(v.names) === JSON.stringify(names) &&
            v.pending === 0,
        );
    };
    await a.evaluate(
      "window.bookmarkRow=document.querySelector('[data-message-id=m109]');window.bookmarkNeighbor=document.querySelector('[data-message-id=m108]')",
    );
    const before = await snapshot(),
      pageReads = pages.length;
    holdRequest = true;
    await enqueue(a, await target("m0", "add", "Synthetic earlier"));
    await until(() => heldRequests === 1);
    const held = await observed(a);
    assert.equal(held.pending, 1);
    assert.deepEqual(held.bookmarks, []);
    assert.equal((await snapshot()).cursor, before.cursor);
    releaseRequest();
    await confirmed(["m0"], { m0: "Synthetic earlier" });
    assert.equal(
      pages.length,
      pageReads,
      "compact bookmark projection must not fetch chat snapshots or unseen message bodies",
    );
    const list = await a.evaluate(
      ui("r().client.read('/chats/a/bookmarks?limit=1')"),
    );
    assert.equal(list.items[0].messageId, "m0");
    assert.equal(list.items[0].ordinal, 0);
    assert.equal(list.items[0].message.data, "Synthetic message 0");
    assert.equal(list.historyCount, 110);
    assert.equal((await observed(a)).modelCount, 100);
    const replayCursor = (await snapshot()).cursor;
    holdRequest = true;
    const replayRequestId = await enqueue(
      a,
      await target("m109", "add", "Synthetic latest"),
    );
    await until(() => heldRequests === 2);
    await a.close();
    await b.close();
    releaseRequest();
    await delay(50);
    a = await open(contextA);
    b = await open(contextB);
    watch(a);
    watch(b);
    await confirmed(["m0", "m109"], {
      m0: "Synthetic earlier",
      m109: "Synthetic latest",
    });
    assert.equal((await snapshot()).cursor, replayCursor + 1);
    assert.equal(
      (await runtime.store.call("readBookmark", "a", "m109")).revision,
      1,
    );
    await a.evaluate(
      "document.querySelector('[data-message-id=m109] .button-icon-menu').click()",
    );
    await until(() =>
      a.evaluate("!!document.querySelector('.button-icon-bookmark')"),
    );
    assert.equal(
      await a.evaluate(
        "document.querySelector('.button-icon-bookmark').classList.contains('text-yellow-400')",
      ),
      true,
    );
    await a.evaluate("document.body.click()");
    const old = await target("m0", "rename", "Synthetic stale");
    await enqueue(b, await target("m0", "rename", "Synthetic remote name"));
    await confirmed(["m0", "m109"], {
      m0: "Synthetic remote name",
      m109: "Synthetic latest",
    });
    const conflictCursor = (await snapshot()).cursor;
    const rejectedId = await enqueue(a, old);
    const blocked = await until(
      () =>
        a.evaluate(
          ui(
            "s.pending.filter(e=>e.requestId===" +
              JSON.stringify(rejectedId) +
              ").map(e=>({state:e.state,error:{code:e.error?.code}}))[0]",
          ),
        ),
      (v) => v?.state === "blocked",
    );
    assert.equal(blocked.error.code, "REVISION_CONFLICT");
    assert.equal((await snapshot()).cursor, conflictCursor);
    assert.equal((await observed(a)).names.m0, "Synthetic remote name");
    await a.evaluate(
      ui("r().discardCommand(" + JSON.stringify(rejectedId) + ")"),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    const final = await observed(a),
      canonical = await snapshot();
    assert.equal(final.pending, 0);
    assert.equal(final.error, "");
    assert.equal(final.modelCount, 100);
    assert.equal(final.facadeCount, 100);
    assert.deepEqual(final.names, {
      m0: "Synthetic remote name",
      m109: "Synthetic latest",
    });
    assert.equal(canonical.messages.length, 110);
    assert.ok(canonical.messages.every((row) => row.message.unknown.retained));
    assert.deepEqual(errors, []);
    const paths = [
      "server/entity/bookmarks.cjs",
      "server/entity/store.cjs",
      "server/entity/fields.cjs",
      "server/entity/worker.cjs",
      "server/runtime/service.cjs",
      "src/ts/runtime/risuReadModel.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/lib/ChatScreens/Chat.svelte",
      "server/browser/bookmarkProtocolUi.test.cjs",
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
      admissionPath:
        "existing public enqueue bridge; original bookmark callbacks are not invoked",
      manualBookmarkActionCoverage: false,
      canonicalMetadataProjected: true,
      unloadedBodyNotAddedToFacade: true,
      compactProjectionWithoutSnapshotReads: true,
      headerAndBoundedPageHttp: true,
      allTabsClosedPendingReplay: true,
      onceAfterReplay: true,
      conflictRetained: true,
      realReload: true,
      replayRequestId,
      held,
      final,
      errors,
      sourceHashes,
    };
    if (process.env.RISU_BOOKMARK_PROTOCOL_UI_OUTPUT)
      await writeFile(
        process.env.RISU_BOOKMARK_PROTOCOL_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
