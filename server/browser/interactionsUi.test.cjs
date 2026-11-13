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
  throw Error("Synthetic interaction UI timeout: " + JSON.stringify(value));
}
test(
  "built original HTML/Lua interactive prompts survive all-tab exit, resolve one peer answer, replay lost receipts and close on same-origin restart without Lua replay",
  { timeout: 120000, skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-interaction-ui-")),
      file = join(root, "state.sqlite"),
      passwordFile = join(root, "password");
    let service,
      browser,
      port = 0,
      releaseAnswers,
      releaseReceipts;
    const answersHeld = new Promise((resolve) => {
        releaseAnswers = resolve;
      }),
      receiptsHeld = new Promise((resolve) => {
        releaseReceipts = resolve;
      });
    t.after(async () => {
      releaseAnswers();
      releaseReceipts();
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
      '<img src=x onerror="window.syntheticInteractionInjected=true"> Synthetic input';
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
        name: "Synthetic interactions",
        desc: "Synthetic",
        firstMessage: '<button risu-btn="ask">Ask synthetic</button>',
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
onButtonClick = async(function(id, data)
  local name=alertInput(id, '${text}'):await()
  local choice=alertSelect(id, {'same','same'}):await()
  local accepted=alertConfirm(id, 'Synthetic confirmation'):await()
  setChatVar(id,'input',name)
  setChatVar(id,'choice',choice)
  setChatVar(id,'confirmed',tostring(accepted))
  return name .. ':' .. choice .. ':' .. tostring(accepted)
end)`,
              },
            ],
          },
        ],
      },
      chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
    });
    store.applyCommand("other", {
      type: "create-character",
      characterId: "other",
      definition: {
        type: "character",
        name: "Synthetic other",
        firstMessage: "Synthetic other",
      },
      chat: { chatId: "b", metadata: { name: "Other", localLore: [] } },
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
        runtime: {
          eventsPollMs: 20,
          scheduler: { pollMs: 20, concurrency: 1 },
        },
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
      return page;
    }
    let a = await open(ca),
      b = await open(cb);
    await a.evaluate("document.querySelector('[risu-btn=ask]').click()");
    const first = await until(
      () => service.runtime.store.call("listInteractions"),
      (p) => p.count === 1,
    );
    const input = first.items[0],
      job = (await service.runtime.store.call("listJobs", "a"))[0];
    assert.equal(job.state, "running");
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-interaction-prompt]')?.textContent===${JSON.stringify(text)}`,
        ),
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-interaction] img')||!!window.syntheticInteractionInjected",
        ),
        false,
      );
    }
    await a.close();
    await b.close();
    assert.equal(
      (await service.runtime.store.call("getJob", job.id)).state,
      "running",
    );
    await service.runtime.store.call(
      "pruneChanges",
      (await service.runtime.store.call("bootstrap")).cursor,
    );
    a = await open(ca);
    b = await open(cb);
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-interaction]')?.dataset.runtimeInteraction===${JSON.stringify(input.id)}&&!!document.querySelector('[data-runtime-interaction-input]')`,
        ),
      );
    const call = service.runtime.store.call.bind(service.runtime.store),
      observed = [];
    let holdAnswers = true,
      holdReceipts = true;
    service.runtime.store.call = async (method, ...args) => {
      if (method === "applyCommand" && args[1]?.type === "answer-interaction") {
        observed.push({ id: args[0], command: structuredClone(args[1]) });
        if (holdAnswers && args[1].interactionId === input.id)
          await answersHeld;
        const result = await call(method, ...args);
        if (holdReceipts && args[1].interactionId === input.id)
          await receiptsHeld;
        return result;
      }
      return call(method, ...args);
    };
    const fill = async (page, value) =>
      page.evaluate(
        `(()=>{const el=document.querySelector('[data-runtime-interaction-input]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.closest('form').requestSubmit();})()`,
      );
    await fill(a, "한글 winner");
    await until(() => observed.length === 1);
    await fill(b, "peer loser");
    await until(() => observed.length === 2);
    for (const page of [a, b])
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-runtime-interaction-submit]').disabled",
        ),
        true,
      );
    holdAnswers = false;
    releaseAnswers();
    const selected = await until(
      () => call("listInteractions"),
      (p) => p.items[0]?.kind === "select",
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-interaction]')?.dataset.runtimeInteraction===${JSON.stringify(selected.items[0].id)}&&document.querySelectorAll('[data-runtime-interaction-option]').length===2`,
        ),
      );
    await until(() =>
      b.evaluate(
        "Array.from(document.querySelectorAll('[data-runtime-ready] button')).some(el=>el.textContent.trim()==='요청 취소')",
      ),
    );
    await b.evaluate(
      "Array.from(document.querySelectorAll('[data-runtime-ready] button')).find(el=>el.textContent.trim()==='요청 취소').click()",
    );
    await a.close();
    a = await open(ca);
    await until(
      () => observed.filter((item) => item.id === observed[0].id).length >= 2,
    );
    await until(() =>
      a.evaluate(
        `document.querySelector('[data-runtime-interaction]')?.dataset.runtimeInteraction===${JSON.stringify(selected.items[0].id)}`,
      ),
    );
    for (const page of [a, b])
      await page.evaluate(
        "window.interactionPrefix=document.querySelector('[risu-btn=ask]');window.interactionRow=document.querySelector('.chattext')",
      );
    await b.evaluate(
      "document.querySelector('[data-runtime-interaction-option=\"1\"]').click()",
    );
    const confirm = await until(
      () => call("listInteractions"),
      (p) => p.items[0]?.kind === "confirm",
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          `document.querySelector('[data-runtime-interaction]')?.dataset.runtimeInteraction===${JSON.stringify(confirm.items[0].id)}&&!!document.querySelector('[data-runtime-interaction-no]')`,
        ),
      );
    await b.evaluate(
      "document.querySelector('[data-runtime-interaction-no]').click()",
    );
    await until(
      () => call("getJob", job.id),
      (j) => j.state === "completed",
    );
    assert.equal(
      (await call("getJob", job.id)).result.value,
      "한글 winner:1:false",
    );
    holdReceipts = false;
    releaseReceipts();
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate("!document.querySelector('[data-runtime-interaction]')"),
      );
      assert.equal(
        await page.evaluate(
          "window.interactionPrefix===document.querySelector('[risu-btn=ask]')&&window.interactionPrefix.isConnected&&window.interactionRow===document.querySelector('.chattext')",
        ),
        true,
      );
    }
    assert.equal(
      observed.filter((item) => item.id === observed[0].id).length >= 2,
      true,
    );
    const ids = new Set(
      observed
        .filter(
          (item) =>
            item.command.interactionId === input.id &&
            item.command.answer === "한글 winner",
        )
        .map((item) => item.id),
    );
    assert.equal(ids.size, 1);
    const saved = await call("snapshot", "a");
    assert.equal(
      saved.variables.find((v) => v.key === "$confirmed").value,
      "false",
    );
    await b.evaluate("document.querySelector('[risu-btn=ask]').click()");
    await until(
      () => call("listInteractions"),
      (p) => p.count === 1,
    );
    const cancelled = (await call("listJobs", "a"))[0];
    await until(() =>
      a.evaluate(
        "!!document.querySelector('[data-runtime-interaction-cancel]')",
      ),
    );
    await a.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await until(() =>
      a.evaluate(
        "Array.from(document.querySelectorAll('.chattext')).some(el=>el.textContent.includes('Synthetic other'))",
      ),
    );
    await a.evaluate(
      "document.querySelector('[data-runtime-interaction-cancel]').click()",
    );
    await until(
      () => call("getJob", cancelled.id),
      (j) => j.state === "cancelled",
    );
    assert.deepEqual((await call("snapshot", "a")).variables, saved.variables);
    assert.equal((await call("snapshot", "b")).variables.length, 0);
    await a.evaluate("document.querySelector('[data-character-id=c]').click()");
    await until(() => a.evaluate("!!document.querySelector('[risu-btn=ask]')"));
    await b.evaluate("document.querySelector('[risu-btn=ask]').click()");
    await until(
      () => call("listInteractions"),
      (p) => p.count === 1,
    );
    const interrupted = (await call("listJobs", "a"))[0];
    await a.close();
    await b.close();
    await service.close();
    await startService();
    await service.runtime.store.call(
      "pruneChanges",
      (await service.runtime.store.call("bootstrap")).cursor,
    );
    a = await open(ca);
    b = await open(cb);
    assert.equal(
      (await service.runtime.store.call("getJob", interrupted.id)).state,
      "interrupted",
    );
    assert.equal((await service.runtime.store.call("listJobs", "a")).length, 3);
    assert.equal(
      (await service.runtime.store.call("listInteractions")).count,
      0,
    );
    for (const page of [a, b])
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-interaction]')",
        ),
        false,
      );
    assert.deepEqual(
      (await service.runtime.store.call("snapshot", "a")).variables,
      saved.variables,
    );
    assert.deepEqual(errors, []);
  },
);
