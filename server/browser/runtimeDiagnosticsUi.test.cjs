"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os");
const { createHash } = require("node:crypto"),
  { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw Error("Diagnostic UI condition timed out");
}
test(
  "fresh built UI records initial DB failure with a visible trace; reload recovers and retains only safe failure metadata",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-diagnostic-ui-"));
    let browser, service;
    t.after(async () => {
      await browser?.close();
      await service?.close();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const file = join(root, "entity.sqlite"),
      passwordFile = join(root, "password"),
      store = new EntityStore(file);
    store.initializeState({
      settings: { didFirstSetup: true, language: "en", autoTranslate: false },
      resources: [],
    });
    store.close();
    await fs.writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-password").digest("hex"),
    );
    service = await createProductionService({
      file,
      passwordFile,
      staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
      origin: "https://risu.test",
      insecureLocalTest: true,
      host: "127.0.0.1",
      port: 0,
    });
    const call = service.runtime.store.call.bind(service.runtime.store);
    let fails = 1;
    service.runtime.store.call = (method, ...args) =>
      method === "bootstrap" && fails-- > 0
        ? Promise.reject(
            Object.assign(new Error("Synthetic DB failure"), {
              code: "ERR_SQLITE_ERROR",
            }),
          )
        : call(method, ...args);
    browser = await launchChromium(root);
    const page = await browser.page(service.url, await browser.newContext(), {
      viewport: { width: 1280, height: 800 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate("!!document.querySelector('input[name=password]')"),
    );
    await page.evaluate(
      "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
    );
    const rows = await until(
      () =>
        page.evaluate(
          "JSON.parse(localStorage.getItem('risu-runtime-diagnostics:v1')||'[]')",
        ),
      (v) => v.some((r) => r.code === "ERR_SQLITE_ERROR"),
    );
    const failure = rows.find((v) => v.code === "ERR_SQLITE_ERROR");
    await until(() =>
      page.evaluate(
        "document.body.innerText.includes(" +
          JSON.stringify(failure.requestId) +
          ")",
      ),
    );
    assert.equal(failure.endpoint, "/api/runtime/bootstrap");
    assert.equal(failure.status, 500);
    assert.ok(!JSON.stringify(rows).includes("Synthetic DB failure"));
    await service.runtime.diagnostics.flush();
    const journal = (await fs.readFile(file + ".diagnostics.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      journal.some(
        (v) =>
          v.requestId === failure.requestId && v.code === "ERR_SQLITE_ERROR",
      ),
    );
    await page.send("Page.reload");
    await until(() =>
      page.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    const after = await page.evaluate(
      "JSON.parse(localStorage.getItem('risu-runtime-diagnostics:v1')||'[]')",
    );
    assert.ok(after.some((v) => v.requestId === failure.requestId));
    assert.equal(
      (await service.runtime.store.call("bootstrap")).characters.length,
      0,
    );
    service.runtime.store.call = call;
  },
);
