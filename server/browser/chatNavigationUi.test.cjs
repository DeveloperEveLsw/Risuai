"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Synthetic chat navigation timed out: " + JSON.stringify(value));
}
async function drag(page, source, target) {
  const bounds = (selector) =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width*.35,y:r.y+r.height*.5};})()`,
    );
  const from = await bounds(source),
    to = await bounds(target);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...from,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 12; step++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * step) / 12,
      y: from.y + ((to.y - from.y) * step) / 12,
      button: "left",
      buttons: 1,
    });
    await delay(30);
  }
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...to,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

test(
  "original folder controls and pointer drags persist private pending intent, guarded canonical membership/order and all-tab replay across devices",
  { timeout: 240000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-chat-navigation-ui-"));
    let runtime, frontend, browser, releaseRequest;
    let holdRequest = false,
      heldRequests = 0;
    const origins = [],
      bodyReads = [],
      errors = [],
      observedFolderCommands = [],
      observedCommands = new Map();
    t.after(async () => {
      releaseRequest?.();
      if (process.env.RISU_CHAT_NAVIGATION_COMMAND_OBSERVATIONS_OUTPUT)
        await writeFile(
          process.env.RISU_CHAT_NAVIGATION_COMMAND_OBSERVATIONS_OUTPUT,
          JSON.stringify(observedFolderCommands, null, 2) + "\n",
        );
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
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    });
    let n = 0;
    const command = (value) =>
      runtime.store.call(
        "applyCommand",
        "synthetic-navigation-ui-" + ++n,
        value,
      );
    await command({
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        aiModel: "gpt35",
        useStreaming: false,
        maxContext: 8000,
        maxResponse: 128,
        zoomsize: 100,
        theme: "default",
        timeout: 120,
      },
    });
    await command({
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic navigation",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        chatFolders: [
          {
            id: "f1",
            name: "Synthetic one",
            folded: false,
            unknown: { preserved: true },
          },
          { id: "f2", name: "Synthetic two", folded: false },
        ],
      },
    });
    for (const [chatId, folderId] of [
      ["a", "f1"],
      ["b", "f1"],
      ["c-chat", "f2"],
      ["orphan", "missing-folder"],
    ])
      await command({
        type: "create-chat",
        characterId: "c",
        chatId,
        metadata: {
          name: chatId,
          folderId,
          note: "Synthetic note",
          unknown: { preserved: true },
        },
        messages: [
          {
            id: "synthetic-" + chatId,
            message: { role: "char", data: "Synthetic body" },
          },
        ],
      });
    const originalCall = runtime.store.call.bind(runtime.store);
    runtime.store.call = async (method, ...args) => {
      if (method === "applyCommand") {
        observedCommands.set(args[0], structuredClone(args[1]));
        observedFolderCommands.push({
          id: args[0],
          type: args[1].type,
          edits: args[1].edits?.filter((edit) => edit.key === "chatFolders"),
          folderId: args[1].folderId,
        });
      }
      return originalCall(method, ...args);
    };
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-navigation-hold",
          configureServer(server) {
            server.middlewares.use((req, _res, next) => {
              if (
                req.method === "GET" &&
                /^\/api\/runtime\/chats\/[^/]+$/.test(
                  new URL(req.url, "http://synthetic.invalid").pathname,
                )
              )
                bodyReads.push(req.url);
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
    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    const open = async (context) => {
      const page = await browser.page(url, context, {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      page.on("Runtime.exceptionThrown", (v) =>
        errors.push(
          v.exceptionDetails?.exception?.description ??
            v.exceptionDetails?.text,
        ),
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await page.evaluate(ui("r().selectCharacter('c','a')"));
      await until(() =>
        page.evaluate(ui("s.scopeReady&&r().model.activeChatId==='a'")),
      );
      await page.evaluate(
        ui(
          "(()=>{window.__syntheticNavigationRestorations=[];const bridge=r(),original=bridge.reorderChatNavigation.bind(bridge);bridge.reorderChatNavigation=(...args)=>{const membership={};for(const e of document.querySelectorAll('[data-chat-id][data-risu-chat-idx]'))membership[e.dataset.chatId]=e.closest('[data-chat-folder-id]')?.dataset.chatFolderId??null;window.__syntheticNavigationRestorations.push({folders:Array.from(document.querySelectorAll('[data-chat-folder-id]')).map(e=>e.dataset.chatFolderId),membership});return original(...args);};return true;})()",
        ),
      );
      return page;
    };
    let a = await open(contextA),
      b = await open(contextB);
    const state = (page) =>
      page.evaluate(
        ui(
          "JSON.parse(JSON.stringify({folders:r().model.database.characters[r().model.characterIndex('c')].chatFolders,order:r().model.database.characters[r().model.characterIndex('c')].chats.map(c=>c.id),active:r().model.activeChatId,pending:s.pending.map(e=>({id:e.requestId,type:e.command.type,state:e.state,code:e.error?.code})),error:s.error}))",
        ),
      );
    const folder = (id) => `[data-chat-folder-id="${id}"]`;
    const click = (page, selector) =>
      page.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).click()`,
      );
    const layout = (page) =>
      page.evaluate(
        "(()=>{const result={};for(const e of document.querySelectorAll('[data-chat-id][data-risu-chat-idx]'))result[e.dataset.chatId]=e.closest('[data-chat-folder-id]')?.dataset.chatFolderId??null;return result;})()",
      );
    const settle = () =>
      Promise.all([
        until(() =>
          a.evaluate(
            "(async()=>{const {RuntimeUIState:s,FieldOverlays:f,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.pending.length===0&&f.size===0&&!r().chatNavigationOverlay('c')})()",
          ),
        ),
        until(() =>
          b.evaluate(
            "(async()=>{const {RuntimeUIState:s,FieldOverlays:f,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.pending.length===0&&f.size===0&&!r().chatNavigationOverlay('c')})()",
          ),
        ),
      ]);
    const header = () => runtime.store.call("getCharacter", "c");
    const snapshot = (id) => runtime.store.call("snapshot", id, { limit: 100 });
    const button = async (page, text) => {
      await until(() =>
        page.evaluate(
          `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)})`,
        ),
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
      );
    };

    holdRequest = true;
    await click(a, "[data-chat-folder-action=add]");
    const newId = await until(() =>
      a.evaluate(
        "Array.from(document.querySelectorAll('[data-chat-folder-id]')).map(e=>e.dataset.chatFolderId).find(id=>!['f1','f2'].includes(id))",
      ),
    );
    assert.ok(newId);
    assert.equal((await state(a)).folders.length, 2);
    assert.equal((await state(b)).folders.length, 2);
    assert.equal((await header()).definition.chatFolders.length, 2);
    await until(() => heldRequests === 1);
    releaseRequest();
    await settle();
    await until(() =>
      b.evaluate(`!!document.querySelector(${JSON.stringify(folder(newId))})`),
    );
    await click(a, folder(newId) + " [data-chat-folder-action=rename]");
    await until(() =>
      a.evaluate(
        `!!document.querySelector(${JSON.stringify(folder(newId) + " input")})`,
      ),
    );
    await a.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(folder(newId) + " input")});e.value='Synthetic renamed';e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await settle();
    await until(
      () => state(b),
      (value) =>
        value.folders.some(
          (f) => f.id === newId && f.name === "Synthetic renamed",
        ),
    );
    await click(a, folder(newId) + " [data-chat-folder-action=rename]");
    holdRequest = true;
    await click(a, folder(newId) + " [data-chat-folder-action=fold]");
    await until(() => heldRequests === 2);
    assert.equal(
      (await state(a)).folders.find((f) => f.id === newId).folded,
      false,
    );
    assert.equal(
      await a.evaluate(
        `document.querySelector(${JSON.stringify(folder(newId) + " .risu-chat")}).classList.contains('hidden')`,
      ),
      true,
    );
    releaseRequest();
    await settle();
    await until(
      () => state(b),
      (value) => value.folders.find((f) => f.id === newId).folded === true,
    );
    await click(a, folder(newId) + " [data-chat-folder-action=fold]");
    await settle();
    await click(a, folder(newId) + " [data-chat-folder-action=color]");
    await until(() =>
      a.evaluate(
        "Array.from(document.querySelectorAll('button')).some(b=>/color/i.test(b.textContent)&&/folder/i.test(b.textContent))",
      ),
    );
    await a.evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>/color/i.test(b.textContent)&&/folder/i.test(b.textContent)).click()",
    );
    await button(a, "blue");
    await settle();
    await until(
      () => state(b),
      (value) => value.folders.find((f) => f.id === newId).color === "blue",
    );

    const membershipBeforeDrop = await layout(a);
    holdRequest = true;
    await drag(
      a,
      "[data-chat-id=b][data-risu-chat-idx]",
      folder(newId) + " .risu-chat",
    );
    await until(() => heldRequests === 3);
    assert.deepEqual(
      (await a.evaluate("window.__syntheticNavigationRestorations"))[0]
        .membership,
      membershipBeforeDrop,
      "Sortable must restore exact memberships before durable admission",
    );
    assert.equal((await snapshot("b")).chat.metadata.folderId, "f1");
    assert.equal((await layout(a)).b, newId);
    assert.equal((await layout(b)).b, "f1");
    assert.equal((await state(a)).active, "a");
    releaseRequest();
    await settle();
    await until(
      () => layout(b),
      (value) => value.b === newId,
    );
    const folderOrderBeforeDrop = (await state(a)).folders.map(
      (folder) => folder.id,
    );
    await drag(
      a,
      folder("f2") + " > [data-chat-folder-action=fold]",
      folder(newId) + " > [data-chat-folder-action=fold]",
    );
    const restoredAtDrop = await until(
      () => a.evaluate("window.__syntheticNavigationRestorations"),
      (rows) => rows.length === 2,
    );
    assert.deepEqual(
      restoredAtDrop[1].folders,
      folderOrderBeforeDrop,
      "Sortable must restore exact folder order before durable admission",
    );
    await until(header, (value) => value.definition.chatFolders[0].id === "f2");
    await settle();
    assert.equal((await state(a)).active, "a");
    assert.equal((await state(b)).active, "a");
    assert.deepEqual(
      (await header()).definition.chatFolders.find((f) => f.id === "f1")
        .unknown,
      { preserved: true },
    );
    assert.ok(
      bodyReads.every((path) => path === "/api/runtime/chats/a?limit=100"),
      JSON.stringify(bodyReads),
    );

    await click(a, folder("f1") + " [data-chat-folder-action=fold]");
    await settle();
    for (let index = 0; index < 131; index++)
      await command({
        type: "create-chat",
        characterId: "c",
        chatId: "unopened-" + index,
        metadata: {
          name: "Synthetic unopened",
          folderId: "f1",
          note: "Synthetic note " + index,
          unknown: { index },
        },
      });
    await until(
      () => state(a),
      (value) => value.order.length === 135,
    );
    await until(
      () => state(b),
      (value) => value.order.length === 135,
    );
    await click(a, folder("f1") + " [data-chat-folder-action=remove]");
    await button(a, "NO");
    assert.ok(
      (await header()).definition.chatFolders.some((f) => f.id === "f1"),
    );
    await click(a, folder("f1") + " [data-chat-folder-action=remove]");
    await b.evaluate(
      ui(
        "r().setField({scope:'chat',entityId:'unopened-0',key:'folderId'},'f2')",
      ),
    );
    await until(
      () => snapshot("unopened-0"),
      (value) => value.chat.metadata.folderId === "f2",
    );
    holdRequest = true;
    await button(a, "YES");
    await until(() => heldRequests === 4);
    assert.equal(
      await a.evaluate(
        `!!document.querySelector(${JSON.stringify(folder("f1"))})`,
      ),
      false,
    );
    assert.ok((await state(a)).folders.some((f) => f.id === "f1"));
    assert.ok(
      (await header()).definition.chatFolders.some((f) => f.id === "f1"),
    );
    releaseRequest();
    await settle();
    await until(
      header,
      (value) => !value.definition.chatFolders.some((f) => f.id === "f1"),
    );
    assert.equal((await snapshot("unopened-0")).chat.metadata.folderId, "f2");
    assert.equal((await snapshot("unopened-1")).chat.metadata.folderId, null);
    assert.equal(
      (await snapshot("unopened-1")).chat.metadata.note,
      "Synthetic note 1",
    );
    assert.deepEqual((await snapshot("unopened-1")).chat.metadata.unknown, {
      index: 1,
    });
    assert.equal(
      (await snapshot("orphan")).chat.metadata.folderId,
      "missing-folder",
    );
    assert.equal((await state(a)).active, "a");
    assert.equal((await state(b)).active, "a");

    // The original confirmation pins the folder revision before waiting.
    await click(a, folder("f2") + " [data-chat-folder-action=remove]");
    await b.evaluate(
      ui(
        "(()=>{const c=r().model.database.characters[r().model.characterIndex('c')];r().setField({scope:'character',entityId:'c',key:'chatFolders'},c.chatFolders.map(f=>f.id==='f2'?{...f,name:'Synthetic peer rename'}:f));return true;})()",
      ),
    );
    await until(
      header,
      (value) =>
        value.definition.chatFolders.find((f) => f.id === "f2").name ===
        "Synthetic peer rename",
    );
    await button(a, "YES");
    await until(
      () => state(a),
      (value) =>
        value.pending.some(
          (e) => e.state === "blocked" && e.code === "REVISION_CONFLICT",
        ),
    );
    assert.ok(
      (await header()).definition.chatFolders.some((f) => f.id === "f2"),
    );
    const blocked = (await state(a)).pending.find((e) => e.state === "blocked");
    await a.evaluate(ui(`r().discardCommand(${JSON.stringify(blocked.id)})`));
    await settle();
    const replayCursor = (await header()).cursor;
    holdRequest = true;
    await click(a, folder(newId) + " [data-chat-folder-action=remove]");
    await button(a, "YES");
    await until(() => heldRequests === 5);
    const replayId = (await state(a)).pending.find(
      (e) => e.type === "remove-chat-folder",
    ).id;
    await a.close();
    await b.close();
    releaseRequest();
    await delay(50);
    a = await open(contextA);
    b = await open(contextB);
    await settle();
    await until(
      header,
      (value) => !value.definition.chatFolders.some((f) => f.id === newId),
    );
    assert.equal((await snapshot("b")).chat.metadata.folderId, null);
    assert.ok(observedCommands.has(replayId));
    const beforeRetry = (await header()).cursor;
    const receipt = await runtime.store.call(
      "applyCommand",
      replayId,
      observedCommands.get(replayId),
    );
    assert.equal(receipt.clearedMembers, 1);
    assert.equal((await header()).cursor, beforeRetry);
    const changes = await runtime.store.call("changes", replayCursor, 1000);
    assert.equal(
      changes.changes.filter(
        (change) => change.type === "fields" && change.id === "c",
      ).length,
      1,
    );
    assert.deepEqual(errors, []);
    const sourceHashes = {};
    for (const path of [
      "server/entity/chatNavigation.cjs",
      "server/entity/store.cjs",
      "server/entity/lifecycle.cjs",
      "src/ts/runtime/chatNavigation.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/ts/runtime/risuReadModel.ts",
      "src/lib/SideBars/SideChatList.svelte",
      "server/browser/chatNavigationUi.test.cjs",
    ])
      sourceHashes[path] = createHash("sha256")
        .update(await readFile(resolve(path)))
        .digest("hex");
    const result = {
      syntheticOnly: true,
      actualOriginalUi: true,
      independentBrowserContexts: true,
      originalCreateRenameColorFold: true,
      privatePendingWithoutFacadeWrites: true,
      actualPointerChatAndFolderDrag: true,
      sortableDomRestoredAtAdmission: true,
      restoredAtDrop,
      selectedIdentityPreserved: true,
      noInactiveBodyReads: true,
      unboundedCanonicalFolderRemoval: true,
      peerMembershipRetained: true,
      originalCancelledAndStaleConfirm: true,
      allTabsClosedReplayOnce: true,
      replayId,
      heldRequests,
      bodyReads,
      errors,
      sourceHashes,
    };
    if (process.env.RISU_CHAT_NAVIGATION_UI_OUTPUT)
      await writeFile(
        process.env.RISU_CHAT_NAVIGATION_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
