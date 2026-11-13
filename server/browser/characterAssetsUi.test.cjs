"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { deflateSync } = require("node:zlib");
const { crc32 } = require("crc");
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
  throw Error("Asset editor condition timed out: " + JSON.stringify(value));
}
const bridge = (code) =>
  `(async()=>{const{browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function click(page, selector) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
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
function png(color, title) {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([size, name, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(24, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(24 * (1 + 32 * 4));
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 32; x++)
      Buffer.from([...color, 255]).copy(pixels, y * 129 + 1 + x * 4);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("Title\0" + title)),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const options of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
].filter(
  (x) =>
    !process.env.RISU_ASSET_SCENARIO ||
    x.name === process.env.RISU_ASSET_SCENARIO,
))
  test(
    `${options.name}: original character asset controls persist, share uploaded bytes and reject stale pickers`,
    { timeout: 240000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-character-assets-"));
      let runtime, frontend, browser, a, b;
      const errors = [];
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              teardown: await a
                .evaluate("document.body.textContent.slice(-1500)")
                .catch(() => null),
            }),
          );
        await browser?.close();
        await frontend?.close();
        await runtime?.close();
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
      await runtime.scheduler.close();
      const authority = (await runtime.store.call("bootstrap")).serverId;
      const upload = async (bytes) => {
        const response = await fetch(
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
        assert.equal(response.status, 200);
        return response.json();
      };
      const first = await upload(png([40, 80, 120], "Seed one")),
        second = await upload(png([120, 80, 40], "Seed two"));
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
          newImageHandlingBeta: true,
          useAdditionalAssetsPreview: true,
        },
      });
      for (const id of ["c", "d"])
        await runtime.store.call("applyCommand", "create-" + id, {
          type: "create-character",
          characterId: id,
          chat: {
            chatId: "chat-" + id,
            metadata: {
              name: "Authored asset test",
              fmIndex: 2,
              syntheticUnknown: "chat",
            },
          },
          definition: {
            type: "character",
            name: "Synthetic assets " + id,
            desc: "Neutral authored fixture",
            firstMessage: "Authored greeting",
            syntheticUnknown: { retained: true },
            ...(id === "c"
              ? {
                  image: first.path,
                  ccAssets: [
                    {
                      type: "icon",
                      name: "authored spare",
                      uri: second.path,
                      ext: "png",
                      syntheticUnknown: "spare",
                    },
                  ],
                  emotionImages: [["calm", first.path]],
                  viewScreen: "emotion",
                  inlayViewScreen: true,
                  newGenData: {
                    prompt: "Authored prompt",
                    negative: "Authored negative",
                    instructions: "Authored image instructions",
                    emotionInstructions: "Authored emotion instructions",
                    syntheticUnknown: "nested",
                  },
                  additionalAssets: [
                    [
                      "Seed A",
                      first.path,
                      "png",
                      { syntheticUnknown: "tuple" },
                    ],
                    ["Seed B", second.path, "png"],
                  ],
                  extentions: {
                    syntheticUnknown: "extension",
                    pngExif: { Author: "Authored author" },
                  },
                }
              : {}),
          },
        });
      const vite = await import("vite");
      frontend = await vite.createServer({
        configFile: resolve("vite.config.ts"),
        logLevel: "error",
        plugins:
          process.env.RISU_ASSET_NEGATIVE === "TRUE"
            ? [
                {
                  name: "authored-asset-negative-control",
                  enforce: "pre",
                  transform(source, id) {
                    if (!id.endsWith("/src/lib/SideBars/CharConfig.svelte"))
                      return;
                    const needle =
                      "{#if entityRuntimeEnabled}\n    {#key `${DBState.db.characters[$selectedCharID].chaId}:${currentChat().id}`}";
                    assert.equal(source.split(needle).length - 1, 1);
                    return source.replace(
                      needle,
                      needle.replace(
                        "{#if entityRuntimeEnabled}",
                        "{#if false}",
                      ),
                    );
                  },
                },
              ]
            : [],
        define: {
          "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
          "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
        },
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      await frontend.listen();
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      browser = await launchChromium(directory);
      const contexts = [await browser.newContext(), await browser.newContext()];
      const open = async (context, mobile = false) => {
        const page = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        page.on("Runtime.exceptionThrown", (e) =>
          errors.push(e.exceptionDetails.text),
        );
        if (mobile) {
          await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
          });
          await page.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 5,
          });
          await page.send("Network.setUserAgentOverride", {
            userAgent:
              "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await page.send("Page.navigate", { url });
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-ready=true]')",
          ),
        );
        return page;
      };
      const edit = async (page, id = "c") => {
        await page.evaluate(
          `(async()=>{const v=await import('/src/ts/stores.svelte.ts');v.settingsOpen.set(false);const{browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter(${JSON.stringify(id)},${JSON.stringify("chat-" + id)});v.botMakerMode.set(true);v.sideBarStore.set(true);v.MobileSideBar.set(2);v.CharConfigSubMenu.set(1);})()`,
        );
        await until(() =>
          page.evaluate(
            process.env.RISU_ASSET_NEGATIVE === "TRUE"
              ? "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Additional Assets')"
              : "!!document.querySelector('[data-runtime-character-assets]')",
          ),
        );
      };
      const character = async (id = "c") =>
        (await runtime.store.call("getCharacter", id)).definition;
      const metadata = async () =>
        (await runtime.store.call("snapshot", "chat-c")).chat.metadata;
      a = await open(contexts[0], options.mobile);
      b = await open(contexts[1]);
      await edit(a);
      await edit(b);
      if (process.env.RISU_ASSET_NEGATIVE === "TRUE") {
        for (const page of [a, b])
          await page.evaluate(
            "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Additional Assets').click()",
          );
        await until(() =>
          a.evaluate(
            "[...document.querySelectorAll('input')].some(e=>e.value==='Seed A')",
          ),
        );
        await a.evaluate(
          "(()=>{const e=[...document.querySelectorAll('input')].find(e=>e.value==='Seed A');e.value='Unstored authored edit';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()",
        );
        await delay(250);
        assert.equal((await character()).additionalAssets[0][0], "Seed A");
        assert.ok(
          await a.evaluate(
            "[...document.querySelectorAll('input')].some(e=>e.value==='Unstored authored edit')",
          ),
        );
        assert.ok(
          await b.evaluate(
            "[...document.querySelectorAll('input')].some(e=>e.value==='Seed A')",
          ),
        );
        console.log(
          JSON.stringify({
            negativeControl: true,
            legacyEditVisibleButUnstored: true,
            peerUnchanged: true,
          }),
        );
        return;
      }
      const before = await character();
      let minimal = await character("d");
      await edit(a, "d");
      for (const tab of ["view", "additional", "icon"])
        await click(a, `[data-runtime-asset-tab=${tab}]`);
      await delay(150);
      assert.deepEqual(
        await character("d"),
        minimal,
        "opening missing fields must not persist defaults",
      );
      await click(a, "[data-runtime-asset-tab=view]");
      await write(a, "[data-runtime-asset-field=viewScreen] select", "emotion");
      await until(
        () => character("d"),
        (x) => x.viewScreen === "emotion",
      );
      await click(a, "[data-runtime-asset-field=inlayViewScreen] label");
      await until(
        () => character("d"),
        (x) => x.inlayViewScreen === true && x.additionalAssets?.length === 0,
      );
      await click(a, "[data-runtime-asset-field=inlayViewScreen] label");
      await until(
        () => character("d"),
        (x) =>
          x.inlayViewScreen === false && !Object.hasOwn(x, "additionalAssets"),
      );
      minimal = await character("d");
      await edit(a);
      const commands = [];
      await a.send("Network.enable");
      a.on("Network.requestWillBeSent", (e) => {
        if (
          e.request.url.endsWith("/api/runtime/commands") &&
          e.request.postData
        )
          commands.push(JSON.parse(e.request.postData).command);
      });
      await click(a, "[data-runtime-asset-tab=additional]");
      await click(b, "[data-runtime-asset-tab=additional]");
      await write(
        a,
        "[data-runtime-asset-additional='0'] input",
        "Renamed authored asset",
      );
      await until(
        character,
        (x) => x.additionalAssets[0][0] === "Renamed authored asset",
      );
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-runtime-asset-additional=\"0\"] input')?.value==='Renamed authored asset'",
        ),
      );
      assert.deepEqual((await character()).additionalAssets[0][3], {
        syntheticUnknown: "tuple",
      });
      assert.ok(
        commands.some(
          (c) =>
            c.type === "change-fields" &&
            c.edits.length === 1 &&
            c.edits[0].key === "additionalAssets",
        ),
        "a name edit must not serialize unrelated image-generation settings",
      );
      await click(a, "[data-runtime-asset-exclude='0']");
      await until(character, (x) => x.prebuiltAssetExclude?.[0] === first.path);
      await click(a, "[data-runtime-asset-field=prebuiltAssetCommand] label");
      await write(
        a,
        "[data-runtime-asset-field=prebuiltAssetStyle] select",
        "dynamic",
      );
      await until(
        character,
        (x) => x.prebuiltAssetCommand && x.prebuiltAssetStyle === "dynamic",
      );
      await click(a, "[data-runtime-asset-remove='1']");
      await until(
        async () => ({ c: await character(), m: await metadata() }),
        (x) => x.c.additionalAssets.length === 1 && x.m.fmIndex === -1,
      );
      assert.equal((await metadata()).syntheticUnknown, "chat");
      assert.ok(
        commands.some(
          (c) =>
            c.type === "change-fields" &&
            c.edits?.some((x) => x.key === "additionalAssets") &&
            c.edits?.some((x) => x.key === "fmIndex"),
        ),
        "deletion and current greeting reset must be one command",
      );
      await click(a, "[data-runtime-asset-tab=icon]");
      await click(a, "[data-runtime-asset-icon='0']");
      await until(
        character,
        (x) => x.image === second.path && x.ccAssets[0].uri === first.path,
      );
      await click(a, "[data-runtime-asset-field=largePortrait] label");
      await until(character, (x) => x.largePortrait === true);
      await click(a, "[data-runtime-asset-tab=view]");
      await click(b, "[data-runtime-asset-tab=view]");
      await write(
        a,
        "[data-runtime-asset-gen=emotionInstructions] textarea",
        "Authored edited emotion instructions",
      );
      await until(
        character,
        (x) =>
          x.newGenData.emotionInstructions ===
          "Authored edited emotion instructions",
      );
      assert.equal((await character()).newGenData.syntheticUnknown, "nested");
      await write(a, "[data-runtime-asset-field=viewScreen] select", "imggen");
      await until(
        character,
        (x) =>
          x.viewScreen === "imggen" &&
          x.newGenData.prompt === "best quality, {{slot}}",
      );
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-runtime-asset-field=viewScreen] select').value==='imggen'",
        ),
      );
      await write(
        a,
        "[data-runtime-asset-gen=prompt] textarea",
        "Authored portable image prompt",
      );
      await until(
        character,
        (x) => x.newGenData.prompt === "Authored portable image prompt",
      );
      await click(a, "[data-runtime-asset-field=inlayViewScreen] label");
      await until(
        character,
        (x) =>
          x.inlayViewScreen === false &&
          x.newGenData.instructions.includes("only output the that prompt"),
      );
      const imageFile = join(directory, "happy.png"),
        cssFile = join(directory, "authored.css");
      const newBytes = png([80, 160, 40], "Authored upload title");
      await writeFile(imageFile, newBytes);
      await writeFile(
        cssFile,
        "/* authored passive asset */\n.authored { color: green; }\n",
      );
      let chooser;
      await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
      a.on("Page.fileChooserOpened", (e) => {
        chooser = e;
      });
      const beginPicker = async (selector) => {
        await until(() => a.evaluate(bridge("s.pending.length===0")));
        chooser = undefined;
        const point = await a.evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await a.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
        await until(() => chooser);
      };
      const supply = (files) =>
        a.send("DOM.setFileInputFiles", {
          files,
          backendNodeId: chooser.backendNodeId,
        });
      await write(a, "[data-runtime-asset-field=viewScreen] select", "emotion");
      await beginPicker("[data-runtime-asset-action=upload-emotion]");
      await supply([imageFile]);
      await until(
        character,
        (x) =>
          x.emotionImages.length === 2 && x.emotionImages[1][0] === "happy",
      );
      await click(a, "[data-runtime-asset-tab=additional]");
      await beginPicker("[data-runtime-asset-action=upload-additional]");
      await supply([imageFile, cssFile]);
      await until(character, (x) => x.additionalAssets.length === 3);
      const uploaded = (await character()).additionalAssets;
      assert.equal(uploaded[1][0], "happy.png");
      assert.equal(uploaded[2][2], "css");
      assert.deepEqual(
        Buffer.from(await runtime.assets.read(uploaded[2][1])),
        Buffer.from(
          "/* authored passive asset */\n.authored { color: green; }\n",
        ),
      );
      await click(a, "[data-runtime-asset-tab=icon]");
      await beginPicker("[data-runtime-asset-action=upload-icon]");
      await supply([imageFile]);
      await until(
        character,
        (x) =>
          x.extentions.pngExif.Title === "Authored upload title" &&
          x.image !== second.path,
      );
      const icon = (await character()).image;
      assert.equal(
        (await character()).extentions.syntheticUnknown,
        "extension",
      );
      assert.equal(
        (await character()).extentions.pngExif.Author,
        "Authored author",
      );
      assert.deepEqual(Buffer.from(await runtime.assets.read(icon)), newBytes);
      await click(b, "[data-runtime-asset-tab=icon]");
      await until(() =>
        b.evaluate(
          "(async()=>{const img=document.querySelector('[data-runtime-asset-icon=current] div');const css=img?.style.backgroundImage;return css&&css.includes('/api/runtime/assets/')})()",
        ),
      );
      // The field clock catches peer A -> B -> A while the actual native chooser waits.
      const pickerBaseline = await character();
      await beginPicker("[data-runtime-asset-action=upload-icon]");
      await click(b, "[data-runtime-asset-icon='0']");
      await until(character, (x) => x.image !== icon);
      await until(() =>
        b.evaluate(
          "!!document.querySelector('[data-runtime-asset-icon=\"1\"]')",
        ),
      );
      await click(b, "[data-runtime-asset-icon='1']");
      await until(character, (x) => x.image === icon);
      await click(b, "[data-runtime-asset-icon='0']");
      await until(character, (x) => x.image !== icon);
      await click(b, "[data-runtime-asset-icon='1']");
      await until(character, (x) => x.image === icon);
      assert.deepEqual(
        await character(),
        pickerBaseline,
        "the complete guarded values return to A before the delayed picker resolves",
      );
      await supply([imageFile]);
      await until(() => a.evaluate(bridge("!!s.error")));
      assert.match(
        await a.evaluate(bridge("s.error")),
        /fields changed while waiting/,
      );
      assert.deepEqual(
        await character(),
        pickerBaseline,
        "stale upload cannot partially attach an icon or append a spare",
      );
      await a.evaluate(bridge("(s.error=undefined)"));
      await until(() =>
        a.evaluate(
          "!document.querySelector('[data-runtime-asset-action=upload-icon]').disabled",
        ),
      );
      await beginPicker("[data-runtime-asset-action=upload-icon]");
      await edit(a, "d");
      await supply([imageFile]);
      await delay(150);
      assert.deepEqual(
        await character("d"),
        minimal,
        "a file chooser from the closed editor must not change the next character",
      );
      assert.equal((await character()).image, icon);
      await edit(a);
      await click(a, "[data-runtime-asset-tab=additional]");
      await click(b, "[data-runtime-asset-tab=additional]");
      await until(() => a.evaluate(bridge("s.pending.length===0")));
      let held;
      a.on("Fetch.requestPaused", (e) => {
        held = e.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await write(
        a,
        "[data-runtime-asset-additional='0'] input",
        "Losing asset name",
      );
      await until(() => held);
      await write(
        b,
        "[data-runtime-asset-additional='0'] input",
        "Winning peer asset name",
      );
      await until(
        character,
        (x) => x.additionalAssets[0][0] === "Winning peer asset name",
      );
      assert.equal(
        await a.evaluate(
          "document.querySelector('[data-runtime-asset-additional=\"0\"] input').value",
        ),
        "Losing asset name",
      );
      await a.send("Fetch.continueRequest", { requestId: held });
      await a.send("Fetch.disable");
      await until(() =>
        a.evaluate(bridge("s.pending.some(x=>x.state==='blocked')")),
      );
      await a.evaluate(
        "[...document.querySelectorAll('[data-runtime-ready] button')].find(e=>e.textContent.trim()==='서버 값 사용').click()",
      );
      await until(() => a.evaluate(bridge("s.pending.length===0")));
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-runtime-asset-additional=\"0\"] input').value==='Winning peer asset name'",
        ),
      );
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(
        a,
        "[data-runtime-asset-additional='0'] input",
        "Offline authored asset",
      );
      await until(() =>
        a.evaluate(bridge("s.pending.some(x=>x.state==='pending')")),
      );
      assert.equal(
        (await character()).additionalAssets[0][0],
        "Winning peer asset name",
      );
      await a.close();
      a = null;
      await b.close();
      b = null;
      a = await open(contexts[0], options.mobile);
      await edit(a);
      await click(a, "[data-runtime-asset-tab=additional]");
      await until(
        character,
        (x) => x.additionalAssets[0][0] === "Offline authored asset",
      );
      await until(() => a.evaluate(bridge("s.pending.length===0")));
      b = await open(contexts[1]);
      await edit(b);
      await click(b, "[data-runtime-asset-tab=additional]");
      await until(() =>
        b.evaluate(
          "document.querySelector('[data-runtime-asset-additional=\"0\"] input')?.value==='Offline authored asset'",
        ),
      );
      const final = await character();
      assert.deepEqual(final.syntheticUnknown, before.syntheticUnknown);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          scenario: options.name,
          actualPicker: true,
          sharedBytes: true,
          peerAbaRejected: true,
          actualConflictButton: true,
          closedPickerIgnored: true,
          allTabsOfflineReplay: true,
          atomicAssetRemoval: true,
          privateContent: false,
          realModelCalls: 0,
        }),
      );
    },
  );
