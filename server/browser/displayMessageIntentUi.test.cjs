"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
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
  throw Error("Message intent condition timed out: " + JSON.stringify(value));
}

for (const withLua of [false, true])
  test(
    "original @@inject admits its own stable message from partial history with deleted position gaps" +
      (withLua ? " and atomic Lua effects" : " without Lua"),
    { timeout: 120000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-display-message-"));
      const file = join(directory, "synthetic.sqlite");
      const raw = "Synthetic source {{getvar::inject_value}} [INJECT]";
      const expected = "Synthetic source confirmed [INJECT]";
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
      const seed = new EntityStore(file);
      try {
        seed.applyCommand("settings", {
          type: "put-resource",
          kind: "settings",
          resourceId: "global",
          expectedRevision: 0,
          payload: {
            didFirstSetup: true,
            language: "en",
            autoTranslate: false,
          },
        });
        seed.applyCommand("character", {
          type: "create-character",
          characterId: "c",
          chat: { chatId: "a", metadata: { name: "Synthetic inject chat" } },
          definition: {
            type: "character",
            name: "Synthetic inject fixture",
            desc: "Synthetic",
            firstMessage: "Synthetic greeting",
            customscript: [
              { in: "\\[INJECT\\]", out: "@@inject", type: "editdisplay" },
            ],
            triggerscript: withLua
              ? [
                  {
                    type: "manual",
                    conditions: [],
                    effect: [
                      {
                        type: "triggerlua",
                        code: `listenEdit('editDisplay',function(id,data)
            if string.find(data,'Synthetic source',1,true) then
              local n=tonumber(getChatVar(id,'inject_counter') or '0')+1
              setChatVar(id,'inject_counter',tostring(n))
              return 'Synthetic source '..getChatVar(id,'inject_value')..' [INJECT]'
            end
            return data
          end)`,
                      },
                    ],
                  },
                ]
              : [],
          },
        });
        for (let i = 0; i < 112; i++)
          seed.applyCommand("append-" + i, {
            type: "append-message",
            chatId: "a",
            messageId: "m-" + i,
            message: {
              role: "char",
              data: i === 111 ? raw : "Synthetic message " + i,
            },
          });
        seed.applyCommand("variable", {
          type: "change-variables",
          edits: [
            {
              scope: "chat",
              chatId: "a",
              key: "$inject_value",
              expectedRevision: 0,
              value: "confirmed",
            },
            ...(withLua
              ? [
                  {
                    scope: "chat",
                    chatId: "a",
                    key: "$inject_counter",
                    expectedRevision: 0,
                    value: "0",
                  },
                ]
              : []),
          ],
        });
        seed.enqueueJob("delete-gaps", { type: "button", chatId: "a" });
        const { job, snapshot } = seed.claimJob("synthetic-owner");
        seed.finishJob(job.id, "synthetic-owner", job.fence, {
          state: "completed",
          writeSet: {
            chatId: "a",
            expectedRevision: snapshot.chat.revision,
            deleteMessages: [2, 5].map((i) => ({
              id: "m-" + i,
              expectedRevision: 1,
            })),
          },
        });
      } finally {
        seed.close();
      }
      const origins = [];
      runtime = await createRuntimeService({
        file,
        origins,
        eventsPollMs: 20,
        scheduler: { pollMs: 600000 },
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
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      await frontend.listen();
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      browser = await launchChromium(directory);
      const firstContext = await browser.newContext();
      const page = await browser.page(url, firstContext, {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      await until(() =>
        page.evaluate(
          '!!document.querySelector("[data-runtime-ready=\\"true\\"]")',
        ),
      );
      await until(() =>
        page.evaluate('!!document.querySelector("[data-character-id=c]")'),
      );
      await page.evaluate(
        'document.querySelector("[data-character-id=c]").click()',
      );
      await until(() =>
        page.evaluate(
          ui(
            "r().captureDisplay(99,false,'c','m-111')?.chat.scriptstate.$inject_value==='confirmed'",
          ),
        ),
      );
      const captured = await page.evaluate(
        ui(
          "(()=>{const c=r().captureDisplay(99,false,'c','m-111');return {loaded:c.chat.message.length,hasEarlier:c.hasEarlier,count:c.history.count,ordinal:c.history.ordinal,messageId:c.message.id,revision:c.message.revision}})()",
        ),
      );
      const { revision, ...scope } = captured;
      assert.deepEqual(scope, {
        loaded: 100,
        hasEarlier: true,
        count: 110,
        ordinal: 109,
        messageId: "m-111",
      });
      assert.ok(
        revision === 1 || revision === 2,
        "Original UI may already have admitted its own source before this explicit parser check",
      );
      const parsed = await page.evaluate(`(async()=>{
    const {ParseMarkdown,risuChatParser}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    const character=getCurrentCharacter(),presentation={};
    const input=risuChatParser(${JSON.stringify(raw)},{chara:character.name,chatID:99,rmVar:true,visualize:true,cbsConditions:{messageId:'m-111'}},presentation);
    try{return {input,html:await ParseMarkdown(input,character,'normal',99,{messageId:'m-111'},presentation)}}
    catch(error){return {input,error:String(error.message??error)}}
  })()`);
      if (!parsed.error)
        await until(async () => {
          const message = (
            await runtime.store.call("snapshot", "a")
          ).messages.find((m) => m.id === "m-111");
          return message?.message.data === expected && message.revision === 2;
        });
      const stored = (await runtime.store.call("snapshot", "a")).messages.find(
        (m) => m.id === "m-111",
      );
      const observed = {
        syntheticOnly: true,
        originalUi: true,
        actualIdbAndSQLite: true,
        hotModuleReload: false,
        actualMobileOS: false,
        captured,
        parsed,
        stored,
        expectedStored: expected,
        runtimeError: await page.evaluate(ui("s.error")),
        sourceHashes: {},
      };
      assert.equal(stored.message.data, expected);
      assert.equal(stored.revision, 2);
      assert.equal(parsed.error, undefined);
      const initialChanges = (await runtime.store.call("changes", 0, 1000))
        .changes;
      const rewrite = initialChanges.filter(
        (e) => e.type === "message" && e.id === "m-111" && e.revision === 2,
      );
      assert.equal(rewrite.length, 1);
      assert.equal(
        stored.displayOrigin.displayKey,
        rewrite[0].payload.displayEffectId,
      );
      if (withLua) {
        const counter = (
          await runtime.store.call("snapshot", "a")
        ).variables.find((v) => v.key === "$inject_counter");
        assert.equal(counter.value, "1");
        assert.equal(counter.revision, 2);
        const variable = initialChanges.find(
          (e) =>
            e.type === "variable" &&
            e.payload.key === "$inject_counter" &&
            e.revision === 2,
        );
        assert.equal(
          variable.payload.displayEffectId,
          rewrite[0].payload.displayEffectId,
        );
        observed.atomicCounter = counter;
      }
      const second = await browser.page(url, await browser.newContext(), {
        blockHttps: true,
        viewport: { width: 390, height: 844 },
      });
      const open = async (target) => {
        await until(() =>
          target.evaluate(
            '!!document.querySelector("[data-runtime-ready=\\"true\\"]")',
          ),
        );
        await until(() =>
          target.evaluate('!!document.querySelector("[data-character-id=c]")'),
        );
        await target.evaluate(
          'document.querySelector("[data-character-id=c]").click()',
        );
        await until(() =>
          target.evaluate(
            ui(
              "r().captureDisplay(99,false,'c','m-111')?.message.revision===2",
            ),
          ),
        );
        return target.evaluate(
          ui(
            "(()=>{const c=r().captureDisplay(99,false,'c','m-111');return {origin:c.message.origin,text:c.sourceContent,counter:c.chat.scriptstate.$inject_counter??null}})()",
          ),
        );
      };
      observed.otherDevice = await open(second);
      assert.deepEqual(observed.otherDevice.origin, stored.displayOrigin);
      assert.equal(observed.otherDevice.text, expected);
      if (withLua) assert.equal(observed.otherDevice.counter, "1");
      await second.evaluate("location.reload();true");
      observed.reloaded = await open(second);
      assert.deepEqual(observed.reloaded, observed.otherDevice);
      // Wait for actual default UI work to drain before verifying no derived echo.
      await until(() => second.evaluate(ui("s.pending.length===0")));
      await delay(200);
      const final = await runtime.store.call("snapshot", "a");
      assert.equal(final.messages.find((m) => m.id === "m-111").revision, 2);
      if (withLua)
        assert.equal(
          final.variables.find((v) => v.key === "$inject_counter").revision,
          2,
        );
      const finalChanges = (await runtime.store.call("changes", 0, 1000))
        .changes;
      assert.equal(
        finalChanges.filter(
          (e) => e.type === "message" && e.id === "m-111" && e.revision > 1,
        ).length,
        1,
      );
      observed.withLua = withLua;
      observed.rewriteCount = 1;
      if (!withLua) {
        await runtime.store.call("applyCommand", "lifecycle-source", {
          type: "append-message",
          chatId: "a",
          messageId: "m-lifecycle",
          message: { role: "char", data: "Synthetic stored lifecycle" },
        });
        await until(() =>
          page.evaluate(
            ui("!!r().captureDisplay(100,false,'c','m-lifecycle')"),
          ),
        );
        const prepare = async (text) =>
          page.evaluate(`(async()=>{
          const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
          const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
          const presentation={};const html=await ParseMarkdown(${JSON.stringify(text)},getCurrentCharacter(),'notrim',100,{messageId:'m-lifecycle'},presentation);
          window.sourceLifecycle={presentation,html};return {html,hasFinalizer:typeof presentation.finalize==='function'};
        })()`);
        const sourceRow = async () =>
          (await runtime.store.call("snapshot", "a")).messages.find(
            (m) => m.id === "m-lifecycle",
          );
        const deferred = "Synthetic deferred [INJECT]";
        observed.cancelled = await prepare(deferred);
        assert.equal(
          await page.evaluate(
            "window.sourceLifecycle.presentation.finalize(window.sourceLifecycle.html,()=>false)",
          ),
          undefined,
        );
        assert.equal((await sourceRow()).revision, 1);
        const css = Buffer.from(
          ".source-history{content:'{{history::role}}';}",
        ).toString("hex");
        await prepare(deferred + " <risu-style>" + css + "</risu-style>");
        const failure = await page.evaluate(
          `(async()=>{try{await window.sourceLifecycle.presentation.finalize(window.sourceLifecycle.html,()=>true);return null;}catch(error){return String(error.message??error)}})()`,
        );
        assert.match(failure, /unloaded history/);
        assert.equal((await sourceRow()).revision, 1);
        observed.laterCssFailure = failure;
        await prepare(deferred);
        await page.evaluate(
          ui(`(()=>{
          const client=r().client,original=client.request.bind(client),gate=new Promise(resolve=>window.releaseSourceRequest=resolve);
          client.request=(path,options)=>{
            if(String(path).endsWith('/commands')&&options?.method==='POST'&&String(options.body).includes('m-lifecycle')){
              window.sourceRequestStarted=true;return gate.then(()=>original(path,options));
            }return original(path,options);
          };return true;
        })()`),
        );
        await page.evaluate(
          "window.sourceLifecycle.presentation.finalize(window.sourceLifecycle.html,()=>true)",
        );
        await until(() => page.evaluate("window.sourceRequestStarted===true"));
        observed.durableBeforeExit = await page.evaluate(
          ui(
            "s.pending.filter(e=>e.command.messageEdits?.[0]?.messageId==='m-lifecycle').map(e=>({requestId:e.requestId,command:JSON.parse(JSON.stringify(e.command))}))",
          ),
        );
        assert.equal(observed.durableBeforeExit.length, 1);
        assert.deepEqual(observed.durableBeforeExit[0].command.messageEdits, [
          { messageId: "m-lifecycle", expectedRevision: 1, text: deferred },
        ]);
        assert.equal((await sourceRow()).revision, 1);
        await page.close();
        const reopened = await browser.page(url, firstContext, {
          blockHttps: true,
          viewport: { width: 1280, height: 900 },
        });
        await open(reopened);
        observed.afterTabExit = await until(
          sourceRow,
          (m) => m.revision === 2 && m.message.data === deferred,
        );
        await until(() => reopened.evaluate(ui("s.pending.length===0")));
        const events = (await runtime.store.call("changes", 0, 1000)).changes;
        assert.equal(
          events.filter(
            (e) =>
              e.type === "message" && e.id === "m-lifecycle" && e.revision > 1,
          ).length,
          1,
        );
      }
      for (const path of [
        "src/ts/process/scriptRuntime.ts",
        "src/ts/process/scriptRuntime.test.ts",
        "src/ts/process/scripts.ts",
        "src/ts/runtime/canonicalDisplayHistory.ts",
        "src/ts/runtime/displayCbsScope.ts",
        "src/ts/runtime/displayEffects.ts",
        "src/ts/runtime/displayReadDependencies.ts",
        "src/ts/runtime/displayLuaContext.ts",
        "src/ts/runtime/browserDisplayLua.ts",
        "src/ts/runtime/browserRuntimeController.svelte.ts",
        "src/ts/runtime/risuReadModel.ts",
        "src/ts/runtime/displayScopeCache.svelte.ts",
        "src/ts/runtime/executionContext.ts",
        "src/ts/process/scriptings.ts",
        "src/ts/parser/parser.svelte.ts",
        "src/lib/ChatScreens/Chat.svelte",
        "src/lib/ChatScreens/ChatBody.svelte",
        "server/entity/displayEffects.cjs",
        "server/entity/store.cjs",
        "server/entity/schema.sql",
        "server/browser/displayMessageIntentUi.test.cjs",
      ])
        observed.sourceHashes[path] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      if (process.env.RISU_DISPLAY_MESSAGE_OUTPUT)
        await writeFile(
          process.env.RISU_DISPLAY_MESSAGE_OUTPUT +
            (withLua ? ".lua.json" : ".regex.json"),
          JSON.stringify(observed, null, 2) + "\n",
        );
      t.diagnostic(
        JSON.stringify({ captured, parsed, stored, expectedStored: expected }),
      );
      assert.equal(
        stored.message.data,
        expected,
        "The original processed pre-removal text must reach its stable message ID",
      );
      assert.equal(stored.revision, 2);
      assert.equal(parsed.error, undefined);
    },
  );
