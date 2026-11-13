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
const probe = "Synthetic ordinal probe";
const countProbe = "Synthetic count probe";

test(
  "original display Lua uses full-history ordinal and count across partial pages and deleted position gaps",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-history-"));
    const file = join(directory, "synthetic.sqlite");
    let runtime, frontend, browser, gatePage;
    t.after(async () => {
      if (gatePage) {
        try {
          await gatePage.evaluate("(window.releaseHistoryPageGate?.(),true)");
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
      controllerSha256: createHash("sha256")
        .update(
          await readFile("src/ts/runtime/browserRuntimeController.svelte.ts"),
        )
        .digest("hex"),
    };
    if (process.env.RISU_DISPLAY_HISTORY_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_HISTORY_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
    assert.match(partialOutput, /Synthetic ordinal probe:20/);
    assert.match(partialCount, /Synthetic count probe:120/);
    assert.equal(partialStored.value, "20");
    assert.match(completeOutput, /Synthetic ordinal probe:20/);
    assert.match(completeCount, /Synthetic count probe:120/);
    assert.equal(result.finalStored.value, "20");
    assert.equal(result.otherDeviceObserved, "20");

    result.changes = [];
    result.changesVerified = false;
    let mutation = 0;
    const mutate = async (writes) => {
      await runtime.store.call(
        "enqueueJob",
        "synthetic-mutation-" + ++mutation,
        { type: "button", chatId: "a" },
      );
      const claim = await runtime.store.call("claimJob", "synthetic-owner");
      assert.ok(claim, "Only the authored fixture owns the synthetic mutation");
      const { job, snapshot } = claim;
      await runtime.store.call(
        "finishJob",
        job.id,
        "synthetic-owner",
        job.fence,
        {
          state: "completed",
          writeSet: {
            chatId: "a",
            expectedRevision: snapshot.chat.revision,
            ...writes,
          },
        },
      );
    };
    const remove = async (id) =>
      mutate({ deleteMessages: [{ id, expectedRevision: 1 }] });
    const indexOf = (page) =>
      page.evaluate(
        ui("r().model.activeChat.message.findIndex(m=>m.chatId==='m-25')"),
      );
    const ready = async (page, count, ordinal, clock) =>
      until(async () => {
        const index = await indexOf(page);
        if (index < 0) return false;
        return page.evaluate(
          ui(
            `(()=>{const c=r().captureDisplay(${index},false,'c');return c?.history.count===${count}&&c?.history.ordinal===${ordinal}&&c?.state.inputClock>=${clock};})()`,
          ),
        );
      });
    const recordChange = async (label, count, ordinal, pages = [a, b]) => {
      const clock = (await runtime.store.call("displayState", "a")).inputClock;
      for (const page of pages) await ready(page, count, ordinal, clock);
      const observations = [];
      for (const page of pages) {
        const index = await indexOf(page);
        observations.push({
          localIndex: index,
          loaded: await page.evaluate(
            ui("r().model.activeChat.message.length"),
          ),
          partial: await page.evaluate(ui("r().model.hasEarlier")),
          output: await parse(page, probe, index),
          countOutput: await parse(page, countProbe, -1),
        });
      }
      await until(observed, (row) => row?.value === String(ordinal));
      const row = {
        label,
        count,
        ordinal,
        inputClock: clock,
        observations,
        stored: await observed(),
      };
      result.changes.push(row);
      if (process.env.RISU_DISPLAY_HISTORY_OUTPUT)
        await writeFile(
          process.env.RISU_DISPLAY_HISTORY_OUTPUT,
          JSON.stringify(result, null, 2) + "\n",
        );
      console.log(JSON.stringify({ historyChange: row }));
      for (const obs of observations) {
        assert.match(
          obs.output,
          new RegExp("Synthetic ordinal probe:" + ordinal + "<"),
        );
        assert.match(
          obs.countOutput,
          new RegExp("Synthetic count probe:" + count + "<"),
        );
      }
      return row;
    };
    await runtime.store.call("applyCommand", "edit-unloaded", {
      type: "edit-message",
      messageId: "m-6",
      expectedRevision: 1,
      text: "Synthetic unloaded edit",
    });
    await recordChange("unloaded-edit", 120, 20);
    assert.equal(
      await b.evaluate(ui("r().model.activeChat.message.length")),
      100,
    );
    await remove("m-5");
    await recordChange("unloaded-delete", 119, 19);
    await runtime.store.call("applyCommand", "append-live", {
      type: "append-message",
      chatId: "a",
      messageId: "m-125",
      message: { role: "char", data: "Synthetic appended message" },
    });
    await recordChange("live-append", 120, 19);

    gatePage = b;
    await b.evaluate(
      ui(`(()=>{
      const controller=r(),original=controller.client.read.bind(controller.client);let armed=true,release;
      const blocked=new Promise(resolve=>release=resolve);window.releaseHistoryPageGate=()=>release();window.historyPageGateStarted=false;
      controller.client.read=async(path,...args)=>{
        const value=await original(path,...args);
        if(armed&&path.startsWith('/chats/a?')&&path.includes('&before=')){armed=false;window.historyPageGateStarted=true;await blocked;}
        return value;
      };
      window.pendingHistoryPage=controller.model.loadEarlier();return true;
    })()`),
    );
    await until(() => b.evaluate("window.historyPageGateStarted"));
    // m-6 was edited above; delete with its actual current entity revision.
    await mutate({ deleteMessages: [{ id: "m-6", expectedRevision: 2 }] });
    await recordChange("delete-during-older-page", 119, 18);
    await b.evaluate("(window.releaseHistoryPageGate(),true)");
    await b.evaluate(
      "(async()=>{await window.pendingHistoryPage;return true})()",
    );
    await recordChange("older-page-retry", 119, 18);
    assert.equal(await b.evaluate(ui("r().model.hasEarlier")), false);

    const c = await open();
    assert.equal(
      await indexOf(c),
      -1,
      "A fresh partial latest window excludes ordinal18",
    );
    const canonical = await runtime.store.call("snapshot", "a", {
      limit: 1000,
    });
    await mutate({
      messageOrder: [
        ...canonical.messages
          .filter((row) => row.id !== "m-25")
          .map((row) => row.id),
        "m-25",
      ],
    });
    const reordered = await recordChange(
      "reorder-into-latest-window",
      119,
      118,
      [a, b, c],
    );
    assert.equal(reordered.observations[2].loaded, 100);
    assert.equal(reordered.observations[2].localIndex, 99);
    assert.equal(reordered.observations[2].partial, true);
    await c.evaluate(ui("r().model.loadEarlier()"));
    await recordChange("reorder-full-page", 119, 118, [a, b, c]);
    result.tailWindowRecovery = { verified: false };
    const d = await open();
    const tail = await d.evaluate(
      ui(
        "r().model.activeChat.message.map(m=>({id:m.chatId,expectedRevision:r().model.messageRevision(m.chatId)}))",
      ),
    );
    assert.equal(tail.length, 100);
    assert.equal(await d.evaluate(ui("r().model.hasEarlier")), true);
    await mutate({ deleteMessages: tail });
    const tailClock = (await runtime.store.call("displayState", "a"))
      .inputClock;
    await until(() =>
      d.evaluate(
        ui(
          `(()=>{const capture=r().captureDisplay(0,false,'c');return r().model.activeChat.message.length===19&&!r().model.hasEarlier&&capture?.history.count===19&&capture?.history.ordinal===0&&capture?.state.inputClock>=${tailClock};})()`,
        ),
      ),
    );
    const recovered = {
      loaded: 19,
      countOutput: await parse(d, countProbe, -1),
      first: await d.evaluate(ui("r().captureDisplay(0,false,'c')?.history")),
    };
    assert.match(recovered.countOutput, /Synthetic count probe:19/);
    assert.equal(recovered.first.ordinal, 0);
    result.tailWindowRecovery = {
      verified: true,
      deleted: 100,
      canonicalRemaining: 19,
      inputClock: tailClock,
      recovery: "actual completed-job refresh",
      recovered,
    };
    console.log(
      JSON.stringify({ tailWindowRecovery: result.tailWindowRecovery }),
    );
    result.changesVerified = true;
    if (process.env.RISU_DISPLAY_HISTORY_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_HISTORY_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);
