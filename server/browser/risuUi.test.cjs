"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Risu UI condition timed out: " + JSON.stringify(last));
}
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;

test(
  "actual Risu application: scoped DBState, HTML buttons, stable streamed row, two devices and all-tab exit",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-ui-browser-"));
    let runtime, frontend, browser, provider, release;
    let gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const requests = [];
    t.after(async () => {
      release();
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      if (runtime) await runtime.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      calls++;
      res.setHeader("content-type", "text/event-stream");
      const delta = (text) =>
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: text } }] }) +
        "\n\n";
      res.write(delta("Synthetic partial"));
      await gate;
      res.end(delta(" final") + "data: [DONE]\n\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "state.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20, progressIntervalMs: 25 },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic UI fixture",
        supaMemory: false,
        syntheticUnused: "Synthetic unused character field ".repeat(8192),
        desc: "Synthetic",
        defaultVariables: "choice=open",
        customModuleToggle: "responsive=Synthetic fast toggle",
        firstMessage:
          '<button risu-btn="chosen">Choose</button><button risu-trigger="manual-choice" risu-id="manual">Manual</button> Choice: {{getvar::choice}}',
        triggerscript: [
          {
            comment: "Lua",
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: "function onButtonClick(id, data) setChatVar(id, 'choice', data) end",
              },
            ],
          },
          {
            comment: "manual-choice",
            type: "manual",
            conditions: [],
            effect: [
              { type: "setvar", var: "choice", operator: "=", value: "manual" },
            ],
          },
        ],
      },
    });
    for (const id of ["a", "b"])
      await runtime.store.call("applyCommand", "chat-" + id, {
        type: "create-chat",
        chatId: id,
        characterId: "c",
        metadata: {
          name: id,
          localLore: [],
          syntheticUnused: "Synthetic unused chat field ".repeat(8192),
          useLocallySetGlobalVariables: id === "b",
        },
      });
    await runtime.store.call("applyCommand", "old", {
      type: "append-message",
      chatId: "b",
      messageId: "unselected",
      message: { role: "char", data: "Synthetic unselected archive marker" },
    });
    await runtime.store.call("applyCommand", "asset-message", {
      type: "append-message",
      chatId: "a",
      messageId: "asset-fixture",
      message: {
        role: "char",
        data: '<img id="synthetic-asset" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSgAAAABJRU5ErkJggg=="><button id="synthetic-control">Unchanged control</button>',
      },
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        sendWithEnter: true,
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        forceReplaceUrl:
          "http://127.0.0.1:" +
          provider.address().port +
          "/v1/chat/completions",
        customTokenizer: "tik",
        useStreaming: true,
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic",
        jailbreak: "Synthetic optional section",
        jailbreakToggle: false,
        supaModelType: "gpt35",
        animationSpeed: 0.2,
        syntheticUnused: "Synthetic unused settings field ".repeat(8192),
        presetRegex: [
          {
            comment: "Synthetic editable script",
            in: "Synthetic pattern",
            out: "Synthetic replacement",
            type: "disabled",
            flag: "",
            extension: { keep: 1 },
          },
        ],
        nanogptKey: "synthetic-nano-key",
        nanogptUseSubscriptionEndpoint: true,
        nanogptSubscriptionState: "active",
        nanogptRequestModel: "synthetic-nano-model",
        nanogptRequestModelName: "Synthetic Nano Model",
        nanogptProvider: "synthetic-nano-provider",
        autoTranslate: false,
        language: "en",
      },
    });
    const { createServer: createViteServer } = await import("vite");
    frontend = await createViteServer({
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
    const frontUrl = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(frontUrl);
    browser = await launchChromium(directory);
    const context = await browser.newContext();
    const open = async (ctx) => {
      const page = await browser.page(frontUrl, ctx, {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(
        () =>
          page.evaluate(
            "document.querySelector('[data-runtime-ready=\"true\"]') !== null",
          ),
        Boolean,
        90000,
      );
      // Use the application's existing character navigation; generation uses its actual textarea.
      await until(() =>
        page.evaluate("!!document.querySelector('[data-character-id=c]')"),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() => page.evaluate(ui("s.scopeReady")));
      return page;
    };
    let a = await open(context),
      b = await open(await browser.newContext());
    assert.equal(
      await a.evaluate(
        "(async()=>{const {DBState}=await import('/src/ts/stores.svelte.ts');return JSON.stringify(DBState.db).includes('Synthetic unselected archive marker')})()",
      ),
      false,
    );
    const toggle =
      "document.querySelector('input[alt=\"Synthetic fast toggle\"]')";
    await until(() => a.evaluate(`!!${toggle}`));
    await a.evaluate(
      ui(
        "(()=>{const client=r().client;window.savedRequest=client.request;client.request=async(...args)=>{if(window.blockCommands && args[1]?.method==='POST' && String(args[0]).endsWith('/commands'))throw new TypeError('Synthetic offline click');return window.savedRequest(...args)};window.blockCommands=true;return true})()",
      ),
    );
    const start = await a.evaluate("performance.now()");
    await a.evaluate(`${toggle}.click()`);
    await until(() => a.evaluate(`${toggle}.checked`));
    const elapsed = (await a.evaluate("performance.now()")) - start;
    assert.ok(
      elapsed < 1000,
      "selection must respond while command transport is unavailable",
    );
    assert.equal(
      await runtime.store.call(
        "getResource",
        "global-variable",
        "toggle_responsive",
      ),
      null,
    );
    await until(() =>
      a.evaluate(ui("s.pending.some(e=>e.command.type==='change-variables')")),
    );
    await a.evaluate(`${toggle}.click()`);
    await until(() => a.evaluate(`!${toggle}.checked`));
    await a.evaluate(`${toggle}.click()`);
    await until(() => a.evaluate(`${toggle}.checked`));
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.filter(e=>e.command.type==='change-variables').length===3",
        ),
      ),
    );
    // Another independent device commits a different final selection while the first is offline.
    await b.evaluate(`${toggle}.click()`);
    await until(() => b.evaluate(ui("s.pending.length===0")));
    await b.evaluate(`${toggle}.click()`);
    await until(
      () =>
        runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        ),
      (value) => value?.revision === 2 && value.payload === "0",
    );
    await a.evaluate("window.blockCommands=false");
    await until(() => a.evaluate(ui("s.pending.some(e=>e.state==='blocked')")));
    await until(() => a.evaluate(`!${toggle}.checked`));
    await a.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='서버 값 사용').click()",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await a.evaluate(`${toggle}.click()`);
    await until(
      () =>
        runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        ),
      (value) => value?.revision === 3 && value.payload === "1",
    );
    await until(() => b.evaluate(`${toggle}.checked`));
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await a.evaluate("window.blockCommands=true");
    await a.evaluate(`${toggle}.click()`);
    await until(() => a.evaluate(`!${toggle}.checked`));
    await a.evaluate(`${toggle}.click()`);
    await until(() => a.evaluate(`${toggle}.checked`));
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.filter(e=>e.command.type==='change-variables').length===2",
        ),
      ),
    );
    await b.evaluate(`${toggle}.click()`);
    await until(
      () =>
        runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        ),
      (value) => value?.revision === 4 && value.payload === "0",
    );
    await a.evaluate("window.blockCommands=false");
    await until(() => a.evaluate(ui("s.pending.some(e=>e.state==='blocked')")));
    await a.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='내 변경 적용').click()",
    );
    await until(
      () =>
        runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        ),
      (value) => value?.revision === 5 && value.payload === "1",
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(() => b.evaluate(`${toggle}.checked`));
    // Navigation is fixture setup here; the actual original checkbox and pin button perform the changes.
    await a.evaluate(ui("r().selectCharacter('c','b')"));
    await until(() => a.evaluate(`${toggle}.checked`));
    await a.evaluate(`${toggle}.click()`);
    await until(
      () =>
        runtime.store.call("readVariables", [
          { scope: "chat-global", chatId: "b", key: "toggle_responsive" },
        ]),
      (value) => value.variables[0].value === "0",
    );
    assert.equal(
      (
        await runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        )
      ).revision,
      5,
    );
    await until(() =>
      a.evaluate(`!!${toggle}.closest('label').querySelector('button')`),
    );
    await a.evaluate(
      `${toggle}.closest('label').querySelector('button').click()`,
    );
    await until(() => a.evaluate(`${toggle}.checked`));
    await until(
      () =>
        runtime.store.call("readVariables", [
          { scope: "chat-global", chatId: "b", key: "toggle_responsive" },
        ]),
      (value) =>
        !value.variables[0].exists && value.variables[0].revision === 2,
    );
    await a.evaluate(ui("r().selectCharacter('c','a')"));
    console.log(
      "Original toggle responds with admission offline; three-click conflict chain resolves through the actual UI. Observed feedback including CDP polling: " +
        elapsed.toFixed(1) +
        "ms (synthetic desktop fixture).",
    );
    await until(() =>
      a.evaluate("!!document.querySelector('[risu-btn=chosen]')"),
    );
    await a.evaluate("document.querySelector('[risu-btn=chosen]').click()");
    await until(() =>
      b.evaluate("document.body.textContent.includes('Choice: chosen')"),
    );
    assert.equal(
      (await runtime.store.call("snapshot", "a")).variables.find(
        (v) => v.key === "$choice",
      ).value,
      "chosen",
    );
    await b.evaluate(
      "document.querySelector('[risu-trigger=manual-choice]').click()",
    );
    await until(() =>
      a.evaluate("document.body.textContent.includes('Choice: manual')"),
    );
    await until(() =>
      b.evaluate(
        "!!document.querySelector('#synthetic-asset') && !!document.querySelector('#synthetic-control')",
      ),
    );
    await b.evaluate(
      "window.savedAsset=document.querySelector('#synthetic-asset');window.savedControl=document.querySelector('#synthetic-control');true",
    );

    await a.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic user input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(() =>
      b.evaluate(ui("s.messages.some(m=>m.data==='Synthetic partial')")),
    );
    const progressId = await b.evaluate(
      ui("s.messages.find(m=>m.data==='Synthetic partial').chatId"),
    );
    await until(() =>
      b.evaluate(
        `!!document.querySelector('[data-message-id="${progressId}"]')`,
      ),
    );
    assert.equal(
      await b.evaluate(
        "window.savedAsset===document.querySelector('#synthetic-asset') && window.savedAsset.isConnected && window.savedControl===document.querySelector('#synthetic-control')",
      ),
      true,
    );
    await b.evaluate(
      `window.savedRow=document.querySelector('[data-message-id="${progressId}"]');true`,
    );
    const jobId = await a.evaluate(
      ui("s.jobs.find(j=>j.state==='running').id"),
    );
    // Keep an observer for the first finalization to prove row identity, then test a new job with all tabs closed.
    release();
    await until(() =>
      b.evaluate(ui("s.messages.some(m=>m.data==='Synthetic partial final')")),
    );
    assert.equal(
      await b.evaluate(
        `window.savedRow===document.querySelector('[data-message-id="${progressId}"]') && window.savedRow.isConnected`,
      ),
      true,
    );
    assert.equal(
      (await runtime.store.call("getJob", jobId)).state,
      "completed",
    );
    assert.equal(calls, 1);
    await until(() =>
      a.evaluate(
        "(async()=>{const {doingChat}=await import('/src/ts/process/index.svelte.ts');let busy;const unsubscribe=doingChat.subscribe(value=>busy=value);unsubscribe();return !busy})()",
      ),
    );
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await a.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Second synthetic input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(
      () =>
        b.evaluate(
          ui(
            "({running:s.jobs.some(j=>j.state==='running'),partial:s.messages.some(m=>m.data==='Synthetic partial'),jobs:s.jobs.map(j=>({id:j.id,state:j.state,result:j.result})),pending:s.pending.map(e=>({id:e.requestId,state:e.state,type:e.command.type})),error:s.error})",
          ),
        ),
      (value) => value.running && value.partial,
    );
    const backgroundId = await a.evaluate(
      ui("s.jobs.find(j=>j.state==='running').id"),
    );
    await a.close();
    await b.close();
    assert.equal(calls, 2);
    release();
    await until(
      () => runtime.store.call("getJob", backgroundId),
      (job) => job.state === "completed",
    );
    const fresh = await open(context);
    assert.equal(
      await fresh.evaluate(
        ui("s.messages.filter(m=>m.chatId==='" + progressId + "').length"),
      ),
      1,
    );
    assert.equal(
      await fresh.evaluate(
        ui("s.messages.filter(m=>m.data==='Synthetic partial final').length"),
      ),
      2,
    );
    assert.equal(calls, 2);
    const confirmed = await runtime.store.call(
      "getResource",
      "global-variable",
      "toggle_responsive",
    );
    // A third call stays gated while the original per-chat toggle commits and another device sees it.
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await fresh.evaluate(ui("r().selectCharacter('c','b')"));
    await until(() => fresh.evaluate(`${toggle}.checked`));
    await fresh.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Concurrent toggle input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(() =>
      fresh.evaluate(
        ui(
          "s.jobs.some(j=>j.chatId==='b' && j.state==='running') && s.messages.some(m=>m.data==='Synthetic partial')",
        ),
      ),
    );
    const concurrentJob = await fresh.evaluate(
      ui("s.jobs.find(j=>j.chatId==='b' && j.state==='running').id"),
    );
    await fresh.evaluate(`${toggle}.click()`);
    await until(
      () =>
        runtime.store.call("readVariables", [
          { scope: "chat-global", chatId: "b", key: "toggle_responsive" },
        ]),
      (value) => value.variables[0].value === "0",
    );
    assert.equal(
      (await runtime.store.call("getJob", concurrentJob)).state,
      "running",
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-variables')"),
      ),
    );
    const observer = await open(await browser.newContext());
    await observer.evaluate(ui("r().selectCharacter('c','b')"));
    await until(() => observer.evaluate(`!${toggle}.checked`));
    assert.equal(
      (await runtime.store.call("getJob", concurrentJob)).state,
      "running",
    );
    // Original setting, character and chat controls confirm while generation retains its pinned snapshot.
    const fields = [
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "jailbreakToggle",
      },
      { scope: "character", entityId: "c", key: "supaMemory" },
      { scope: "chat", entityId: "b", key: "useLocallySetGlobalVariables" },
    ];
    await fresh.evaluate(
      ui(
        "(()=>{const client=r().client;const saved=client.request;window.fieldProjectionReads=[];client.request=async(...args)=>{if(!args[1]?.method||args[1]?.method==='GET'){const path=new URL(String(args[0]),location.origin).pathname;if(path.endsWith('/characters/c')||path.endsWith('/characters/c/chats')||path.endsWith('/resources/settings/global')||path.endsWith('/chats/b'))window.fieldProjectionReads.push(path)}return saved(...args)};return true})()",
      ),
    );
    const controls = ["Toggle Jailbreak", "Toggle SupaMemory", "Local Toggles"];
    for (const label of controls) {
      await until(() =>
        fresh.evaluate(`!!document.querySelector('input[alt="${label}"]')`),
      );
      await fresh.evaluate(
        `document.querySelector('input[alt="${label}"]').click()`,
      );
    }
    await until(async () => {
      const result = await runtime.store.call("readFields", fields);
      return result.fields.every((field, i) => field.value === (i !== 2));
    });
    assert.equal(
      (await runtime.store.call("getJob", concurrentJob)).state,
      "running",
    );
    for (let i = 0; i < controls.length; i++)
      await until(() =>
        observer.evaluate(
          `document.querySelector('input[alt="${controls[i]}"]')?.checked === ${i !== 2}`,
        ),
      );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(entry=>entry.command.type==='change-fields')"),
      ),
    );
    assert.deepEqual(await fresh.evaluate("window.fieldProjectionReads"), []);
    release();
    await until(
      () => runtime.store.call("getJob", concurrentJob),
      (value) => value.state === "completed",
    );
    assert.equal(
      (
        await runtime.store.call("readVariables", [
          { scope: "chat-global", chatId: "b", key: "toggle_responsive" },
        ])
      ).variables[0].value,
      "0",
    );
    assert.equal(calls, 3);
    const storedFields = await runtime.store.call("readFields", fields);
    assert.deepEqual(
      storedFields.fields.map((field) => field.value),
      [true, true, false],
    );
    // Offline field overlays do not mutate confirmed DBState; use the actual conflict buttons.
    await fresh.evaluate(
      ui(
        "(()=>{const client=r().client;window.fieldRequest=client.request;client.request=async(...args)=>{if(window.blockFields&&args[1]?.method==='POST'&&String(args[0]).endsWith('/commands'))throw new TypeError('Synthetic field offline');return window.fieldRequest(...args)};window.blockFields=true;return true})()",
      ),
    );
    const jailbreak =
      "document.querySelector('input[alt=\"Toggle Jailbreak\"]')";
    await fresh.evaluate(`${jailbreak}.click()`);
    await until(() => fresh.evaluate(`!${jailbreak}.checked`));
    assert.equal(
      await fresh.evaluate(ui("r().model.database.jailbreakToggle")),
      true,
    );
    await until(() =>
      fresh.evaluate(ui("s.pending.some(e=>e.command.type==='change-fields')")),
    );
    await fresh.evaluate(`${jailbreak}.click()`);
    await until(() => fresh.evaluate(`${jailbreak}.checked`));
    await observer.evaluate(`${jailbreak}.click()`);
    await until(
      async () =>
        (await runtime.store.call("readFields", [fields[0]])).fields[0]
          .value === false,
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.state==='blocked')",
        ),
      ),
    );
    await until(() => fresh.evaluate(`!${jailbreak}.checked`));
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='내 변경 적용').click()",
    );
    await until(
      async () =>
        (await runtime.store.call("readFields", [fields[0]])).fields[0]
          .value === true,
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    await until(() => observer.evaluate(`${jailbreak}.checked`));
    const settingsPage = (index, isOpen = true) =>
      `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.SettingsMenuIndex.set(${index});stores.settingsOpen.set(${isOpen});return true})()`;
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(settingsPage(11));
    await observer.evaluate(settingsPage(11));
    const sendControl =
      "document.querySelector('input[alt=\"Send with Enter Key\"]')";
    await until(() => fresh.evaluate(`!!${sendControl}`));
    await fresh.evaluate(`${sendControl}.click()`);
    await until(() => fresh.evaluate(`!${sendControl}.checked`));
    assert.equal(
      await fresh.evaluate(ui("r().model.database.sendWithEnter")),
      true,
    );
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(edit=>edit.key==='sendWithEnter'))",
        ),
      ),
    );
    const sendTarget = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "sendWithEnter",
    };
    await until(() => observer.evaluate(`!!${sendControl}`));
    await observer.evaluate(`${sendControl}.click()`);
    await until(
      async () =>
        (await runtime.store.call("readFields", [sendTarget])).fields[0]
          .value === false,
    );
    await observer.evaluate(`${sendControl}.click()`);
    await until(
      async () =>
        (await runtime.store.call("readFields", [sendTarget])).fields[0]
          .value === true,
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.state==='blocked')",
        ),
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='서버 값 사용').click()",
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    await until(() => fresh.evaluate(`${sendControl}.checked`));
    // Presentation keeps working after the settings page closes and rolls back
    // rejected intent. This checks the original slider and the actual CSS variable.
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(settingsPage(3));
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Size and Speed').click()",
    );
    const animationSlider =
      "[...document.querySelectorAll('span')].find(e=>e.textContent.trim()==='Animation Speed')?.nextElementSibling?.querySelector('[role=slider]')";
    await until(() => fresh.evaluate(`!!(${animationSlider})`));
    await fresh.evaluate(
      `(${animationSlider}).dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`,
    );
    await until(() =>
      fresh.evaluate(
        "document.documentElement.style.getPropertyValue('--risu-animation-speed')==='1s'",
      ),
    );
    assert.equal(
      await fresh.evaluate(ui("r().model.database.animationSpeed")),
      0.2,
    );
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(edit=>edit.key==='animationSpeed'))",
        ),
      ),
    );
    await fresh.evaluate(settingsPage(3, false));
    await observer.evaluate(settingsPage(3));
    await observer.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Size and Speed').click()",
    );
    await until(() => observer.evaluate(`!!(${animationSlider})`));
    const animationTarget = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "animationSpeed",
    };
    await observer.evaluate(
      `(${animationSlider}).dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`,
    );
    await until(
      async () =>
        (await runtime.store.call("readFields", [animationTarget])).fields[0]
          .value === 1,
    );
    await observer.evaluate(
      `(${animationSlider}).dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`,
    );
    await until(
      async () =>
        (await runtime.store.call("readFields", [animationTarget])).fields[0]
          .value === 0,
    );
    assert.equal(
      await fresh.evaluate(
        "document.documentElement.style.getPropertyValue('--risu-animation-speed')",
      ),
      "1s",
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.state==='blocked')",
        ),
      ),
    );
    await until(() =>
      fresh.evaluate(
        "document.documentElement.style.getPropertyValue('--risu-animation-speed')==='0s'",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='서버 값 사용').click()",
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    // The original display settings render an input from a pending condition and edit
    // their custom array setter without writing the confirmed DBState or losing siblings.
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(settingsPage(3));
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Others').click()",
    );
    const quotes = "document.querySelector('input[alt=\"Custom Quotes\"]')";
    await until(() => fresh.evaluate(`!!${quotes}`));
    const quotesBefore = JSON.parse(
      await fresh.evaluate(
        ui("JSON.stringify(r().model.database.customQuotesData)"),
      ),
    );
    await fresh.evaluate(`${quotes}.click()`);
    const quoteInput =
      "[...document.querySelectorAll('span')].find(e=>e.textContent.trim()==='Leading Double Quote')?.nextElementSibling";
    await until(() => fresh.evaluate(`!!(${quoteInput})?.matches('input')`));
    await fresh.evaluate(
      `(()=>{const input=${quoteInput};input.value='Synthetic quote';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(edit=>edit.key==='customQuotesData'))",
        ),
      ),
    );
    assert.notEqual(
      await fresh.evaluate(ui("r().model.database.customQuotesData?.[0]")),
      "Synthetic quote",
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(async () => {
      const record = (
        await runtime.store.call("readFields", [
          {
            scope: "resource",
            resourceKind: "settings",
            entityId: "global",
            key: "customQuotesData",
          },
        ])
      ).fields[0];
      return record.value?.[0] === "Synthetic quote";
    });
    const quoteValue = (
      await runtime.store.call("readFields", [
        {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "customQuotesData",
        },
      ])
    ).fields[0].value;
    assert.deepEqual(quoteValue, ["Synthetic quote", ...quotesBefore.slice(1)]);
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    await fresh.evaluate(settingsPage(11, false));
    await observer.evaluate(settingsPage(11, false));
    await fresh.evaluate(ui("r().selectCharacter('c','a')"));
    await until(() => fresh.evaluate(`${toggle}.checked`));
    console.log(
      "Original per-chat toggle commits and synchronizes to another device while the native provider is still gated; final output preserves the confirmed selection.",
    );
    // Configure the actual original model page; opening it must not write defaults.
    const beforeSettingsCursor = (await runtime.store.call("bootstrap")).cursor;
    await fresh.evaluate(settingsPage(1));
    await observer.evaluate(settingsPage(1));
    await until(() =>
      fresh.evaluate("!!document.querySelector('#risu-proxy-model')"),
    );
    await until(() =>
      observer.evaluate("!!document.querySelector('#risu-proxy-model')"),
    );
    assert.equal(
      (await runtime.store.call("bootstrap")).cursor,
      beforeSettingsCursor,
      JSON.stringify(await runtime.store.call("changes", beforeSettingsCursor)),
    );
    const settingsTarget = (key) => ({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key,
    });
    const modelBefore = (
      await runtime.store.call("readFields", [
        settingsTarget("customProxyRequestModel"),
      ])
    ).fields[0];
    const setInput = (id, value) =>
      `(()=>{const input=document.querySelector(${JSON.stringify("#")}+${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()`;
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(
      setInput("risu-proxy-model", "synthetic-from-settings"),
    );
    await until(() =>
      fresh.evaluate(
        "document.querySelector('#risu-proxy-model').value==='synthetic-from-settings'",
      ),
    );
    assert.equal(
      await fresh.evaluate(ui("r().model.database.customProxyRequestModel")),
      modelBefore.value,
    );
    const providerUrl =
      "http://127.0.0.1:" +
      provider.address().port +
      "/configured/v1/chat/completions";
    await fresh.evaluate(setInput("risu-proxy-url", providerUrl));
    await fresh.evaluate(setInput("risu-proxy-key", "synthetic-key-from-ui"));
    await until(() =>
      fresh.evaluate(
        ui("s.pending.filter(e=>e.command.type==='change-fields').length===3"),
      ),
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    const configuredFields = (
      await runtime.store.call("readFields", [
        settingsTarget("customProxyRequestModel"),
        settingsTarget("forceReplaceUrl"),
        settingsTarget("proxyKey"),
      ])
    ).fields;
    assert.deepEqual(
      configuredFields.map((field) => field.value),
      ["synthetic-from-settings", providerUrl, "synthetic-key-from-ui"],
    );
    // These were three independent writes. Sender admission is not the peer's projection barrier.
    await until(
      () =>
        observer.evaluate(
          "['risu-proxy-model','risu-proxy-url','risu-proxy-key'].map(id=>document.getElementById(id).value)",
        ),
      (values) =>
        values[0] === "synthetic-from-settings" &&
        values[1] === providerUrl &&
        values[2] === "synthetic-key-from-ui",
    );
    assert.equal(
      await observer.evaluate(
        "document.querySelector('#risu-proxy-url').value",
      ),
      providerUrl,
    );
    assert.equal(
      await observer.evaluate(
        "document.querySelector('#risu-proxy-key').value",
      ),
      "synthetic-key-from-ui",
    );
    const selectFormat = (value) =>
      `(()=>{const select=[...document.querySelectorAll('.rs-setting-cont select')].find(e=>[...e.options].some(o=>o.value==='18'&&o.textContent.includes('Response')));select.value='${value}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`;
    await fresh.evaluate(selectFormat(18));
    await until(
      async () =>
        (
          await runtime.store.call("readFields", [
            settingsTarget("customAPIFormat"),
          ])
        ).fields[0].value === 18,
    );
    await fresh.evaluate(selectFormat(0));
    await until(
      async () =>
        (
          await runtime.store.call("readFields", [
            settingsTarget("customAPIFormat"),
          ])
        ).fields[0].value === 0,
    );
    // Use ModelList's real modal, including the original unrecommended/provider groups.
    await fresh.evaluate(
      "document.querySelector('button[aria-label=\"Model\"]').click()",
    );
    const unrecommended =
      "document.querySelector('input[alt=\"Show Unrecommended Settings\"]')";
    await until(() => fresh.evaluate(`!!${unrecommended}`));
    await fresh.evaluate(`${unrecommended}.click()`);
    await until(() =>
      fresh.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='For Developer')",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='For Developer').click()",
    );
    await until(() =>
      fresh.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Echo')",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Echo').click()",
    );
    await until(() =>
      observer.evaluate(ui("r().model.database.aiModel==='echo_model'")),
    );
    await fresh.evaluate(
      "document.querySelector('button[aria-label=\"Model\"]').click()",
    );
    await until(() =>
      fresh.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Custom API')",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Custom API').click()",
    );
    await until(() =>
      observer.evaluate(ui("r().model.database.aiModel==='reverse_proxy'")),
    );
    // Clearing a real provider key captures all dependent resets in one field command.
    await fresh.evaluate(
      "document.querySelector('button[aria-label=\"Model\"]').click()",
    );
    await until(() =>
      fresh.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='NanoGPT')",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='NanoGPT').click()",
    );
    await until(() =>
      fresh.evaluate("!!document.querySelector('#risu-nanogpt-key')"),
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(setInput("risu-nanogpt-key", ""));
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.edits?.some(edit=>edit.key==='nanogptKey'))",
        ),
      ),
    );
    const clearKeyEntry = JSON.parse(
      await fresh.evaluate(
        ui(
          "JSON.stringify(s.pending.find(e=>e.command.edits?.some(edit=>edit.key==='nanogptKey')))",
        ),
      ),
    );
    assert.deepEqual(
      clearKeyEntry.command.edits.map((edit) => edit.key).sort(),
      [
        "nanogptKey",
        "nanogptUseSubscriptionEndpoint",
        "nanogptSubscriptionState",
        "nanogptRequestModel",
        "nanogptRequestModelName",
        "nanogptProvider",
      ].sort(),
    );
    assert.equal(
      await fresh.evaluate(ui("r().model.database.nanogptRequestModel")),
      "synthetic-nano-model",
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      observer.evaluate(
        ui(
          "r().model.database.nanogptKey===''&&r().model.database.nanogptRequestModel===''&&r().model.database.nanogptUseSubscriptionEndpoint===false",
        ),
      ),
    );
    await fresh.evaluate(
      "document.querySelector('button[aria-label=\"Model\"]').click()",
    );
    await until(() =>
      fresh.evaluate(
        "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Custom API')",
      ),
    );
    await fresh.evaluate(
      "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Custom API').click()",
    );
    await until(() =>
      observer.evaluate(ui("r().model.database.aiModel==='reverse_proxy'")),
    );
    // Nested RegexData bindings edit only the isolated field draft, including while offline.
    const clickSettingsButton = (text) =>
      `(()=>{const button=[...document.querySelectorAll('.rs-setting-cont button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}));button.click()})()`;
    await fresh.evaluate(clickSettingsButton("Others"));
    await observer.evaluate(clickSettingsButton("Others"));
    await fresh.evaluate(clickSettingsButton("Regex Script"));
    await observer.evaluate(clickSettingsButton("Regex Script"));
    await until(() =>
      fresh.evaluate(
        "!!document.querySelector('.rs-setting-cont [data-risu-idx=\"0\"] .endflex')",
      ),
    );
    await fresh.evaluate(
      "document.querySelector('.rs-setting-cont [data-risu-idx=\"0\"] .endflex').click()",
    );
    await observer.evaluate(
      "document.querySelector('.rs-setting-cont [data-risu-idx=\"0\"] .endflex').click()",
    );
    const regexComment =
      "document.querySelector('.rs-setting-cont [data-risu-idx=\"0\"] input')";
    await until(() => fresh.evaluate(`!!${regexComment}`));
    await fresh.evaluate(ui("window.blockFields=true;true"));
    await fresh.evaluate(
      `(()=>{const input=${regexComment};input.value='Synthetic edited script';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await until(() =>
      fresh.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='change-fields'&&e.command.edits.some(edit=>edit.key==='presetRegex'))",
        ),
      ),
    );
    assert.equal(
      await fresh.evaluate(ui("r().model.database.presetRegex[0].comment")),
      "Synthetic editable script",
    );
    await fresh.evaluate(ui("window.blockFields=false;r().client.kick();true"));
    await until(() =>
      observer.evaluate(`${regexComment}.value==='Synthetic edited script'`),
    );
    const regexRecord = (
      await runtime.store.call("readFields", [settingsTarget("presetRegex")])
    ).fields[0];
    assert.deepEqual(regexRecord.value[0].extension, { keep: 1 });
    await until(() =>
      fresh.evaluate(
        ui("!s.pending.some(e=>e.command.type==='change-fields')"),
      ),
    );
    const changedRegex = structuredClone(regexRecord.value);
    changedRegex[0].comment = "Synthetic remote script";
    await runtime.store.call("applyCommand", "remote-regex-editor", {
      type: "change-fields",
      edits: [
        {
          ...settingsTarget("presetRegex"),
          expectedRevision: regexRecord.revision,
          expectedEpoch: regexRecord.entityEpoch,
          value: changedRegex,
        },
      ],
    });
    const remoteRegexCursor = (await runtime.store.call("bootstrap")).cursor;
    await until(() =>
      fresh.evaluate(`${regexComment}.value==='Synthetic remote script'`),
    );
    await until(() =>
      observer.evaluate(`${regexComment}.value==='Synthetic remote script'`),
    );
    assert.equal(
      (await runtime.store.call("bootstrap")).cursor,
      remoteRegexCursor,
    );
    await fresh.evaluate(settingsPage(1, false));
    await observer.evaluate(settingsPage(1, false));
    // A real textarea send uses the endpoint/key/model configured through those controls.
    await fresh.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic configured generation';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(
      async () => ({
        calls,
        state: JSON.parse(
          await fresh.evaluate(
            ui(
              "JSON.stringify({error:s.error,pending:s.pending.map(e=>({type:e.command.type,state:e.state})),jobs:s.jobs.map(j=>({id:j.id,state:j.state,result:j.result})),sendWithEnter:r().model.database.sendWithEnter})",
            ),
          ),
        ),
      }),
      (result) => result.calls === 4,
    );
    await until(() =>
      fresh.evaluate(
        ui("!s.jobs.some(job=>['queued','running'].includes(job.state))"),
      ),
    );
    await until(
      async () =>
        (await runtime.store.call("snapshot", "a")).messages.filter(
          (m) => m.message.data === "Synthetic partial final",
        ).length === 3,
    );
    assert.equal(requests[3].url, "/configured/v1/chat/completions");
    assert.equal(requests[3].authorization, "Bearer synthetic-key-from-ui");
    assert.equal(requests[3].body.model, "synthetic-from-settings");
    assert.equal(calls, 4);
    console.log(
      "Original model/endpoint/key/format controls and nested regex editor persist across two devices; remote hydration emits no editor echo; native generation consumes the UI configuration.",
    );
    await fresh.evaluate(ui("r().outbox.close()"));
    const fieldBeforeFailure = (
      await runtime.store.call("readFields", [fields[0]])
    ).fields[0];
    await fresh.evaluate(`${jailbreak}.click()`);
    await until(() => fresh.evaluate(`${jailbreak}.checked`));
    assert.deepEqual(
      (await runtime.store.call("readFields", [fields[0]])).fields[0],
      fieldBeforeFailure,
    );
    assert.equal(
      await fresh.evaluate(
        ui("s.pending.some(e=>e.command.type==='change-fields')"),
      ),
      false,
    );
    await fresh.evaluate(`${toggle}.click()`);
    await until(() =>
      fresh.evaluate(
        ui(
          "s.error.includes('closed') || s.error.includes('not running') || s.error.includes('connection')",
        ),
      ),
    );
    await until(() => fresh.evaluate(`${toggle}.checked`));
    assert.equal(
      (
        await runtime.store.call(
          "getResource",
          "global-variable",
          "toggle_responsive",
        )
      ).revision,
      confirmed.revision,
    );
    assert.equal(
      await fresh.evaluate(
        ui("s.pending.some(e=>e.command.type==='change-variables')"),
      ),
      false,
    );
    console.log(
      "Actual Risu UI exercised. Full editing/import/export, mobile and latency acceptance remain unfinished.",
    );
  },
);
