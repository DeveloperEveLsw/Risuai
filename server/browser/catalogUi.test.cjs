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
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Synthetic catalog UI timed out: " + JSON.stringify(value));
}
const ui = (body) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${body}})()`;
const settings = (open) =>
  `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.SettingsMenuIndex.set(14);stores.settingsOpen.set(${open});})()`;
const action = (id, key) =>
  `(async()=>{const {language}=await import('/src/lang/index.ts');const button=document.querySelector('[data-module-id="${id}"] button[aria-label="'+language.${key}+'"]');if(!button)return false;button.click();return true;})()`;
async function input(page, id, value) {
  await until(() =>
    page.evaluate(`!!document.getElementById(${JSON.stringify(id)})`),
  );
  await page.evaluate(
    `(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
test(
  "original module UI reads bounded catalogs, fetches one edit/active body and releases closed-view definitions",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-catalog-ui-"));
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
      initialize: true,
      origins,
      eventsPollMs: 20,
    });
    const targets = ["didFirstSetup", "language"].map((key) => ({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key,
    }));
    const fields = (await runtime.store.call("readFields", targets)).fields;
    await runtime.store.call("applyCommand", "synthetic-catalog-settings", {
      type: "change-fields",
      edits: fields.map((field) => ({
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: field.key === "language" ? "en" : true,
      })),
    });
    const large = "Synthetic definition body.".repeat(12000),
      count = 63;
    for (let i = 0; i < count; i++) {
      const id = "catalog-" + i;
      await runtime.store.call("applyCommand", "synthetic-catalog-" + i, {
        type: "save-library-resource",
        kind: "module",
        resourceId: id,
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id,
          name: "Synthetic catalog " + String(i).padStart(2, "0"),
          description: "Small catalog summary",
          unknown: { retained: true, large },
          regex: [
            {
              in: "Synthetic input",
              out: "Synthetic output",
              type: "editoutput",
              ableFlag: false,
            },
          ],
        },
      });
    }
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const open = async () => {
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=\"true\"]')",
        ),
      );
      await page.evaluate(
        `(async()=>{const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');const client=browserRuntime().client;window.catalogTraffic=[];window.catalogLongTasks=[];new PerformanceObserver(list=>window.catalogLongTasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration})))).observe({type:'longtask'});const original=client.request;client.request=async(...args)=>{const response=await original(...args);const path=typeof args[0]==='string'?args[0]:args[0].url;if(path.includes('/libraries/')||path.includes('/resources/module/')){const record={path,bytes:0};window.catalogTraffic.push(record);record.bytes=new TextEncoder().encode(await response.clone().text()).byteLength;}return response;};})()`,
      );
      return page;
    };
    const a = await open();
    const started = await a.evaluate("performance.now()");
    await a.evaluate(settings(true));
    await until(
      () => a.evaluate("document.querySelectorAll('[data-module-id]').length"),
      (value) => value === 50,
    );
    const firstPageMs = (await a.evaluate("performance.now()")) - started;
    assert.equal(await a.evaluate(ui("r().model.database.modules.length")), 0);
    await a.evaluate(
      "window.firstCatalogRow=document.querySelector('[data-module-id=\"catalog-0\"]')",
    );
    await until(() =>
      a.evaluate(
        `(async()=>{const {language}=await import('/src/lang/index.ts');const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===language.loadMore);if(!button)return false;button.click();return true;})()`,
      ),
    );
    await until(
      () => a.evaluate("document.querySelectorAll('[data-module-id]').length"),
      (value) => value === count,
    );
    assert.equal(
      await a.evaluate(
        "window.firstCatalogRow===document.querySelector('[data-module-id=\"catalog-0\"]')",
      ),
      true,
    );
    assert.equal(
      await a.evaluate(
        "window.catalogTraffic.filter(r=>r.path.includes('/resources/module/')).length",
      ),
      0,
    );
    const searchStart = await a.evaluate("performance.now()");
    await input(a, "runtime-module-search", "Synthetic catalog 60");
    await until(() =>
      a.evaluate(
        ui(
          "s.libraries.module?.length===1&&s.libraries.module[0].id==='catalog-60'",
        ),
      ),
    );
    const searchMs = (await a.evaluate("performance.now()")) - searchStart;
    await until(() => a.evaluate(action("catalog-60", "edit")));
    await input(a, "runtime-module-name", "Synthetic catalog 60 edited");
    assert.equal(
      await a.evaluate(
        "window.catalogTraffic.filter(row => row.path.endsWith('/resources/module/catalog-60')).length",
      ),
      1,
    );
    assert.deepEqual(
      await a.evaluate(ui("r().model.database.modules.map(value=>value.id)")),
      ["catalog-60"],
    );
    await until(() =>
      a.evaluate(
        `(async()=>{const {language}=await import('/src/lang/index.ts');const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===language.editModule);if(!button)return false;button.click();return true;})()`,
      ),
    );
    await until(
      async () =>
        (await runtime.store.call("getResource", "module", "catalog-60"))
          .payload.name === "Synthetic catalog 60 edited",
    );
    const saved = await runtime.store.call(
      "getResource",
      "module",
      "catalog-60",
    );
    assert.equal(saved.payload.unknown.large, large);
    await until(() =>
      a.evaluate("!!document.getElementById('runtime-module-search')"),
    );
    await a.evaluate(settings(false));
    await until(() =>
      a.evaluate(
        ui(
          "r().model.database.modules.length===0&&s.libraries.module.length===0",
        ),
      ),
    );
    await a.evaluate(
      ui("r().model.bootstrap(await r().client.read('/bootstrap'))"),
    );
    assert.equal(await a.evaluate(ui("r().model.database.modules.length")), 0);
    await a.evaluate(settings(true));
    await until(() => a.evaluate(action("catalog-0", "enableGlobal")));
    await until(() =>
      a.evaluate(
        ui(
          "r().model.database.modules.length===1&&r().model.database.modules[0].id==='catalog-0'",
        ),
      ),
    );
    await a.evaluate(settings(false));
    const b = await open();
    assert.deepEqual(
      await b.evaluate(ui("r().model.database.modules.map(value=>value.id)")),
      ["catalog-0"],
    );
    await b.evaluate(settings(true));
    await until(
      () => b.evaluate("document.querySelectorAll('[data-module-id]').length"),
      (value) => value === 50,
    );
    assert.equal(
      await b.evaluate(
        "window.catalogTraffic.filter(r=>r.path.includes('/resources/module/')).length",
      ),
      0,
    );
    const traffic = await a.evaluate("window.catalogTraffic");
    assert.ok(
      traffic.filter((row) => row.path.includes("/libraries/module?")).length >=
        4,
    );
    assert.deepEqual(
      [
        ...new Set(
          traffic
            .filter((row) => row.path.includes("/resources/module/"))
            .map((row) => row.path.split("/").at(-1)),
        ),
      ].sort(),
      ["catalog-0", "catalog-60"],
    );
    const tasks = await a.evaluate("window.catalogLongTasks");
    assert.ok(
      traffic
        .filter((row) => row.path.includes("/libraries/module?"))
        .every((row) => row.bytes > 0 && row.bytes < 20000),
    );
    assert.ok(
      traffic
        .filter((row) => row.path.includes("/resources/module/"))
        .every((row) => /catalog-(60|0)$/.test(row.path)),
    );
    console.log(
      "CATALOG_SYNTHETIC_MEASUREMENTS " +
        JSON.stringify({
          moduleCount: count,
          definitionBytes: Buffer.byteLength(large) * count,
          firstPageMs,
          searchWith150msDebounceMs: searchMs,
          catalogResponses: traffic
            .filter((row) => row.path.includes("/libraries/module?"))
            .map((row) => row.bytes),
          bodyFetches: traffic
            .filter((row) => row.path.includes("/resources/module/"))
            .map((row) => row.path),
          observedLongTasks: tasks.length,
          maxObservedLongTaskMs: Math.max(
            0,
            ...tasks.map((task) => task.duration),
          ),
          scope:
            "Synthetic desktop Chromium/Vite; not mobile or production acceptance",
        }),
    );
  },
);
