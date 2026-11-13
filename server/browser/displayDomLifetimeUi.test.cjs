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
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("DOM lifetime condition timed out: " + JSON.stringify(value));
}
test(
  "a second device's original toggle preserves unchanged image/input descendants, local typing and focus",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-dom-"));
    let runtime, frontend, browser;
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
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: { didFirstSetup: true, language: "en", autoTranslate: false },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic DOM" } },
      definition: {
        type: "character",
        name: "Synthetic DOM fixture",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        customModuleToggle: "dom=Synthetic DOM toggle",
      },
    });
    const image =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const source = `<section id="dom-lifetime"><img id="dom-image" src="${image}" alt="Synthetic pixel"><input id="dom-input" type="text" value="Synthetic original"><span id="dom-choice">{{getglobalvar::toggle_dom}}</span></section>`;
    await runtime.store.call("applyCommand", "message", {
      type: "append-message",
      chatId: "a",
      messageId: "m",
      message: { role: "char", data: source },
    });
    const { createServer } = await import("vite");
    frontend = await createServer({
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
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        p.evaluate("!!document.querySelector('[data-runtime-ready=\"true\"]')"),
      );
      await p.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => p.evaluate(ui("s.scopeReady")));
      await until(() =>
        p.evaluate(
          "!!document.querySelector('#dom-input')&&!!document.querySelector('input[alt=\"Synthetic DOM toggle\"]')",
        ),
      );
      return p;
    };
    const a = await open(),
      b = await open();
    await delay(200);
    const before = await a.evaluate(
      `(async()=>{const image=document.querySelector('#dom-image');await image.decode();const input=document.querySelector('#dom-input');input.value='Synthetic unsaved typing';input.focus();input.setSelectionRange(3,7);window.domBefore={image,input,row:document.querySelector('[data-message-id=m]')};return {width:image.naturalWidth,value:input.value,focused:document.activeElement===input,selection:[input.selectionStart,input.selectionEnd]};})()`,
    );
    assert.equal(before.width, 1);
    assert.equal(before.focused, true);
    await b.evaluate(
      "document.querySelector('input[alt=\"Synthetic DOM toggle\"]').click()",
    );
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await until(() =>
      a.evaluate("document.querySelector('#dom-choice')?.textContent==='1'"),
    );
    await delay(150);
    const after = await a.evaluate(
      `(()=>{const image=document.querySelector('#dom-image'),input=document.querySelector('#dom-input');return {sameImage:image===window.domBefore.image,sameInput:input===window.domBefore.input,sameRow:document.querySelector('[data-message-id=m]')===window.domBefore.row,value:input.value,focused:document.activeElement===input,selection:[input.selectionStart,input.selectionEnd],choice:document.querySelector('#dom-choice').textContent};})()`,
    );
    const expectedBaseline = process.env.RISU_DISPLAY_DOM_BASELINE === "TRUE";
    const result = {
      syntheticOnly: true,
      originalUi: true,
      independentContexts: true,
      remoteToggle: true,
      expectedBaseline,
      fixed: after.sameImage && after.sameInput && after.focused,
      before,
      after,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/lib/ChatScreens/ChatBody.svelte",
            "src/lib/ChatScreens/Chat.svelte",
            "src/ts/parser/parser.svelte.ts",
            "src/ts/runtime/stableDisplayDom.ts",
            "server/browser/displayDomLifetimeUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_DOM_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_DOM_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
    assert.equal(after.sameRow, true);
    assert.equal(after.choice, "1");
    if (expectedBaseline) {
      assert.equal(after.sameImage, false);
      assert.equal(after.sameInput, false);
      assert.equal(after.value, "Synthetic original");
      assert.equal(after.focused, false);
    } else {
      assert.equal(after.sameImage, true);
      assert.equal(after.sameInput, true);
      assert.equal(after.value, before.value);
      assert.equal(after.focused, true);
      assert.deepEqual(after.selection, before.selection);
    }
  },
);
