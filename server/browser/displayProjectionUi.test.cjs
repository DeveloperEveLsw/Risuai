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
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Projection condition timed out: " + JSON.stringify(result));
}
const probe = "Synthetic projection probe";
const ownedSource =
  '<span id="projection-owner">Synthetic owner prefix<input id="projection-local-input" value="initial"></span>';

test(
  "original display waits for canonical projection before pinning a new input clock or saving effects from stale defaults",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-projection-"));
    let runtime, frontend, browser, a;
    t.after(async () => {
      if (a) {
        try {
          await a.evaluate("(window.releaseProjectionGate?.(),true)");
        } catch {}
      }
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
    const settings = {
      didFirstSetup: true,
      language: "en",
      autoTranslate: false,
      templateDefaultVariables: "choice=before",
    };
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: settings,
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic chat" } },
      definition: {
        type: "character",
        name: "Synthetic projection",
        desc: "Synthetic",
        defaultVariables: "",
        firstMessage: "Synthetic greeting",
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `listenEdit('editDisplay', function(id,data)
          if data ~= '${probe}' then return data end
          local choice=getChatVar(id,'choice')
          setChatVar(id,'observed',choice)
          return data .. ':' .. choice
        end)`,
              },
            ],
          },
        ],
      },
    });
    await runtime.store.call("applyCommand", "owner-message", {
      type: "append-message",
      chatId: "a",
      messageId: "owner",
      message: { role: "char", data: ownedSource },
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
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1280, height: 900 },
        blockHttps: true,
      });
      const diagnostics = [];
      page.on("Runtime.exceptionThrown", (event) =>
        diagnostics.push(
          event.exceptionDetails?.exception?.description ??
            event.exceptionDetails?.text,
        ),
      );
      page.on("Runtime.consoleAPICalled", (event) => {
        if (event.type === "error")
          diagnostics.push(
            event.args.map((arg) => arg.value ?? arg.description),
          );
      });
      try {
        await until(
          () =>
            page.evaluate(
              "!!document.querySelector('[data-runtime-ready=\"true\"]')",
            ),
          Boolean,
          90000,
        );
      } catch (error) {
        console.log(
          JSON.stringify({
            startupFailure: true,
            diagnostics,
            body: await page.evaluate("document.body.innerText.slice(0,3000)"),
            state: await page.evaluate(
              ui("({ready:s.ready,connection:s.connection,error:s.error})"),
            ),
          }),
        );
        throw error;
      }
      await until(() =>
        page.evaluate("!!document.querySelector('[data-character-id=c]')"),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      return page;
    };
    const pages = await Promise.all([open(), open()]);
    [a] = pages;
    const b = pages[1];
    await until(() =>
      a.evaluate("!!document.querySelector('#projection-local-input')"),
    );
    await a.evaluate(
      "window.projectionOldRow=document.querySelector('[data-message-id=owner]');window.projectionOldBody=window.projectionOldRow.querySelector('.chattext');window.projectionOldInput=document.querySelector('#projection-local-input');window.projectionOldInput.value='local typing retained';window.projectionOldInput.focus()",
    );

    const observed = async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$observed",
      ) ?? null;
    assert.equal(await observed(), null);
    await a.evaluate(
      ui(`(()=>{
      const controller=r(), original=controller.client.read.bind(controller.client);
      let armed=true,release;const blocked=new Promise(resolve=>release=resolve);
      window.projectionGateStarted=false;
      window.releaseProjectionGate=()=>release();
      controller.client.read=async(path,...args)=>{
        if(armed&&path==='/resources/settings/global') {
          armed=false;window.projectionGateStarted=true;await blocked;
        }
        return original(path,...args);
      };
      return true;
    })()`),
    );
    const resource = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await runtime.store.call("applyCommand", "changed-settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: resource.revision,
      payload: { ...settings, templateDefaultVariables: "choice=after" },
    });
    const serverState = await runtime.store.call("displayState", "a");
    await until(() => a.evaluate("window.projectionGateStarted"));
    await until(() =>
      b.evaluate(
        ui("r().model.database.templateDefaultVariables==='choice=after'"),
      ),
    );
    const before = await a.evaluate(
      ui(`(()=>{
      const controller=r(),capture=controller.captureDisplay(-1,false,'c');
      return {scopeReady:s.scopeReady,projectedCursor:controller.displayProjectedCursor,
        ledgerCursor:controller.display.state.cursor,inputClock:controller.display.state.inputClock,
        template:controller.model.database.templateDefaultVariables,
        capture:!!capture,capturedClock:capture?.state.inputClock,capturedTemplate:capture?.database.templateDefaultVariables};
    })()`),
    );
    assert.equal(before.template, "choice=before");
    assert.equal(before.inputClock, serverState.inputClock);
    assert.ok(
      before.projectedCursor < before.inputClock,
      "The controlled read must reproduce a real projection gap",
    );
    const during = await a.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const {RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');
      const output=await ParseMarkdown('${probe}',getCurrentCharacter(),'normal',-1);
      return JSON.parse(JSON.stringify({output,pending:s.pending.filter(e=>e.command.type==='apply-display-effects').map(e=>({requestId:e.requestId,inputClock:e.command.inputClock,edits:e.command.edits}))}));
    })()`);
    const ownedDuring = await a.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const p={current:()=>true};
      const raw=await ParseMarkdown(${JSON.stringify(ownedSource)},getCurrentCharacter(),'notrim',0,{messageId:'owner'},p);
      const finalized=await p.finalize(raw);
      return {raw,discarded:finalized===undefined,domRetained:window.projectionOldRow===document.querySelector('[data-message-id=owner]')&&window.projectionOldBody===window.projectionOldRow.querySelector('.chattext')&&window.projectionOldInput===document.querySelector('#projection-local-input')&&window.projectionOldInput.value==='local typing retained'};
    })()`);
    // Durable acceptance can run independently while this device's SSE projection waits.
    await delay(150);
    const duringStored = await observed();
    await a.evaluate("(window.releaseProjectionGate(),true)");
    await until(() =>
      a.evaluate(
        ui("r().model.database.templateDefaultVariables==='choice=after'"),
      ),
    );
    await until(
      () =>
        a.evaluate(ui("r().captureDisplay(-1,false,'c')?.state.inputClock")),
      (clock) => clock === serverState.inputClock,
    );
    const ownedAfter = await a.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const p={current:()=>true};
      const raw=await ParseMarkdown(${JSON.stringify(ownedSource)},getCurrentCharacter(),'notrim',0,{messageId:'owner'},p);
      return {raw,finalized:await p.finalize(raw)};
    })()`);
    const after = await a.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      return await ParseMarkdown('${probe}',getCurrentCharacter(),'normal',-1);
    })()`);
    await until(observed);
    await until(() =>
      b.evaluate(ui("r().model.activeChat.scriptstate.$observed")),
    );
    const finalStored = await observed();
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualController: true,
      actualLuaAndCbs: true,
      actualIdbAndServer: true,
      controlledRealResourceRead: true,
      actualMobileOS: false,
      hotModuleReload: false,
      serverClock: serverState.inputClock,
      before,
      during,
      duringStored,
      ownedDuring,
      ownedAfter,
      after,
      finalStored,
      otherDeviceTemplate: await b.evaluate(
        ui("r().model.database.templateDefaultVariables"),
      ),
      otherDeviceObserved: await b.evaluate(
        ui("r().model.activeChat.scriptstate.$observed"),
      ),
      controllerSha256: createHash("sha256")
        .update(
          await readFile("src/ts/runtime/browserRuntimeController.svelte.ts"),
        )
        .digest("hex"),
    };
    if (process.env.RISU_DISPLAY_PROJECTION_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_PROJECTION_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
    assert.equal(
      before.capture,
      false,
      "New clock must not be captured with old projected settings",
    );
    assert.match(during.output, /<p>Synthetic projection probe<\/p>/);
    assert.doesNotMatch(
      during.output,
      /projection probe:(before|after)/,
      "Lua must not run from an unprojected read scope",
    );
    assert.equal(
      duringStored,
      null,
      "A new input clock must not authorize an effect computed from old defaults",
    );
    assert.equal(
      ownedDuring.raw,
      "",
      "A live owning UI must defer discarded formatting while its canonical capture is unavailable",
    );
    assert.equal(ownedDuring.discarded, true);
    assert.equal(ownedDuring.domRetained, true);
    assert.match(ownedAfter.raw, /projection-owner/);
    assert.match(ownedAfter.finalized, /projection-owner/);
    assert.match(after, /Synthetic projection probe:after/);
    assert.equal(finalStored.value, "after");
    assert.equal(result.otherDeviceObserved, "after");
  },
);
