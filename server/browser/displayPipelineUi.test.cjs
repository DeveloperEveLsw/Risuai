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
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("History condition timed out: " + JSON.stringify(result));
}
const probe = "Synthetic ordinal probe {{chat_index}}";
const countProbe = "Synthetic count probe";

test(
  "original outer CBS and Lua agree on canonical message ordinal across partial and complete pages",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-pipeline-"));
    const file = join(directory, "synthetic.sqlite");
    let runtime, frontend, browser, gatePage;
    t.after(async () => {
      if (gatePage) {
        try {
          await gatePage.evaluate(
            "(window.releaseHistoryPageGate?.(),window.releaseGatedAsset?.(),true)",
          );
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
    // Authored fixtures use the real entity commands and ownership-checked write set.
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
        chat: { chatId: "a", metadata: { name: "Synthetic chat" } },
        definition: {
          type: "character",
          name: "Synthetic history",
          desc: "Synthetic",
          firstMessage: "Synthetic greeting",
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `listenEdit('editDisplay', function(id,data,meta)
            if string.find(data,'Synthetic gated presentation',1,true) then
              setChatVar(id,'asset_ordinal_observed',tostring(meta.index))
              return data .. ':' .. tostring(meta.index)
            end
            if data == 'Synthetic failure source' then
              setChatVar(id,'pipeline_failure_observed','unsafe')
              return 'Synthetic later failure probe {{previoususerchat}}'
            end
            if data == '${probe}' then
              setChatVar(id,'ordinal_observed',tostring(meta.index))
              return data .. ':' .. tostring(meta.index)
            end
            if data == '${countProbe}' then
              return data .. ':' .. tostring(getChatLength(id))
            end
            return data
          end)`,
                },
              ],
            },
          ],
        },
      });
      for (let i = 0; i < 125; i++)
        seed.applyCommand("append-" + i, {
          type: "append-message",
          chatId: "a",
          messageId: "m-" + i,
          message: {
            role: "char",
            data: i === 25 ? probe : "Synthetic message " + i,
          },
        });
      seed.enqueueJob("delete-seed", { type: "button", chatId: "a" });
      const { job, snapshot } = seed.claimJob("synthetic-owner");
      seed.finishJob(job.id, "synthetic-owner", job.fence, {
        state: "completed",
        writeSet: {
          chatId: "a",
          expectedRevision: snapshot.chat.revision,
          deleteMessages: Array.from({ length: 5 }, (_, i) => ({
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
      page.on("Network.responseReceived", (event) => {
        if (event.response.status >= 400)
          diagnostics.push({
            url: event.response.url,
            status: event.response.status,
          });
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
      await until(() => page.evaluate(ui("!!r().captureDisplay(0,false,'c')")));
      return page;
    };
    const a = await open(),
      b = await open();
    const observed = async () =>
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$ordinal_observed",
      ) ?? null;
    const parse = async (page, value, index) =>
      page.evaluate(`(async()=>{
        const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
        const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
        return await ParseMarkdown(${JSON.stringify(value)},getCurrentCharacter(),'normal',${index});
      })()`);
    const before = await a.evaluate(
      ui(
        "({loaded:r().model.activeChat.message.length,partial:r().model.hasEarlier,first:r().model.activeChat.message[0].chatId,capture:r().captureDisplay(0,false,'c')?.history})",
      ),
    );
    const partialSnapshot = await runtime.store.call("snapshot", "a");
    assert.equal(before.loaded, 100);
    assert.equal(before.partial, true);
    assert.equal(before.first, "m-25");
    const partialOutput = await parse(a, probe, 0);
    const partialCount = await parse(a, countProbe, -1);
    await until(observed);
    await until(() =>
      b.evaluate(ui("r().model.activeChat.scriptstate.$ordinal_observed")),
    );
    const partialStored = await observed();
    await a.evaluate(ui("r().model.loadEarlier()"));
    await until(() => a.evaluate(ui("!r().model.hasEarlier")));
    await until(() => a.evaluate(ui("!!r().captureDisplay(20,false,'c')")));
    const completeOutput = await parse(a, probe, 20);
    const completeCount = await parse(a, countProbe, -1);
    await delay(100);
    const result = {
      syntheticOnly: true,
      originalUi: true,
      actualController: true,
      actualLuaAndCbs: true,
      actualIdbAndServer: true,
      actualMobileOS: false,
      hotModuleReload: false,
      before,
      storedPosition: partialSnapshot.messages[0].position,
      canonicalOrdinal: 20,
      canonicalCount: 120,
      serverHistory: partialSnapshot.history,
      partialOutput,
      partialCount,
      partialStored,
      completeOutput,
      completeCount,
      finalStored: await observed(),
      otherDeviceObserved: await b.evaluate(
        ui("r().model.activeChat.scriptstate.$ordinal_observed"),
      ),
      runtimeErrors: [
        await a.evaluate(ui("s.error")),
        await b.evaluate(ui("s.error")),
      ],
      controllerSha256: createHash("sha256")
        .update(
          await readFile("src/ts/runtime/browserRuntimeController.svelte.ts"),
        )
        .digest("hex"),
    };
    if (process.env.RISU_DISPLAY_PIPELINE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_PIPELINE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
    assert.deepEqual(
      result.runtimeErrors,
      ["", ""],
      "overlapping complete-history display must wait for Lua capacity",
    );
    // Delay only the original asset URL capability. The real upload, parser,
    // worker, CAS admission and SQLite remain in use while pagination changes
    // the source's UI row before the prefix await resumes.
    await b.evaluate(
      ui(`(async()=>{
      const bridge=r();const canvas=document.createElement('canvas');
      canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);
      const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
      window.gatedAssetPath=await bridge.uploadAsset(bytes,'Synthetic-delay.png');
      bridge.setField({scope:'character',entityId:'c',key:'additionalAssets'},[['synthetic-delay',window.gatedAssetPath,'png']]);
      return true;
    })()`),
    );
    await until(() =>
      b.evaluate(
        ui(
          "s.pending.length===0&&r().captureDisplay(1,false,'c','m-26')?.character.additionalAssets?.[0]?.[1]===window.gatedAssetPath",
        ),
      ),
    );
    await b.evaluate(
      ui(`(()=>{
      const bridge=r(),original=bridge.assetUrl.bind(bridge),submit=bridge.submitDisplay.bind(bridge);
      window.gatedAdmissions=[];window.gatedAssetStarted=false;window.gatedDone=false;
      const gate=new Promise(resolve=>window.releaseGatedAsset=resolve);
      bridge.assetUrl=path=>{const result=original(path);if(path===window.gatedAssetPath){window.gatedAssetStarted=true;return gate.then(()=>result)}return result};
      bridge.submitDisplay=(command,capture)=>{window.gatedAdmissions.push(structuredClone(command));return submit(command,capture)};
      return true;
    })()`),
    );
    gatePage = b;
    await b.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      void ParseMarkdown('Synthetic gated presentation {{raw::synthetic-delay}}',getCurrentCharacter(),'normal',1,{messageId:'m-26'})
        .then(output=>window.gatedOutput=output).catch(error=>window.gatedError=String(error)).finally(()=>window.gatedDone=true);
      return true;
    })()`);
    const gateStatus = await until(
      () =>
        b.evaluate(
          "({started:window.gatedAssetStarted,done:window.gatedDone,output:window.gatedOutput,error:window.gatedError})",
        ),
      (status) => status.started || status.done,
    );
    console.log(
      JSON.stringify({
        gateStatus,
        assetCapture: await b.evaluate(
          ui(
            "({projected:r().model.database.characters[0].additionalAssets,captured:r().captureDisplay(1,false,'c','m-26')?.character.additionalAssets})",
          ),
        ),
      }),
    );
    assert.equal(
      gateStatus.started,
      true,
      "Original asset prefix must reach the delayed capability",
    );
    const gatedBefore = await b.evaluate(
      ui(
        "({loaded:r().model.activeChat.message.length,index:r().model.activeChat.message.findIndex(message=>message.chatId==='m-26')})",
      ),
    );
    assert.deepEqual(gatedBefore, { loaded: 100, index: 1 });
    await b.evaluate(ui("r().model.loadEarlier()"));
    await until(() => b.evaluate(ui("!r().model.hasEarlier")));
    const gatedAfter = await b.evaluate(
      ui(
        "({loaded:r().model.activeChat.message.length,index:r().model.activeChat.message.findIndex(message=>message.chatId==='m-26')})",
      ),
    );
    assert.deepEqual(gatedAfter, { loaded: 120, index: 21 });
    await b.evaluate("(window.releaseGatedAsset(),true)");
    await until(() => b.evaluate("window.gatedDone"));
    await until(() => b.evaluate(ui("s.pending.length===0")));
    const gated = await b.evaluate(
      "({output:window.gatedOutput,error:window.gatedError??null,commands:window.gatedAdmissions})",
    );
    gated.stored =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$asset_ordinal_observed",
      ) ?? null;
    await until(() =>
      a.evaluate(
        ui("r().model.activeChat.scriptstate.$asset_ordinal_observed==='21'"),
      ),
    );
    gated.otherDevice = await a.evaluate(
      ui("r().model.activeChat.scriptstate.$asset_ordinal_observed"),
    );
    result.asyncPrefix = {
      ...gated,
      before: gatedBefore,
      after: gatedAfter,
      delay: "original asset URL capability",
      sourceId: "m-26",
      sourceRevision: 1,
    };
    assert.equal(gated.error, null);
    assert.match(gated.output, /Synthetic gated presentation .*:21/);
    assert.equal(gated.stored.value, "21");
    const admission = gated.commands.find((command) =>
      command.edits?.some((edit) => edit.key === "$asset_ordinal_observed"),
    );
    assert.equal(admission.source.messageId, "m-26");
    assert.equal(admission.source.expectedRevision, 1);
    // A fresh partial device keeps the later-failure probe independent of the
    // successful complete-history source race above.
    await b.close();
    gatePage = undefined;
    const partialDevice = await open();
    await a.close();
    await runtime.store.call("applyCommand", "append-failure-source", {
      type: "append-message",
      chatId: "a",
      messageId: "m-125",
      message: { role: "char", data: "Synthetic failure source" },
    });
    await until(() =>
      partialDevice.evaluate(
        ui("r().captureDisplay(100,false,'c','m-125')?.history.ordinal===120"),
      ),
    );
    const failure = await partialDevice.evaluate(`(async()=>{
      const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
      const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
      try { return {output:await ParseMarkdown('Synthetic failure source',getCurrentCharacter(),'normal',100,{messageId:'m-125'})}; }
      catch(error){return {error:String(error)};}
    })()`);
    await until(() => partialDevice.evaluate(ui("s.pending.length===0")));
    failure.stored =
      (await runtime.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$pipeline_failure_observed",
      ) ?? null;
    result.laterFailure = failure;
    console.log(JSON.stringify({ laterFailure: failure }));
    if (process.env.RISU_DISPLAY_PIPELINE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_PIPELINE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    assert.match(failure.error, /unloaded history/);
    assert.equal(
      failure.stored,
      null,
      "Later display failure cannot admit an earlier provisional Lua write",
    );
    assert.match(partialOutput, /Synthetic ordinal probe 20:20/);
    assert.match(completeOutput, /Synthetic ordinal probe 20:20/);
  },
);
