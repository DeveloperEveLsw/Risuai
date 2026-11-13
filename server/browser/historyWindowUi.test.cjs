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
  "original bookmark jumps and history controls keep bounded contiguous windows, original Lua ranks/count and independent native responses",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-history-window-ui-"));
    let provider, runtime, frontend, browser, release;
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
        supaMemory: false,
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay', function(id,data,meta)
 if data == 'Synthetic window probe' then return '<span class="window-probe">Synthetic ordinal ' .. tostring(meta.index) .. ' count ' .. tostring(getChatLength(id)) .. '</span>' end
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
          role: "char",
          data: i === 130 ? "Synthetic window probe" : "Synthetic message " + i,
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
    const book = await runtime.store.call("readBookmark", "a", "m130");
    await command("bookmark", {
      type: "set-bookmark",
      chatId: "a",
      messageId: "m130",
      expectedRevision: book.revision,
      expectedMessageRevision: book.messageRevision,
      expectedChatEpoch: book.entityEpoch,
      action: "add",
      name: "Synthetic jump",
    });
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      plugins: [
        {
          name: "synthetic-history-gate",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
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
    assert.equal((await ids(a)).length, 100);
    assert.equal((await ids(a))[0], "m120");
    await a.evaluate(
      "document.querySelector('.button-open-bookmarks').click()",
    );
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-bookmark-id=m130] .bookmark-jump')",
      ),
    );
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m130] [role=button]').click()",
    );
    await until(
      () =>
        a.evaluate(
          ui(
            "(()=>{const el=document.querySelector('[data-runtime-bookmark-id=m130]');const capture=r().captureDisplay(10,false,'c','m130');return {text:el?.textContent,html:el?.querySelector('.x-risu-window-probe')?.outerHTML,error:s.error,scope:s.scopeReady,history:capture?.history,triggers:capture?.triggers.length}})()",
          ),
        ),
      (v) => v.html?.includes("Synthetic ordinal 128 count 218"),
    );
    console.log("Synthetic window: loaded original HTML/Lua preview accepted");
    await a.evaluate(
      ui(
        "window.syntheticOverlap=r().model.activeChat.message.find(m=>m.chatId==='m170');true",
      ),
    );
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m130] .bookmark-jump').click()",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&s.historicalWindow&&!s.loadingHistory&&!document.querySelector('.bookmark-close')",
        ),
      ),
    );
    assert.deepEqual(
      await ids(a),
      Array.from({ length: 100 }, (_, i) => "m" + (80 + i)),
    );
    assert.equal(
      await a.evaluate(
        ui(
          "r().model.activeChat.message.find(m=>m.chatId==='m170')===window.syntheticOverlap",
        ),
      ),
      true,
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-message-id=m130] .x-risu-window-probe')?.textContent==='Synthetic ordinal 128 count 218'",
      ),
    );
    console.log(
      "Synthetic window: stable-ID jump and original main HTML accepted",
    );
    const oldIds = await ids(a);
    const job = await b.evaluate(ui("r().send('Synthetic peer input')"));
    console.log("Synthetic window: peer native job admitted");
    await b.evaluate(ui("r().waitForJob(" + JSON.stringify(job) + ")"));
    console.log("Synthetic window: peer native job saved");
    await until(() => a.evaluate(ui("s.newerMessageCount===42&&s.hasLater")));
    assert.deepEqual(await ids(a), oldIds);
    assert.equal(calls, 1);
    await until(
      () =>
        a.evaluate(
          ui(
            "({text:document.querySelector('[data-message-id=m130]')?.textContent,probe:document.querySelector('[data-message-id=m130] .x-risu-window-probe')?.textContent,scope:s.scopeReady,error:s.error,history:r().model.displayHistory(50),capture:r().captureDisplay(50,false,'c','m130')?.state})",
          ),
        ),
      (v) => v.probe === "Synthetic ordinal 128 count 220",
    );
    await a.evaluate(
      "document.querySelector('.runtime-history-later').click()",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&!s.loadingHistory&&r().model.activeChat.message.length===42",
        ),
      ),
    );
    assert.deepEqual(
      (await ids(a)).slice(0, 40),
      Array.from({ length: 40 }, (_, i) => "m" + (180 + i)),
    );
    assert.equal(
      await a.evaluate(ui("r().model.activeChat.message.at(-1).data")),
      "Synthetic remote response",
    );
    await a.evaluate(
      "document.querySelector('.runtime-history-earlier').click()",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&!s.loadingHistory&&r().model.activeChat.message[0].chatId==='m80'",
        ),
      ),
    );
    await a.evaluate(
      "document.querySelector('.runtime-history-earlier').click()",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&!s.loadingHistory&&r().model.activeChat.message[0].chatId==='m0'",
        ),
      ),
    );
    assert.equal((await ids(a)).length, 78);
    assert.equal(
      await a.evaluate(
        "document.querySelector('.runtime-history-earlier').disabled",
      ),
      true,
    );
    await a.evaluate(
      "document.querySelector('.runtime-history-latest').click()",
    );
    await until(() =>
      a.evaluate(ui("s.scopeReady&&!s.loadingHistory&&!s.historicalWindow")),
    );
    assert.equal((await ids(a)).length, 100);
    assert.equal((await ids(a))[0], "m122");
    await a.evaluate(ui("r().jumpToMessage('m130')"));
    holdLatest = true;
    await a.evaluate(ui("(window.syntheticLatest=r().loadLatest(),true)"));
    await until(() => heldLatest === 1);
    await a.evaluate(ui("r().jumpToMessage('m70')"));
    release();
    assert.equal(await a.evaluate("window.syntheticLatest"), false);
    assert.equal((await ids(a))[0], "m20");
    assert.equal(
      await a.evaluate(
        ui("s.historicalWindow&&s.scopeReady&&!s.loadingHistory"),
      ),
      true,
    );
    // A held stable-ID read must not restore its old screen after a selection change.
    hold = true;
    await a.evaluate(
      ui("(window.syntheticNavigation=r().jumpToMessage('m130'),true)"),
    );
    await until(() => held === 1);
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    assert.equal(await a.evaluate(ui("s.scopeReady&&!s.loadingHistory")), true);
    release();
    assert.equal(await a.evaluate("window.syntheticNavigation"), -1);
    assert.deepEqual(await ids(a), []);
    // The original callback must recompute the stable ID after display hydration.
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    await a.evaluate(
      "document.querySelector('.button-open-bookmarks').click()",
    );
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-bookmark-id=m130] .bookmark-jump')",
      ),
    );
    await a.evaluate(
      ui(
        "(()=>{const controller=r(),original=controller.jumpToMessage.bind(controller);controller.jumpToMessage=(id)=>window.syntheticRemovedJump=original(id);return true})()",
      ),
    );
    holdDisplay = true;
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m130] .bookmark-jump').click()",
    );
    await until(() => heldDisplay === 1);
    const removalHeader = await runtime.store.call("readBookmark", "a", "m130");
    const removalSnapshot = await runtime.store.call("snapshot", "a");
    await command("synthetic-removed-jump-target", {
      type: "remove-message",
      chatId: "a",
      messageId: "m130",
      mode: "one",
      expectedRevision: removalHeader.messageRevision,
      expectedChatRevision: removalSnapshot.chat.revision,
      expectedChatEpoch: removalHeader.entityEpoch,
    });
    await until(() =>
      a.evaluate(
        ui("!r().model.activeChat.message.some(m=>m.chatId==='m130')"),
      ),
    );
    release();
    assert.equal(await a.evaluate("window.syntheticRemovedJump"), -1);
    assert.equal(
      await a.evaluate("!!document.querySelector('.bookmark-close')"),
      true,
    );
    await until(() => a.evaluate(ui("s.scopeReady&&!s.loadingHistory")));
    assert.equal(await a.evaluate(ui("s.error")), "");
    assert.ok(
      requests.every(
        (p) =>
          Number(
            new URL(p, "http://synthetic.invalid").searchParams.get("limit"),
          ) <= 100,
      ),
    );
    assert.deepEqual(errors, []);
    const paths = [
      "server/entity/messageWindow.cjs",
      "server/entity/store.cjs",
      "server/runtime/service.cjs",
      "src/ts/parser/parser.svelte.ts",
      "src/ts/process/scriptings.ts",
      "src/lib/ChatScreens/ChatBody.svelte",
      "src/ts/runtime/browserDisplayLua.ts",
      "src/ts/runtime/browserDisplayMetadata.ts",
      "src/ts/runtime/risuReadModel.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/lib/Others/BookmarkList.svelte",
      "src/lib/ChatScreens/DefaultChatScreen.svelte",
      "server/browser/historyWindowUi.test.cjs",
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
      independentContexts: true,
      originalBookmarkJump: true,
      originalHtmlLua: true,
      denseOrdinalAcrossGaps: true,
      stableOverlappingModelRow: true,
      boundedBodies: true,
      bidirectionalControls: true,
      latestReturn: true,
      remoteNativeGeneration: true,
      remoteResponseOutsideHistoricalWindow: true,
      selectionDuringHeldReadRejected: true,
      supersededLatestReturnsFalse: true,
      removedTargetDuringDisplayHydrationRejected: true,
      originalListRetainedAfterRejectedJump: true,
      requests,
      nativeCalls: calls,
      errors,
      sourceHashes,
      canonicalCount: 219,
      outsidePageBookmarkListPreview: false,
    };
    if (process.env.RISU_HISTORY_WINDOW_UI_OUTPUT)
      await writeFile(
        process.env.RISU_HISTORY_WINDOW_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(
      JSON.stringify({ requests: requests.length, nativeCalls: calls, errors }),
    );
  },
);
