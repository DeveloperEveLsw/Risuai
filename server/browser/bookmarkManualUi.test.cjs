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
  throw Error("Synthetic manual bookmark timed out: " + JSON.stringify(value));
}
test(
  "original bookmark buttons pin inputs, show private pending state and persist across devices and all-tab exit",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-bookmark-manual-ui-"));
    let runtime, frontend, browser, releaseRequest, releaseHeader;
    let holdHeader = false,
      heldHeaders = 0;
    let holdRequest = false,
      heldRequests = 0;
    const pages = [];
    t.after(async () => {
      releaseRequest?.();
      releaseHeader?.();
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
        metadata: { name: "Synthetic manual", unknown: { retained: true } },
      },
      definition: {
        type: "character",
        name: "Synthetic manual",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
      },
    });
    await runtime.store.call("applyCommand", "other-chat", {
      type: "create-chat",
      characterId: "c",
      chatId: "b",
      metadata: { name: "Synthetic other" },
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
          name: "synthetic-bookmark-manual-gate",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (
                req.method === "GET" &&
                req.url.startsWith("/api/runtime/chats/a?")
              )
                pages.push(req.url);
              if (
                holdHeader &&
                req.method === "GET" &&
                req.url.startsWith("/api/runtime/chats/a/bookmarks/m109")
              ) {
                holdHeader = false;
                heldHeaders++;
                new Promise((resolve) => (releaseHeader = resolve)).then(() =>
                  next(),
                );
                return;
              }
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
          "JSON.parse(JSON.stringify({chatId:r().model.activeChatId,pending:s.pending.map(e=>({id:e.requestId,state:e.state,type:e.command.type,code:e.error?.code})),error:s.error,bookmarks:r().model.activeChat.bookmarks??[],names:r().model.activeChat.bookmarkNames??{},count:r().model.activeChat.message.length,facadeCount:s.messages.length}))",
        ),
      );
    const snapshot = () => runtime.store.call("snapshot", "a", { limit: 1000 });
    const openMenu = async (page, id) => {
      await page.evaluate(
        "document.querySelector('[data-message-id=" +
          id +
          "] .button-icon-menu').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('.button-icon-bookmark')"),
      );
    };
    const toggle = async (page, id) => {
      await openMenu(page, id);
      await until(() =>
        page.evaluate(
          "!document.querySelector('.button-icon-bookmark').disabled",
        ),
      );
      await page.evaluate(
        "document.querySelector('.button-icon-bookmark').click()",
      );
    };
    const input = async (page, value) => {
      await until(() =>
        page.evaluate("!!document.querySelector('#alert-input')"),
      );
      await page.evaluate(
        "(()=>{const i=document.querySelector('#alert-input');i.value=" +
          JSON.stringify(value) +
          ";i.dispatchEvent(new Event('input',{bubbles:true}));Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='OK').click();})()",
      );
    };
    const openList = async (page) => {
      await page.evaluate(
        "document.querySelector('.button-open-bookmarks').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('.bookmark-close')"),
      );
      await until(() => page.evaluate(ui("s.bookmarkList.ready")));
    };
    const closeList = async (page) => {
      await page.evaluate("document.querySelector('.bookmark-close').click()");
      await until(() =>
        page.evaluate("!document.querySelector('.bookmark-close')"),
      );
    };
    const rename = async (page, id) => {
      await page.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=" +
          id +
          "] .bookmark-name').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('#alert-input')"),
      );
    };
    let reorderedByReadd = false;
    const settled = async (names) => {
      const ids =
        reorderedByReadd && Object.keys(names).length === 2
          ? ["m108", "m109"]
          : Object.keys(names);
      for (const page of [a, b])
        await until(
          () => observed(page),
          (v) =>
            v.chatId === "a" &&
            v.pending.length === 0 &&
            JSON.stringify(v.bookmarks) === JSON.stringify(ids) &&
            JSON.stringify(Object.entries(v.names).sort()) ===
              JSON.stringify(Object.entries(names).sort()),
        );
    };
    const blocked = async (page) => {
      const v = await until(
        () => observed(page),
        (v) => v.pending.some((e) => e.state === "blocked"),
      );
      const entry = v.pending.find((e) => e.state === "blocked");
      assert.equal(entry.code, "REVISION_CONFLICT");
      await until(() => page.evaluate(ui("!!s.error")));
      await page.evaluate(
        ui("r().discardCommand(" + JSON.stringify(entry.id) + ")"),
      );
      await until(() => page.evaluate(ui("s.pending.length===0")));
      return entry;
    };
    // A delayed header must retain the click's owner, and reject before opening
    // a name dialog if selection changed during preparation.
    const original = await snapshot();
    holdHeader = true;
    await toggle(a, "m109");
    await until(() => heldHeaders === 1);
    await openMenu(a, "m109");
    const preparing = await a.evaluate(
      "(()=>{const b=document.querySelector('.button-icon-bookmark');return {pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy'),disabled:b.disabled}})()",
    );
    assert.deepEqual(preparing, {
      pressed: "true",
      busy: "true",
      disabled: true,
    });
    assert.deepEqual((await observed(a)).bookmarks, []);
    await a.evaluate("document.body.click()");
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    releaseHeader();
    await until(() =>
      a.evaluate(ui("s.error.includes('Conversation changed')")),
    );
    assert.equal(
      await a.evaluate("!!document.querySelector('#alert-input')"),
      false,
    );
    assert.equal((await snapshot()).cursor, original.cursor);
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    await a.evaluate(ui("s.error=''"));

    await a.evaluate(
      "window.bookmarkRow=document.querySelector('[data-message-id=m109]');window.bookmarkNeighbor=document.querySelector('[data-message-id=m108]')",
    );
    const pageReads = pages.length;
    await toggle(a, "m109");
    holdRequest = true;
    await input(a, "Synthetic chosen");
    await until(() => heldRequests === 1);
    const held = await observed(a);
    assert.deepEqual(held.bookmarks, []);
    assert.deepEqual(held.names, {});
    assert.equal(held.pending.length, 1);
    assert.equal((await snapshot()).cursor, original.cursor);
    await openMenu(a, "m109");
    const pendingControl = await a.evaluate(
      "(()=>{const b=document.querySelector('.button-icon-bookmark');return {pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy'),disabled:b.disabled}})()",
    );
    assert.deepEqual(pendingControl, preparing);
    await a.evaluate("document.body.click()");
    releaseRequest();
    await settled({ m109: "Synthetic chosen" });
    assert.equal(pages.length, pageReads);
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-message-id=m109]')===window.bookmarkRow&&document.querySelector('[data-message-id=m108]')===window.bookmarkNeighbor",
      ),
      true,
    );
    await toggle(a, "m108");
    await input(a, "");
    await settled({
      m109: "Synthetic chosen",
      m108: "Synthetic manual| Synthetic message 108...",
    });
    await openList(a);
    await openList(b);
    // Original expanded Chat previews now carry their actual persistent ID.
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m109] [role=button]').click()",
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=m109]').textContent.includes('Synthetic message 109')",
      ),
    );
    const closedListCursor = (await snapshot()).cursor;
    holdHeader = true;
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-name').click()",
    );
    await until(() => heldHeaders === 2);
    await closeList(a);
    releaseHeader();
    await until(() =>
      a.evaluate(
        "(async()=>{const {BookmarkPreparations}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return BookmarkPreparations.size===0 || !!document.querySelector('#alert-input');})()",
      ),
    );
    assert.equal(
      await a.evaluate("!!document.querySelector('#alert-input')"),
      false,
      "Closing the list before header completion must retire its late name dialog",
    );
    assert.equal((await snapshot()).cursor, closedListCursor);
    await openList(a);
    // Deletion/re-addition with the same visible value must not rebase an old click.
    holdHeader = true;
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-name').click()",
    );
    await until(() => heldHeaders === 3);
    await b.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-remove').click()",
    );
    await until(() =>
      b.evaluate(
        ui(
          "!r().model.activeChat.bookmarks.includes('m109')&&s.pending.length===0",
        ),
      ),
    );
    await closeList(b);
    await toggle(b, "m109");
    await until(() =>
      b.evaluate(ui("!!document.querySelector('#alert-input')||!!s.error")),
    );
    assert.equal(
      (await observed(b)).error,
      "",
      "Readd must accept a deleted Svelte name key",
    );
    await input(b, "Synthetic chosen");
    reorderedByReadd = true;
    await settled({
      m108: "Synthetic manual| Synthetic message 108...",
      m109: "Synthetic chosen",
    });
    await openList(b);
    const abaCursor = (await snapshot()).cursor;
    releaseHeader();
    await until(() =>
      a.evaluate(
        "(async()=>{const {BookmarkPreparations}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return BookmarkPreparations.size===0 || !!document.querySelector('#alert-input');})()",
      ),
    );
    assert.equal(
      await a.evaluate("!!document.querySelector('#alert-input')"),
      false,
      "A same-value remove/readd while the header is held must reject the old click",
    );
    assert.equal((await snapshot()).cursor, abaCursor);
    await until(() => a.evaluate(ui("s.error.includes('changed')")));
    await a.evaluate(ui("s.error=''"));
    const cancelCursor = (await snapshot()).cursor;
    await rename(a, "m109");
    assert.equal(
      await a.evaluate("document.querySelector('#alert-input').value"),
      "Synthetic chosen",
    );
    await input(a, "");
    await until(() =>
      a.evaluate(
        "!document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-name').disabled",
      ),
    );
    assert.equal((await snapshot()).cursor, cancelCursor);
    await rename(a, "m109");
    holdRequest = true;
    await input(a, "Synthetic pending name");
    await until(() => heldRequests === 2);
    assert.equal((await observed(a)).names.m109, "Synthetic chosen");
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=m109]').textContent.includes('Synthetic pending name')",
      ),
      true,
    );
    await rename(b, "m108");
    await input(b, "Synthetic other member");
    await until(() =>
      b.evaluate(
        ui(
          "r().model.activeChat.bookmarkNames.m108==='Synthetic other member'&&s.pending.length===0",
        ),
      ),
    );
    releaseRequest();
    await settled({
      m109: "Synthetic pending name",
      m108: "Synthetic other member",
    });
    // Stale name and body captures become visible retained conflicts.
    await rename(a, "m109");
    await rename(b, "m109");
    await input(b, "Synthetic remote name");
    await until(() =>
      b.evaluate(
        ui(
          "r().model.activeChat.bookmarkNames.m109==='Synthetic remote name'&&s.pending.length===0",
        ),
      ),
    );
    const nameConflictCursor = (await snapshot()).cursor;
    await input(a, "Synthetic stale name");
    const nameConflict = await blocked(a);
    assert.equal((await snapshot()).cursor, nameConflictCursor);
    await settled({
      m109: "Synthetic remote name",
      m108: "Synthetic other member",
    });
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=m109]').textContent.includes('Synthetic stale name')",
      ),
      false,
    );
    await rename(a, "m109");
    const body = await runtime.store.call("readBookmark", "a", "m109");
    await runtime.store.call("applyCommand", "synthetic-body-race", {
      type: "edit-message",
      chatId: "a",
      messageId: "m109",
      expectedRevision: body.messageRevision,
      text: "Synthetic revised message 109",
    });
    await until(() =>
      b.evaluate(
        ui(
          "r().model.activeChat.message.find(m=>m.chatId==='m109').data==='Synthetic revised message 109'",
        ),
      ),
    );
    const bodyConflictCursor = (await snapshot()).cursor;
    await input(a, "Synthetic stale body name");
    const bodyConflict = await blocked(a);
    assert.equal((await snapshot()).cursor, bodyConflictCursor);
    await settled({
      m109: "Synthetic remote name",
      m108: "Synthetic other member",
    });
    // Selection after the input opens must keep the original target.
    await rename(a, "m108");
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    await input(a, "Synthetic captured owner");
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(() =>
      b.evaluate(
        ui(
          "r().model.activeChat.bookmarkNames.m108==='Synthetic captured owner'",
        ),
      ),
    );
    assert.deepEqual((await observed(a)).bookmarks, []);
    assert.deepEqual(
      (await runtime.store.call("snapshot", "b")).chat.metadata.bookmarks,
      undefined,
    );
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-remove')",
      ),
    );
    const replayCursor = (await snapshot()).cursor;
    holdRequest = true;
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-remove').click()",
    );
    await until(() => heldRequests === 3);
    const pendingRemove = await observed(a);
    assert.ok(pendingRemove.bookmarks.includes("m109"));
    const replayRequestId = pendingRemove.pending[0].id;
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=m109] .bookmark-remove').disabled",
      ),
      true,
    );
    await a.close();
    await b.close();
    releaseRequest();
    await delay(50);
    a = await open(contextA);
    b = await open(contextB);
    watch(a);
    watch(b);
    await settled({ m108: "Synthetic captured owner" });
    assert.equal((await snapshot()).cursor, replayCursor + 1);
    // Original Chat toggle removes without reopening the name dialog.
    await toggle(a, "m109");
    await input(a, "Synthetic readded");
    await settled({
      m108: "Synthetic captured owner",
      m109: "Synthetic readded",
    });
    await toggle(a, "m109");
    await settled({ m108: "Synthetic captured owner" });
    assert.equal(
      await a.evaluate("!!document.querySelector('#alert-input')"),
      false,
    );
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    const final = await observed(a),
      canonical = await snapshot();
    assert.equal(final.error, "");
    assert.equal(final.count, 100);
    assert.equal(final.facadeCount, 100);
    assert.equal(canonical.messages.length, 110);
    assert.ok(canonical.messages.every((row) => row.message.unknown.retained));
    assert.deepEqual(errors, []);
    const paths = [
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/lib/ChatScreens/Chat.svelte",
      "src/lib/Others/BookmarkList.svelte",
      "src/lib/SideBars/SideChatList.svelte",
      "server/entity/bookmarks.cjs",
      "server/entity/store.cjs",
      "server/entity/schema.sql",
      "server/runtime/service.cjs",
      "src/ts/runtime/risuReadModel.ts",
      "server/browser/bookmarkManualUi.test.cjs",
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
      originalMenuAndNameDialog: true,
      originalListRenameAndRemove: true,
      independentBrowserContexts: true,
      immediatePrivatePreparation: true,
      confirmedFacadesNotMutated: true,
      defaultAddAndCancelledRename: true,
      independentMembers: true,
      staleNameAndBodyConflicts: true,
      selectionBeforeHeaderRejected: true,
      selectionAfterInputTargetPinned: true,
      loadedOriginalPreviewStableId: true,
      compactProjectionWithoutSnapshotReads: true,
      allTabsClosedPendingReplay: true,
      onceAfterReplay: true,
      realReload: true,
      outsidePageListUi: false,
      closedListBeforeInputNoWrite: true,
      abaBeforeHeaderRejected: true,
      pendingControl,
      preparing,
      held,
      nameConflict,
      bodyConflict,
      replayRequestId,
      final,
      errors,
      sourceHashes,
    };
    if (process.env.RISU_BOOKMARK_MANUAL_UI_OUTPUT)
      await writeFile(
        process.env.RISU_BOOKMARK_MANUAL_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
