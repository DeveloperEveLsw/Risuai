"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
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
    await delay(30);
  } while (Date.now() < end);
  throw Error(
    "Synthetic result UI condition timed out: " + JSON.stringify(value),
  );
}

test(
  "two authenticated built browsers inspect raw retained output and recover once after modal navigation",
  {
    timeout: 120000,
    skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
  },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-result-ui-")),
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
    for (const id of ["c", "other"])
      store.applyCommand(id, {
        type: "create-character",
        characterId: id,
        definition: {
          type: "character",
          name: "Synthetic " + id,
          desc: "Synthetic",
          firstMessage: "",
        },
        chat: {
          chatId: id === "c" ? "a" : "b",
          metadata: { name: "Synthetic history", localLore: [] },
        },
      });
    store.enqueueJob("source", {
      type: "send",
      chatId: "a",
      messageId: "input",
      input: "Synthetic",
    });
    const job = store.claimJob("worker").job;
    const raw =
      "<script>window.syntheticResultExecuted=true</script> Retained reply";
    store.finishJob(job.id, "worker", job.fence, {
      state: "failed",
      result: {
        code: "DATABASE_ERROR",
        message: "Synthetic save unavailable",
        uncommitted: {
          writeSet: {
            chatId: "a",
            expectedRevision: job.startedRevision,
            expectedContentRevision: job.startedContentRevision,
            characterReads: [{ id: "c", expectedEpoch: 0 }],
            messages: [
              {
                id: "saved",
                expectedRevision: 0,
                message: { role: "char", data: raw },
              },
            ],
            variables: [
              { key: "$recovery-effect", value: "once", expectedRevision: 0 },
            ],
          },
          result: { script: "synthetic-secret-do-not-show" },
        },
      },
    });
    store.enqueueJob("conflict", {
      type: "send",
      chatId: "b",
      input: "Synthetic",
    });
    const conflict = store.claimJob("worker").job;
    store.finishJob(conflict.id, "worker", conflict.fence, {
      state: "failed",
      result: {
        message: "Synthetic retained conflict",
        uncommitted: {
          writeSet: {
            chatId: "b",
            expectedRevision: conflict.startedRevision,
            expectedContentRevision: conflict.startedContentRevision,
            characterReads: [{ id: "other", expectedEpoch: 0 }],
            messages: [
              {
                id: "conflict-reply",
                expectedRevision: 0,
                message: { role: "char", data: "Retained conflict reply" },
              },
            ],
            variables: [
              { key: "$conflict", expectedRevision: 0, value: "computed" },
            ],
          },
        },
      },
    });
    store.enqueueJob("partial", {
      type: "send",
      chatId: "b",
      input: "Synthetic",
    });
    const partial = store.claimJob("worker").job;
    store.writeJobProgress(partial.id, "worker", partial.fence, {
      messages: [
        {
          role: "char",
          chatId: "partial-message",
          data: "<b>Synthetic partial</b>",
        },
      ],
    });
    store.interruptJob(
      partial.id,
      "worker",
      partial.fence,
      "Synthetic interruption",
    );
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
        page.evaluate(
          "!!document.querySelector('[data-runtime-result=source]')",
        ),
      );
      const compact = await page.evaluate(
        "fetch('/api/runtime/jobs/source/status').then(r=>r.text())",
      );
      assert.equal(compact.includes("synthetic-secret-do-not-show"), false);
      assert.equal(compact.includes("Retained reply"), false);
      assert.equal(
        await page.evaluate(
          "document.body.textContent.includes('synthetic-secret-do-not-show')",
        ),
        false,
      );
      await page.evaluate(
        "document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=source]').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('[data-runtime-recover]')"),
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-runtime-result-review] textarea').value",
        ),
        raw,
      );
      assert.equal(
        await page.evaluate("!!window.syntheticResultExecuted"),
        false,
      );
      return page;
    }
    const a = await open(),
      b = await open();
    // The review captures the source before navigation. Programmatic navigation
    // exercises the same public original sidebar control behind the modal.
    await b.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await Promise.all([
      a.evaluate("document.querySelector('[data-runtime-recover]').click()"),
      b.evaluate("document.querySelector('[data-runtime-recover]').click()"),
    ]);
    await until(() =>
      a.evaluate("!!document.querySelector('[data-runtime-result-saved]')"),
    );
    await until(() =>
      b.evaluate("!!document.querySelector('[data-runtime-result-saved]')"),
    );
    const saved = await service.runtime.store.call("snapshot", "a"),
      other = await service.runtime.store.call("snapshot", "b");
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].message.data, raw);
    assert.equal(
      saved.variables.find((v) => v.key === "$recovery-effect").value,
      "once",
    );
    assert.equal(other.messages.length, 0);
    assert.equal(other.variables.length, 0);
    assert.equal(await a.evaluate("!!window.syntheticResultExecuted"), false);
    assert.equal(await b.evaluate("!!window.syntheticResultExecuted"), false);
    await b.evaluate(
      "Array.from(document.querySelector('[data-runtime-result-review]').querySelectorAll('button')).find(el=>el.textContent==='닫기').click();document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=conflict]').click()",
    );
    await until(() =>
      b.evaluate("!!document.querySelector('[data-runtime-recover]')"),
    );
    await service.runtime.store.call("applyCommand", "peer-variable", {
      type: "set-chat-variable",
      chatId: "b",
      key: "$conflict",
      value: "peer",
    });
    await b.evaluate(
      "document.querySelector('[data-runtime-recover]').click()",
    );
    await until(() =>
      b.evaluate(
        "document.querySelector('[data-runtime-result-review] [role=alert]')?.textContent.includes('changed')",
      ),
    );
    assert.equal(
      (await service.runtime.store.call("snapshot", "b")).messages.length,
      0,
    );
    assert.equal(
      (await service.runtime.store.call("snapshot", "b")).variables[0].value,
      "peer",
    );
    assert.equal(
      (await service.runtime.store.call("previewJobResult", "conflict"))
        .messages[0].data,
      "Retained conflict reply",
    );
    await b.evaluate(
      "Array.from(document.querySelector('[data-runtime-result-review]').querySelectorAll('button')).find(el=>el.textContent==='닫기').click();document.querySelector('[data-runtime-result=partial]').click()",
    );
    await until(() =>
      b.evaluate(
        "document.querySelector('[data-runtime-result-review] textarea')?.value==='<b>Synthetic partial</b>'",
      ),
    );
    assert.equal(
      await b.evaluate("!!document.querySelector('[data-runtime-recover]')"),
      false,
    );
    assert.deepEqual(errors, []);
    await a.send("Page.reload");
    await until(() =>
      a.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
    );
    const status = await service.runtime.store.call("getJobStatus", "source");
    assert.equal(status.disposition.action, "recover");
    assert.equal(
      (await service.runtime.store.call("snapshot", "a")).messages.length,
      1,
    );
  },
);
