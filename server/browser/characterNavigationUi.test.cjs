"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean) {
  const end = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error(
    "Synthetic character navigation timed out: " + JSON.stringify(value),
  );
}
async function drag(page, source, target) {
  const point = (selector) =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing drag target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.5};})()`,
    );
  const from = await point(source),
    to = await point(target);
  await page.send("Input.setInterceptDrags", { enabled: true });
  let data;
  page.on("Input.dragIntercepted", (event) => {
    data = event.data;
  });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...from,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 6; step++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * step) / 6,
      y: from.y + ((to.y - from.y) * step) / 6,
      button: "left",
      buttons: 1,
    });
    await delay(25);
    if (data) break;
  }
  await until(() => data);
  assert.ok(
    data.items.some((item) => item.mimeType.includes("risu")),
    "original native dragstart supplies the Risu marker",
  );
  for (const type of ["dragEnter", "dragOver", "drop"])
    await page.send("Input.dispatchDragEvent", { type, ...to, data });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...to,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await page.send("Input.setInterceptDrags", { enabled: false });
}

test(
  "original character avatar drags and folder menus retain immediate private views, canonical metadata, peer conflicts and all-tab outbox replay",
  { timeout: 240000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-character-navigation-ui-"),
    );
    let runtime,
      frontend,
      browser,
      releaseRequest,
      holdRequest = false,
      held = 0;
    const origins = [],
      errors = [],
      bodyReads = [],
      observed = new Map();
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
        "synthetic-character-ui-" + ++n,
        value,
      );
    const imported = {
      id: "synthetic-imported",
      name: "Synthetic hidden",
      color: "",
      data: ["hidden", "unmapped"],
      unknown: { preserved: true },
    };
    await command({
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        menuSideBar: false,
        aiModel: "gpt35",
        useStreaming: false,
        maxContext: 8000,
        maxResponse: 128,
        zoomsize: 100,
        theme: "default",
        timeout: 120,
        characterOrder: ["c", "d", "e", imported, "unmapped-top"],
      },
    });
    for (const id of ["c", "d", "e", "hidden"]) {
      await command({
        type: "create-character",
        characterId: id,
        definition: {
          type: "character",
          name: "Synthetic " + id,
          desc: "Synthetic",
          firstMessage: "Synthetic greeting",
          ...(id === "hidden" ? { trashTime: 123 } : {}),
        },
      });
      await command({
        type: "create-chat",
        characterId: id,
        chatId: id + "-chat",
        metadata: { name: "Synthetic chat" },
        messages: [
          {
            id: id + "-message",
            message: { role: "char", data: "Synthetic body " + id },
          },
        ],
      });
    }
    const call = runtime.store.call.bind(runtime.store);
    runtime.store.call = async (method, ...args) => {
      if (method === "applyCommand")
        observed.set(args[0], structuredClone(args[1]));
      return call(method, ...args);
    };
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-character-hold",
          configureServer(server) {
            server.middlewares.use((req, _res, next) => {
              if (
                req.method === "GET" &&
                /^\/api\/runtime\/(chats|characters)\//.test(req.url)
              )
                bodyReads.push(req.url);
              if (
                holdRequest &&
                req.method === "POST" &&
                req.url === "/api/runtime/commands"
              ) {
                holdRequest = false;
                held++;
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
    const avatar = (id) => `[data-character-nav-id="${id}"]`;
    const click = (page, selector) =>
      page.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).click()`,
      );
    const open = async (context) => {
      const page = await browser.page(url, context, {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      page.on("Runtime.exceptionThrown", (value) =>
        errors.push(
          value.exceptionDetails?.exception?.description ??
            value.exceptionDetails?.text,
        ),
      );
      await until(
        () =>
          page.evaluate(
            "({ready:!!document.querySelector('[data-runtime-ready=true]'),avatars:Array.from(document.querySelectorAll('[data-character-nav-id]')).map(e=>e.dataset.characterNavId),body:document.body?.innerText?.slice(0,1000)??''})",
          ),
        (value) => value.ready && value.avatars.length > 0,
      ).catch((error) => {
        throw new Error(
          error.message + "; runtime exceptions: " + JSON.stringify(errors),
        );
      });
      console.log("Synthetic character context ready");
      await page.evaluate(ui("r().selectCharacter('c','c-chat')"));
      await until(() =>
        page.evaluate(ui("s.scopeReady&&r().model.activeChatId==='c-chat'")),
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-message-id=c-message]')",
        ),
      );
      assert.equal(
        await page.evaluate(
          "(()=>{const row=document.querySelector('[data-message-id=c-message]');window.__syntheticSelectedRow=row;return !!row&&row.isConnected;})()",
        ),
        true,
      );
      return page;
    };
    let a = await open(contextA),
      b = await open(contextB);
    const state = (page) =>
      page.evaluate(
        ui(
          "JSON.parse(JSON.stringify({confirmed:r().model.database.characterOrder,view:r().characterNavigationOrder(),raw:r().model.characterOrderSource(),active:r().model.activeChatId,pendingNavigation:!!r().characterNavigationOverlay(),pending:s.pending.map(e=>({id:e.requestId,type:e.command.type,state:e.state,code:e.error?.code})),error:s.error}))",
        ),
      );
    const canonical = async () =>
      (await runtime.store.call("getResourceSnapshot", "settings", "global"))
        .payload.characterOrder;
    const settled = async () => {
      for (const page of [a, b])
        await until(
          () => state(page),
          (value) => value.pending.length === 0 && !value.pendingNavigation,
        );
    };
    const button = async (page, text) => {
      await until(() =>
        page.evaluate(
          `Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()===${JSON.stringify(text)})`,
        ),
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`,
      );
    };
    const context = async (page, id) => {
      await until(
        () => state(page),
        (value) => value.pending.length === 0 && !value.pendingNavigation,
      );
      await until(() =>
        page.evaluate(
          `!!document.querySelector(${JSON.stringify(avatar(id) + " .avatar")})`,
        ),
      );
      await page.evaluate(
        `document.querySelector(${JSON.stringify(avatar(id) + " .avatar")}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
      );
    };
    const input = async (page, value) => {
      await until(() =>
        page.evaluate("!!document.querySelector('#alert-input')"),
      );
      await page.evaluate(
        `(()=>{const e=document.querySelector('#alert-input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await button(page, "OK");
    };
    const initial = await canonical();
    holdRequest = true;
    console.log("Synthetic original grouping drag");
    await drag(a, avatar("d"), avatar("c"));
    await until(() => held === 1);
    const pending = await until(
      () => state(a),
      (value) => value.view.some((item) => item?.data?.includes("d")),
    );
    const folderId = pending.view.find((item) => item?.data?.includes("d")).id;
    assert.deepEqual(pending.confirmed, ["c", "d", "e"]);
    assert.deepEqual((await state(b)).confirmed, ["c", "d", "e"]);
    assert.deepEqual(await canonical(), initial);
    assert.equal(pending.active, "c-chat");
    releaseRequest();
    await settled();
    await until(
      () => state(b),
      (value) => value.view[0]?.id === folderId,
    );
    await context(a, folderId);
    await button(a, "Rename Folder");
    holdRequest = true;
    await input(a, "Synthetic renamed");
    await until(() => held === 2);
    assert.equal((await state(a)).view[0].name, "Synthetic renamed");
    assert.equal((await canonical())[0].name, "New Folder");
    releaseRequest();
    await settled();
    await until(
      () => state(b),
      (value) => value.view[0]?.name === "Synthetic renamed",
    );
    await context(a, folderId);
    await button(a, "Change Folder Color");
    await button(a, "purple");
    await until(
      () => state(b),
      (value) => value.view[0]?.color === "purple",
    );
    await settled();
    await context(a, folderId);
    await button(a, "Change Folder Image");
    await button(a, "Reset to Default Image");
    await until(
      () => canonical(),
      (value) => value[0].imgFile === null && value[0].img === "",
    );
    await settled();
    await click(a, avatar(folderId) + " .avatar");
    await until(() =>
      a.evaluate(
        `!!document.querySelector('[data-character-nav-id=d][data-character-nav-folder="${folderId}"]')`,
      ),
    );
    await drag(
      a,
      avatar("d"),
      "[data-character-drop-folder=''][data-character-drop-before=e]",
    );
    await settled();
    await until(
      () => state(b),
      (value) => value.view[1] === "d",
    );
    await drag(
      a,
      avatar(folderId),
      "[data-character-drop-folder=''][data-character-drop-before='']",
    );
    await settled();
    await until(
      () => state(b),
      (value) => value.view.at(-1)?.id === folderId,
    );
    assert.equal(
      await a.evaluate(
        "!!window.__syntheticSelectedRow&&window.__syntheticSelectedRow.isConnected&&window.__syntheticSelectedRow===document.querySelector('[data-message-id=c-message]')",
      ),
      true,
    );
    assert.equal((await state(a)).active, "c-chat");
    await context(a, folderId);
    await button(a, "Rename Folder");
    const snapshot = await runtime.store.call("bootstrap");
    await command({
      type: "change-character-navigation",
      expectedNavigationRevision: snapshot.characterNavigation.revision,
      expectedOrderRevision: snapshot.characterNavigation.order.revision,
      expectedSettingsEpoch: snapshot.characterNavigation.order.entityEpoch,
      action: {
        type: "move",
        source: { kind: "folder", id: folderId },
        destination: { folderId: null, before: { kind: "character", id: "d" } },
      },
    });
    await until(
      () => state(b),
      (value) => value.view[0]?.id === folderId,
    );
    await input(a, "Synthetic stale dialog");
    const blocked = await until(
      () => state(a),
      (value) => value.pending.some((item) => item.state === "blocked"),
    );
    assert.equal(
      blocked.pending.find((item) => item.state === "blocked").code,
      "REVISION_CONFLICT",
    );
    assert.equal((await canonical())[0].name, "Synthetic renamed");
    await a.evaluate(
      ui(
        `r().discardCommand(${JSON.stringify(blocked.pending.find((item) => item.state === "blocked").id)})`,
      ),
    );
    await settled();
    await context(a, folderId);
    await button(a, "Cancel");
    await settled();
    holdRequest = true;
    await context(a, folderId);
    await button(a, "Rename Folder");
    await input(a, "Synthetic after reopening");
    await until(() => held === 3);
    await until(
      () => state(a),
      (value) => value.pending.length === 1,
    );
    await a.close();
    await b.close();
    releaseRequest();
    a = await open(contextA);
    b = await open(contextB);
    await settled();
    await until(
      () => state(b),
      (value) => value.view[0]?.name === "Synthetic after reopening",
    );
    const raw = await canonical();
    assert.deepEqual(
      raw.find((item) => item?.id === "synthetic-imported"),
      imported,
    );
    assert.ok(raw.includes("unmapped-top"));
    assert.ok(
      bodyReads.every(
        (path) =>
          path.startsWith("/api/runtime/characters/c") ||
          path.startsWith("/api/runtime/chats/c-chat"),
      ),
      JSON.stringify(bodyReads),
    );
    assert.deepEqual(errors, []);
    if (process.env.RISU_CHARACTER_NAVIGATION_UI_OUTPUT)
      await writeFile(
        process.env.RISU_CHARACTER_NAVIGATION_UI_OUTPUT,
        JSON.stringify(
          {
            syntheticOnly: true,
            originalNativePointerDrags: 3,
            originalMenus: ["rename", "color", "image-reset", "cancel"],
            heldRequests: held,
            privatePending: true,
            twoContexts: true,
            selectedMessageDomRetained: true,
            staleDialogBlocked: true,
            allTabsClosedReplay: true,
            canonicalImportedMetadataPreserved: true,
            bodyReads,
            commands: [...observed].map(([id, command]) => ({
              id,
              type: command.type,
              action: command.action?.type,
            })),
            errors,
          },
          null,
          2,
        ) + "\n",
      );
  },
);
