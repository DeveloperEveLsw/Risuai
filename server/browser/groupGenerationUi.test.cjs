"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
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
  throw Error(
    "Synthetic group UI condition timed out: " + JSON.stringify(value),
  );
}

test(
  "built original group UI retains member batches across tab exit, reroll and a killed process with service restart",
  {
    timeout: 150000,
    skip: !process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
  },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-group-ui-"));
    let service, browser, provider;
    let releaseFirst, releaseSecond, releaseReroll;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const rerollLast = new Promise((resolve) => {
      releaseReroll = resolve;
    });
    let calls = 0;
    t.after(async () => {
      releaseFirst();
      releaseSecond();
      releaseReroll();
      await browser?.close();
      await service?.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      const count = ++calls;
      res.setHeader("content-type", "text/event-stream");
      const delta = (text) =>
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: text } }] }) +
        "\n\n";
      res.write(
        delta(count % 2 ? "Synthetic Alpha reply" : "Synthetic Beta reply"),
      );
      if (count === 1) await first;
      if (count === 2) await second;
      if (count === 4) await rerollLast;
      if (count === 6) {
        await new Promise((resolve) => res.on("close", resolve));
        return;
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const file = join(root, "entity.sqlite"),
      passwordFile = join(root, "password");
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        sendWithEnter: true,
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        customTokenizer: "tik",
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        useStreaming: true,
        streamingDisplayOptimizationMode: "strong",
        maxContext: 8000,
        maxResponse: 100,
        mainPrompt: "Synthetic group",
      },
      resources: [],
    });
    for (const [id, name] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]) {
      store.applyCommand("member-" + id, {
        type: "create-character",
        characterId: id,
        definition: {
          type: "character",
          name,
          desc: "Synthetic member",
          firstMessage: "Synthetic greeting",
        },
      });
    }
    store.applyCommand("synthetic-group", {
      type: "create-character",
      characterId: "group",
      definition: {
        type: "group",
        name: "Synthetic group",
        characters: ["alpha", "beta"],
        characterTalks: [1, 1],
        characterActive: [true, true],
        orderByOrder: false,
        autoMode: false,
        customscript: [
          {
            comment: "Original null display argument skips group regex",
            in: "Synthetic",
            out: "MUST_NOT_APPLY",
            type: "editdisplay",
          },
        ],
        triggerscript: [],
        globalLore: [],
      },
      chat: {
        chatId: "group-chat",
        metadata: { name: "Synthetic group chat", localLore: [] },
      },
    });
    store.close();
    await fs.writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-password").digest("hex"),
    );
    const startService = () =>
      createProductionService({
        file,
        passwordFile,
        staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
        origin: "https://risu.test",
        insecureLocalTest: true,
        host: "127.0.0.1",
        port: 0,
        runtime: {
          eventsPollMs: 20,
          scheduler: { pollMs: 20, progressIntervalMs: 25 },
        },
      });
    service = await startService();
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
          "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=group]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=group]').click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('textarea.input-text')&&!document.querySelector('textarea.input-text').disabled",
        ),
      );
      return page;
    }
    let a = await open(),
      b = await open();
    await a.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Alpha Beta';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(
      () => calls,
      (n) => n === 1,
    );
    const hasText = (text) =>
      `Array.from(document.querySelectorAll('[data-message-id] .chattext')).some(el=>el.textContent.includes(${JSON.stringify(text)}))`;
    await until(() => a.evaluate(hasText("Synthetic Alpha reply")));
    await until(() => b.evaluate(hasText("Synthetic Alpha reply")));
    const firstId = await b.evaluate(
      "Array.from(document.querySelectorAll('[data-message-id]')).find(el=>el.textContent.includes('Synthetic Alpha reply')).dataset.messageId",
    );
    await b.evaluate(
      `window.firstGroupRow=document.querySelector('[data-message-id="${firstId}"]')`,
    );
    await a.close();
    releaseFirst();
    await until(
      () => calls,
      (n) => n === 2,
    );
    await until(() => b.evaluate(hasText("Synthetic Beta reply")));
    assert.equal(
      await b.evaluate(
        `window.firstGroupRow===document.querySelector('[data-message-id="${firstId}"]')&&window.firstGroupRow.isConnected&&window.firstGroupRow.textContent.includes('Synthetic Alpha reply')`,
      ),
      true,
      "Earlier member reply must remain visible while the next member streams",
    );
    await b.close();
    releaseSecond();
    const jobs = await until(
      () => service.runtime.store.call("listJobs", "group-chat"),
      (rows) => rows[0]?.state === "completed",
    );
    assert.equal(jobs.length, 1);
    const completed = await service.runtime.store.call("getJob", jobs[0].id);
    assert.equal(completed.result.providerCalls, 2);
    const snapshot = await service.runtime.store.call("snapshot", "group-chat");
    assert.equal(snapshot.messages.length, 3);
    assert.equal(snapshot.messages[1].id, firstId);
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    a = await open();
    b = await open();
    for (const page of [a, b]) {
      await until(() => page.evaluate(hasText("Synthetic Alpha reply")));
      await until(() => page.evaluate(hasText("Synthetic Beta reply")));
      const ids = await page.evaluate(
        "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
      );
      assert.deepEqual(ids, snapshot.messages.map((row) => row.id).reverse());
      assert.ok(
        await page.evaluate(
          "document.body.textContent.includes('Alpha')&&document.body.textContent.includes('Beta')",
        ),
      );
    }
    assert.deepEqual(errors, []);
    assert.equal(calls, 2);
    // The real original reroll control must replace both members in the latest
    // batch, preserving the user row and the previous batch until completion.
    const oldReplyIds = snapshot.messages.slice(1).map((row) => row.id);
    for (const page of [a, b])
      await page.evaluate(
        `window.oldGroupRows=${JSON.stringify(oldReplyIds)}.map(id=>document.querySelector('[data-message-id="'+id+'"]'))`,
      );
    await until(() =>
      a.evaluate(
        `!!document.querySelector('[data-message-id="${oldReplyIds[1]}"] .button-icon-reroll')`,
      ),
    );
    await a.evaluate(
      `document.querySelector('[data-message-id="${oldReplyIds[1]}"] .button-icon-reroll').click()`,
    );
    await until(
      () => calls,
      (n) => n === 4,
    );
    const during = await service.runtime.store.call("snapshot", "group-chat");
    assert.deepEqual(during.messages, snapshot.messages);
    assert.deepEqual(during.variables, snapshot.variables);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.querySelectorAll('[data-message-id]').length===5",
        ),
      );
      assert.equal(
        await page.evaluate(
          `window.oldGroupRows.every((el,i)=>el.isConnected&&el===document.querySelector('[data-message-id="'+${JSON.stringify(oldReplyIds)}[i]+'"]'))`,
        ),
        true,
        "Confirmed original member rows must survive the pending reroll",
      );
    }
    releaseReroll();
    await until(
      async () => service.runtime.store.call("listJobs", "group-chat"),
      (rows) => rows.length === 2 && rows[0].state === "completed",
    );
    const rerolled = await service.runtime.store.call("snapshot", "group-chat");
    assert.equal(calls, 4);
    assert.equal(rerolled.messages.length, 3);
    assert.equal(rerolled.messages[0].id, snapshot.messages[0].id);
    assert.ok(
      rerolled.messages.slice(1).every((row) => !oldReplyIds.includes(row.id)),
    );
    assert.deepEqual(
      rerolled.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    for (const page of [a, b])
      await until(
        () =>
          page.evaluate(
            "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
          ),
        (ids) =>
          JSON.stringify(ids) ===
          JSON.stringify(rerolled.messages.map((row) => row.id).reverse()),
      );
    assert.deepEqual(errors, []);
    // Both original arrows select full saved group batches across devices.
    // No new provider call or variable rewind is allowed, and the input DOM stays.
    const pendingCommands =
      "(async()=>{const out=[];for(const name of (await indexedDB.databases()).filter(x=>x.name.startsWith('risu-runtime-outbox:'))){const db=await new Promise(ok=>{const r=indexedDB.open(name.name);r.onsuccess=()=>ok(r.result)});const rows=await new Promise(ok=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>ok(r.result)});out.push(...rows.filter(x=>x.command.type==='move-reply-choice'));db.close();}return out.length;})()";
    for (const page of [a, b])
      await page.evaluate(
        `window.historyUser=document.querySelector('[data-message-id="${snapshot.messages[0].id}"]')`,
      );
    for (const [page, direction, expected] of [
      [a, "previous", snapshot],
      [b, "next", rerolled],
    ]) {
      // Message IDs can project before the terminal job event releases doingChat.
      // The original screen deliberately ignores arrows while its send UI is busy.
      await until(() =>
        page.evaluate("!!document.querySelector('.button-icon-send')"),
      );
      await until(
        () => page.evaluate(pendingCommands),
        (n) => n === 0,
      );
      const current = await service.runtime.store.call(
        "snapshot",
        "group-chat",
      );
      await page.evaluate(
        `document.querySelector('[data-message-id="${current.messages.at(-1).id}"] .button-icon-${direction === "previous" ? "unreroll" : "reroll"}').click()`,
      );
      for (const peer of [a, b]) {
        await until(
          () =>
            peer.evaluate(
              "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
            ),
          (ids) =>
            JSON.stringify(ids) ===
            JSON.stringify(expected.messages.map((r) => r.id).reverse()),
        );
        await until(
          () => peer.evaluate(pendingCommands),
          (n) => n === 0,
        );
        assert.equal(
          await peer.evaluate(
            `window.historyUser===document.querySelector('[data-message-id="${snapshot.messages[0].id}"]')&&window.historyUser.isConnected`,
          ),
          true,
        );
      }
      const selected = await service.runtime.store.call(
        "snapshot",
        "group-chat",
      );
      assert.deepEqual(
        selected.messages.map((r) => r.message),
        expected.messages.map((r) => r.message),
      );
      assert.deepEqual(selected.variables, rerolled.variables);
      assert.equal(calls, 4);
    }
    // Crash the real process during another compound reroll. Its completed
    // first response and streaming second response remain diagnostic progress,
    // while the already confirmed batch survives on both screens and disk.
    const crashBaseline = await service.runtime.store.call(
      "snapshot",
      "group-chat",
    );
    const retainedIds = crashBaseline.messages.slice(1).map((row) => row.id);
    for (const page of [a, b])
      await page.evaluate(
        `window.retainedGroupRows=${JSON.stringify(retainedIds)}.map(id=>document.querySelector('[data-message-id="'+id+'"]'))`,
      );
    await a.evaluate(
      `document.querySelector('[data-message-id="${retainedIds[1]}"] .button-icon-reroll').click()`,
    );
    const running = await until(
      () => service.runtime.store.call("listJobs", "group-chat"),
      (rows) => rows.length === 3 && rows[0].state === "running",
    );
    const jobId = running[0].id;
    const checkpoint = await until(
      () => service.runtime.store.call("getJob", jobId),
      (job) =>
        job.progress.providerCalls === 2 &&
        job.progress.messages?.length === 2 &&
        job.progress.messages.at(-1).data === "Synthetic Beta reply",
    );
    assert.equal(calls, 6);
    assert.deepEqual(
      checkpoint.progress.messages.map((m) => m.saying),
      ["alpha", "beta"],
    );
    for (const page of [a, b])
      await until(() =>
        page.evaluate(
          "document.querySelectorAll('[data-message-id]').length===5",
        ),
      );
    const entry = service.runtime.scheduler.running.get(jobId);
    assert.ok(entry.worker.pid);
    await entry.worker.terminate();
    await entry.done;
    const stopped = await service.runtime.store.call("getJob", jobId);
    assert.equal(stopped.state, "interrupted");
    assert.equal(stopped.result.mayHaveExternalEffects, true);
    assert.deepEqual(stopped.progress.messages, checkpoint.progress.messages);
    const afterCrash = await service.runtime.store.call(
      "snapshot",
      "group-chat",
    );
    assert.deepEqual(afterCrash.messages, crashBaseline.messages);
    assert.deepEqual(afterCrash.variables, crashBaseline.variables);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.body.textContent.includes('Job interrupted')&&document.querySelectorAll('[data-message-id]').length===3",
        ),
      );
      assert.equal(
        await page.evaluate(
          `window.retainedGroupRows.every((el,i)=>el.isConnected&&el===document.querySelector('[data-message-id="'+${JSON.stringify(retainedIds)}[i]+'"]'))`,
        ),
        true,
      );
      await page.close();
    }
    await service.close();
    service = await startService();
    for (const page of [await open(), await open()]) {
      await until(() =>
        page.evaluate("document.body.textContent.includes('Job interrupted')"),
      );
      const ids = await page.evaluate(
        "Array.from(document.querySelectorAll('[data-message-id]')).map(el=>el.dataset.messageId)",
      );
      assert.deepEqual(ids, rerolled.messages.map((row) => row.id).reverse());
      await page.close();
    }
    const restored = await service.runtime.store.call("getJob", jobId);
    assert.deepEqual(restored, stopped);
    assert.equal(
      calls,
      6,
      "Restart must not repeat either uncertain member request",
    );
    assert.deepEqual(errors, []);
  },
);
