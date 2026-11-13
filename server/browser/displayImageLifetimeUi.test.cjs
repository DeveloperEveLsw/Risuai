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
  throw Error("Image lifecycle condition timed out: " + JSON.stringify(value));
}
test(
  "real original named-image lookup cannot overwrite a newer image or mutate a retired owner after its delayed URL resolves",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-image-life-"));
    let runtime, frontend, browser, page;
    t.after(async () => {
      if (page)
        try {
          await page.evaluate("window.releaseImageGate?.()");
        } catch {}
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
        newImageHandlingBeta: true,
      },
    });
    for (const [id, chatId] of [
      ["c", "a"],
      ["other", "other-chat"],
    ])
      await runtime.store.call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        chat: { chatId, metadata: { name: "Synthetic image " + id } },
        definition: {
          type: "character",
          name: "Synthetic image " + id,
          desc: "Synthetic",
          firstMessage: "Synthetic greeting " + id,
        },
      });
    await runtime.store.call("applyCommand", "message", {
      type: "append-message",
      chatId: "a",
      messageId: "m",
      message: { role: "char", data: "Synthetic image source" },
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
    page = await browser.page(url, await browser.newContext(), {
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
    await until(() => page.evaluate(ui("s.scopeReady")));
    await page.evaluate(
      ui(
        `(async()=>{const bridge=r(),paths=[];for(const color of ['red','blue']){const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,2,2);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));paths.push(await bridge.uploadAsset(bytes,'Synthetic-'+color+'.png'));}window.imagePaths=paths;bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['hero',paths[0],'png'],['hero2',paths[1],'png']]);return true;})()`,
      ),
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(0,false,'c','m')?.character.additionalAssets?.length===2",
        ),
      ),
    );
    await page.evaluate(
      ui(
        `(()=>{const bridge=r(),original=bridge.assetUrl.bind(bridge);window.imageGateStarts=0;window.prepareImageGate=()=>{window.imageGate=new Promise(resolve=>window.releaseImageGate=resolve);};window.prepareImageGate();bridge.assetUrl=path=>{const result=original(path);if(path===window.imagePaths[0]){window.imageGateStarts++;return window.imageGate.then(()=>result);}return result;};})()`,
      ),
    );
    const source = (name) =>
      `<section><img id="lifetime-image" src="${name}" alt="Synthetic ${name}"><span>${name}</span></section>`;
    const edit = async (name) =>
      page.evaluate(ui(`r().editMessage('m',${JSON.stringify(source(name))})`));
    await edit("hero");
    await until(() =>
      page.evaluate(
        "window.imageGateStarts>0&&!!document.querySelector('#lifetime-image')",
      ),
    );
    await page.evaluate(
      "window.imageOriginal=document.querySelector('#lifetime-image')",
    );
    await edit("hero2");
    await until(() =>
      page.evaluate(
        "document.querySelector('#lifetime-image')?.getAttribute('src')?.includes(window.imagePaths[1].split('/').at(-1))",
      ),
    );
    await page.evaluate("document.querySelector('#lifetime-image').decode()");
    const beforeRelease = await page.evaluate(
      "({sameImage:document.querySelector('#lifetime-image')===window.imageOriginal,src:document.querySelector('#lifetime-image').getAttribute('src'),width:document.querySelector('#lifetime-image').naturalWidth})",
    );
    assert.equal(beforeRelease.sameImage, true);
    assert.equal(beforeRelease.width, 2);
    await page.evaluate("window.releaseImageGate()");
    await delay(150);
    const afterRelease = await page.evaluate(
      "({src:document.querySelector('#lifetime-image').getAttribute('src'),width:document.querySelector('#lifetime-image').naturalWidth})",
    );
    assert.equal(afterRelease.src, beforeRelease.src);
    assert.equal(afterRelease.width, 2);
    const previousStarts = await page.evaluate(
      "(window.prepareImageGate(),window.imageGateStarts)",
    );
    await edit("hero");
    await until(() =>
      page.evaluate(
        `window.imageGateStarts>${previousStarts}&&document.querySelector('#lifetime-image')?.getAttribute('src')==='hero'`,
      ),
    );
    await page.evaluate(
      "window.retiredImage=document.querySelector('#lifetime-image')",
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await until(() =>
      page.evaluate(ui("s.scopeReady&&r().model.activeChatId==='other-chat'")),
    );
    assert.equal(await page.evaluate("window.retiredImage.isConnected"), false);
    await page.evaluate("window.releaseImageGate()");
    await delay(150);
    const retired = await page.evaluate(
      "({src:window.retiredImage.getAttribute('src'),connected:window.retiredImage.isConnected})",
    );
    assert.equal(retired.src, "hero");
    assert.equal(retired.connected, false);
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualOriginalGetFileSrc: true,
      actualUploadHttpAndDecode: true,
      delayedUrlCapability: true,
      newerImageProtected: true,
      retiredOwnerProtected: true,
      beforeRelease,
      afterRelease,
      retired,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/ts/runtime/stableDisplayDom.ts",
            "src/lib/ChatScreens/ChatBody.svelte",
            "server/browser/displayImageLifetimeUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_IMAGE_LIFETIME_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_IMAGE_LIFETIME_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
