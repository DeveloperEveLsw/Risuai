"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, mkdir, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Lore editor condition timed out: " + JSON.stringify(value));
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function clickText(page, text) {
  return until(() =>
    page.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`,
    ),
  );
}
async function write(page, selector, value) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}
const lore = (name) => ({
  key: "synthetic",
  comment: name,
  content: "Authored neutral lore",
  mode: "normal",
  insertorder: 100,
  alwaysActive: false,
  secondkey: "",
  selective: false,
  syntheticUnknown: { retained: true },
});
test(
  "original lore editors persist scoped drafts and preserve original local-activation semantics",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-lore-editor-"));
    let runtime, frontend, browser, a, b;
    t.after(async () => {
      if (a)
        console.log(
          JSON.stringify({
            teardownText: await a
              .evaluate("document.body.textContent.slice(-1600)")
              .catch(() => null),
            teardownProjection: await a
              .evaluate(
                "(async()=>{const {DBState:d}=await import('/src/ts/stores.svelte.ts');return d.db.characters.map(c=>({id:c.chaId,globalLore:c.globalLore,chatIds:c.chats.map(x=>x.id)}))})()",
              )
              .catch(() => null),
          }),
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
        aiModel: "gpt35",
        localActivationInGlobalLorebook: true,
        bulkEnabling: true,
        useExperimental: true,
        loreBookToken: 500,
        loreBookDepth: 2,
      },
    });
    for (const id of ["c", "d"])
      await runtime.store.call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        chat: {
          chatId: "chat-" + id,
          metadata: {
            name: "Authored lore test",
            localLore: [lore("Synthetic chat lore")],
          },
        },
        definition: {
          type: "character",
          name: "Synthetic lore " + id,
          desc: "Authored neutral fixture",
          firstMessage: "Synthetic greeting",
          globalLore: [lore("Synthetic character lore")],
        },
      });
    await runtime.store.call("applyCommand", "second-chat", {
      type: "create-chat",
      characterId: "c",
      chatId: "chat-c2",
      metadata: {
        name: "Independent second chat",
        localLore: [lore("Second chat lore")],
      },
    });
    const vite = await import("vite");
    frontend = await vite.createServer({
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
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const contexts = [await browser.newContext(), await browser.newContext()];
    const open = async (context) => {
      const page = await browser.page(url, context, {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      return page;
    };
    a = await open(contexts[0]);
    b = await open(contexts[1]);
    const edit = async (page, id = "c", name = "Synthetic character lore") => {
      await page.evaluate(
        `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.settingsOpen.set(false);await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter(${JSON.stringify(id)});stores.botMakerMode.set(true);stores.CharConfigSubMenu.set(3)})()`,
      );
      await until(() =>
        page.evaluate(
          `[...document.querySelectorAll('button')].some(e=>e.textContent.trim()===${JSON.stringify(name)})`,
        ),
      );
      if (
        !(await page.evaluate(
          "!!document.querySelector('[data-risu-idx=\"0\"] textarea')",
        ))
      )
        await clickText(page, name);
    };
    const character = async (id = "c") =>
      (await runtime.store.call("getCharacter", id)).definition;
    const chat = async (id = "chat-c") =>
      (await runtime.store.call("snapshot", id)).chat.metadata;
    const nameSelector = '[data-risu-idx="0"] input';
    await edit(a);
    await edit(b);
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await write(a, nameSelector, "Character edited");
    if (process.env.RISU_LORE_EDITOR_NEGATIVE === "TRUE") {
      await delay(200);
      assert.equal(
        (await character()).globalLore[0].comment,
        "Synthetic character lore",
      );
      assert.equal(
        await a.evaluate(
          `document.querySelector(${JSON.stringify(nameSelector)}).value`,
        ),
        "Character edited",
      );
      assert.equal(
        await b.evaluate(
          `document.querySelector(${JSON.stringify(nameSelector)}).value`,
        ),
        "Synthetic character lore",
      );
      console.log(
        JSON.stringify({
          negativeControl: true,
          editVisibleButNotStored: true,
          peerUnchanged: true,
        }),
      );
      return;
    }
    await until(
      character,
      (v) => v.globalLore[0].comment === "Character edited",
    );
    await until(() =>
      b.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Character edited')",
      ),
    );
    assert.equal(
      (await character("d")).globalLore[0].comment,
      "Synthetic character lore",
    );
    assert.deepEqual((await character()).globalLore[0].syntheticUnknown, {
      retained: true,
    });
    await until(() => a.evaluate(ui("s.pending.length===0")));
    assert.equal(
      (await character()).globalLore[0].useRegex,
      undefined,
      "opening optional checkbox must not persist false",
    );
    assert.equal((await character()).lorePlus, undefined);
    const commands = [];
    await a.send("Network.enable");
    a.on("Network.requestWillBeSent", (e) => {
      if (e.request.url.endsWith("/api/runtime/commands") && e.request.postData)
        commands.push(JSON.parse(e.request.postData).command);
    });
    const checkbox = async (page, name) => {
      await until(() =>
        page.evaluate(
          `!!document.querySelector('[data-runtime-lorebook] input[alt=${JSON.stringify(name)}]')`,
        ),
      );
      await page.evaluate(
        `document.querySelector('[data-runtime-lorebook] input[alt=${JSON.stringify(name)}]').click()`,
      );
    };
    const tab = async (page, name) => {
      await page.evaluate(
        `(()=>{const e=[...document.querySelector('[data-runtime-lorebook]').querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!e)throw Error('Missing lore tab');e.click()})()`,
      );
    };
    await checkbox(a, "Always Active (Current Chat)");
    await until(chat, (v) => v.localLore.some((e) => e.mode === "child"));
    const parent = (await character()).globalLore[0],
      child = (await chat()).localLore.find((e) => e.mode === "child");
    assert.ok(parent.id);
    assert.equal(child.id, parent.id);
    assert.equal(child.content, "");
    const atomic = await until(() =>
      commands.find(
        (c) =>
          c?.type === "change-fields" &&
          c.edits.some((e) => e.key === "globalLore") &&
          c.edits.some((e) => e.key === "localLore"),
      ),
    );
    assert.equal(
      atomic.edits.length,
      2,
      "local activation persists parent ID and chat reference atomically",
    );
    assert.deepEqual(atomic.edits.map((e) => [e.scope, e.entityId]).sort(), [
      ["character", "c"],
      ["chat", "chat-c"],
    ]);
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await checkbox(a, "Always Active (Current Chat)");
    await until(chat, (v) => !v.localLore.some((e) => e.mode === "child"));
    assert.equal((await character()).globalLore[0].id, parent.id);
    await tab(a, "Chat");
    await clickText(a, "Synthetic chat lore");
    await write(a, nameSelector, "Chat edited");
    await until(chat, (v) => v.localLore[0].comment === "Chat edited");
    assert.equal(
      (await chat("chat-d")).localLore[0].comment,
      "Synthetic chat lore",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await a.evaluate(
      `(async()=>{const e=document.querySelector(${JSON.stringify(nameSelector)});e.value='Last chat edit before navigation';e.dispatchEvent(new Event('input',{bubbles:true}));await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('c','chat-c2')})()`,
    );
    await until(
      chat,
      (v) => v.localLore[0].comment === "Last chat edit before navigation",
    );
    assert.equal(
      (await chat("chat-c2")).localLore[0].comment,
      "Second chat lore",
    );
    await a.evaluate(ui("r().selectCharacter('c','chat-c')"));
    await tab(a, "Settings");
    await checkbox(a, "Use Global Settings");
    await until(character, (v) => v.loreSettings?.tokenBudget === 500);
    assert.equal((await character()).loreSettings.fullWordMatching, undefined);
    await write(a, "[data-runtime-lorebook] input[type=number]", "7");
    await until(character, (v) => v.loreSettings.scanDepth === 7);
    await checkbox(a, "Use Global Settings");
    await until(character, (v) => v.loreSettings === undefined);
    await tab(a, "Character");
    // Real JSON file selection captures its field before waiting. Equal JSON after
    // two peer edits (ABA) still has a new field revision and must be rejected.
    await edit(b, "c", "Character edited");
    const imported = {
      ...lore("Imported synthetic lore"),
      id: "portable-original-id",
      folder: "portable-folder",
      syntheticExtension: [1, { keep: true }],
    };
    const importPath = join(directory, "authored-lore.json");
    await writeFile(
      importPath,
      JSON.stringify({ type: "risu", ver: 1, data: [imported] }),
    );
    let chooser;
    a.on("Page.fileChooserOpened", (e) => {
      chooser = e;
    });
    await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const beginImport = async () => {
      chooser = undefined;
      const p = await a.evaluate(
        "(()=>{const e=document.querySelector('[data-lore-action=import]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await a.send("Input.dispatchMouseEvent", {
          type,
          ...p,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      await until(() => chooser);
    };
    const supply = () =>
      a.send("DOM.setFileInputFiles", {
        files: [importPath],
        backendNodeId: chooser.backendNodeId,
      });
    await beginImport();
    await write(b, '[data-risu-idx="0"] textarea', "Peer import edit");
    await until(
      character,
      (v) => v.globalLore[0].content === "Peer import edit",
    );
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await write(b, '[data-risu-idx="0"] textarea', "Authored neutral lore");
    await until(
      character,
      (v) => v.globalLore[0].content === "Authored neutral lore",
    );
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await supply();
    await until(() =>
      a.evaluate("document.body.textContent.includes('changed while waiting')"),
    );
    assert.equal((await character()).globalLore.length, 1);
    await clickText(a, "OK");
    await beginImport();
    await supply();
    await until(character, (v) => v.globalLore.length === 2);
    assert.deepEqual((await character()).globalLore[1], imported);
    const downloads = join(directory, "downloads");
    await mkdir(downloads);
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      browserContextId: contexts[0],
      downloadPath: downloads,
    });
    await a.evaluate(
      "document.querySelector('[data-lore-action=export]').click()",
    );
    const exported = await until(async () => {
      try {
        return JSON.parse(
          await readFile(join(downloads, "lorebook_export.json"), "utf8"),
        );
      } catch {
        return null;
      }
    });
    assert.equal(exported.type, "risu");
    assert.equal(exported.ver, 1);
    assert.deepEqual(exported.data, (await character()).globalLore);
    await clickText(a, "OK");
    await a.evaluate(
      "document.querySelector('[data-lore-action=folder]').click()",
    );
    await until(character, (v) => v.globalLore.length === 3);
    await clickText(a, "New Folder");
    await a.evaluate(
      "document.querySelector('[data-lore-action=folder-entry]').click()",
    );
    await until(character, (v) => v.globalLore.length === 4);
    const folder = (await character()).globalLore.find(
      (e) => e.mode === "folder",
    );
    assert.ok(folder.key);
    assert.equal((await character()).globalLore.at(-1).folder, folder.key);
    await a.evaluate(
      "document.querySelector('[data-lore-action=globalLore]').click()",
    );
    await until(character, (v) => v.globalLore.every((e) => e.alwaysActive));
    await a.evaluate(
      "document.querySelector('[data-lore-action=globalLore]').click()",
    );
    await until(character, (v) => v.globalLore.every((e) => !e.alwaysActive));
    await a.evaluate(
      "document.querySelector('[data-risu-idx=\"2\"]').querySelector(':scope > div > button:last-child').click()",
    );
    await edit(b, "c", "Character edited");
    await write(b, '[data-risu-idx="0"] textarea', "Peer edit during removal");
    await until(
      character,
      (v) => v.globalLore[0].content === "Peer edit during removal",
    );
    await clickText(a, "YES");
    await clickText(a, "YES");
    await until(() =>
      a.evaluate("document.body.textContent.includes('changed while waiting')"),
    );
    assert.equal((await character()).globalLore.length, 4);
    await clickText(a, "OK");
    await a.evaluate(
      "document.querySelector('[data-risu-idx=\"2\"]').querySelector(':scope > div > button:last-child').click()",
    );
    await clickText(a, "YES");
    await clickText(a, "YES");
    await until(character, (v) => v.globalLore.length === 2);
    assert.ok(
      !(await character()).globalLore.some(
        (e) => e.key === folder.key || e.folder === folder.key,
      ),
    );
    // Hold a captured field command until a peer wins that field. The local draft
    // remains visible, then the durable loser becomes an explicit conflict.
    await edit(a, "c", "Character edited");
    await edit(b, "c", "Character edited");
    await until(() => a.evaluate(ui("s.pending.length===0")));
    let held;
    a.on("Fetch.requestPaused", (e) => {
      held = e.requestId;
    });
    await a.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
      ],
    });
    await write(a, '[data-risu-idx="0"] textarea', "Losing local lore");
    await until(() => held);
    await write(b, '[data-risu-idx="0"] textarea', "Winning peer lore");
    await until(
      character,
      (v) => v.globalLore[0].content === "Winning peer lore",
    );
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-risu-idx=\"0\"] textarea').value",
      ),
      "Losing local lore",
    );
    await a.send("Fetch.continueRequest", { requestId: held });
    await a.send("Fetch.disable");
    const conflict = await until(() =>
      a.evaluate(ui("s.pending.find(e=>e.state==='blocked')?.requestId")),
    );
    await a.evaluate(
      ui(`r().resolveFieldConflict(${JSON.stringify(conflict)},false)`),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await edit(a, "c", "Character edited");
    await write(a, '[data-risu-idx="0"] textarea', "Offline durable lore");
    await until(
      character,
      (v) => v.globalLore[0].content === "Offline durable lore",
    );
    await a.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await write(
      a,
      '[data-risu-idx="0"] textarea',
      "Persisted after all tabs close",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(f=>f.value?.[0]?.content==='Persisted after all tabs close'))",
        ),
      ),
    );
    assert.equal(
      (await character()).globalLore[0].content,
      "Offline durable lore",
    );
    await a.close();
    await b.close();
    a = await open(contexts[0]);
    await until(
      character,
      (v) => v.globalLore[0].content === "Persisted after all tabs close",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    console.log(
      JSON.stringify({
        reopened: await a.evaluate(
          "(async()=>{const {DBState:d}=await import('/src/ts/stores.svelte.ts');const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return {ready:s.ready,scopeReady:s.scopeReady,pending:s.pending.length,characters:d.db.characters.map(c=>({id:c.chaId,lore:JSON.stringify(c.globalLore)})),clock:r().fieldHeader({scope:'character',entityId:'c',key:'globalLore'})}})()",
        ),
      }),
    );
    await edit(a, "c", "Character edited");
    await a.evaluate(
      `(async()=>{const e=document.querySelector(${JSON.stringify(nameSelector)});e.value='Edit before navigation';e.dispatchEvent(new Event('input',{bubbles:true}));await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('d')})()`,
    );
    await until(
      character,
      (v) => v.globalLore[0].comment === "Edit before navigation",
    );
    assert.equal(
      (await character("d")).globalLore[0].comment,
      "Synthetic character lore",
    );
    console.log(
      JSON.stringify({
        characterLoreStored: true,
        chatLoreStored: true,
        peerUpdated: true,
        otherCharacterUnchanged: true,
        unknownFieldsPreserved: true,
        localActivationAtomic: true,
        localDeactivationRetainsParentId: true,
        optionalDefaultsNotSaved: true,
        settingsRemoved: true,
        originalJsonImportExport: true,
        staleImportAbaRejected: true,
        folderAddDeleteStored: true,
        staleRemovalRejected: true,
        bulkToggleStored: true,
        sameFieldConflictVisible: true,
        offlineAllTabsExitReplay: true,
        navigationFlushedOldStableId: true,
        chatNavigationFlushedOldStableId: true,
      }),
    );
  },
);
