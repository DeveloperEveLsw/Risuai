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
  throw Error("Script editor condition timed out: " + JSON.stringify(value));
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function clickText(page, text) {
  return until(() =>
    page.evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`,
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
test(
  "original character and global script editors persist nested edits, synchronize peers and retain ordinary script shapes",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-script-editor-"));
    let runtime, frontend, browser, a, b;
    t.after(async () => {
      if (a)
        console.log(
          JSON.stringify({
            teardownState: await a
              .evaluate(
                "({text:document.body.textContent.slice(-2500),containers:[...document.querySelectorAll('[data-risu-idx]')].map(e=>({class:e.parentElement?.className,index:e.dataset.risuIdx}))})",
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
        globalscript: [
          {
            comment: "Synthetic global regex",
            in: "GLOBAL",
            out: "Global original",
            type: "editoutput",
            syntheticUnknown: { retained: true },
          },
        ],
      },
    });
    for (const id of ["c", "d"])
      await runtime.store.call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        chat: {
          chatId: "chat-" + id,
          metadata: { name: "Authored script test" },
        },
        definition: {
          type: "character",
          name: "Synthetic scripts " + id,
          desc: "Authored neutral fixture",
          firstMessage: "Synthetic greeting",
          customscript: [
            {
              comment: "Synthetic character regex",
              in: "INPUT",
              out: "Character original",
              type: "editoutput",
              syntheticUnknown: { retained: true },
            },
          ],
          triggerscript: [
            {
              comment: "Authored Lua",
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: "-- Synthetic original Lua\nfunction synthetic() return 'original' end",
                },
              ],
              syntheticUnknown: { retained: true },
            },
          ],
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
    const characterScripts = async (
      page,
      id = "c",
      comment = "Synthetic character regex",
    ) => {
      await page.evaluate(
        `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.settingsOpen.set(false);await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter(${JSON.stringify(id)});stores.botMakerMode.set(true);stores.CharConfigSubMenu.set(4)})()`,
      );
      await until(() =>
        page.evaluate(
          `[...document.querySelectorAll('button')].some(e=>e.textContent.trim()===${JSON.stringify(comment)})`,
        ),
      );
      await clickText(page, comment);
    };
    const globalScripts = async (page) => {
      await page.evaluate(
        "(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.SettingsMenuIndex.set(9);stores.settingsOpen.set(true)})()",
      );
      await clickText(page, "Synthetic global regex");
    };
    const regexName = ".contain [data-risu-idx='0'] input[type=text]";
    const character = async (id = "c") =>
      (await runtime.store.call("getCharacter", id)).definition;
    const settings = async () =>
      (await runtime.store.call("getResource", "settings", "global")).payload;
    await characterScripts(a);
    await characterScripts(b);
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(() => b.evaluate(ui("s.pending.length===0")));
    assert.equal(
      (await character()).customscript[0].ableFlag,
      undefined,
      "opening the checkbox must not save its default false",
    );
    await write(a, regexName, "Character edited");
    if (process.env.RISU_SCRIPT_EDITOR_NEGATIVE === "TRUE") {
      await delay(200);
      assert.equal(
        (await character()).customscript[0].comment,
        "Synthetic character regex",
      );
      assert.equal(
        await b.evaluate(
          `document.querySelector(${JSON.stringify(regexName)}).value`,
        ),
        "Synthetic character regex",
      );
      assert.equal(
        await a.evaluate(
          `document.querySelector(${JSON.stringify(regexName)}).value`,
        ),
        "Character edited",
      );
      await globalScripts(a);
      await write(a, regexName, "Global edited");
      await delay(200);
      assert.equal(
        (await settings()).globalscript[0].comment,
        "Synthetic global regex",
      );
      console.log(
        JSON.stringify({
          negativeControl: true,
          characterEditVisibleButNotStored: true,
          globalEditVisibleButNotStored: true,
        }),
      );
      return;
    }
    await until(
      character,
      (value) => value.customscript[0].comment === "Character edited",
    );
    await until(
      () =>
        b.evaluate(
          `document.querySelector(${JSON.stringify(regexName)}).value`,
        ),
      (v) => v === "Character edited",
    );
    assert.deepEqual((await character()).customscript[0].syntheticUnknown, {
      retained: true,
    });
    assert.equal(
      (await character("d")).customscript[0].comment,
      "Synthetic character regex",
    );
    await write(
      a,
      ".contain [data-risu-idx='0'] textarea",
      "Character output changed",
    );
    await until(
      character,
      (value) => value.customscript[0].out === "Character output changed",
    );
    await until(
      () =>
        b.evaluate(
          "document.querySelector('.contain [data-risu-idx=\"0\"] textarea')?.value",
        ),
      (v) => v === "Character output changed",
    );
    const lua =
      "-- Synthetic updated Lua\nfunction synthetic() return 'updated' end";
    await write(a, "[data-runtime-object-field=triggerscript] textarea", lua);
    await until(
      character,
      (value) => value.triggerscript[0].effect[0].code === lua,
    );
    await until(
      () =>
        b.evaluate(
          "document.querySelector('[data-runtime-object-field=triggerscript] textarea')?.value",
        ),
      (v) => v === lua,
    );
    assert.deepEqual((await character()).triggerscript[0].syntheticUnknown, {
      retained: true,
    });
    await globalScripts(a);
    await globalScripts(b);
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(() => b.evaluate(ui("s.pending.length===0")));
    assert.equal((await settings()).globalscript[0].ableFlag, undefined);
    await write(a, regexName, "Global edited");
    await until(
      settings,
      (value) => value.globalscript[0].comment === "Global edited",
    );
    await until(
      () =>
        b.evaluate(
          `document.querySelector(${JSON.stringify(regexName)}).value`,
        ),
      (v) => v === "Global edited",
    );
    assert.deepEqual((await settings()).globalscript[0].syntheticUnknown, {
      retained: true,
    });
    const imported = {
      comment: "Authored imported regex",
      in: "IMPORTED",
      out: "Imported output",
      type: "disabled",
      syntheticExtension: [1, { keep: "yes" }],
    };
    const importPath = join(directory, "authored-regex.json");
    await writeFile(
      importPath,
      JSON.stringify({ type: "regex", data: [imported] }),
    );
    let chooser;
    a.on("Page.fileChooserOpened", (event) => {
      chooser = event;
    });
    await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const beginImport = async () => {
      chooser = undefined;
      const point = await a.evaluate(
        "(()=>{const e=document.querySelector('[data-script-action=import]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      await a.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await a.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await until(() => chooser);
    };
    const supplyImport = () =>
      a.send("DOM.setFileInputFiles", {
        files: [importPath],
        backendNodeId: chooser.backendNodeId,
      });
    // Opening a file chooser captures the original field. A peer edit while it
    // remains open must reject the stale import, rather than overwrite that edit.
    await beginImport();
    await write(
      b,
      ".contain [data-risu-idx='0'] textarea",
      "Peer edited during import",
    );
    await until(
      settings,
      (value) => value.globalscript[0].out === "Peer edited during import",
    );
    await until(
      () =>
        a.evaluate(
          "document.querySelector('.contain [data-risu-idx=\"0\"] textarea').value",
        ),
      (value) => value === "Peer edited during import",
    );
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await write(b, ".contain [data-risu-idx='0'] textarea", "Global original");
    await until(
      settings,
      (value) => value.globalscript[0].out === "Global original",
    );
    await until(
      () =>
        a.evaluate(
          "document.querySelector('.contain [data-risu-idx=\"0\"] textarea').value",
        ),
      (value) => value === "Global original",
    );
    // The JSON has returned to its initial value; the field clock still changed.
    await supplyImport();
    await until(
      () => a.evaluate(ui("s.error")),
      (value) => value?.includes("changed while importing"),
    );
    assert.equal((await settings()).globalscript.length, 1);
    await beginImport();
    await supplyImport();
    await until(settings, (value) => value.globalscript.length === 2);
    assert.deepEqual((await settings()).globalscript[1], imported);
    const downloads = join(directory, "downloads");
    await mkdir(downloads);
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      browserContextId: contexts[0],
      downloadPath: downloads,
    });
    await a.evaluate(
      "document.querySelector('[data-script-action=import]').previousElementSibling.click()",
    );
    const exported = await until(async () => {
      try {
        return JSON.parse(
          await readFile(join(downloads, "regexscript_export.json"), "utf8"),
        );
      } catch {
        return null;
      }
    });
    assert.equal(exported.type, "regex");
    assert.deepEqual(exported.data, (await settings()).globalscript);
    await clickText(a, "OK");
    // Hold one device's real field command until a peer wins the same field.
    // The pending draft remains private and the loser enters explicit conflict.
    let held;
    a.on("Fetch.requestPaused", (event) => {
      held = event.requestId;
    });
    await a.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
      ],
    });
    await write(
      a,
      ".contain [data-risu-idx='0'] textarea",
      "Losing local edit",
    );
    await until(() => held);
    await write(
      b,
      ".contain [data-risu-idx='0'] textarea",
      "Winning peer edit",
    );
    await until(
      settings,
      (value) => value.globalscript[0].out === "Winning peer edit",
    );
    assert.equal(
      await a.evaluate(
        "document.querySelector('.contain [data-risu-idx=\"0\"] textarea').value",
      ),
      "Losing local edit",
    );
    await a.send("Fetch.continueRequest", { requestId: held });
    await a.send("Fetch.disable");
    const conflict = await until(() =>
      a.evaluate(ui("s.pending.find(e=>e.state==='blocked')?.requestId")),
    );
    await a.evaluate(
      ui(`r().resolveFieldConflict(${JSON.stringify(conflict)},false)`),
    );
    await until(
      () =>
        a.evaluate(
          "document.querySelector('.contain [data-risu-idx=\"0\"] textarea').value",
        ),
      (value) => value === "Winning peer edit",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    // An offline nested edit must reach IDB, survive all tabs closing, and replay
    // from this device's existing context without changing another character.
    await a.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await write(
      a,
      ".contain [data-risu-idx='0'] textarea",
      "Offline durable edit",
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(f=>f.value?.[0]?.out==='Offline durable edit'))",
        ),
      ),
    );
    assert.equal((await settings()).globalscript[0].out, "Winning peer edit");
    await a.close();
    await b.close();
    a = await open(contexts[0]);
    await until(
      settings,
      (value) => value.globalscript[0].out === "Offline durable edit",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    b = await open(contexts[1]);
    assert.equal(
      (await character("d")).customscript[0].comment,
      "Synthetic character regex",
    );
    // Mutating and navigating in one task flushes to the captured old owner.
    await characterScripts(a, "c", "Character edited");
    await a.evaluate(
      `(async()=>{const e=document.querySelector(${JSON.stringify(regexName)});e.value='Edit before navigation';e.dispatchEvent(new Event('input',{bubbles:true}));await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('d')})()`,
    );
    await until(
      character,
      (value) => value.customscript[0].comment === "Edit before navigation",
    );
    assert.equal(
      (await character("d")).customscript[0].comment,
      "Synthetic character regex",
    );
    await a.send("Page.reload");
    await until(() =>
      a.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    assert.equal(
      await a.evaluate(
        "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.globalscript[0].comment})()",
      ),
      "Global edited",
    );
    console.log(
      JSON.stringify({
        characterRegexStored: true,
        luaStored: true,
        globalRegexStored: true,
        peerFieldsUpdated: true,
        unknownFieldsPreserved: true,
        reloadRetained: true,
        sameFieldConflictVisible: true,
        keepServerRestoredEditor: true,
        offlineAllTabsExitReplay: true,
        navigationFlushedOldStableId: true,
        originalJsonImportExport: true,
        staleImportRejected: true,
        staleImportAbaRejected: true,
      }),
    );
  },
);
