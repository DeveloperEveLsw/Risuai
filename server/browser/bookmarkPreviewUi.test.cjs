"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { createServer: createHttp } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (v) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${v}})()`;
async function until(read, predicate = Boolean) {
  const end = Date.now() + 45000;
  let v;
  do {
    v = await read();
    if (predicate(v)) return v;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic history condition timed out: " + JSON.stringify(v));
}
test(
  "canonical bookmark pages keep outside-window original CBS/regex/Lua previews independent and retire stale owners across two browsers",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-bookmark-preview-ui-"),
    );
    let provider, runtime, frontend, browser, release;
    let holdPage = false,
      heldPage = 0;
    let hold = false,
      held = 0,
      calls = 0;
    let holdLatest = false,
      heldLatest = 0,
      holdDisplay = false,
      heldDisplay = 0;
    const requests = [],
      errors = [];
    t.after(async () => {
      release?.();
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      if (runtime) await runtime.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((r) => provider.close(r));
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createHttp(async (req, res) => {
      for await (const chunk of req) {
      }
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Synthetic remote response" } }],
        }),
      );
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20, progressIntervalMs: 25 },
    });
    const command = (id, command) =>
      runtime.store.call("applyCommand", id, command);
    await command("settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        enableBookmark: true,
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic",
        forceReplaceUrl:
          "http://127.0.0.1:" +
          provider.address().port +
          "/v1/chat/completions",
        customTokenizer: "tik",
        useStreaming: false,
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic",
      },
    });
    await command("character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic navigation" } },
      definition: {
        type: "character",
        name: "Synthetic navigation",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        customscript: [
          { in: "\\[INJECT\\]", out: "@@inject", type: "editdisplay" },
        ],
        supaMemory: false,
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay', function(id,data,meta)
 if string.find(data, 'Synthetic outside probe', 1, true) then return '<span class="window-probe">Synthetic ordinal ' .. tostring(meta.index) .. ' count ' .. tostring(getChatLength(id)) .. '</span>' end
 return data
end)`,
              },
            ],
          },
        ],
      },
    });
    await command("other", {
      type: "create-chat",
      characterId: "c",
      chatId: "b",
      metadata: { name: "Other synthetic" },
    });
    for (let i = 0; i < 220; i++)
      await command("message" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m" + i,
        message: {
          role: i === 11 ? "user" : "char",
          data:
            i === 10
              ? "Synthetic outside probe"
              : i === 11
                ? "Synthetic outside source {{role}} [INJECT]"
                : "Synthetic message " + i,
          unknown: { retained: true },
        },
      });
    for (const id of ["m3", "m5"]) {
      const h = await runtime.store.call("readBookmark", "a", id);
      const snapshot = await runtime.store.call("snapshot", "a");
      await command("remove" + id, {
        type: "remove-message",
        chatId: "a",
        messageId: id,
        expectedRevision: h.messageRevision,
        expectedChatRevision: snapshot.chat.revision,
        expectedChatEpoch: h.entityEpoch,
        mode: "one",
      });
    }
    const bookmarkIds = Array.from({ length: 112 }, (_, i) => "m" + i).filter(
      (id) => !["m3", "m5"].includes(id),
    );
    for (const id of bookmarkIds) {
      const h = await runtime.store.call("readBookmark", "a", id);
      await command("bookmark-" + id, {
        type: "set-bookmark",
        chatId: "a",
        messageId: id,
        expectedRevision: h.revision,
        expectedMessageRevision: h.messageRevision,
        expectedChatEpoch: h.entityEpoch,
        action: "add",
        name: "Synthetic " + id,
      });
    }
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-history-gate",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (
                req.method === "GET" &&
                req.url.startsWith("/api/runtime/chats/a/bookmarks?")
              ) {
                requests.push(req.url);
                if (holdPage) {
                  holdPage = false;
                  heldPage++;
                  const captured = runtime.store.call("listBookmarks", "a", {
                    limit: 100,
                  });
                  const gate = new Promise((r) => (release = r));
                  Promise.all([captured, gate])
                    .then(([page]) => {
                      res.setHeader("content-type", "application/json");
                      res.end(JSON.stringify(page));
                    })
                    .catch(next);
                  return;
                }
              }
              if (
                req.method === "GET" &&
                req.url.startsWith("/api/runtime/chats/a?")
              )
                requests.push(req.url);
              if (
                hold &&
                req.method === "GET" &&
                req.url.includes("around=m130")
              ) {
                hold = false;
                held++;
                new Promise((r) => (release = r)).then(() => next());
                return;
              }
              const parsed = new URL(req.url, "http://synthetic.invalid");
              if (
                holdLatest &&
                req.method === "GET" &&
                parsed.pathname === "/api/runtime/chats/a" &&
                !parsed.searchParams.has("around") &&
                !parsed.searchParams.has("before") &&
                !parsed.searchParams.has("after")
              ) {
                holdLatest = false;
                heldLatest++;
                new Promise((r) => (release = r)).then(() => next());
                return;
              }
              if (
                holdDisplay &&
                req.method === "GET" &&
                parsed.pathname === "/api/runtime/chats/a/display"
              ) {
                holdDisplay = false;
                heldDisplay++;
                new Promise((r) => (release = r)).then(() => next());
                return;
              }
              next();
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
    const open = async () => {
      const p = await browser.page(url, await browser.newContext(), {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      const evaluate = p.evaluate.bind(p);
      p.evaluate = async (expression, ...args) => {
        try {
          return await evaluate(expression, ...args);
        } catch (error) {
          throw new Error(
            "Synthetic evaluation: " +
              expression.slice(0, 350) +
              "; " +
              error.message,
          );
        }
      };
      p.on("Runtime.exceptionThrown", (v) =>
        errors.push(v.exceptionDetails?.text),
      );
      await until(() =>
        p.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await p.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(
        () =>
          p.evaluate(
            ui(
              "({scopeReady:s.scopeReady,chatId:r().model.activeChatId,error:s.error})",
            ),
          ),
        (v) => v.scopeReady,
      );
      if (await p.evaluate(ui("r().model.activeChatId!=='a'")))
        await p.evaluate(ui("r().selectCharacter('c','a')"));
      await until(() =>
        p.evaluate(ui("s.scopeReady&&r().model.activeChatId==='a'")),
      );
      return p;
    };
    const a = await open(),
      b = await open();
    const ids = (p) =>
      p.evaluate(ui("r().model.activeChat.message.map(m=>m.chatId)"));
    const initial = await ids(a);
    assert.equal(initial.length, 100);
    assert.equal(initial[0], "m120");
    const openList = async (p) => {
      await p.evaluate(
        "document.querySelector('.button-open-bookmarks').click()",
      );
      await until(() =>
        p.evaluate(
          ui("s.bookmarkList.ready&&s.bookmarkList.items.length===100"),
        ),
      );
    };
    const closeList = async (p) => {
      await p.evaluate("document.querySelector('.bookmark-close').click()");
      await until(() =>
        p.evaluate(
          ui(
            "!s.bookmarkList.session&&!document.querySelector('.bookmark-close')",
          ),
        ),
      );
    };
    const expand = async (p, id) => {
      await p.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=" +
          id +
          "] [role=button]').click()",
      );
    };
    await openList(a);
    await openList(b);
    assert.deepEqual(
      await a.evaluate(ui("s.bookmarkList.items.map(i=>i.messageId)")),
      bookmarkIds.slice(0, 100),
    );
    await expand(a, "m10");
    const outside = await until(
      () =>
        a.evaluate(
          ui(
            "(()=>{const c=r().captureBookmarkDisplay(s.bookmarkList.presentationToken,'m10');return {html:document.querySelector('[data-runtime-bookmark-id=m10] .x-risu-window-probe')?.outerHTML,history:c?.history,source:c?.sourceContent,revision:c?.message.revision,error:s.error}})()",
          ),
        ),
      (v) => v.html?.includes("Synthetic ordinal 8 count 218"),
    );
    assert.equal(outside.source, "Synthetic outside probe");
    assert.equal(outside.history.ordinal, 8);
    assert.equal(outside.history.count, 218);
    assert.deepEqual(await ids(a), initial);
    await expand(a, "m11");
    const rewritten = await until(
      async () => {
        const p = await runtime.store.call("listBookmarks", "a", {
          limit: 100,
        });
        return p.items.find((i) => i.messageId === "m11");
      },
      (v) => v.messageRevision === 2,
    );
    assert.equal(
      rewritten.message.data,
      "Synthetic outside source user [INJECT]",
    );
    assert.equal(rewritten.displayOrigin.messageRevision, 2);
    await until(() =>
      a.evaluate(
        ui(
          "s.bookmarkList.ready&&s.bookmarkList.items.find(i=>i.messageId==='m11')?.messageRevision===2",
        ),
      ),
    );
    const origin = await a.evaluate(
      ui(
        "r().captureBookmarkDisplay(s.bookmarkList.presentationToken,'m11').message.origin",
      ),
    );
    assert.deepEqual(origin, rewritten.displayOrigin);
    assert.deepEqual(await ids(a), initial);
    // An independent device receives the rewrite origin, so reopening its original
    // source cannot submit it under a fabricated occurrence.
    await until(() =>
      b.evaluate(
        ui(
          "s.bookmarkList.ready&&s.bookmarkList.items.find(i=>i.messageId==='m11')?.messageRevision===2",
        ),
      ),
    );
    await expand(b, "m11");
    await until(() =>
      b.evaluate(
        "document.querySelector('[data-runtime-bookmark-id=m11] .chattext')?.textContent.includes('Synthetic outside source user')",
      ),
    );
    assert.equal(
      (
        await runtime.store.call("listBookmarks", "a", { limit: 100 })
      ).items.find((i) => i.messageId === "m11").messageRevision,
      2,
    );
    // Use the original outside-row name dialog on A, then observe B's list.
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m10] .bookmark-name').click()",
    );
    await until(() => a.evaluate("!!document.querySelector('#alert-input')"));
    await a.evaluate(
      "(()=>{const i=document.querySelector('#alert-input');i.value='Synthetic outside renamed';i.dispatchEvent(new Event('input',{bubbles:true}));Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='OK').click()})()",
    );
    for (const p of [a, b])
      await until(() =>
        p.evaluate(
          ui(
            "s.bookmarkList.ready&&s.bookmarkList.items.find(i=>i.messageId==='m10')?.name==='Synthetic outside renamed'",
          ),
        ),
      );
    await b.evaluate(
      ui("r().editMessage('m10','Synthetic outside probe edited')"),
    );
    for (const p of [a, b])
      await until(() =>
        p.evaluate(
          ui(
            "s.bookmarkList.ready&&s.bookmarkList.items.find(i=>i.messageId==='m10')?.message.data==='Synthetic outside probe edited'",
          ),
        ),
      );
    assert.deepEqual(await ids(a), initial);
    // All110 canonical members are reachable through bounded original controls.
    await a.evaluate("document.querySelector('.bookmark-next').click()");
    await until(() =>
      a.evaluate(ui("s.bookmarkList.ready&&!s.bookmarkList.first")),
    );
    assert.deepEqual(
      await a.evaluate(ui("s.bookmarkList.items.map(i=>i.messageId)")),
      bookmarkIds.slice(100),
    );
    assert.equal(await a.evaluate(ui("s.bookmarkList.items.length")), 10);
    assert.deepEqual(await ids(a), initial);
    await a.evaluate("document.querySelector('.bookmark-first').click()");
    await until(() =>
      a.evaluate(ui("s.bookmarkList.ready&&s.bookmarkList.items.length===100")),
    );
    // A held old page cannot publish after the originating list was closed.
    holdPage = true;
    await a.evaluate(
      ui(
        "(window.syntheticHeld=r().loadBookmarkPage(s.bookmarkList.session),true)",
      ),
    );
    await until(() => heldPage === 1);
    await closeList(a);
    const retired = await a.evaluate(
      ui("r().captureBookmarkDisplay('retired','m10')===undefined"),
    );
    assert.equal(retired, true);
    await openList(a);
    release();
    release = undefined;
    await a.evaluate("window.syntheticHeld");
    assert.equal(await a.evaluate(ui("s.bookmarkList.items.length")), 100);
    // A removed outside source cannot be resurrected by a page captured before
    // that deletion; dense ranks in the replacement page remain canonical.
    holdPage = true;
    await a.evaluate(
      ui(
        "(window.syntheticOld=r().loadBookmarkPage(s.bookmarkList.session),true)",
      ),
    );
    await until(() => heldPage === 2);
    const saved = await runtime.store.call("readBookmark", "a", "m10");
    const snapshot = await runtime.store.call("snapshot", "a");
    await command("remove-outside-source", {
      type: "remove-message",
      chatId: "a",
      messageId: "m10",
      expectedRevision: saved.messageRevision,
      expectedChatRevision: snapshot.chat.revision,
      expectedChatEpoch: saved.entityEpoch,
      mode: "one",
    });
    await until(() =>
      a.evaluate(
        ui(
          "s.bookmarkList.ready&&!s.bookmarkList.items.some(i=>i.messageId==='m10')",
        ),
      ),
    );
    release();
    release = undefined;
    await a.evaluate("window.syntheticOld");
    assert.equal(
      await a.evaluate(ui("s.bookmarkList.items.some(i=>i.messageId==='m10')")),
      false,
    );
    assert.equal(
      await a.evaluate(
        ui(
          "r().captureBookmarkDisplay(s.bookmarkList.presentationToken,'m10')===undefined",
        ),
      ),
      true,
    );
    assert.deepEqual(await ids(a), initial);
    // Remove another outside member through the original list's remove control.
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m0] .bookmark-remove').click()",
    );
    for (const p of [a, b])
      await until(() =>
        p.evaluate(
          ui(
            "s.bookmarkList.ready&&s.bookmarkList.count===108&&!s.bookmarkList.items.some(i=>i.messageId==='m0')",
          ),
        ),
      );
    // Original jump remains a stable-ID navigation, after arbitrary outside edits.
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m11] .bookmark-jump').click()",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&s.historicalWindow&&!document.querySelector('.bookmark-close')",
        ),
      ),
    );
    assert.equal((await ids(a)).length, 100);
    assert.ok((await ids(a)).includes("m11"));
    const final = await runtime.store.call("listBookmarks", "a", {
      limit: 100,
    });
    const responseRequests = requests.filter((p) => p.includes("/bookmarks?"));
    assert.ok(responseRequests.length >= 8);
    assert.ok(
      responseRequests.every(
        (p) =>
          new URL(p, "http://synthetic.invalid").searchParams.get("limit") ===
          "100",
      ),
    );
    assert.ok(
      requests
        .filter((p) => !p.includes("/bookmarks?"))
        .every(
          (p) =>
            Number(
              new URL(p, "http://synthetic.invalid").searchParams.get("limit"),
            ) <= 100,
        ),
    );
    assert.deepEqual(errors, []);
    assert.equal(await a.evaluate(ui("s.error")), "");
    if (process.env.RISU_BOOKMARK_PREVIEW_UI_OUTPUT) {
      const sourceFiles = [
        "src/ts/runtime/bookmarkPreviews.ts",
        "src/ts/runtime/browserRuntimeController.svelte.ts",
        "src/lib/Others/BookmarkList.svelte",
        "src/lib/ChatScreens/Chat.svelte",
        "src/lib/ChatScreens/ChatBody.svelte",
        "src/ts/process/scriptings.ts",
        "src/ts/parser/parser.svelte.ts",
        "server/entity/bookmarks.cjs",
        "server/browser/bookmarkPreviewUi.test.cjs",
      ];
      const sourceHashes = {};
      for (const file of sourceFiles)
        sourceHashes[file] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
      await writeFile(
        process.env.RISU_BOOKMARK_PREVIEW_UI_OUTPUT,
        JSON.stringify(
          {
            syntheticOnly: true,
            originalUi: true,
            browsers: 2,
            historyCount: 218,
            bookmarkCount: 110,
            mainWindowBodies: 100,
            pageLimit: 100,
            outside,
            rewritten,
            origin,
            heldPages: heldPage,
            finalCount: final.count,
            requests,
            errors,
            sourceHashes,
            productionAccess: false,
            privateDataRead: false,
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
