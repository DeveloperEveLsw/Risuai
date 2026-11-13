"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 60000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic production UI condition timed out");
}
test(
  "built authenticated UI synchronizes independent devices and native Lua finishes after every tab closes",
  { timeout: 180000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-production-ui-"));
    let service, browser;
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
      passwordFile = join(root, "password");
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        customModuleToggle: "responsive=Synthetic hosted toggle",
        autoTranslate: false,
      },
      resources: [],
    });
    store.applyCommand("synthetic-character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic hosted fixture",
        desc: "Neutral authored fixture",
        customModuleToggle: "responsive=Synthetic hosted toggle",
        defaultVariables: "choice=open",
        firstMessage: '<button risu-btn="chosen">Choose</button>',
        triggerscript: [
          {
            comment: "Lua",
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: "function onButtonClick(id, data) sleep(id, 1000) setChatVar(id, 'choice', data) end",
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic hosted chat" } },
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
      runtime: { eventsPollMs: 20, scheduler: { pollMs: 20 } },
    });
    browser = await launchChromium(root);
    async function open() {
      const page = await browser.page(service.url, await browser.newContext(), {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate("!!document.querySelector('input[name=password]')"),
      );
      await page.evaluate(
        "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('[risu-btn=chosen]')"),
      );
      return page;
    }
    let a = await open(),
      b = await open();
    const toggle =
      "document.querySelector('input[alt=\"Synthetic hosted toggle\"]')";
    await until(() => a.evaluate(`!!${toggle}`));
    await a.evaluate(`${toggle}.click()`);
    await until(() => b.evaluate(`${toggle}.checked`));
    await a.evaluate("document.querySelector('[risu-btn=chosen]').click()");
    await until(
      () => service.runtime.store.call("listJobs", "a"),
      (jobs) => jobs[0]?.state === "running",
    );
    await a.close();
    await b.close();
    await until(
      () => service.runtime.store.call("listJobs", "a"),
      (jobs) => jobs[0]?.state === "completed",
    );
    const variables = await service.runtime.store.call("readVariables", [
      { scope: "chat", chatId: "a", key: "$choice" },
    ]);
    assert.equal(variables.variables[0].value, "chosen");
    a = await open();
    assert.equal(await a.evaluate(`${toggle}.checked`), true);
  },
);
