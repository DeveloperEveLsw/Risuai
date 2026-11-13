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
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Dependency condition timed out: " + JSON.stringify(value));
}

test(
  "original CSS read dependencies reject a stale proposal after another real display changes its source at the same input clock",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-dependency-"));
    const file = join(directory, "synthetic.sqlite");
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
    const hex = Buffer.from(
      '.dependency-probe{content:"{{getvar::dep_source}}";}',
    ).toString("hex");
    const markup =
      "<risu-style>" +
      hex +
      '</risu-style><span id="synthetic-dependency-probe">Synthetic dependency</span>';
    const seed = new EntityStore(file);
    try {
      seed.applyCommand("settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: 0,
        payload: { didFirstSetup: true, language: "en", autoTranslate: false },
      });
      seed.applyCommand("character", {
        type: "create-character",
        characterId: "c",
        chat: { chatId: "a", metadata: { name: "Synthetic dependency chat" } },
        definition: {
          type: "character",
          name: "Synthetic dependency fixture",
          desc: "Synthetic",
          firstMessage: "Synthetic greeting",
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `listenEdit('editDisplay', function(id,data)
        if data == 'Synthetic dependency target' then
          setChatVar(id,'dep_target','unsafe')
          return ${JSON.stringify(markup)}
        end
        if data == 'Synthetic dependency writer' then
          setChatVar(id,'dep_source','after')
          return data
        end
        if data == 'Synthetic dependency writer final' then
          setChatVar(id,'dep_source','final')
          return data
        end
        local outer = data:match('^Synthetic outer dependency (.*)$')
        if outer then
          setChatVar(id,'dep_outer_target',outer)
          return data
        end
        if string.find(data,'Synthetic automatic outer ',1,true) then
          setChatVar(id,'dep_automatic_target','safe')
          return data
        end
        return data
      end)`,
                },
              ],
            },
          ],
        },
      });
      for (const [messageId, data] of [
        ["m-target", "Synthetic stored target " + "fixture".repeat(1024)],
        ["m-writer", "Synthetic stored writer"],
      ])
        seed.applyCommand("append-" + messageId, {
          type: "append-message",
          chatId: "a",
          messageId,
          message: { role: "char", data },
        });
      seed.applyCommand("before", {
        type: "change-variables",
        edits: [
          {
            scope: "chat",
            chatId: "a",
            key: "$dep_source",
            value: "before",
            expectedRevision: 0,
          },
        ],
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const page = await browser.page(url, await browser.newContext(), {
      blockHttps: true,
      viewport: { width: 1280, height: 900 },
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await until(() =>
      page.evaluate("!!document.querySelector('[data-character-id=c]')"),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(() =>
      page.evaluate(
        ui(
          "r().captureDisplay(0,false,'c','m-target')?.chat.scriptstate.$dep_source==='before'",
        ),
      ),
    );
    await page.evaluate(
      ui(`(()=>{
    const bridge=r(),submit=bridge.submitDisplay.bind(bridge);window.dependencyCommands=[];
    bridge.submitDisplay=(command,capture)=>{window.dependencyCommands.push(structuredClone(command));return submit(command,capture)};
    return true;
  })()`),
    );
    const prepared = await page.evaluate(`(async()=>{
    const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    const presentation={};const html=await ParseMarkdown('Synthetic dependency target',getCurrentCharacter(),'notrim',0,{messageId:'m-target'},presentation);
    window.dependencyPresentation={html,presentation};return {html,hasFinalizer:typeof presentation.finalize==='function'};
  })()`);
    const before = await runtime.store.call("displayState", "a");
    assert.equal(
      (await runtime.store.call("snapshot", "a")).variables.some(
        (row) => row.key === "$dep_target",
      ),
      false,
    );
    const writer = await page.evaluate(`(async()=>{
    const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    return ParseMarkdown('Synthetic dependency writer',getCurrentCharacter(),'normal',1,{messageId:'m-writer'});
  })()`);
    await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_source" && row.value === "after",
      ),
    );
    const after = await runtime.store.call("displayState", "a");
    const finalized = await page.evaluate(`(async()=>{
    const p=window.dependencyPresentation;
    try{return {html:await p.presentation.finalize(p.html)}}catch(error){return {error:String(error)}}
  })()`);
    const conflict = await until(() =>
      page.evaluate(
        ui(
          "(()=>{const blocked=s.pending.filter(e=>e.command.type==='apply-display-effects'&&e.state==='blocked'&&e.command.edits?.some(edit=>edit.key==='$dep_target'));return blocked.length&&{error:s.error,blocked:structuredClone(blocked),visible:document.body.textContent.includes(s.error)}})()",
        ),
      ),
    );
    const snapshot = await runtime.store.call("snapshot", "a");
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualLuaWorker: true,
      actualIdbAndSQLite: true,
      actualMobileOS: false,
      hotModuleReload: false,
      prepared,
      writer,
      finalized,
      conflict,
      beforeClock: before.inputClock,
      afterClock: after.inputClock,
      source: snapshot.variables.find((row) => row.key === "$dep_source"),
      stored:
        snapshot.variables.find((row) => row.key === "$dep_target") ?? null,
      commands: await page.evaluate("window.dependencyCommands"),
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/ts/parser/parser.svelte.ts",
            "src/ts/runtime/displayCbsScope.ts",
            "src/ts/process/scriptings.ts",
            "src/ts/runtime/browserDisplayLua.ts",
            "src/ts/runtime/displayReadDependencies.ts",
            "src/lib/ChatScreens/Chat.svelte",
            "src/lib/ChatScreens/ChatBody.svelte",
            "server/browser/displayDependencyUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_DEPENDENCY_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_DEPENDENCY_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
    assert.equal(
      result.beforeClock,
      result.afterClock,
      "Real derived display writes intentionally retain the external input clock",
    );
    assert.equal(result.source.value, "after");
    assert.equal(result.source.revision, 2);
    assert.equal(
      result.stored,
      null,
      "CSS read provenance must reject saving a proposal based on a changed derived source",
    );
    assert.match(conflict.error, /Display change was rejected/);
    assert.equal(conflict.visible, true);
    assert.equal(conflict.blocked.length, 1);
    assert.ok(
      conflict.blocked[0].command.reads.some(
        (read) =>
          read.scope === "chat" &&
          read.key === "$dep_source" &&
          read.expectedRevision === 1,
      ),
    );
    await page.evaluate(
      ui(
        `r().discardCommand(${JSON.stringify(conflict.blocked[0].requestId)})`,
      ),
    );
    const epoch = async (value) => {
      await runtime.store.call("applyCommand", "dependency-epoch-" + value, {
        type: "change-variables",
        edits: [
          {
            scope: "chat",
            chatId: "a",
            key: "$dep_epoch",
            expectedRevision: value - 1,
            value: String(value),
          },
        ],
      });
      await until(() =>
        page.evaluate(
          ui(
            `r().captureDisplay(0,false,'c','m-target')?.chat.scriptstate.$dep_epoch==='${value}'`,
          ),
        ),
      );
    };
    await epoch(1);
    const outerPrepared = await page.evaluate(`(async()=>{
      const {ParseMarkdown,risuChatParser}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const {displayScopeJson}=await import('/src/ts/runtime/displayScopeIdentity.ts');
      const {DisplayWireBudget}=await import('/src/ts/runtime/displayWireBudget.ts');
      const presentation={},conditions={messageId:'m-target'};
      const input=risuChatParser('Synthetic outer dependency {{getvar::dep_source}}',{chatID:0,rmVar:true,visualize:true,cbsConditions:conditions},presentation);
      const html=await ParseMarkdown(input,getCurrentCharacter(),'notrim',0,conditions,presentation);
      const key=displayScopeJson(presentation.capture,new DisplayWireBudget(undefined,0,0));
      window.outerDependencyPresentation={html,presentation};return {input,html,sourceAnchored:JSON.parse(key)[0]==='source-field',sourceBytes:new TextEncoder().encode(presentation.capture.sourceContent).length,keyBytes:new TextEncoder().encode(key).length};
    })()`);
    const outerBefore = await runtime.store.call("displayState", "a");
    await page.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      return ParseMarkdown('Synthetic dependency writer final',getCurrentCharacter(),'normal',1,{messageId:'m-writer'});
    })()`);
    await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_source" && row.value === "final",
      ),
    );
    const outerAfter = await runtime.store.call("displayState", "a");
    await page.evaluate(
      "window.outerDependencyPresentation.presentation.finalize(window.outerDependencyPresentation.html)",
    );
    const outerConflict = await until(() =>
      page.evaluate(
        ui(
          "(()=>{const e=s.pending.find(e=>e.state==='blocked'&&e.command.edits?.some(edit=>edit.key==='$dep_outer_target'));return e&&{entry:structuredClone(e),error:s.error}})()",
        ),
      ),
    );
    const outerStored =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_outer_target",
      ) ?? null;
    assert.match(outerPrepared.input, /dependency after$/);
    assert.equal(outerPrepared.sourceAnchored, true);
    assert.ok(outerPrepared.sourceBytes > 4096);
    assert.ok(outerPrepared.keyBytes < 5000);
    assert.equal(
      outerConflict.entry.command.source.contentHash,
      createHash("sha256")
        .update("Synthetic stored target " + "fixture".repeat(1024))
        .digest("hex"),
      "A compact local key must retain the raw canonical source digest",
    );
    assert.equal(outerBefore.inputClock, outerAfter.inputClock);
    assert.equal(outerStored, null);
    assert.ok(
      outerConflict.entry.command.reads.some(
        (read) => read.key === "$dep_source" && read.expectedRevision === 2,
      ),
    );
    result.outerCbs = {
      prepared: outerPrepared,
      beforeClock: outerBefore.inputClock,
      afterClock: outerAfter.inputClock,
      conflict: outerConflict,
      stored: outerStored,
    };
    await page.evaluate(
      ui(
        `r().discardCommand(${JSON.stringify(outerConflict.entry.requestId)})`,
      ),
    );
    await epoch(2);
    const recoveredHtml = await page.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      return ParseMarkdown('Synthetic dependency target',getCurrentCharacter(),'normal',0,{messageId:'m-target'});
    })()`);
    const recovered = await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_target",
      ),
    );
    assert.equal(recovered.revision, 1);
    assert.match(recoveredHtml, /content:\s*"final"/);
    result.recovery = { html: recoveredHtml, stored: recovered };
    // Verify the actual Chat.svelte -> ChatBody token, rather than only a
    // manually composed invocation: the stored row has an ordinary CBS macro.
    await runtime.store.call("applyCommand", "dependency-automatic-row", {
      type: "append-message",
      chatId: "a",
      messageId: "m-auto",
      message: {
        role: "char",
        data: "Synthetic automatic outer {{getvar::dep_source}}",
      },
    });
    const automatic = await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_automatic_target",
      ),
    );
    const automaticCommand = await until(() =>
      page.evaluate(
        "window.dependencyCommands.find(c=>c.source.messageId==='m-auto'&&c.edits.some(e=>e.key==='$dep_automatic_target'))",
      ),
    );
    assert.equal(automatic.revision, 1);
    assert.ok(
      automaticCommand.reads.some(
        (read) =>
          read.scope === "chat" &&
          read.key === "$dep_source" &&
          read.expectedRevision === 3,
      ),
    );
    await until(() =>
      page.evaluate(
        "document.querySelector('.chattext')&&document.body.textContent.includes('Synthetic automatic outer final')",
      ),
    );
    result.automaticOriginalUi = {
      stored: automatic,
      command: automaticCommand,
    };
    await epoch(3);
    await page.evaluate(
      ui(`(()=>{
      const client=r().client,original=client.request.bind(client),gate=new Promise(resolve=>window.releaseDependencyPending=resolve);
      window.restoreDependencyFetch=()=>client.request=original;
      client.request=(url,options)=>{
        if(String(url).endsWith('/commands')&&options?.method==='POST'&&String(options.body).includes('"dep_pending"')){
          window.dependencyPendingStarted=true;return gate.then(()=>original(url,options));
        }
        return original(url,options);
      };
      r().setGlobalVariable('dep_pending','pending');return true;
    })()`),
    );
    await until(() => page.evaluate("window.dependencyPendingStarted===true"));
    const preview = await page.evaluate(`(async()=>{
      const {ParseMarkdown,risuChatParser}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const {displayReadAdmission}=await import('/src/ts/runtime/displayReadDependencies.ts');
      const conditions={messageId:'m-target'},presentation={};
      const input=risuChatParser('Synthetic outer dependency {{getglobalvar::dep_pending}}',{chatID:0,rmVar:true,visualize:true,cbsConditions:conditions},presentation);
      const reads=displayReadAdmission(presentation.capture);
      const html=await ParseMarkdown(input,getCurrentCharacter(),'notrim',0,conditions,presentation);
      return {input,html:await presentation.finalize(html),reads};
    })()`);
    const previewStored =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_outer_target",
      ) ?? null;
    assert.equal(preview.reads.provisional, true);
    assert.match(preview.html, /dependency pending/);
    assert.equal(
      previewStored,
      null,
      "Original Lua proposal based on a real pending global edit must not persist",
    );
    await page.evaluate(
      "window.releaseDependencyPending();window.restoreDependencyFetch();true",
    );
    await until(() =>
      page.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(0,false,'c','m-target')?.database.globalChatVariables.dep_pending==='pending'",
        ),
      ),
    );
    const confirmedHtml = await page.evaluate(`(async()=>{
      const {ParseMarkdown,risuChatParser}=await import('/src/ts/parser/parser.svelte.ts');const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      const conditions={messageId:'m-target'},presentation={};
      const input=risuChatParser('Synthetic outer dependency {{getglobalvar::dep_pending}}',{chatID:0,rmVar:true,visualize:true,cbsConditions:conditions},presentation);
      const html=await ParseMarkdown(input,getCurrentCharacter(),'notrim',0,conditions,presentation);return presentation.finalize(html);
    })()`);
    const confirmedStored = await until(async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$dep_outer_target",
      ),
    );
    assert.equal(confirmedStored.value, "pending");
    assert.equal(confirmedStored.revision, 1);
    assert.match(confirmedHtml, /dependency pending/);
    result.realPendingGlobal = {
      preview,
      previewStored,
      confirmedHtml,
      confirmedStored,
      delay: "actual HTTP command admission, real IDB pending global edit",
    };
    if (process.env.RISU_DISPLAY_DEPENDENCY_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_DEPENDENCY_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);
