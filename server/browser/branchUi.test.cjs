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
const ui = (v) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${v}})()`;
async function until(read, predicate = Boolean) {
  const end = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic branch condition timed out: " + JSON.stringify(value));
}
test(
  "original branch button copies full canonical history, shares folders, retains source navigation and replays outside-window intent once after all tabs close",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-branch-ui-"));
    let runtime, frontend, browser;
    const requests = [],
      errors = [];
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
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    });
    const command = (id, value) =>
      runtime.store.call("applyCommand", id, value);
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
        createFolderOnBranch: true,
      },
    });
    await command("character", {
      type: "create-character",
      characterId: "c",
      chat: {
        chatId: "a",
        metadata: {
          name: "Synthetic :: source",
          unknown: { retained: true },
          GLGlobalVariables: { local: false },
        },
      },
      definition: {
        type: "character",
        name: "Synthetic branch",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        supaMemory: false,
        customscript: [],
        triggerscript: [],
        chatFolders: [],
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
          data: "Synthetic message " + i,
          unknown: { retained: true },
        },
      });
    for (const messageId of ["m3", "m5"])
      await command("remove" + messageId, {
        type: "remove-message",
        chatId: "a",
        messageId,
        expectedRevision: 1,
        expectedChatRevision: (await runtime.store.call("snapshot", "a")).chat
          .revision,
        expectedChatEpoch: 0,
        mode: "one",
      });
    await command("variable", {
      type: "set-chat-variable",
      chatId: "a",
      key: "$state",
      value: "Synthetic current",
    });
    for (const messageId of ["m10", "m219"]) {
      const h = await runtime.store.call("readBookmark", "a", messageId);
      await command("bookmark-" + messageId, {
        type: "set-bookmark",
        chatId: "a",
        messageId,
        expectedRevision: h.revision,
        expectedMessageRevision: h.messageRevision,
        expectedChatEpoch: h.entityEpoch,
        action: "add",
        name: "Synthetic " + messageId,
      });
    }
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-branch-observation",
          configureServer(server) {
            server.middlewares.use((req, _res, next) => {
              const parsed = new URL(req.url, "http://synthetic.invalid");
              if (
                req.method === "GET" &&
                /^\/api\/runtime\/chats\/[^/]+$/.test(parsed.pathname)
              )
                requests.push(req.url);
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
    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    const ready = async (page) => {
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      await page.evaluate(ui("r().selectCharacter('c','a')"));
      await until(() =>
        page.evaluate(ui("s.scopeReady&&s.pending.length===0")),
      );
    };
    const observationScript =
      "(()=>{const original=window.fetch;window.heldBranch=null;window.releaseBranch=null;window.holdBranch=false;window.holdVariable=false;window.heldVariable=null;window.releaseVariable=null;window.fetch=async(url,init)=>{if(String(url).endsWith('/commands')&&init?.body){const payload=JSON.parse(init.body);if(payload.command?.type==='change-variables'&&window.holdVariable){window.holdVariable=false;window.heldVariable=payload;await new Promise(resolve=>window.releaseVariable=resolve)}if(payload.command?.type==='branch-chat'&&window.holdBranch){window.holdBranch=false;window.heldBranch=payload;await new Promise(resolve=>window.releaseBranch=resolve)}}return original(url,init)}})()";
    const open = async (context) => {
      const p = await browser.page("about:blank", context, {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      p.on("Runtime.exceptionThrown", (v) =>
        errors.push(v.exceptionDetails?.text),
      );
      await p.send("Page.addScriptToEvaluateOnNewDocument", {
        source: observationScript,
      });
      await p.send("Page.navigate", { url });
      await ready(p);
      return p;
    };
    let a = await open(contextA),
      b = await open(contextB);
    const observed = (p) =>
      p.evaluate(
        ui(
          "({chatId:r().model.activeChatId,count:r().model.activeChat.message.length,pending:s.pending.map(e=>({id:e.requestId,state:e.state,type:e.command.type,code:e.error?.code})),error:s.error})",
        ),
      );
    const openMenu = async (p, selector) => {
      await until(() =>
        p.evaluate(
          "!!document.querySelector(" +
            JSON.stringify(selector + " .button-icon-menu") +
            ")",
        ),
      );
      await p.evaluate(
        "document.querySelector(" +
          JSON.stringify(selector + " .button-icon-menu") +
          ").click()",
      );
      await until(() =>
        p.evaluate(
          "!!document.querySelector('.button-icon-branch[data-runtime-branch-message=" +
            selector.match(/=(m\d+)\]/)[1] +
            "]')",
        ),
      );
    };
    const clickBranch = async (p, selector) => {
      await p.evaluate(
        "window.heldBranch=null;window.releaseBranch=null;window.holdBranch=true",
      );
      await openMenu(p, selector);
      await p.evaluate(
        "document.querySelector('.button-icon-branch[data-runtime-branch-message=" +
          selector.match(/=(m\d+)\]/)[1] +
          "]').click()",
      );
      const held = await until(() => p.evaluate("window.heldBranch"));
      assert.equal(held.command.messageId, selector.match(/=(m\d+)\]/)[1]);
      return held;
    };
    assert.equal((await observed(a)).count, 100);
    assert.deepEqual(
      await a.evaluate(
        ui("r().model.activeChat.message.map(m=>m.chatId).slice(0,1)"),
      ),
      ["m120"],
    );
    await a.evaluate("window.holdVariable=true");
    await a.evaluate(
      ui(
        "r().client.enqueueVariables([{scope:'chat',chatId:'a',key:'$state',expectedRevision:1,value:'Synthetic confirmed after pending'}],'source-variable-pending')",
      ),
    );
    await until(() => a.evaluate("window.heldVariable"));
    await openMenu(a, "[data-message-id=m199]");
    assert.equal(
      await a.evaluate(
        "document.querySelector('.button-icon-branch[data-runtime-branch-message=m199]').disabled",
      ),
      true,
    );
    assert.equal(
      (
        await runtime.store.call("readVariables", [
          { scope: "chat", chatId: "a", key: "$state" },
        ])
      ).variables[0].value,
      "Synthetic current",
    );
    await a.evaluate("window.releaseVariable()");
    await until(() =>
      a.evaluate(ui("s.pending.length===0&&!r().pendingBranch('m199')")),
    );
    await a.evaluate("document.body.click()");
    await a.evaluate("window.heldVariable=null;window.holdVariable=true");
    await a.evaluate(
      ui(
        "r().client.enqueueVariables([{scope:'chat',chatId:'b',key:'$independent',expectedRevision:0,value:'Synthetic other'}],'other-variable-pending')",
      ),
    );
    await until(() => a.evaluate("window.heldVariable"));
    assert.equal(await a.evaluate(ui("r().pendingBranch('m199')")), false);
    await a.evaluate("window.releaseVariable()");
    await until(() => a.evaluate(ui("s.pending.length===0")));
    const before = await runtime.store.call("snapshot", "a", { limit: 1000 });
    await until(() =>
      b.evaluate(
        "!!document.querySelector('[data-message-id=m199] .button-icon-menu')",
      ),
    );
    await b.evaluate(
      "window.sourceRow=document.querySelector('[data-message-id=m199]')",
    );
    const first = await clickBranch(a, "[data-message-id=m199]");
    await until(() =>
      a.evaluate(ui("s.pending.some(e=>e.command.type==='branch-chat')")),
    );
    await openMenu(a, "[data-message-id=m199]");
    const control = await a.evaluate(
      "(()=>{const e=document.querySelector('.button-icon-branch');return {disabled:e.disabled,busy:e.getAttribute('aria-busy')}})()",
    );
    assert.deepEqual(control, { disabled: true, busy: "true" });
    assert.equal((await observed(a)).chatId, "a");
    assert.equal((await observed(a)).count, 100);
    assert.equal((await runtime.store.call("listChats", "c")).length, 2);
    assert.equal(
      (await runtime.store.call("getCharacter", "c")).definition.chatFolders
        .length,
      0,
    );
    await a.evaluate("window.releaseBranch()");
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&r().model.activeChatId==='" +
            first.command.chatId +
            "'&&s.pending.length===0",
        ),
      ),
    );
    const copy = await runtime.store.call("snapshot", first.command.chatId, {
      limit: 1000,
    });
    assert.equal(copy.messages.length, 199);
    assert.deepEqual(
      copy.messages.slice(0, -1).map((m) => m.message.data),
      before.messages
        .filter((m) => m.position <= 199)
        .map((m) => m.message.data),
    );
    assert.equal((await observed(a)).count, 100);
    assert.equal(copy.variables[0].value, "Synthetic confirmed after pending");
    assert.deepEqual(copy.chat.metadata.GLGlobalVariables, { local: false });
    assert.deepEqual(copy.chat.metadata.unknown, { retained: true });
    assert.ok(
      copy.messages.every(
        (m) => !before.messages.some((old) => old.id === m.id),
      ),
    );
    assert.deepEqual(copy.chat.metadata.bookmarks, [
      copy.messages.find((m) => m.message.data === "Synthetic message 10").id,
    ]);
    await until(() =>
      b.evaluate(ui("r().model.activeChat.folderId!==undefined")),
    );
    assert.equal(
      await b.evaluate(
        "window.sourceRow===document.querySelector('[data-message-id=m199]')",
      ),
      true,
    );
    assert.equal((await observed(b)).chatId, "a");
    const folder = await runtime.store.call("getCharacter", "c");
    assert.equal(folder.definition.chatFolders.length, 1);
    assert.equal(
      copy.chat.metadata.folderId,
      folder.definition.chatFolders[0].id,
    );
    const creation = await runtime.store.call("changes", before.cursor, 1000);
    assert.deepEqual(
      creation.changes.map((e) => e.type),
      ["fields", "fields", "chat"],
    );
    assert.ok(creation.changes.every((e) => !e.payload.message));
    await until(() =>
      a.evaluate(
        "document.querySelector('.button-branch-origin')?.textContent.includes('Synthetic :: source')",
      ),
    );
    await a.evaluate("document.querySelector('.button-branch-origin').click()");
    await until(() =>
      a.evaluate(
        ui(
          "s.scopeReady&&r().model.activeChatId==='a'&&r().model.activeChat.message.some(m=>m.chatId==='m199')",
        ),
      ),
    );
    const navigated = await clickBranch(a, "[data-message-id=m198]");
    await a.evaluate("document.body.click()");
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    await a.evaluate("window.releaseBranch()");
    await until(() => a.evaluate(ui("s.pending.length===0")));
    assert.equal((await observed(a)).chatId, "b");
    assert.equal(
      (
        await runtime.store.call("snapshot", navigated.command.chatId, {
          limit: 1000,
        })
      ).messages.length,
      198,
    );
    // A second real device edits the boundary while the originating intent is durable but unsent.
    const conflict = await clickBranch(b, "[data-message-id=m197]");
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    await a.evaluate(ui("r().editMessage('m197','Synthetic peer edited')"));
    await until(
      async () =>
        (await runtime.store.call("readBookmark", "a", "m197"))
          .messageRevision === 2,
    );
    await b.evaluate("window.releaseBranch()");
    const blocked = await until(
      () => observed(b),
      (v) =>
        v.pending.some(
          (e) => e.id === conflict.requestId && e.state === "blocked",
        ),
    );
    assert.equal(
      blocked.pending.find((e) => e.id === conflict.requestId).code,
      "REVISION_CONFLICT",
    );
    assert.equal((await runtime.store.call("listChats", "c")).length, 4);
    await b.evaluate(ui("r().discardCommand('" + conflict.requestId + "')"));
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await b.evaluate(ui("s.error=''"));
    // The original outside-window bookmark preview issues the same captured branch command.
    await a.evaluate(
      "document.body.click();document.querySelector('.button-open-bookmarks').click()",
    );
    await until(() =>
      a.evaluate(ui("s.bookmarkList.ready&&s.bookmarkList.items.length===2")),
    );
    await a.evaluate(
      "document.querySelector('[data-runtime-bookmark-id=m10] [role=button]').click()",
    );
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-bookmark-id=m10] .button-icon-menu')",
      ),
    );
    const replay = await clickBranch(a, "[data-runtime-bookmark-id=m10]");
    await until(() =>
      a.evaluate(
        ui("s.pending.some(e=>e.requestId==='" + replay.requestId + "')"),
      ),
    );
    assert.equal((await observed(a)).count, 100);
    const replayCursor = (await runtime.store.call("snapshot", "a")).cursor;
    await a.close();
    await b.close();
    assert.equal((await runtime.store.call("listChats", "c")).length, 4);
    a = await open(contextA);
    b = await open(contextB);
    await until(
      async () => (await runtime.store.call("listChats", "c")).length === 5,
    );
    const replayed = await runtime.store.call(
      "snapshot",
      replay.command.chatId,
      { limit: 1000 },
    );
    assert.equal(replayed.messages.length, 10);
    assert.equal(replayed.messages[0].message.data, "Synthetic message 0");
    const replayEvents = await runtime.store.call(
      "changes",
      replayCursor,
      1000,
    );
    assert.equal(replayEvents.changes.length, 1);
    assert.equal(replayEvents.changes[0].type, "chat");
    const cursor = replayEvents.cursor;
    await command(replay.requestId, replay.command);
    assert.equal((await runtime.store.call("snapshot", "a")).cursor, cursor);
    await a.send("Page.reload", { ignoreCache: true });
    await ready(a);
    await a.evaluate(
      ui("r().selectCharacter('c','" + replay.command.chatId + "')"),
    );
    assert.equal((await observed(a)).count, 10);
    assert.equal(
      (await runtime.store.call("getCharacter", "c")).definition.chatFolders
        .length,
      1,
    );
    assert.ok(requests.length > 5);
    assert.ok(
      requests.every(
        (path) =>
          Number(
            new URL(path, "http://synthetic.invalid").searchParams.get("limit"),
          ) <= 100,
      ),
    );
    assert.deepEqual(errors, []);
    assert.equal((await observed(a)).error, "");
    assert.equal((await observed(b)).error, "");
    const evidence = {
      syntheticOnly: true,
      originalUi: true,
      browsers: 2,
      originalLoadedBodies: 100,
      sourceLiveCount: 218,
      canonicalBranchCount: 199,
      outsideBranchCount: 10,
      bodyFreeCreationEvents: creation.changes.length,
      immediatePendingControl: control,
      sharedFolder: folder.definition.chatFolders[0].id,
      stablePeerRow: true,
      structuredOriginNameWithDelimiter: true,
      sourceNavigation: true,
      navigationDuringAdmissionRetained: true,
      conflictCode: "REVISION_CONFLICT",
      allTabsClosedPendingReplay: true,
      idempotentReplay: true,
      reloadRetained: true,
      currentVariableCopy: true,
      sourcePendingVariableHeld: true,
      unrelatedChatPendingNotHeld: true,
      maxHistoryRead: 100,
      errors,
      requests,
      productionAccess: false,
      privateDataRead: false,
    };
    if (process.env.RISU_BRANCH_UI_OUTPUT) {
      evidence.sourceHashes = {};
      for (const file of [
        "server/entity/branching.cjs",
        "server/entity/lifecycle.cjs",
        "server/entity/store.cjs",
        "src/ts/runtime/browserRuntimeController.svelte.ts",
        "src/ts/runtime/browserRuntimeState.svelte.ts",
        "src/lib/ChatScreens/Chat.svelte",
        "server/browser/branchUi.test.cjs",
      ])
        evidence.sourceHashes[file] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
      await writeFile(
        process.env.RISU_BRANCH_UI_OUTPUT,
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
