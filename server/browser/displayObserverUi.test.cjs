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
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Observer condition timed out: " + JSON.stringify(value));
}
test(
  "original codeblock DOM observation attaches once across repeated initialization, unchanged nodes and changed metadata",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-observer-"));
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
      chat: { chatId: "a", metadata: { name: "Synthetic observer" } },
      definition: {
        type: "character",
        name: "Synthetic observer",
        desc: "Synthetic",
        firstMessage: "Synthetic observer greeting",
      },
    });
    await runtime.store.call("applyCommand", "message", {
      type: "append-message",
      chatId: "a",
      messageId: "m",
      message: {
        role: "char",
        data: "```javascript\nconsole.log('Synthetic');\n```",
      },
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
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(
      () =>
        page.evaluate(
          "({ready:!!document.querySelector('pre[x-hl-lang]'),message:document.querySelector('[data-message-id=m]')?.textContent,chatBodies:document.querySelectorAll('.chattext').length})",
        ),
      (value) => value.ready,
    );
    await page.evaluate(
      `(()=>{window.observerMenuAppends=0;window.observerClipboard=[];const append=document.body.appendChild.bind(document.body);document.body.appendChild=function(node){if(node.id==='code-contextmenu')window.observerMenuAppends++;return append(node);};Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>window.observerClipboard.push(text)});window.observerCode=document.querySelector('pre[x-hl-lang]');})()`,
    );
    await delay(550);
    const menu = async () =>
      page.evaluate(
        `(()=>{window.observerMenuAppends=0;window.observerCode.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));const menu=document.querySelector('#code-contextmenu');if(!menu)throw Error('Missing original menu');menu.firstElementChild.click();menu.remove();return {menus:window.observerMenuAppends,clipboardCalls:window.observerClipboard.length,clipboardText:window.observerClipboard.at(-1)};})()`,
      );
    const first = await menu();
    await page.evaluate(
      "(async()=>{const {startObserveDom}=await import('/src/ts/observer.svelte.ts');void startObserveDom();void startObserveDom();})()",
    );
    await delay(350);
    const repeated = await menu();
    await page.evaluate(
      "window.observerCode.setAttribute('x-hl-lang','synthetic-changed')",
    );
    await delay(150);
    const changed = await menu();
    await page.evaluate("window.observerCode.removeAttribute('x-hl-lang')");
    await delay(150);
    const removed = await page.evaluate(
      "(window.observerMenuAppends=0,window.observerCode.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})),window.observerMenuAppends)",
    );
    const expectedBaseline =
      process.env.RISU_DISPLAY_OBSERVER_BASELINE === "TRUE";
    // No media/network simulation is attributed to actual audio decoding. The
    // actual observer owns these neutral EventTarget playback observations.
    await page.evaluate(`(()=>{
      window.observerAudio=[];
      window.Audio=class extends EventTarget{constructor(src){super();this.src=src;this.volume=0;this.played=false;this.removed=false;window.observerAudio.push(this);}play(){this.played=true;return Promise.resolve();}remove(){this.removed=true;}};
      const node=document.createElement('div');node.setAttribute('risu-ctrl','bgm___0.25___Synthetic-before');document.body.append(node);window.observerBgm=node;
    })()`);
    await until(() => page.evaluate("window.observerAudio.length===1"));
    await page.evaluate(
      "window.observerAudio[0].dispatchEvent(new Event('ended'))",
    );
    await until(() => page.evaluate("window.observerAudio.length===2"));
    await page.evaluate(
      "window.observerBgm.setAttribute('risu-ctrl','bgm___0.75___Synthetic-after');window.observerAudio[1].dispatchEvent(new Event('ended'))",
    );
    await until(() => page.evaluate("window.observerAudio.length===3"));
    await page.evaluate(
      "window.observerBgm.remove();window.observerAudio[2].dispatchEvent(new Event('ended'))",
    );
    await delay(200);
    const audio = await page.evaluate(
      "({count:window.observerAudio.length,tracks:window.observerAudio.map(a=>({src:a.src,volume:a.volume,played:a.played,removed:a.removed}))})",
    );
    assert.deepEqual(audio, {
      count: 3,
      tracks: [
        { src: "Synthetic-before", volume: 0.25, played: true, removed: true },
        { src: "Synthetic-before", volume: 0.25, played: true, removed: true },
        { src: "Synthetic-after", volume: 0.75, played: true, removed: true },
      ],
    });
    const result = {
      syntheticOnly: true,
      originalUi: true,
      originalCodeblock: true,
      expectedBaseline,
      fixed:
        first.menus === 1 &&
        repeated.menus === 1 &&
        changed.menus === 1 &&
        removed === 0,
      first,
      repeated,
      changed,
      removed,
      audio,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/ts/observer.svelte.ts",
            "src/lib/ChatScreens/ChatBody.svelte",
            "server/browser/displayObserverUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_OBSERVER_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_OBSERVER_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
    assert.equal(first.clipboardCalls, 1);
    assert.equal(repeated.clipboardCalls, 2);
    assert.equal(changed.clipboardCalls, 3);
    assert.match(changed.clipboardText, /Synthetic/);
    if (expectedBaseline) {
      assert.ok(first.menus > 1);
      assert.ok(repeated.menus > first.menus);
      assert.ok(changed.menus > repeated.menus);
      assert.ok(removed > 0);
    } else {
      assert.equal(first.menus, 1);
      assert.equal(repeated.menus, 1);
      assert.equal(changed.menus, 1);
      assert.equal(removed, 0);
    }
  },
);
