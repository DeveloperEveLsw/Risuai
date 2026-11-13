"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");
const { execFileSync } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error(
    "Authored module UI condition timed out: " + JSON.stringify(value),
  );
}
const ui = (body) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${body}})()`;
async function click(page, selector) {
  await until(() =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`,
    ),
  );
}
async function textButton(page, text) {
  await until(() =>
    page.evaluate(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`,
    ),
  );
}
async function search(page, value) {
  await page.evaluate(
    `(()=>{const e=document.getElementById('runtime-chat-module-search');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
const choose = (id, action = "select") =>
  `[data-module-picker-id="${id}"] [data-runtime-module-action="${action}"]`;

for (const options of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${options.name}: original module picker, copy application and character conversion persist across peers, captured owners and offline tab exit`,
    {
      timeout: 180000,
      skip:
        process.env.RISU_MODULE_NEGATIVE === "TRUE" &&
        options.name !== "desktop",
    },
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "risu-character-module-ui-"),
      );
      let runtime, frontend, browser, a, b;
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              teardownText: await a
                .evaluate("document.body.textContent.slice(-1000)")
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
          useAdditionalAssetsPreview: false,
          enabledModules: [],
        },
      });
      const lore = (label) => ({
        key: "authored",
        content: label,
        comment: label,
        mode: "normal",
        insertorder: 1,
        alwaysActive: false,
        secondkey: "",
        selective: false,
        authoredUnknown: { retained: true },
      });
      const regex = (label) => ({
        comment: label,
        in: "NEVER_MATCH_AUTHORED",
        out: label,
        type: "editdisplay",
        authoredUnknown: { retained: true },
      });
      const trigger = (label) => ({
        comment: label,
        type: "output",
        conditions: [],
        effect: [],
        authoredUnknown: { retained: true },
      });
      for (const id of ["c", "d"])
        await runtime.store.call("applyCommand", "create-" + id, {
          type: "create-character",
          characterId: id,
          definition: {
            type: "character",
            name: "Authored module source " + id,
            desc: "Authored neutral description",
            firstMessage: "Authored greeting",
            alternateGreetings: ["Authored alternate"],
            creatorNotes: "Authored creator note",
            replaceGlobalNote: "Authored global note",
            globalLore: [lore("Character seed")],
            customscript: [regex("Character seed")],
            triggerscript: [trigger("Character seed")],
            additionalAssets: [
              [
                "authored-file",
                "assets/authored.png",
                "png",
                "extra portable tuple member",
              ],
            ],
            lowLevelAccess: false,
            hideChatIcon: false,
            backgroundHTML: "<p>Authored background</p>",
            modules: [],
            authoredUnknown: { retained: true },
          },
          chat: {
            chatId: "chat-" + id,
            metadata: { name: "Authored chat " + id, modules: [] },
          },
        });
      await runtime.store.call("applyCommand", "second-chat", {
        type: "create-chat",
        characterId: "c",
        chatId: "chat-c2",
        metadata: { name: "Authored second chat", modules: [] },
      });
      for (let i = 0; i < 61; i++) {
        const id = "m" + String(i).padStart(3, "0");
        await runtime.store.call("applyCommand", "module-" + id, {
          type: "save-library-resource",
          kind: "module",
          resourceId: id,
          expectedRevision: 0,
          expectedEpoch: 0,
          payload: {
            id,
            name: "Authored module " + String(i).padStart(3, "0"),
            description: "Authored description",
            lorebook: [lore("Module " + id)],
            regex: [regex("Module " + id)],
            trigger: [trigger("Module " + id)],
            inertAuthoredText: "x".repeat(16384),
          },
        });
      }
      const { createServer } = await import("vite");
      const negative = process.env.RISU_MODULE_NEGATIVE === "TRUE";
      const baseline = "28166952f326357626cd1d4dfff742d712232317";
      const baselineSources = negative
        ? new Map(
            [
              "src/lib/SideBars/CharConfig.svelte",
              "src/lib/Setting/Pages/Module/ModuleChatMenu.svelte",
              "src/ts/process/modules.ts",
            ].map((path) => [
              resolve(path),
              execFileSync("git", ["show", `${baseline}:${path}`], {
                encoding: "utf8",
              }),
            ]),
          )
        : new Map();
      frontend = await createServer({
        configFile: resolve("vite.config.ts"),
        logLevel: "error",
        plugins: negative
          ? [
              {
                name: "authored-module-baseline-control",
                enforce: "pre",
                load(id) {
                  return baselineSources.get(id);
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
      const browserExceptions = [];
      const contexts = [await browser.newContext(), await browser.newContext()];
      const open = async (context) => {
        const p = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        p.on("Runtime.exceptionThrown", (event) => {
          const description =
            event.exceptionDetails.exception?.description ??
            event.exceptionDetails.text;
          browserExceptions.push(description);
          console.log(JSON.stringify({ browserException: description }));
        });
        if (options.mobile && context === contexts[0]) {
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
              "Mozilla/5.0 (Linux; Android 14; Authored Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await p.send("Page.navigate", { url });
        await until(() =>
          p.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
        );
        await p.evaluate(
          ui(
            `(()=>{window.moduleCommands=[];window.moduleBodies=[];const client=r().client;const original=client.request.bind(client);client.request=async(...args)=>{const path=typeof args[0]==='string'?args[0]:args[0].url;const body=args[1]?.body;if(path.endsWith('/commands')&&typeof body==='string')window.moduleCommands.push(JSON.parse(body).command);if(path.includes('/resources/module/'))window.moduleBodies.push(path);return original(...args)};return true})()`,
          ),
        );
        return p;
      };
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      const select = async (page, id = "c", chat = "chat-c", edit = false) => {
        await page.evaluate(
          `(async()=>{const s=await import('/src/ts/stores.svelte.ts');s.settingsOpen.set(false);await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter(${JSON.stringify(id)},${JSON.stringify(chat)});s.botMakerMode.set(${edit});s.sideBarStore.set(${edit});s.MobileSideBar.set(${edit ? 2 : 0});s.CharConfigSubMenu.set(2)})()`,
        );
        if (edit)
          await until(() =>
            page.evaluate(
              negative
                ? "!!document.getElementById('runtime-definition-systemPrompt')"
                : "!!document.querySelector('[data-runtime-character-module-action=apply] button')",
            ),
          );
      };
      const definition = async (id = "c") =>
        (await runtime.store.call("getCharacter", id)).definition;
      const metadata = async (id = "chat-c") =>
        (await runtime.store.call("snapshot", id)).chat.metadata;
      const settings = async () =>
        (await runtime.store.call("getResource", "settings", "global")).payload;
      const closeSuccess = async (page) => {
        await until(() =>
          page.evaluate(
            "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='OK')",
          ),
        );
        await textButton(page, "OK");
      };
      const applyPicker = async (page) => {
        await click(
          page,
          "[data-runtime-character-module-action=apply] button",
        );
        await until(
          () =>
            page.evaluate(
              "document.querySelectorAll('[data-module-picker-id]').length",
            ),
          (n) => n === 50,
        );
      };
      await select(a, "c", "chat-c", true);
      await select(b, "c", "chat-c", true);
      const unchanged = await definition();
      if (negative) {
        await a.evaluate(ui("r().getLibraryResource('module','m060')"));
        await textButton(a, "Apply Module");
        await until(() =>
          a.evaluate(
            "(()=>{const e=[...document.querySelectorAll('svg.lucide-circle-check')].find(e=>e.closest('div.pl-3')?.textContent.includes('Authored module 060'))?.closest('button');if(!e)return false;e.click();return true})()",
          ),
        );
        await closeSuccess(a);
        assert.equal(
          await a.evaluate(
            ui(
              "r().model.database.characters[r().model.characterIndex('c')].globalLore.length",
            ),
          ),
          2,
        );
        assert.deepEqual(await definition(), unchanged);
        assert.equal(
          await b.evaluate(
            ui(
              "r().model.database.characters[r().model.characterIndex('c')].globalLore.length",
            ),
          ),
          1,
        );
        const before = (await settings()).moduleIds;
        await textButton(a, "Convert to Module");
        await closeSuccess(a);
        assert.ok(
          await a.evaluate(
            ui(
              "r().model.database.modules.some(m=>m.name==='Authored module source c')",
            ),
          ),
        );
        assert.deepEqual((await settings()).moduleIds, before);
        assert.equal(await a.evaluate("window.moduleCommands.length"), 0);
        assert.deepEqual(browserExceptions, []);
        console.log(
          JSON.stringify({
            negative: true,
            baseline,
            localApplicationChanged: true,
            serverApplicationUnchanged: true,
            peerApplicationUnchanged: true,
            localConversionExists: true,
            serverConversionMissing: true,
            fieldOrResourceCommands: 0,
            realProviderRequests: 0,
          }),
        );
        return;
      }
      await applyPicker(a);
      assert.equal(await a.evaluate("window.moduleBodies.length"), 0);
      assert.deepEqual(await definition(), unchanged);
      assert.equal(await a.evaluate("window.moduleCommands.length"), 0);
      await textButton(a, "Load More");
      await until(
        () =>
          a.evaluate(
            "document.querySelectorAll('[data-module-picker-id]').length",
          ),
        (n) => n === 61,
      );
      assert.equal(await a.evaluate("window.moduleBodies.length"), 0);
      await search(a, "module 060");
      await until(
        () =>
          a.evaluate(
            "document.querySelectorAll('[data-module-picker-id]').length",
          ),
        (n) => n === 1,
      );
      let firstAdmission;
      a.on("Fetch.requestPaused", (event) => {
        firstAdmission = event.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await click(a, choose("m060"));
      await until(() => firstAdmission);
      assert.deepEqual(await definition(), unchanged);
      assert.ok(
        !(await a.evaluate(
          "document.body.textContent.includes('Module is successfully applied')",
        )),
      );
      await a.send("Fetch.continueRequest", { requestId: firstAdmission });
      await a.send("Fetch.disable");
      await until(async () => (await definition()).globalLore.length === 2);
      await closeSuccess(a);
      let stored = await definition();
      assert.equal(stored.customscript.length, 2);
      assert.equal(stored.triggerscript.length, 2);
      assert.deepEqual(stored.globalLore[1], lore("Module m060"));
      assert.deepEqual(stored.authoredUnknown, { retained: true });
      await until(() =>
        b.evaluate(
          ui(
            "r().model.database.characters[r().model.characterIndex('c')].globalLore.length===2",
          ),
        ),
      );
      const applied = await a.evaluate(
        "window.moduleCommands.filter(c=>c?.type==='change-fields'&&c.edits.some(e=>e.key==='globalLore'))",
      );
      assert.equal(applied.length, 1);
      assert.deepEqual(applied[0].edits.map((e) => e.key).sort(), [
        "customscript",
        "globalLore",
        "triggerscript",
      ]);
      assert.ok(applied[0].edits.every((e) => e.entityId === "c"));
      assert.equal(await a.evaluate("window.moduleBodies.length"), 1);
      // A peer's ABA changes keep the same array value but advance its revision.
      await applyPicker(a);
      const beforeAba = await definition();
      const field = { scope: "character", entityId: "c", key: "globalLore" };
      for (const value of [
        [...beforeAba.globalLore, lore("Temporary ABA")],
        beforeAba.globalLore,
      ]) {
        await b.evaluate(
          ui(`r().setField(${JSON.stringify(field)},${JSON.stringify(value)})`),
        );
        await until(
          async () => (await definition()).globalLore,
          (actual) => isDeepStrictEqual(actual, value),
        );
        await until(
          async () =>
            JSON.parse(
              await a.evaluate(
                ui(
                  "JSON.stringify(r().model.database.characters[r().model.characterIndex('c')].globalLore)",
                ),
              ),
            ),
          (actual) => isDeepStrictEqual(actual, value),
        );
      }
      const commandsBeforeAba = await a.evaluate(
        "window.moduleCommands.length",
      );
      await click(a, choose("m001"));
      await until(() =>
        a.evaluate(ui("s.error.includes('changed while selecting')")),
      );
      assert.equal(
        await a.evaluate("window.moduleCommands.length"),
        commandsBeforeAba,
      );
      assert.deepEqual(await definition(), beforeAba);
      await textButton(a, "확인");
      // A conflict after durable staging rejects the whole application and the
      // new completion waiter, retaining the original arrays for review.
      await applyPicker(a);
      let conflictAdmission;
      a.on("Fetch.requestPaused", (event) => {
        conflictAdmission = event.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await click(a, choose("m004"));
      await until(() => conflictAdmission);
      const beforeConflict = await definition();
      const peerLore = [
        ...beforeConflict.globalLore,
        lore("Peer wins application conflict"),
      ];
      await b.evaluate(
        ui(
          `r().setField(${JSON.stringify(field)},${JSON.stringify(peerLore)})`,
        ),
      );
      await until(
        async () => (await definition()).globalLore,
        (actual) => isDeepStrictEqual(actual, peerLore),
      );
      await a.send("Fetch.continueRequest", { requestId: conflictAdmission });
      await a.send("Fetch.disable");
      await until(() =>
        a.evaluate(
          ui(
            "s.pending.some(e=>e.state==='blocked'&&e.command.edits?.length===3)&&!!s.error",
          ),
        ),
      );
      const afterConflict = await definition();
      assert.deepEqual(afterConflict.customscript, beforeConflict.customscript);
      assert.deepEqual(
        afterConflict.triggerscript,
        beforeConflict.triggerscript,
      );
      assert.deepEqual(afterConflict.globalLore, peerLore);
      assert.ok(
        !(await a.evaluate(
          "document.body.textContent.includes('Module is successfully applied')",
        )),
      );
      await textButton(a, "서버 값 사용");
      await textButton(a, "확인");
      await until(() => a.evaluate(ui("s.pending.length===0")));
      // Selection changes must not retarget the application to a different character.
      await select(a, "c", "chat-c", true);
      await applyPicker(a);
      const beforeNavigation = await definition();
      await select(a, "d", "chat-d", true);
      await click(a, choose("m002"));
      await until(
        async () =>
          (await definition()).globalLore.length ===
          beforeNavigation.globalLore.length + 1,
      );
      await closeSuccess(a);
      assert.equal((await definition("d")).globalLore.length, 1);
      // A converted module contains original mapped arrays/assets and marker lore,
      // never chat history; missing optional fields do not become invalid commands.
      await select(a, "c", "chat-c", true);
      const sourceBeforeConvert = await definition();
      const idsBefore = (await settings()).moduleIds;
      await click(a, "[data-runtime-character-module-action=convert] button");
      await until(
        async () =>
          (await settings()).moduleIds.length === idsBefore.length + 1,
      );
      await closeSuccess(a);
      const convertedId = (await settings()).moduleIds.find(
        (id) => !idsBefore.includes(id),
      );
      const converted = (
        await runtime.store.call("getResource", "module", convertedId)
      ).payload;
      assert.deepEqual(await definition(), sourceBeforeConvert);
      assert.equal(converted.name, sourceBeforeConvert.name);
      assert.equal(converted.description, sourceBeforeConvert.creatorNotes);
      assert.deepEqual(converted.regex, sourceBeforeConvert.customscript);
      assert.deepEqual(converted.trigger, sourceBeforeConvert.triggerscript);
      assert.deepEqual(converted.assets, sourceBeforeConvert.additionalAssets);
      assert.equal(
        converted.lorebook.length,
        sourceBeforeConvert.globalLore.length + 3,
      );
      assert.equal(
        converted.lorebook.at(-3).content,
        "@@indicator character_desc\n\n" + sourceBeforeConvert.desc,
      );
      assert.equal(
        converted.lorebook.at(-2).content,
        "@@indicator character_first_message\n\n<FM>\nAuthored greeting\n</FM>\n<FM_alt>\nAuthored alternate\n</FM_alt>",
      );
      assert.equal(
        converted.lorebook.at(-1).content,
        "@@indicator replace_global_note\n\n" +
          sourceBeforeConvert.replaceGlobalNote,
      );
      assert.ok(!("chats" in converted));
      assert.ok(!("moduleNamespace" in converted));
      await b.evaluate(ui("r().loadLibrary('module')"));
      await b.evaluate(
        ui(
          `r().loadLibrary('module',${JSON.stringify(sourceBeforeConvert.name)})`,
        ),
      );
      await until(() =>
        b.evaluate(
          ui(
            `s.libraries.module.some(m=>m.id===${JSON.stringify(convertedId)})`,
          ),
        ),
      );
      // Open the real chat menu via its original composer menu button.
      const chatPicker = async (page) => {
        await select(page);
        await until(() =>
          page.evaluate(
            "(()=>{const e=document.querySelector('button.rounded-r-md svg.lucide-menu')?.closest('button');if(!e)return false;e.click();return true})()",
          ),
        );
        await until(() =>
          page.evaluate(
            "(()=>{const e=document.querySelector('svg.lucide-package')?.closest('div');if(!e)return false;e.click();return true})()",
          ),
        );
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-module-picker]')",
          ),
        );
      };
      await chatPicker(a);
      await chatPicker(b);
      await click(a, choose("m001", "toggle"));
      await until(async () => (await metadata()).modules.includes("m001"));
      await until(() =>
        b.evaluate(
          `${JSON.stringify(choose("m001", "toggle"))}&&document.querySelector(${JSON.stringify(choose("m001", "toggle"))})?.className.includes('text-blue-500')`,
        ),
      );
      assert.deepEqual((await metadata("chat-c2")).modules, []);
      await a.evaluate(
        `document.querySelector(${JSON.stringify(choose("m002", "toggle"))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
      );
      await until(async () => (await definition()).modules.includes("m002"));
      await until(() =>
        b.evaluate(
          `document.querySelector(${JSON.stringify(choose("m002", "toggle"))})?.className.includes('text-violet-500')`,
        ),
      );
      // A globally enabled module remains disabled in the per-chat picker.
      await b.evaluate(
        ui(
          "r().setField({scope:'resource',resourceKind:'settings',entityId:'global',key:'enabledModules'},['m003'])",
        ),
      );
      await until(() =>
        a.evaluate(
          "document.querySelector('[data-module-picker-id=m003] button')?.disabled",
        ),
      );
      assert.ok(!(await metadata()).modules.includes("m003"));
      // Competing same-field drafts retain an explicit conflict, with no partial write.
      let held;
      a.on("Fetch.requestPaused", (event) => {
        held = event.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await click(a, choose("m004", "toggle"));
      await until(() => held);
      await click(b, choose("m005", "toggle"));
      await until(async () => (await metadata()).modules.includes("m005"));
      await a.send("Fetch.continueRequest", { requestId: held });
      await a.send("Fetch.disable");
      await until(() =>
        a.evaluate(
          ui(
            "s.pending.some(e=>e.state==='blocked'&&e.command.type==='change-fields')",
          ),
        ),
      );
      assert.ok(!(await metadata()).modules.includes("m004"));
      await textButton(a, "서버 값 사용");
      await until(() => a.evaluate(ui("s.pending.length===0")));
      assert.ok((await metadata()).modules.includes("m005"));
      // Durable offline chat membership survives every browser target closing.
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await click(a, choose("m006", "toggle"));
      await until(() =>
        a.evaluate(
          ui(
            "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(f=>f.key==='modules'&&f.value?.includes('m006')))",
          ),
        ),
      );
      assert.ok(!(await metadata()).modules.includes("m006"));
      await a.close();
      await b.close();
      a = b = undefined;
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await until(async () => (await metadata()).modules.includes("m006"));
      assert.equal(
        (await metadata()).modules.filter((id) => id === "m006").length,
        1,
      );
      // A staged three-field application also survives closing all observing
      // tabs before HTTP admission; no success notice is invented on reload.
      await select(a, "c", "chat-c", true);
      await applyPicker(a);
      const beforeExit = await definition();
      let exitAdmission;
      a.on("Fetch.requestPaused", (event) => {
        exitAdmission = event.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await click(a, choose("m007"));
      await until(() => exitAdmission);
      await until(() =>
        a.evaluate(
          ui(
            "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.length===3)",
          ),
        ),
      );
      assert.deepEqual(await definition(), beforeExit);
      await a.close();
      await b.close();
      a = b = undefined;
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      await until(
        async () =>
          (await definition()).globalLore.length ===
          beforeExit.globalLore.length + 1,
      );
      const afterExit = await definition();
      assert.deepEqual(afterExit.globalLore.at(-1), lore("Module m007"));
      assert.deepEqual(afterExit.customscript.at(-1), regex("Module m007"));
      assert.deepEqual(afterExit.triggerscript.at(-1), trigger("Module m007"));
      await chatPicker(b);
      await until(() =>
        b.evaluate(
          `document.querySelector(${JSON.stringify(choose("m006", "toggle"))})?.className.includes('text-blue-500')`,
        ),
      );
      const allConverted = (await settings()).moduleIds.filter(
        (id) => !idsBefore.includes(id),
      );
      assert.deepEqual(allConverted, [convertedId]);
      assert.equal(
        (await runtime.store.call("snapshot", "chat-c")).messages.length,
        0,
      );
      assert.deepEqual(browserExceptions, []);
      console.log(
        JSON.stringify({
          layout: options.name,
          catalogFirstPage: 50,
          catalogFull: 61,
          catalogBodyReadsBeforeSelection: 0,
          selectedBodyReads: 1,
          atomicApplication: true,
          mappedConversionRetained: true,
          sourceUnchangedOnConversion: true,
          pickerOwnerCaptured: true,
          peerAbaRejected: true,
          chatAndCharacterMembershipShared: true,
          sameFieldConflictVisible: true,
          stagedApplicationConflictAtomic: true,
          successWaitsForProjection: true,
          stagedApplicationAllTabsExitReplay: true,
          allTabsOfflineReplay: true,
          realProviderRequests: 0,
          physicalPhone: false,
        }),
      );
    },
  );
