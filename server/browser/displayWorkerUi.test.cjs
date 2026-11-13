"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < end);
  throw new Error("Worker UI condition timed out: " + JSON.stringify(value));
}
test(
  "real display worker: infinite Lua leaves original checkbox responsive, no partial admission, owner cancellation and original API recovery",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-worker-"));
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
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: { didFirstSetup: true, language: "en", autoTranslate: false },
    });
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic worker" } },
      definition: {
        type: "character",
        name: "Synthetic worker fixture",
        desc: "Synthetic",
        firstMessage: "Synthetic",
        customModuleToggle: "worker=Synthetic worker toggle",
      },
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
        hmr: false,
        port: 0,
        strictPort: false,
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    const phases = [];
    page.on("Runtime.consoleAPICalled", (event) => {
      for (const arg of event.args ?? []) {
        const values = Object.fromEntries(
          (arg.preview?.properties ?? []).map((p) => [p.name, p.value]),
        );
        if (values.fixture === "display-worker") phases.push(values.phase);
      }
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
        "!!document.querySelector('input[alt=\"Synthetic worker toggle\"]')",
      ),
    );
    await page.evaluate(
      `(async()=>{const {createWorkerHarness}=await import('/server/browser/displayWorkerHarness.ts');window.workerHarness=createWorkerHarness();window.workerFrames=[];window.workerLast=performance.now();window.workerSampling=true;const frame=now=>{window.workerFrames.push({now,gap:now-window.workerLast});window.workerLast=now;if(window.workerSampling)requestAnimationFrame(frame)};requestAnimationFrame(frame)})()`,
    );
    const infinite = `listenEdit('editDisplay',function(id,data) setChatVar(id,'partial','must-not-persist'); log({fixture='display-worker',phase='infinite'}); while true do end; return data end)`;
    await page.evaluate(
      `window.workerStart=performance.now();window.workerDone=false;window.workerHarness.run(${JSON.stringify(infinite)}).then(value=>{window.workerOutput=value;window.workerDone=true});true`,
    );
    await until(async () => phases.includes("infinite"));
    const feedback = await page.evaluate(
      `(async()=>{const start=performance.now();const checkbox=document.querySelector('input[alt="Synthetic worker toggle"]');checkbox.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {ms:performance.now()-start,checked:checkbox.checked,workerDone:window.workerDone}})()`,
    );
    assert.equal(feedback.checked, true);
    assert.equal(
      feedback.workerDone,
      false,
      "checkbox paints while Lua is still executing",
    );
    assert.ok(
      feedback.ms < 400,
      "original checkbox feedback while infinite Lua: " + feedback.ms,
    );
    const toggle = await until(
      async () =>
        (
          await runtime.store.call("readVariables", [
            { scope: "global", key: "toggle_worker" },
          ])
        ).variables[0],
      (row) => row.value === "1",
    );
    assert.equal(
      toggle.value,
      "1",
      "real original checkbox is durably admitted",
    );
    assert.equal(
      await page.evaluate("window.workerDone"),
      false,
      "server toggle admission completes during the infinite invocation",
    );
    await until(() => page.evaluate("window.workerDone"));
    const timeout = await page.evaluate(
      `({elapsed:performance.now()-window.workerStart,output:window.workerOutput,commands:window.workerHarness.commands,errors:window.workerHarness.errors,diagnostics:window.workerHarness.runtime.diagnostics(),maxFrameGap:Math.max(...window.workerFrames.filter(x=>x.now>=window.workerStart).map(x=>x.gap))})`,
    );
    assert.equal(timeout.output, "Synthetic");
    assert.deepEqual(timeout.commands, []);
    assert.match(timeout.errors[0], /800 ms execution budget/);
    assert.deepEqual(timeout.diagnostics, { contexts: 0, invocations: 0 });
    assert.ok(
      timeout.maxFrameGap < 400,
      "continuous RAF during infinite Lua: " + timeout.maxFrameGap,
    );
    const snapshot = await runtime.store.call("snapshot", "a");
    assert.equal(
      snapshot.variables.some((v) => v.key === "$partial"),
      false,
    );
    const recovery = `local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1; setChatVar(id,'worker_value','changed'); local books=getLoreBooks(id,'Synthetic lore'); return data..':'..calls..':'..cbs('{{getvar::worker_value}}')..':'..books[1].content..':'..hash(id,'Synthetic'):await() end)`;
    const recovered = await page.evaluate(
      `window.workerHarness.run(${JSON.stringify(recovery)})`,
    );
    assert.match(recovered, /^Synthetic:1:changed:changed:[0-9a-f]{64}$/);
    const again = await page.evaluate(
      `window.workerHarness.run(${JSON.stringify(recovery)},'Synthetic second')`,
    );
    assert.match(again, /^Synthetic second:2:changed:changed:[0-9a-f]{64}$/);
    assert.equal(
      await page.evaluate("window.workerHarness.commands.length"),
      2,
    );
    const image = await page.evaluate(
      `window.workerHarness.run("listenEdit('editDisplay',function(id,data) return data..':'..getCharacterImage(id) end)")`,
    );
    assert.equal(image, "Synthetic:{{inlayed::synthetic-worker-image}}");
    assert.deepEqual(await page.evaluate("window.workerHarness.imageCalls"), [
      { path: "synthetic-image.png" },
      {
        options: {
          name: "synthetic-image.png",
          ext: "png",
          id: "synthetic-image.png",
        },
        width: 1,
        height: 1,
      },
    ]);
    for (const [expression, expectedError] of [
      ["{invalid=true}", "must be text"],
      ["string.rep('x',4194305)", "exceeds 4 MiB"],
    ]) {
      const code = `listenEdit('editDisplay',function(id,data) setChatVar(id,'partial','must-not-persist'); return ${expression} end)`;
      assert.equal(
        await page.evaluate(
          `window.workerHarness.run(${JSON.stringify(code)})`,
        ),
        "Synthetic",
      );
      assert.ok(
        await page.evaluate(
          `window.workerHarness.errors.at(-1).includes(${JSON.stringify(expectedError)})`,
        ),
      );
      assert.equal(
        await page.evaluate("window.workerHarness.commands.length"),
        2,
      );
    }
    const scopeGuard = await page.evaluate(`(async()=>{
      const input='\\u0000'.repeat(3*1024*1024);
      const output=await window.workerHarness.run("listenEdit('editDisplay',function(id,data) setChatVar(id,'partial','must-not-persist');log({fixture='display-worker',phase='oversized'});return data end)",input);
      return {original:output===input,length:output.length,error:window.workerHarness.errors.at(-1),commands:window.workerHarness.commands.length};
    })()`);
    assert.equal(scopeGuard.original, true);
    assert.equal(scopeGuard.length, 3 * 1024 * 1024);
    assert.ok(scopeGuard.error.includes("scope exceeds 16 MiB"));
    assert.equal(scopeGuard.commands, 2);
    assert.equal(
      phases.includes("oversized"),
      false,
      "scope budget rejects before executing Lua",
    );
    await page.evaluate(
      `window.workerClosed=false;window.workerHarness.run(${JSON.stringify(infinite)},'Synthetic close').then(value=>{window.workerCloseOutput=value;window.workerClosed=true});true`,
    );
    await until(
      async () => phases.filter((p) => p === "infinite").length === 2,
    );
    const closed = await page.evaluate(
      `(async()=>{const start=performance.now();window.workerHarness.runtime.close();while(!window.workerClosed)await new Promise(resolve=>setTimeout(resolve,1));return {ms:performance.now()-start,output:window.workerCloseOutput,diagnostics:window.workerHarness.runtime.diagnostics(),commands:window.workerHarness.commands.length,errors:window.workerHarness.errors.length}})()`,
    );
    assert.ok(closed.ms < 200);
    assert.equal(closed.output, "Synthetic close");
    assert.equal(closed.commands, 2);
    assert.equal(closed.errors, 4, "owner closure is not a user script error");
    assert.deepEqual(closed.diagnostics, { contexts: 0, invocations: 0 });
    await page.evaluate("window.workerSampling=false");
    const evidence = {
      syntheticDesktopOnly: true,
      realWorker: true,
      originalCheckbox: true,
      effectAdmissionInHarness:
        "captured proposals; real end-to-end admission is checked by displayUi.test.cjs",
      budgetMs: 800,
      feedback,
      timeout,
      closed,
      scopeGuard,
      originalGlobalsCbsLoreHashImage: true,
    };
    t.diagnostic(JSON.stringify(evidence));
    if (process.env.RISU_DISPLAY_WORKER_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_WORKER_OUTPUT,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
