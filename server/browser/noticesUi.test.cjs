"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os"),
  { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic notice UI timeout: " + JSON.stringify(value));
}
test(
  "built original HTML/Lua notifications survive all-tab exit, share acknowledgements, reject HTML and replay lost receipts across restart",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-notice-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
    let service,
      browser,
      releaseReceipt,
      port = 0;
    const receiptHeld = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    t.after(async () => {
      releaseReceipt();
      await browser?.close();
      await service?.close();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const text =
      '<img src=x onerror="window.syntheticNoticeInjected=true"> 알림';
    const store = new EntityStore(file);
    store.initializeState({
      settings: { didFirstSetup: true, language: "en", autoTranslate: false },
      resources: [],
    });
    store.applyCommand("c", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic notifications",
        desc: "Synthetic",
        firstMessage: '<button risu-btn="notify">Notify</button>',
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
onButtonClick = async(function(id, data)
  alertNormal(id, '${text}')
  sleep(id, 3500):await()
  pcall(alertError, id, 'Second retained notification')
  setChatVar(id, 'notified', 'yes')
end)`,
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
    });
    store.close();
    await fs.writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-password").digest("hex"),
    );
    async function startService() {
      service = await createProductionService({
        file,
        passwordFile,
        staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
        origin: "https://risu.test",
        insecureLocalTest: true,
        host: "127.0.0.1",
        port,
        runtime: { eventsPollMs: 20, scheduler: { pollMs: 20 } },
      });
      port = Number(new URL(service.url).port);
    }
    await startService();
    browser = await launchChromium(root);
    const ca = await browser.newContext(),
      cb = await browser.newContext(),
      errors = [];
    async function open(context) {
      const page = await browser.page(service.url, context, {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      page.on("Runtime.exceptionThrown", (event) =>
        errors.push(
          event.exceptionDetails.exception?.description ??
            event.exceptionDetails.text,
        ),
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('input[name=password]')||!!document.querySelector('[data-runtime-ready=true]')",
        ),
      );
      if (
        await page.evaluate("!!document.querySelector('input[name=password]')")
      )
        await page.evaluate(
          "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
        );
      try {
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=c]')",
          ),
        );
      } catch (error) {
        // Auth/data are authored fixtures. Preserve the failed bootstrap state
        // instead of reducing an intermittent login failure to boolean false.
        t.diagnostic(
          JSON.stringify({
            stage: "synthetic-notice-bootstrap",
            page: await page.evaluate(`({
            path: location.pathname,
            ready: document.querySelector('[data-runtime-ready]')?.getAttribute('data-runtime-ready'),
            characters: document.querySelectorAll('[data-character-id]').length,
            login: !!document.querySelector('input[name=password]'),
            text: document.body.textContent.slice(0, 4000)
          })`),
            exceptions: [...errors],
          }),
        );
        throw error;
      }
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('[risu-btn=notify]')"),
      );
      return page;
    }
    let a = await open(ca),
      b = await open(cb);
    await a.evaluate("document.querySelector('[risu-btn=notify]').click()");
    const first = await until(
      () => service.runtime.store.call("listNotices"),
      (value) => value.count === 1,
    );
    const job = (await service.runtime.store.call("listJobs", "a"))[0];
    assert.equal(job.state, "running");
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-notice-message]')?.textContent===${JSON.stringify(text)}`,
        ),
      );
    await a.close();
    await b.close();
    await until(
      () => service.runtime.store.call("getJobStatus", job.id),
      (value) => value.state === "completed",
    );
    assert.equal((await service.runtime.store.call("listNotices")).count, 2);
    assert.equal(
      (
        await service.runtime.store.call("readVariables", [
          { scope: "chat", chatId: "a", key: "$notified" },
        ])
      ).variables[0].value,
      "yes",
    );
    await service.runtime.store.call(
      "pruneChanges",
      (await service.runtime.store.call("bootstrap")).cursor,
    );
    await service.close();
    await startService();
    a = await open(ca);
    b = await open(cb);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-notice-message]')?.textContent===${JSON.stringify(text)}`,
        ),
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-notice] img')||!!window.syntheticNoticeInjected",
        ),
        false,
      );
      await page.evaluate(
        "window.noticePrefix=document.querySelector('[risu-btn=notify]');window.noticeMessage=document.querySelector('.chattext')",
      );
    }
    const call = service.runtime.store.call.bind(service.runtime.store),
      observed = [];
    let hold = true;
    service.runtime.store.call = async (method, ...args) => {
      const value = await call(method, ...args);
      if (method === "applyCommand" && args[1]?.type === "acknowledge-notice") {
        observed.push({ id: args[0], command: structuredClone(args[1]) });
        if (hold) await receiptHeld;
      }
      return value;
    };
    await a.evaluate(
      "document.querySelector('[data-runtime-notice-ack]').click()",
    );
    await until(() => observed.length === 1);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-runtime-notice-message]')?.textContent==='Second retained notification'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "window.noticePrefix===document.querySelector('[risu-btn=notify]')&&window.noticeMessage===document.querySelector('.chattext')&&window.noticePrefix.isConnected",
        ),
        true,
      );
    }
    assert.equal(observed[0].command.noticeId, first.items[0].id);
    const oldId = observed[0].id;
    await a.close();
    await b.close();
    hold = false;
    releaseReceipt();
    // The accepted acknowledgement remains in device A's durable outbox because its HTTP receipt was lost.
    await service.close();
    await startService();
    const replayCall = service.runtime.store.call.bind(service.runtime.store);
    const replayed = [];
    service.runtime.store.call = async (method, ...args) => {
      if (method === "applyCommand" && args[1]?.type === "acknowledge-notice")
        replayed.push({ id: args[0], command: args[1] });
      return replayCall(method, ...args);
    };
    a = await open(ca);
    b = await open(cb);
    await until(() => replayed.some((item) => item.id === oldId));
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "document.querySelector('[data-runtime-notice-message]')?.textContent==='Second retained notification'",
        ),
      );
    assert.equal((await service.runtime.store.call("listNotices")).count, 1);
    await b.evaluate(
      "document.querySelector('[data-runtime-notice-ack]').click()",
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate("!document.querySelector('[data-runtime-notice]')"),
      );
    assert.equal((await service.runtime.store.call("listNotices")).count, 0);
    assert.equal((await service.runtime.store.call("listJobs", "a")).length, 1);
    assert.equal(
      (await service.runtime.store.call("getJobStatus", job.id)).state,
      "completed",
    );
    assert.deepEqual(errors, []);
  },
);
