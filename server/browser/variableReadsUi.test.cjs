"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path"),
  { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(
    "Synthetic variable-read UI timeout: " + JSON.stringify(value),
  );
}
test(
  "built two-device original Lua rejects a changed read without replacing the row, shows retained output and preserves a fresh explicit invocation",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-variable-read-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
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
        name: "Synthetic",
        desc: "Synthetic",
        firstMessage: '<button risu-btn="ask">Synthetic read</button>',
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
onButtonClick = async(function(id, data)
  local source = getGlobalVar(id, 'source')
  alertInput(id, 'Synthetic read completed'):await()
  setChatVar(id, 'derived', source)
  addChat(id, 'char', 'derived:' .. source)
  return source
end)`,
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
    });
    store.applyCommand("seed", {
      type: "change-variables",
      edits: [
        {
          scope: "global",
          key: "source",
          expectedRevision: 0,
          value: "before",
        },
      ],
    });
    const baseline = store.snapshot("a");
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
    const errors = [];
    async function open() {
      const page = await browser.page(service.url, await browser.newContext(), {
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
        page.evaluate("!!document.querySelector('[risu-btn=ask]')"),
      );
      await page.evaluate(
        "window.readPrefix=document.querySelector('[risu-btn=ask]');window.readRow=window.readPrefix.closest('.chattext')",
      );
      return page;
    }
    const a = await open(),
      b = await open();
    const call = (...args) => service.runtime.store.call(...args);
    await a.evaluate("document.querySelector('[risu-btn=ask]').click()");
    await until(
      () => call("listInteractions"),
      (p) => p.count === 1,
    );
    const job = (await call("listJobs", "a"))[0];
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-interaction-input]')",
        ),
      );
    const edit = await b.evaluate(
      `(async()=>{const response=await fetch('/api/runtime/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),command:{type:'change-variables',edits:[{scope:'global',key:'source',expectedRevision:1,value:'after'}]}})});return response.status;})()`,
    );
    assert.equal(edit, 200);
    await b.evaluate(
      "const el=document.querySelector('[data-runtime-interaction-input]');el.value='resume';el.dispatchEvent(new Event('input',{bubbles:true}));el.closest('form').requestSubmit()",
    );
    const failed = await until(
      () => call("getJob", job.id),
      (j) => ["failed", "completed"].includes(j.state),
    );
    assert.equal(failed.state, "failed");
    assert.equal(failed.result.code, "REVISION_CONFLICT");
    assert.equal(failed.result.uncommitted.result.value, "before");
    assert.deepEqual((await call("snapshot", "a")).messages, baseline.messages);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          `!!document.querySelector('[data-runtime-result="${job.id}"]')&&!document.querySelector('[data-runtime-interaction]')`,
        ),
      );
      assert.equal(
        await page.evaluate(
          "window.readPrefix===document.querySelector('[risu-btn=ask]')&&window.readPrefix.isConnected&&window.readRow===window.readPrefix.closest('.chattext')",
        ),
        true,
      );
    }
    await a.evaluate(
      `document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result="${job.id}"]').click()`,
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-result-review] textarea')?.value==='derived:before'",
      ),
    );
    assert.equal(
      await a.evaluate("!!document.querySelector('[data-runtime-recover]')"),
      false,
    );
    assert.equal(
      await a.evaluate(
        "document.querySelector('[data-runtime-result-review]').textContent.includes('REVISION_CONFLICT')",
      ),
      true,
    );
    await a.evaluate(
      "Array.from(document.querySelector('[data-runtime-result-review]').querySelectorAll('button')).find(el=>el.textContent==='닫기').click();document.querySelector('[risu-btn=ask]').click()",
    );
    await until(
      () => call("listInteractions"),
      (p) => p.count === 1,
    );
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-interaction-input]')",
      ),
    );
    await a.evaluate(
      "const el=document.querySelector('[data-runtime-interaction-input]');el.value='resume';el.dispatchEvent(new Event('input',{bubbles:true}));el.closest('form').requestSubmit()",
    );
    const completed = await until(
      () => call("listJobs", "a"),
      (jobs) => jobs.some((j) => j.id !== job.id && j.state === "completed"),
    );
    assert.equal(completed.length, 2);
    const saved = await call("snapshot", "a");
    assert.equal(saved.messages.at(-1).message.data, "derived:after");
    assert.equal(
      saved.variables.find((v) => v.key === "$derived").value,
      "after",
    );
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.querySelectorAll('.chattext').length===2&&Array.from(document.querySelectorAll('.chattext')).some(el=>el.textContent.includes('derived:after'))",
        ),
      );
      console.log(
        "variable-read-dom-observation:",
        await page.evaluate(
          "JSON.stringify({samePrefix:window.readPrefix===document.querySelector('[risu-btn=ask]'),sameRow:window.readRow===window.readPrefix.closest('.chattext'),prefixConnected:window.readPrefix.isConnected,rowConnected:window.readRow.isConnected})",
        ),
      );
      assert.equal(
        await page.evaluate(
          "window.readPrefix===document.querySelector('[risu-btn=ask]')&&window.readRow===window.readPrefix.closest('.chattext')",
        ),
        true,
      );
    }
    assert.deepEqual(errors, []);
  },
);
