"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStoreClient } = require("../entity/client.cjs");
const { TRIAL_PASSWORD } = require("../runtime/localTrial.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Local trial UI condition timed out: " + JSON.stringify(last));
}

test(
  "local user trial: original built UI login, peer toggle and HTML Lua, stable streamed DOM, every-tab exit and reconnect",
  {
    timeout: 300000,
    skip:
      process.env.RISU_LOCAL_TRIAL_BUILD !== "TRUE" &&
      !process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
  },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-local-trial-browser-"),
    );
    const parent = resolve(__dirname, "../../.local-runtime/trials");
    await mkdir(parent, { recursive: true });
    const ownedBuild = await mkdtemp(join(parent, "accept-"));
    let child, browser, store;
    t.after(async () => {
      await browser?.close();
      await store?.close();
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        await exited;
        clearTimeout(timer);
      }
      for (const path of [directory, ownedBuild])
        await rm(path, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
    });
    const args =
      process.env.RISU_LOCAL_TRIAL_BUILD === "TRUE"
        ? []
        : ["--built-ui", process.env.RISU_DISPLAY_WORKER_BUILD_PATH];
    child = fork(join(__dirname, "../runtime/localTrial.cjs"), args, {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        RISU_LOCAL_TRIAL_PARENT: ownedBuild,
        RISU_LOCAL_TRIAL_PORT: "0",
        RISU_LOCAL_TRIAL_DELAY_MS: "8000",
      },
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const ready = await new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message.ready) resolve(message);
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(Error("Trial CLI exited before ready: " + code)),
      );
    });
    const manifest = JSON.parse(
      await readFile(join(ready.directory, "trial.json"), "utf8"),
    );
    if (!args.length) {
      assert.ok(manifest.staticDirectory.startsWith(ownedBuild + "/trial-"));
      assert.ok(manifest.bundlePath.startsWith(ownedBuild + "/trial-"));
    }
    store = new EntityStoreClient(join(ready.directory, "entity.sqlite"));
    await store.ready;
    browser = await launchChromium(directory);
    const contexts = [await browser.newContext(), await browser.newContext()];
    const open = async (context) => {
      const page = await browser.page(ready.url, context, {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate(
          "!!document.querySelector('input[name=password]') || !!document.querySelector('[data-runtime-ready=true]')",
        ),
      );
      if (
        await page.evaluate("!!document.querySelector('input[name=password]')")
      ) {
        await page.evaluate(
          `document.querySelector('input[name=password]').value=${JSON.stringify(TRIAL_PASSWORD)};document.querySelector('form').requestSubmit()`,
        );
      }
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=true]') && !!document.querySelector('[data-character-id=local-trial-character]')",
        ),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=local-trial-character]').click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[risu-btn=trial-counter]') && !!document.querySelector('textarea.input-text')",
        ),
      );
      return page;
    };
    let a = await open(contexts[0]),
      b = await open(contexts[1]);
    const toggle = "document.querySelector('input[alt=\"동기화 시험 토글\"]')";
    await until(() => a.evaluate(`!!${toggle}`));
    await a.evaluate(`${toggle}.click()`);
    await until(() => b.evaluate(`${toggle}.checked`));
    await a.evaluate(
      "document.querySelector('[risu-btn=trial-counter]').click()",
    );
    await until(() =>
      b.evaluate("document.body.textContent.includes('카운터: 1')"),
    );
    await until(() =>
      b.evaluate(
        "!!document.querySelector('[data-message-id=local-trial-prefix] img')",
      ),
    );
    await b.evaluate(
      "window.prefixRow=document.querySelector('[data-message-id=local-trial-prefix]');window.prefixImage=window.prefixRow.querySelector('img');true",
    );
    const send = async (page, text) => {
      // Server completion can precede the browser's subscribed job update.
      // The original composer intentionally ignores Enter while doingChat.
      await until(() =>
        page.evaluate("!!document.querySelector('button.button-icon-send')"),
      );
      return page.evaluate(
        `(()=>{const input=document.querySelector('textarea.input-text');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
      );
    };
    await send(a, "첫 번째 합성 입력");
    console.log(
      "Trial provider admitted",
      await until(
        async () => (await fetch(ready.providerUrl + "/health")).json(),
        (stats) => stats.accepted === 1,
      ),
    );
    await until(() =>
      b.evaluate(
        "document.body.textContent.includes('연습 응답 1: 처리 중입니다.')",
      ),
    );
    await b.evaluate(
      "window.streamRow=[...document.querySelectorAll('[data-message-id]')].find(row=>row.textContent.includes('연습 응답 1: 처리 중입니다.'));true",
    );
    console.log(
      "Trial partial displayed",
      await (await fetch(ready.providerUrl + "/health")).json(),
    );
    assert.deepEqual(
      await b.evaluate(
        "({sameRow:window.prefixRow===document.querySelector('[data-message-id=local-trial-prefix]'),connected:window.prefixRow.isConnected,sameImage:window.prefixImage===window.prefixRow.querySelector('img'),complete:window.prefixImage.complete,width:window.prefixImage.naturalWidth})",
      ),
      {
        sameRow: true,
        connected: true,
        sameImage: true,
        complete: true,
        width: 1,
      },
    );
    await a.evaluate(`${toggle}.click()`);
    await until(() => b.evaluate(`!${toggle}.checked`));
    assert.equal(
      (await (await fetch(ready.providerUrl + "/health")).json()).active,
      1,
      "the peer toggle must synchronize before the delayed native provider finishes",
    );
    await until(() =>
      b.evaluate(
        "document.body.textContent.includes('완료했습니다.') && document.body.textContent.includes('마지막 응답: 완료')",
      ),
    );
    assert.equal(
      await b.evaluate(
        "window.streamRow.isConnected && window.streamRow.textContent.includes('완료했습니다.') && window.prefixImage===document.querySelector('[data-message-id=local-trial-prefix] img')",
      ),
      true,
    );
    await until(
      () => store.call("listJobs", "local-trial-a"),
      (rows) =>
        rows.some((job) => job.type === "send" && job.state === "completed"),
    );
    console.log("Trial next-send readiness", {
      sendReady: await a.evaluate(
        "!!document.querySelector('button.button-icon-send')",
      ),
      jobs: (await store.call("listJobs", "local-trial-a")).map((job) => ({
        type: job.type,
        state: job.state,
      })),
      provider: await (await fetch(ready.providerUrl + "/health")).json(),
    });
    await send(a, "탭을 닫는 두 번째 합성 입력");
    await until(() =>
      b.evaluate(
        "document.body.textContent.includes('연습 응답 2: 처리 중입니다.')",
      ),
    );
    const running = (await store.call("listJobs", "local-trial-a")).find(
      (job) => job.type === "send" && job.state === "running",
    );
    assert.ok(running);
    await a.close();
    await b.close();
    const saved = await until(
      () => store.call("getJob", running.id),
      (job) => ["completed", "failed"].includes(job.state),
    );
    assert.equal(saved.state, "completed", JSON.stringify(saved.error));
    a = await open(contexts[0]);
    await until(() =>
      a.evaluate(
        "document.body.textContent.includes('연습 응답 2: 처리 중입니다.') && document.body.textContent.includes('카운터: 1') && document.body.textContent.includes('마지막 응답: 완료')",
      ),
    );
    assert.equal(await a.evaluate(`${toggle}.checked`), false);
    const snapshot = await store.call("snapshot", "local-trial-a");
    assert.equal(
      snapshot.messages.filter((row) => row.message.role === "user").length,
      2,
    );
    const replies = snapshot.messages.filter((row) =>
      row.message.data.startsWith("연습 응답 "),
    );
    assert.equal(replies.length, 2);
    assert.ok(
      replies.every((row) => row.message.data.includes("완료했습니다.")),
    );
    assert.equal(
      new Set(snapshot.messages.map((row) => row.id)).size,
      snapshot.messages.length,
    );
    const stats = await (await fetch(ready.providerUrl + "/health")).json();
    assert.equal(stats.accepted, 2);
    assert.equal(stats.completed, 2);
    assert.equal(stats.aborted, 0);
    // Stable object references must still receive each confirmed aggregate
    // version in the optimized production UI, including adjacent edits.
    b = await open(contexts[1]);
    for (const page of [a, b]) {
      await page.evaluate(
        "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='캐릭터').click()",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('#runtime-character-name')"),
      );
      await page.evaluate(
        "[...document.querySelectorAll('button')].find(e=>e.querySelector('svg.lucide-volume-2')).click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-tts-settings]')",
        ),
      );
    }
    await a.evaluate(
      "(()=>{const e=document.querySelector('[data-runtime-tts-field=ttsMode] select');e.value='openai';e.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await until(() =>
      b.evaluate(
        "document.querySelector('[data-runtime-tts-field=ttsMode] select').value==='openai'",
      ),
    );
    await a.evaluate(
      "(()=>{const e=document.querySelector('[data-runtime-tts-field=\"oaiTTSConfig.enabled\"] input');e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await until(() =>
      a.evaluate("!!document.getElementById('runtime-tts-oaiTTSConfig.model')"),
    );
    for (const value of ["First authored model", "Second authored model"]) {
      await a.evaluate(
        `(()=>{const e=document.getElementById('runtime-tts-oaiTTSConfig.model');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      );
      await until(() =>
        b.evaluate(
          `document.getElementById('runtime-tts-oaiTTSConfig.model')?.value===${JSON.stringify(value)}`,
        ),
      );
    }
    assert.equal(
      (await store.call("getCharacter", "local-trial-character")).definition
        .oaiTTSConfig.model,
      "Second authored model",
    );
    for (const page of [a, b]) {
      await page.evaluate(
        "[...document.querySelectorAll('button')].find(e=>e.querySelector('svg.lucide-activity')).click()",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-character-module-action=convert] button')",
        ),
      );
    }
    const beforeModules =
      (await store.call("getResource", "settings", "global")).payload
        .moduleIds ?? [];
    const sourceCharacter = (
      await store.call("getCharacter", "local-trial-character")
    ).definition;
    await a.evaluate(
      "document.querySelector('[data-runtime-character-module-action=convert] button').click()",
    );
    const moduleIds = await until(
      async () =>
        (await store.call("getResource", "settings", "global")).payload
          .moduleIds,
      (ids) => ids?.length === beforeModules.length + 1,
    );
    const convertedId = moduleIds.find((id) => !beforeModules.includes(id));
    const converted = (await store.call("getResource", "module", convertedId))
      .payload;
    assert.equal(converted.name, sourceCharacter.name);
    assert.deepEqual(converted.trigger, sourceCharacter.triggerscript);
    assert.equal("chats" in converted, false);
    assert.deepEqual(
      (await store.call("getCharacter", "local-trial-character")).definition,
      sourceCharacter,
    );
    await b.evaluate(
      "document.querySelector('[data-runtime-character-module-action=apply] button').click()",
    );
    await until(() =>
      b.evaluate(
        `!!document.querySelector('[data-module-picker-id="${convertedId}"]')`,
      ),
    );
    await b.evaluate(
      "document.querySelector('[data-runtime-module-picker-close]').click()",
    );
    console.log(
      "Verified actual user CLI, original optimized UI, two isolated browser contexts, peer toggle during streaming, native button/output Lua, stable row/image identities, all-tab exit, one saved reply per input, successive TTS aggregate edits in the peer and original character-to-module conversion in a peer picker. Loopback synthetic provider only; physical mobile and representative latency remain unverified.",
    );
  },
);
