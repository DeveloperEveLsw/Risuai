"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
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
  throw Error(
    "Definition editor condition timed out: " + JSON.stringify(value),
  );
}
const ui = (code) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${code}})()`;
async function write(page, selector, value) {
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
  );
  await page.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}
for (const options of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${options.name}: original advanced character controls persist field drafts with atomic greeting selection, peer conflicts and all-tab offline replay`,
    { timeout: 180000 },
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "risu-definition-editor-"),
      );
      let runtime, frontend, browser, a, b;
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              teardownText: await a
                .evaluate("document.body.textContent.slice(-1500)")
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
          showUnrecommended: true,
          betaMobileGUI: options.beta,
        },
      });
      for (const id of ["c", "d"])
        await runtime.store.call("applyCommand", "create-" + id, {
          type: "create-character",
          characterId: id,
          chat: {
            chatId: "chat-" + id,
            metadata: { name: "Authored definition test", fmIndex: 1 },
          },
          definition: {
            type: "character",
            name: "Synthetic definition " + id,
            desc: "Authored neutral fixture",
            firstMessage: "Synthetic greeting",
            systemPrompt: "Synthetic system",
            creatorNotes: "Plain authored notes",
            removedQuotes: true,
            alternateGreetings: [
              "First authored greeting",
              "Second authored greeting",
            ],
            bias: [["SEED", 0]],
            ...(id === "c"
              ? {
                  additionalData: {
                    creator: "Original author",
                    character_version: "v1",
                    syntheticUnknown: { retained: true },
                  },
                  depth_prompt: {
                    depth: 2,
                    prompt: "Original depth",
                    syntheticUnknown: "retained",
                  },
                }
              : {}),
            syntheticUnknown: { retained: true },
          },
        });
      await runtime.store.call("applyCommand", "second-chat", {
        type: "create-chat",
        characterId: "c",
        chatId: "chat-c2",
        metadata: { name: "Independent second chat", fmIndex: 0 },
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
      const open = async (context) => {
        const p = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
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
              "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await p.send("Page.navigate", { url });
        await until(() =>
          p.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
        );
        return p;
      };
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      const edit = async (page, id = "c", chat = "chat-c") => {
        await page.evaluate(
          `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.settingsOpen.set(false);const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter(${JSON.stringify(id)},${JSON.stringify(chat)});stores.botMakerMode.set(true);stores.sideBarStore.set(true);stores.MobileSideBar.set(2);stores.CharConfigSubMenu.set(2)})()`,
        );
        await until(() =>
          page.evaluate(
            "[...document.querySelectorAll('textarea')].some(e=>e.value==='Synthetic system')||!!document.querySelector('#runtime-definition-systemPrompt')",
          ),
        );
      };
      const character = async (id = "c") =>
        (await runtime.store.call("getCharacter", id)).definition;
      const chat = async (id = "chat-c") =>
        (await runtime.store.call("snapshot", id)).chat.metadata;
      await edit(a);
      await edit(b);
      if (process.env.RISU_DEFINITION_NEGATIVE === "TRUE") {
        await a.evaluate(
          "(()=>{const e=[...document.querySelectorAll('textarea')].find(e=>e.value==='Synthetic system');e.value='Local only change';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()",
        );
        await delay(200);
        assert.equal((await character()).systemPrompt, "Synthetic system");
        assert.ok(
          await a.evaluate(
            "[...document.querySelectorAll('textarea')].some(e=>e.value==='Local only change')",
          ),
        );
        assert.ok(
          await b.evaluate(
            "[...document.querySelectorAll('textarea')].some(e=>e.value==='Synthetic system')",
          ),
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
      const emulation = await a.evaluate(
        "(async()=>{const {MobileGUI:m,DBState:d}=await import('/src/ts/stores.svelte.ts');let mobileGui;const unsubscribe=m.subscribe(value=>mobileGui=value);unsubscribe();return {mobileGui,beta:d.db.betaMobileGUI,width:innerWidth,touch:navigator.maxTouchPoints,visible:document.querySelector('#runtime-definition-systemPrompt').getBoundingClientRect().width>0}})()",
      );
      assert.equal(emulation.mobileGui, options.beta);
      assert.equal(emulation.visible, true);
      if (options.mobile) {
        assert.equal(emulation.width, 390);
        assert.equal(emulation.touch, 5);
      }
      assert.equal(emulation.beta, options.beta);
      const before = await character();
      assert.equal(
        await a.evaluate(
          "document.querySelector('#runtime-definition-creatorNotes').value",
        ),
        "Plain authored notes",
      );
      await delay(150);
      await until(() => a.evaluate(ui("s.pending.length===0")));
      assert.deepEqual(
        await character(),
        before,
        "opening editors must not normalize notes or persist optional false defaults",
      );
      const commands = [];
      await a.send("Network.enable");
      a.on("Network.requestWillBeSent", (e) => {
        if (
          e.request.url.endsWith("/api/runtime/commands") &&
          e.request.postData
        )
          commands.push(JSON.parse(e.request.postData).command);
      });
      for (const key of [
        "systemPrompt",
        "exampleMessage",
        "replaceGlobalNote",
        "additionalText",
        "personality",
        "scenario",
        "defaultVariables",
        "translatorNote",
        "customModuleToggle",
        "nickname",
      ]) {
        const value = "Authored " + key;
        await write(a, "#runtime-definition-" + key, value);
        await until(character, (v) => v[key] === value);
        await until(
          () =>
            b.evaluate(
              `document.querySelector('#runtime-definition-${key}').value`,
            ),
          (v) => v === value,
        );
      }
      await write(
        a,
        "#runtime-definition-creatorNotes",
        "Revised authored notes",
      );
      await until(
        character,
        (v) =>
          v.creatorNotes.includes("Revised authored notes") &&
          v.removedQuotes === false,
      );
      assert.ok(
        commands.some(
          (c) =>
            c.type === "change-fields" &&
            c.edits.some((e) => e.key === "creatorNotes") &&
            c.edits.some((e) => e.key === "removedQuotes"),
        ),
        "note edit and quote reset must be atomic",
      );
      await until(
        () =>
          b.evaluate(
            "document.querySelector('#runtime-definition-creatorNotes').value",
          ),
        (v) => v === "Revised authored notes",
      );
      await write(a, "#runtime-definition-creator", "Revised author");
      await until(
        character,
        (v) => v.additionalData.creator === "Revised author",
      );
      await write(a, "#runtime-definition-version", "v2");
      await until(
        character,
        (v) => v.additionalData.character_version === "v2",
      );
      await write(a, "#runtime-definition-depth", 7);
      await until(character, (v) => v.depth_prompt.depth === 7);
      await write(a, "#runtime-definition-depth-prompt", "Revised depth");
      await until(character, (v) => v.depth_prompt.prompt === "Revised depth");
      assert.deepEqual((await character()).additionalData.syntheticUnknown, {
        retained: true,
      });
      assert.equal(
        (await character()).depth_prompt.syntheticUnknown,
        "retained",
      );
      await write(
        a,
        "[data-definition-bias] tbody tr:nth-child(2) input[type=text]",
        "TOKEN",
      );
      await write(
        a,
        "[data-definition-bias] tbody tr:nth-child(2) input[type=number]",
        42,
      );
      await until(
        character,
        (v) => v.bias[0][0] === "TOKEN" && v.bias[0][1] === 42,
      );
      await a.evaluate(
        "document.querySelector('[data-definition-bias] th button').click()",
      );
      await until(character, (v) => v.bias.length === 2);
      await a.evaluate(
        "document.querySelector('[data-definition-bias] tbody tr:last-child button').click()",
      );
      await until(character, (v) => v.bias.length === 1);
      for (const name of [
        "Low Level Access",
        "Hide Icon UI",
        "Utility Bot",
        "Escape Output",
      ]) {
        await until(() =>
          a.evaluate(
            `(()=>{const e=document.querySelector('[data-character-definition-settings] input[alt=${JSON.stringify(name)}]');if(!e)return false;e.click();return true})()`,
          ),
        );
      }
      await until(
        character,
        (v) =>
          v.lowLevelAccess === true &&
          v.hideChatIcon === true &&
          v.utilityBot === true &&
          v.escapeOutput === true,
      );
      await a.evaluate(
        "document.querySelector('[data-definition-greetings] th button').click()",
      );
      await until(character, (v) => v.alternateGreetings.length === 3);
      await write(
        a,
        "[data-definition-greetings] tbody tr:last-child textarea",
        "Third authored greeting",
      );
      await until(
        character,
        (v) => v.alternateGreetings[2] === "Third authored greeting",
      );
      await a.evaluate(
        "document.querySelector('[data-definition-greetings] tbody tr:last-child [data-greeting-action=up]').click()",
      );
      await until(
        character,
        (v) => v.alternateGreetings[1] === "Third authored greeting",
      );
      await a.evaluate(
        "document.querySelector('[data-definition-greetings] tbody tr:nth-child(3) [data-greeting-action=down]').click()",
      );
      await until(
        character,
        (v) => v.alternateGreetings[2] === "Third authored greeting",
      );
      await until(() => a.evaluate(ui("s.pending.length===0")));
      assert.equal((await chat()).fmIndex, 1);
      await a.evaluate(
        "document.querySelector('[data-definition-greetings] tbody tr:last-child [data-greeting-action=remove]').click()",
      );
      await until(character, (v) => v.alternateGreetings.length === 2);
      await until(chat, (v) => v.fmIndex === -1);
      assert.ok(
        commands.some(
          (c) =>
            c.type === "change-fields" &&
            c.edits.length === 2 &&
            c.edits.some(
              (e) => e.key === "alternateGreetings" && e.scope === "character",
            ) &&
            c.edits.some(
              (e) =>
                e.key === "fmIndex" &&
                e.scope === "chat" &&
                e.entityId === "chat-c" &&
                e.value === -1,
            ),
        ),
        "greeting removal and selected chat reset require one transaction",
      );
      assert.equal((await chat("chat-c2")).fmIndex, 0);
      assert.equal((await chat("chat-d")).fmIndex, 1);
      // Different fields can be edited concurrently without replacing other values.
      await until(() => a.evaluate(ui("s.pending.length===0")));
      await until(() => b.evaluate(ui("s.pending.length===0")));
      await Promise.all([
        write(a, "#runtime-definition-systemPrompt", "Concurrent system"),
        write(b, "#runtime-definition-exampleMessage", "Concurrent example"),
      ]);
      await until(
        character,
        (v) =>
          v.systemPrompt === "Concurrent system" &&
          v.exampleMessage === "Concurrent example",
      );
      // Same-field losers retain a private visible draft, then resolve explicitly.
      let held;
      a.on("Fetch.requestPaused", (e) => {
        held = e.requestId;
      });
      await a.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*/api/runtime/commands", requestStage: "Request" },
        ],
      });
      await write(a, "#runtime-definition-systemPrompt", "Losing local system");
      await until(() => held);
      await write(b, "#runtime-definition-systemPrompt", "Winning peer system");
      await until(character, (v) => v.systemPrompt === "Winning peer system");
      assert.equal(
        await a.evaluate(
          "document.querySelector('#runtime-definition-systemPrompt').value",
        ),
        "Losing local system",
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
      await until(
        () =>
          a.evaluate(
            "document.querySelector('#runtime-definition-systemPrompt').value",
          ),
        (v) => v === "Winning peer system",
      );
      // Durable offline field drafts survive closing every tab and replay once.
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await write(a, "#runtime-definition-depth-prompt", "Offline depth");
      await until(() =>
        a.evaluate(
          ui(
            "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(f=>f.key==='depth_prompt'&&f.value?.prompt==='Offline depth'))",
          ),
        ),
      );
      assert.equal((await character()).depth_prompt.prompt, "Revised depth");
      await a.close();
      await b.close();
      a = await open(contexts[0]);
      await until(character, (v) => v.depth_prompt.prompt === "Offline depth");
      await until(() => a.evaluate(ui("s.pending.length===0")));
      await edit(a);
      // Navigation in the input task must flush the captured old character.
      await a.evaluate(
        "(async()=>{const e=document.querySelector('#runtime-definition-nickname');e.value='Before character navigation';e.dispatchEvent(new Event('input',{bubbles:true}));await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('d')})()",
      );
      await until(
        character,
        (v) => v.nickname === "Before character navigation",
      );
      assert.equal((await character("d")).nickname, undefined);
      await until(() =>
        a.evaluate(
          "document.querySelector('#runtime-definition-creator')?.value===''",
        ),
      );
      const missingBefore = await character("d");
      await delay(100);
      assert.deepEqual(
        await character("d"),
        missingBefore,
        "opening absent nested fields must not persist default objects",
      );
      assert.equal(missingBefore.additionalData, undefined);
      assert.equal(missingBefore.depth_prompt, undefined);
      await write(a, "#runtime-definition-creator", "Created neutral metadata");
      await until(
        () => character("d"),
        (v) => v.additionalData?.creator === "Created neutral metadata",
      );
      await write(a, "#runtime-definition-depth", 3);
      await until(
        () => character("d"),
        (v) => v.depth_prompt?.depth === 3 && v.depth_prompt.prompt === "",
      );
      await edit(a);
      await a.evaluate(
        "(async()=>{const e=document.querySelector('#runtime-definition-defaultVariables');e.value='tone=before-chat-navigation';e.dispatchEvent(new Event('input',{bubbles:true}));await (await import('/src/ts/runtime/browserRuntimeState.svelte.ts')).browserRuntime().selectCharacter('c','chat-c2')})()",
      );
      await until(
        character,
        (v) => v.defaultVariables === "tone=before-chat-navigation",
      );
      assert.equal((await chat("chat-c2")).fmIndex, 0);
      await a.send("Page.reload");
      await until(() =>
        a.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      await edit(a);
      assert.equal(
        await a.evaluate(
          "document.querySelector('#runtime-definition-systemPrompt').value",
        ),
        "Winning peer system",
      );
      assert.equal(
        await a.evaluate(
          "document.querySelector('#runtime-definition-depth-prompt').value",
        ),
        "Offline depth",
      );
      assert.deepEqual((await character()).syntheticUnknown, {
        retained: true,
      });
      console.log(
        JSON.stringify({
          layout: options.name,
          mobileEmulation: options.mobile,
          betaBranch: options.beta,
          definitionFieldsStored: true,
          absentNestedFieldsOpenWithoutWrites: true,
          absentNestedFieldsCreatedOnEdit: true,
          plainNotesNotNormalizedOnOpen: true,
          optionalDefaultsNotSaved: true,
          notesAndQuoteResetAtomic: true,
          greetingRemovalAndChatResetAtomic: true,
          otherChatSelectionUnchanged: true,
          biasAddEditRemoveStored: true,
          greetingAddEditReorderRemoveStored: true,
          nestedUnknownFieldsPreserved: true,
          peerFieldsUpdated: true,
          differentFieldConcurrentEdits: true,
          sameFieldConflictVisible: true,
          offlineAllTabsExitReplay: true,
          characterNavigationFlushedOldStableId: true,
          chatNavigationFlushedOldStableId: true,
          reloadRetained: true,
          realDevices: false,
          realProviderRequests: 0,
        }),
      );
    },
  );
