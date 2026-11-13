"use strict";
const { createProductionService } = require("../runtime/production.cjs");
const { createHash } = require("node:crypto");
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join, resolve } = require("node:path"),
  { tmpdir } = require("node:os");
const { deflateSync } = require("node:zlib"),
  { crc32 } = require("crc"),
  { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs"),
  { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Group asset timeout: " + JSON.stringify(value));
}
async function click(p, selector) {
  await until(() =>
    p.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true})()`,
    ),
  );
}
async function write(p, selector, value) {
  await until(() =>
    p.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    ),
  );
}
async function physicalClick(p, selector) {
  const point = await p.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
}
async function offlineCommands(page) {
  let failed = 0;
  page.on("Fetch.requestPaused", (e) => {
    failed++;
    void page
      .send("Fetch.failRequest", {
        requestId: e.requestId,
        errorReason: "InternetDisconnected",
      })
      .catch(() => {});
  });
  await page.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/runtime/commands*", requestStage: "Request" },
    ],
  });
  return () => failed;
}
const bridge = (c) =>
  `(async()=>{const{browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${c}})()`;
function png(color) {
  const chunk = (type, data) => {
    const n = Buffer.from(type),
      s = Buffer.alloc(4),
      c = Buffer.alloc(4);
    s.writeUInt32BE(data.length);
    c.writeUInt32BE(crc32(Buffer.concat([n, data])) >>> 0);
    return Buffer.concat([s, n, data, c]);
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(16, 0);
  h.writeUInt32BE(16, 4);
  h[8] = 8;
  h[9] = 6;
  const pixels = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      Buffer.from([...color, 255]).copy(pixels, y * 65 + 1 + x * 4);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", h),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const options of [
  { name: "desktop", mobile: false, beta: false, built: false },
  ...(process.env.RISU_DISPLAY_WORKER_BUILD_PATH
    ? [{ name: "built-desktop", mobile: false, beta: false, built: true }]
    : []),
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
].filter(
  (x) =>
    !process.env.RISU_GROUP_ASSET_SCENARIO ||
    x.name === process.env.RISU_GROUP_ASSET_SCENARIO,
))
  test(
    `${options.name}: original group asset controls capture sources, share decoded pixels and reject stale owners`,
    { timeout: 180000 },
    async (t) => {
      const directory = await fs.mkdtemp(join(tmpdir(), "risu-group-assets-"));
      let runtime, production, frontend, browser, a, b, release;
      const origins = [],
        observed = [],
        reads = [];
      let hold = false;
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              teardown: await a
                .evaluate(
                  options.built
                    ? "({status:document.querySelector('[role=status]')?.textContent})"
                    : bridge(
                        "({error:s.error,pending:s.pending.map(e=>({type:e.command.type,error:e.error})),status:document.querySelector('[role=status]')?.textContent})",
                      ),
                )
                .catch(() => null),
            }),
          );
        release?.();
        await browser?.close();
        await frontend?.close();
        await (production ?? runtime)?.close();
        await fs.rm(directory, {
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
      });
      await runtime.scheduler.close();
      const authority = (await runtime.store.call("bootstrap")).serverId;
      const upload = async (bytes) => {
        const r = await fetch(
          runtime.url + "/api/runtime/assets?extension=png",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "Risu-Runtime-Id": authority,
            },
            body: bytes,
          },
        );
        assert.equal(r.status, 200);
        return r.json();
      };
      const red = await upload(png([210, 30, 20])),
        blue = await upload(png([20, 30, 210]));
      await runtime.store.call("applyCommand", "settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: 0,
        payload: {
          didFirstSetup: true,
          language: "en",
          aiModel: "gpt35",
          betaMobileGUI: options.beta,
          hideAllImages: false,
          newImageHandlingBeta: true,
          useAdditionalAssetsPreview: true,
        },
      });
      for (const [id, image] of [
        ["alpha", red.path],
        ["beta", blue.path],
      ])
        await runtime.store.call("applyCommand", "member-" + id, {
          type: "create-character",
          characterId: id,
          definition: {
            type: "character",
            name: id,
            image,
            desc: "Authored unused definition",
            firstMessage: "Authored greeting",
            customscript: [],
            triggerscript: [],
          },
        });
      for (const id of ["g", "other"])
        await runtime.store.call("applyCommand", "group-" + id, {
          type: "create-character",
          characterId: id,
          chat: {
            chatId: "chat-" + id,
            metadata: { name: "Authored asset group", fmIndex: 2 },
          },
          definition: {
            type: "group",
            name: "Synthetic group " + id,
            characters: id === "g" ? ["alpha", "beta"] : [],
            characterTalks: id === "g" ? [1, 1] : [],
            characterActive: id === "g" ? [true, true] : [],
            customscript: [],
            triggerscript: [],
            globalLore: [],
            unknown: { retain: true },
            ...(id === "g"
              ? {
                  image: red.path,
                  ccAssets: [
                    {
                      type: "icon",
                      name: "Authored spare",
                      uri: blue.path,
                      ext: "png",
                      unknown: true,
                    },
                  ],
                  additionalAssets: [
                    ["Authored asset", red.path, "png", { unknown: true }],
                  ],
                  viewScreen: "none",
                }
              : {}),
          },
        });
      if (options.built) {
        await runtime.close();
        const passwordFile = join(directory, "password");
        await fs.writeFile(
          passwordFile,
          createHash("sha256").update("synthetic-password").digest("hex"),
        );
        production = await createProductionService({
          file: join(directory, "synthetic.sqlite"),
          passwordFile,
          staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
          origin: "https://risu.test",
          insecureLocalTest: true,
          host: "127.0.0.1",
          port: 0,
          runtime: { eventsPollMs: 20 },
        });
        runtime = production.runtime;
        await runtime.scheduler.close();
      }
      const call = runtime.store.call.bind(runtime.store);
      runtime.store.call = async (method, ...args) => {
        if (method === "getCharacter") reads.push(args[0]);
        if (method === "applyCommand" && args[1]?.type === "change-fields") {
          observed.push(structuredClone(args[1]));
          if (hold && args[1].groupImageSources) {
            hold = false;
            await new Promise((r) => (release = r));
          }
        }
        return call(method, ...args);
      };
      let url = production?.url;
      if (!options.built) {
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
            proxy: {
              "/api/runtime": { target: runtime.url, changeOrigin: true },
            },
          },
        });
        await frontend.listen();
        url = "http://127.0.0.1:" + frontend.httpServer.address().port;
        origins.push(url);
      }
      browser = await launchChromium(directory);
      const contexts = [await browser.newContext(), await browser.newContext()];
      const open = async (index) => {
        const p = await browser.page("about:blank", contexts[index], {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        if (!index && options.mobile) {
          await p.send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
          });
          await p.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 5,
          });
          await p.send("Network.setUserAgentOverride", {
            userAgent:
              "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await p.send("Page.navigate", { url });
        if (options.built) {
          await until(() =>
            p.evaluate(
              "!!document.querySelector('input[name=password]')||!!document.querySelector('[data-runtime-ready=true]')",
            ),
          );
          await p.evaluate(
            "(()=>{const e=document.querySelector('input[name=password]');if(e){e.value='synthetic-password';document.querySelector('form').requestSubmit()}})()",
          );
        }

        await until(() =>
          p.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
        );
        return p;
      };
      const edit = async (p, id = "g") => {
        if (options.built) {
          await click(p, `[data-character-id=${id}]`);
          await until(() =>
            p.evaluate(
              "!!document.querySelector('textarea.input-text')&&!document.querySelector('textarea.input-text').disabled",
            ),
          );
          if (
            !(await p.evaluate(
              "!!document.querySelector('button[aria-label=\"Character Display\"]')",
            ))
          )
            await p.evaluate(
              "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Character').click()",
            );
          await click(p, 'button[aria-label="Character Display"]');
          await until(() =>
            p.evaluate(
              `!!document.querySelector('[data-runtime-group-assets=${id}]')`,
            ),
          );
          return;
        }

        await p.evaluate(
          `(async()=>{const v=await import('/src/ts/stores.svelte.ts');v.settingsOpen.set(false);const{browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter(${JSON.stringify(id)},${JSON.stringify("chat-" + id)});v.botMakerMode.set(true);v.sideBarStore.set(true);v.MobileSideBar.set(2);v.CharConfigSubMenu.set(1)})()`,
        );
        await until(() =>
          p.evaluate(
            `!!document.querySelector('[data-runtime-group-assets=${id}]')`,
          ),
        );
      };
      const definition = async (id = "g") =>
        (await call("getCharacter", id)).definition;
      const change = async (id, key, value) => {
        const target = { scope: "character", entityId: id, key },
          f = (await call("readFields", [target])).fields[0];
        return call("applyCommand", crypto.randomUUID(), {
          type: "change-fields",
          edits: [
            {
              ...target,
              value,
              expectedRevision: f.revision,
              expectedEpoch: f.entityEpoch,
            },
          ],
        });
      };
      a = await open(0);
      b = await open(1);
      await edit(a);
      await edit(b);
      if (options.built) {
        const pixels = async (p) =>
          p.evaluate(
            `(async()=>{const style=document.querySelector('[data-runtime-asset-icon=current] div')?.style.backgroundImage;const url=style?.match(/url\\(["']?(.*?)["']?\\)/)?.[1];if(!url)return null;const i=new Image();i.src=url;await i.decode();const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.drawImage(i,0,0);return{width:i.width,left:[...x.getImageData(32,128,1,1).data],right:[...x.getImageData(192,128,1,1).data]}})()`,
          );
        const before = await definition();
        await click(a, "[data-runtime-group-image]");
        await until(definition, (x) => x.image !== before.image);
        await until(
          () => pixels(b),
          (x) => x?.width === 256,
        );
        assert.deepEqual(await pixels(b), {
          width: 256,
          left: [210, 30, 20, 255],
          right: [20, 30, 210, 255],
        });
        assert.deepEqual((await definition()).ccAssets, before.ccAssets);
        await change("g", "image", red.path);
        await until(
          () => pixels(a),
          (x) => x?.width === 16,
        );
        hold = true;
        await click(a, "[data-runtime-group-image]");
        await until(() => !!release);
        await change("beta", "image", red.path);
        await change("beta", "image", blue.path);
        release();
        release = null;
        await until(() =>
          a.evaluate(
            "document.querySelector('[role=status]').textContent.includes('이미지를 다시')",
          ),
        );
        assert.equal((await definition()).image, red.path);
        assert.ok(
          !(await a.evaluate(
            "document.querySelector('[role=status]').textContent.includes('내 변경 적용')",
          )),
        );
        await a.evaluate(
          "[...document.querySelectorAll('button')].find(e=>e.textContent==='서버 값 사용').click()",
        );
        await until(() =>
          a.evaluate(
            "document.querySelector('[data-runtime-pending-count]').dataset.runtimePendingCount==='0'",
          ),
        );
        const blocked0 = await offlineCommands(a);
        await click(a, "[data-runtime-group-image]");
        await until(() =>
          a.evaluate(
            "Number(document.querySelector('[data-runtime-pending-count]').dataset.runtimePendingCount)>0",
          ),
        );
        await until(() => blocked0() > 0);
        await a.close();
        await b.close();
        a = b = null;
        a = await open(0);
        b = await open(1);
        await edit(a);
        await edit(b);
        await until(definition, (x) => x.image !== red.path);
        await until(() =>
          a.evaluate(
            "document.querySelector('[data-runtime-pending-count]').dataset.runtimePendingCount==='0'",
          ),
        );
        await until(
          () => pixels(b),
          (x) => x?.width === 256,
        );
        console.log(
          JSON.stringify({
            optimizedOriginalUi: true,
            authenticatedSynthetic: true,
            decodedPeerPixels: true,
            derivedSourceABARejected: true,
            derivedAllTabsExit: true,
            sourceImportsUsed: false,
          }),
        );
        return;
      }
      const minimal = await definition("other");
      await edit(a, "other");
      for (const tab of ["view", "additional", "icon"])
        await click(a, `[data-runtime-asset-tab=${tab}]`);
      await delay(100);
      assert.deepEqual(await definition("other"), minimal);
      await click(a, "[data-runtime-group-image]");
      await until(
        () => definition("other"),
        (x) => typeof x.image === "string",
      );
      const blank = await definition("other");
      assert.equal(blank.ccAssets, undefined);

      await edit(a);
      for (const mode of ["single", "multiple", "emp", "none"]) {
        await click(a, "[data-runtime-asset-tab=view]");
        await write(a, "[data-runtime-asset-field=viewScreen] select", mode);
        await until(definition, (x) => x.viewScreen === mode);
        await click(b, "[data-runtime-asset-tab=view]");
        await until(
          () =>
            b.evaluate(
              "document.querySelector('[data-runtime-asset-field=viewScreen] select').value",
            ),
          (x) => x === mode,
        );
      }
      await click(a, "[data-runtime-asset-tab=additional]");
      await write(
        a,
        '[data-runtime-asset-additional="0"] input',
        "Renamed authored asset",
      );
      await until(
        definition,
        (x) => x.additionalAssets[0][0] === "Renamed authored asset",
      );
      assert.deepEqual((await definition()).additionalAssets[0][3], {
        unknown: true,
      });
      await click(a, '[data-runtime-asset-exclude="0"]');
      await until(definition, (x) =>
        x.prebuiltAssetExclude?.includes(red.path),
      );
      await click(a, '[data-runtime-asset-remove="0"]');
      await until(definition, (x) => x.additionalAssets.length === 0);
      assert.equal(
        (await call("snapshot", "chat-g")).chat.metadata.fmIndex,
        -1,
      );
      await click(a, "[data-runtime-asset-tab=icon]");
      const before = await definition();
      reads.length = 0;
      await click(a, "[data-runtime-group-image]");
      await until(definition, (x) => x.image !== before.image);
      const composite = await definition();
      assert.deepEqual(composite.ccAssets, before.ccAssets);
      assert.ok(
        !reads.includes("alpha") && !reads.includes("beta"),
        "composition must not hydrate member definitions",
      );
      const derived = observed.find(
        (x) => x.groupImageSources?.groupId === "g",
      );
      assert.deepEqual(
        derived.edits.map((x) => x.key),
        ["image"],
      );
      assert.deepEqual(
        derived.checks.map((x) => x.key),
        ["image", "ccAssets", "hideAllImages"],
      );
      const pixels = await b.evaluate(
        `(async()=>{const{getFileSrc}=await import('/src/ts/globalApi.svelte.ts');const i=new Image();i.src=await getFileSrc(${JSON.stringify(composite.image)});await i.decode();const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.drawImage(i,0,0);return {width:i.width,height:i.height,left:[...x.getImageData(32,128,1,1).data],right:[...x.getImageData(192,128,1,1).data]}})()`,
      );
      assert.deepEqual(pixels, {
        width: 256,
        height: 256,
        left: [210, 30, 20, 255],
        right: [20, 30, 210, 255],
      });
      await until(
        () =>
          b.evaluate(
            bridge(
              "r().fieldHeader({scope:'character',entityId:'g',key:'image'}).revision",
            ),
          ),
        (x) => x === derived.edits[0].expectedRevision + 1,
      );
      // The real durable command waits at the server. A peer ABA makes its derived pixels stale.
      await change("g", "image", red.path);
      await until(
        () =>
          a.evaluate(
            `(async()=>{const{DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.characters.find(c=>c.chaId==='g').image})()`,
          ),
        (x) => x === red.path,
      );
      hold = true;
      await click(a, "[data-runtime-group-image]");
      await until(() => !!release);
      await change("beta", "image", red.path);
      await change("beta", "image", blue.path);
      release();
      release = null;
      await until(() =>
        a.evaluate(
          bridge(
            "s.pending.some(e=>e.state==='blocked'&&e.command.groupImageSources)",
          ),
        ),
      );
      assert.equal((await definition()).image, red.path);
      const conflict = await a.evaluate(
        "document.querySelector('[role=status]').textContent",
      );
      assert.ok(conflict.includes("이미지를 다시"));
      assert.ok(!conflict.includes("내 변경 적용"));
      await a.evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent==='서버 값 사용').click()",
      );
      await until(() => a.evaluate(bridge("!s.pending.length")));
      await click(a, "[data-runtime-group-image]");
      await until(
        () =>
          observed.filter((x) => x.groupImageSources?.groupId === "g").length >=
          3,
      );
      await until(() => a.evaluate(bridge("!s.pending.length")));
      // Image-hiding policy is a captured dependency, even when its value returns to false.
      await change("g", "image", red.path);
      await until(
        () =>
          a.evaluate(
            `(async()=>{const{DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.characters.find(c=>c.chaId==='g').image})()`,
          ),
        (x) => x === red.path,
      );
      hold = true;
      await click(a, "[data-runtime-group-image]");
      await until(() => !!release);
      for (const value of [true, false]) {
        const target = {
            scope: "resource",
            resourceKind: "settings",
            entityId: "global",
            key: "hideAllImages",
          },
          f = (await call("readFields", [target])).fields[0];
        await call("applyCommand", crypto.randomUUID(), {
          type: "change-fields",
          edits: [
            {
              ...target,
              value,
              expectedRevision: f.revision,
              expectedEpoch: f.entityEpoch,
            },
          ],
        });
      }
      release();
      release = null;
      await until(() =>
        a.evaluate(
          bridge(
            "s.pending.some(e=>e.state==='blocked'&&e.command.groupImageSources)",
          ),
        ),
      );
      assert.equal((await definition()).image, red.path);
      await a.evaluate(
        "[...document.querySelectorAll('button')].find(e=>e.textContent==='서버 값 사용').click()",
      );
      await until(() => a.evaluate(bridge("!s.pending.length")));
      // Large membership crosses the128-reference page boundary in the actual compositor.
      const members = Array.from({ length: 130 }, (_, i) =>
        i % 2 ? "beta" : "alpha",
      );
      await change("g", "characters", members);
      await click(a, "[data-runtime-group-image]");
      await until(
        definition,
        (x) => x.image !== composite.image && x.image !== red.path,
      );
      const large = await definition();
      assert.equal(large.characters.length, 130);
      const bytes = await a.evaluate(
        `(async()=>{const{getFileSrc}=await import('/src/ts/globalApi.svelte.ts');const i=new Image();i.src=await getFileSrc(${JSON.stringify(large.image)});await i.decode();const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(Math.floor(9.5*256/12),Math.floor(10.5*256/11),1,1).data]})()`,
      );
      assert.deepEqual(bytes, [20, 30, 210, 255]);
      await change("g", "characters", ["alpha", "beta"]);
      // Missing and broken member images end visibly without changing the saved icon.
      for (const image of ["", "assets/runtime/authored-missing.png"]) {
        const stable = await definition();
        await change("beta", "image", image);
        await click(a, "[data-runtime-group-image]");
        await until(() => a.evaluate(bridge("s.error")));
        assert.equal((await definition()).image, stable.image);
        await a.evaluate(bridge('s.error=""'));
      }
      await change("beta", "image", blue.path);
      // Captured picker ownership: a file selected after navigation cannot attach to the other group.
      await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
      let chooser;
      const off = a.on(
        "Page.fileChooserOpened",
        (e) => (chooser = e.backendNodeId),
      );
      await physicalClick(a, "[data-runtime-asset-action=upload-icon]");
      await until(() => chooser);
      await edit(a, "other");
      const other = await definition("other");
      const file = join(directory, "authored-upload.png");
      await fs.writeFile(file, png([80, 150, 40]));
      await a.send("DOM.setFileInputFiles", {
        files: [file],
        backendNodeId: chooser,
      });
      off();
      await delay(150);
      assert.deepEqual(await definition("other"), other);
      await edit(a);
      chooser = null;
      const off2 = a.on(
        "Page.fileChooserOpened",
        (e) => (chooser = e.backendNodeId),
      );
      await physicalClick(a, "[data-runtime-asset-action=upload-icon]");
      await until(() => chooser);
      const preUpload = await definition();
      await a.send("DOM.setFileInputFiles", {
        files: [file],
        backendNodeId: chooser,
      });
      off2();
      await until(definition, (x) => x.image !== preUpload.image);
      const uploaded = await definition();
      assert.equal(uploaded.ccAssets.at(-1).uri, preUpload.image);
      assert.equal(
        uploaded.extentions,
        undefined,
        "group icons do not import character PNG metadata",
      );
      // A complete derived command survives all-tab exit, then rejects a source ABA on replay.
      await change("g", "image", red.path);
      await until(
        () =>
          a.evaluate(
            `(async()=>{const{DBState}=await import('/src/ts/stores.svelte.ts');return DBState.db.characters.find(c=>c.chaId==='g').image})()`,
          ),
        (x) => x === red.path,
      );
      await until(() => a.evaluate(bridge("!s.pending.length")));
      await a.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const blocked1 = await offlineCommands(a);
      await click(a, "[data-runtime-group-image]");
      await until(() =>
        a.evaluate(
          bridge(
            "s.pending.some(e=>e.state==='pending'&&e.command.groupImageSources?.groupId==='g')",
          ),
        ),
      );
      await until(() => blocked1() > 0);
      const retainedDigest = await a.evaluate(
        bridge(
          "s.pending.find(e=>e.state==='pending'&&e.command.groupImageSources?.groupId==='g')?.command.groupImageSources.digest",
        ),
      );
      assert.equal(typeof retainedDigest, "string");
      await a.close();
      await b.close();
      a = b = null;
      await change("beta", "image", red.path);
      await change("beta", "image", blue.path);
      assert.notEqual(
        (await call("groupImageSources", "g")).guard.digest,
        retainedDigest,
      );
      a = await open(0);
      b = await open(1);
      await edit(a);
      await edit(b);
      await until(() =>
        a.evaluate(
          bridge(
            "s.pending.some(e=>e.state==='blocked'&&e.command.groupImageSources)",
          ),
        ),
      );
      assert.equal((await definition()).image, red.path);
      await a.evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent==='서버 값 사용').click()",
      );
      await until(() => a.evaluate(bridge("!s.pending.length")));
      // Offline ordinary field intent is durable through destruction of both tabs.
      const blocked2 = await offlineCommands(a);
      await click(a, "[data-runtime-asset-tab=view]");
      await write(a, "[data-runtime-asset-field=viewScreen] select", "emp");
      await until(() =>
        a.evaluate(
          bridge("s.pending.some(e=>e.command.type==='change-fields')"),
        ),
      );
      await until(() => blocked2() > 0);
      await a.close();
      await b.close();
      a = b = null;
      a = await open(0);
      b = await open(1);
      await edit(a);
      await edit(b);
      await until(definition, (x) => x.viewScreen === "emp");
      await until(() => a.evaluate(bridge("!s.pending.length")));
      assert.deepEqual((await definition()).unknown, { retain: true });
      console.log(
        JSON.stringify({
          layout: options.name,
          orderedPixels: true,
          sourceABARejected: true,
          originalIconDump: true,
          memberBodiesHydrated: false,
          allTabsExit: true,
          physicalDevice: false,
        }),
      );
    },
  );
