"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");
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
  throw Error("Synthetic button UI timeout: " + JSON.stringify(value));
}

test(
  "original HTML buttons acknowledge before server admission, preserve every invocation and converge after all-tab exit",
  { timeout: 180000 },
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), "risu-button-ui-"));
    const file = join(directory, "synthetic.sqlite");
    let runtime, production, frontend, browser, releaseAdmission;
    t.after(async () => {
      releaseAdmission?.();
      await browser?.close();
      await frontend?.close();
      await (production ?? runtime)?.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const store = new EntityStore(file);
    store.initializeState({
      settings: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        hideAllImages: true,
      },
      resources: [],
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "synthetic-buttons",
      definition: {
        type: "character",
        name: "Synthetic buttons",
        desc: "Synthetic",
        firstMessage:
          '<button id="synthetic-increment" risu-btn="increment" aria-checked="{{getvar::selected}}">Increment {{getvar::count}}</button><button id="synthetic-other" risu-btn="other">Other action</button><details id="synthetic-details"><summary>Local detail</summary>Independent local control</details>',
        customscript: [],
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `onButtonClick = async(function(id, data)
  local count = tonumber(getChatVar(id, 'count')) or 0
  setChatVar(id, 'count', tostring(count + 1))
  setChatVar(id, 'selected', 'true')
end)`,
              },
            ],
          },
        ],
      },
      chat: {
        chatId: "synthetic-chat",
        metadata: { name: "Synthetic", localLore: [] },
      },
    });
    store.applyCommand("variables", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "synthetic-chat",
          key: "$count",
          expectedRevision: 0,
          value: "0",
        },
        {
          scope: "chat",
          chatId: "synthetic-chat",
          key: "$selected",
          expectedRevision: 0,
          value: "false",
        },
      ],
    });
    store.close();
    const origins = [];
    let url;
    if (process.env.RISU_DISPLAY_WORKER_BUILD_PATH) {
      const passwordFile = join(directory, "password");
      await fs.writeFile(
        passwordFile,
        createHash("sha256").update("synthetic-password").digest("hex"),
      );
      production = await createProductionService({
        file,
        passwordFile,
        staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
        origin: "https://risu.test",
        insecureLocalTest: true,
        host: "127.0.0.1",
        port: 0,
        runtime: { eventsPollMs: 20 },
      });
      runtime = production.runtime;
      url = production.url;
    } else {
      runtime = await createRuntimeService({ file, origins, eventsPollMs: 20 });
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
          hmr: false,
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      await frontend.listen();
      url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
    }
    await runtime.scheduler.close();
    const call = runtime.store.call.bind(runtime.store);
    const admissions = [];
    const admissionHeld = new Promise(
      (resolve) => (releaseAdmission = resolve),
    );
    runtime.store.call = async (method, ...args) => {
      if (method === "enqueueJob" && args[1]?.type === "button") {
        admissions.push(args[0]);
        await admissionHeld;
      }
      return call(method, ...args);
    };
    browser = await launchChromium(directory);
    const contexts = [await browser.newContext(), await browser.newContext()];
    const errors = [];
    async function open(context) {
      const page = await browser.page(url, context, {
        viewport: { width: 1100, height: 900 },
        blockHttps: true,
      });
      page.on("Runtime.exceptionThrown", (event) =>
        errors.push(
          event.exceptionDetails.exception?.description ??
            event.exceptionDetails.text,
        ),
      );
      const network = [];
      page.on("Network.responseReceived", (event) => {
        const response = event.response;
        try {
          network.push({
            path: new URL(response.url).pathname,
            status: response.status,
          });
        } catch {}
      });
      async function waitFor(expression, stage) {
        try {
          return await until(() => page.evaluate(expression));
        } catch (error) {
          const snapshot = await page.evaluate(
            "({path:location.pathname,title:document.title,body:document.body.innerText.slice(0,6000),ready:document.querySelector('[data-runtime-ready]')?.dataset.runtimeReady,status:[...document.querySelectorAll('[data-runtime-status-message]')].map(e=>e.textContent),characters:[...document.querySelectorAll('[data-character-id]')].map(e=>e.dataset.characterId)})",
          );
          console.log(
            JSON.stringify({
              syntheticOpenFailure: stage,
              snapshot,
              errors,
              network: network.slice(-25),
            }),
          );
          if (process.env.RISU_BUTTON_UI_DIAGNOSTIC_PREFIX) {
            const prefix = process.env.RISU_BUTTON_UI_DIAGNOSTIC_PREFIX;
            await fs.writeFile(
              prefix + ".json",
              JSON.stringify({ stage, snapshot, errors, network }, null, 2),
            );
            const shot = await page.send("Page.captureScreenshot", {
              format: "png",
            });
            await fs.writeFile(
              prefix + ".png",
              Buffer.from(shot.data, "base64"),
            );
          }
          throw error;
        }
      }
      await waitFor(
        "!!document.querySelector('input[name=password]')||!!document.querySelector('[data-runtime-ready=true]')",
        "login-or-runtime",
      );
      if (
        await page.evaluate("!!document.querySelector('input[name=password]')")
      )
        await page.evaluate(
          "document.querySelector('input[name=password]').value='synthetic-password';document.querySelector('form').requestSubmit()",
        );
      await waitFor(
        "!!document.querySelector('[data-character-id=synthetic-buttons]')",
        "synthetic-character-list",
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=synthetic-buttons]').click()",
      );
      await waitFor(
        "!!document.querySelector('#synthetic-increment')&&!document.querySelector('textarea.input-text')?.disabled",
        "synthetic-character-buttons",
      );
      return page;
    }
    let a = await open(contexts[0]),
      b = await open(contexts[1]);
    await a.evaluate(
      "window.syntheticButtonStarted=performance.now();document.querySelector('#synthetic-increment').click()",
    );
    const feedback = await until(() =>
      a.evaluate(
        "(()=>{const e=document.querySelector('#synthetic-increment');return e?.hasAttribute('data-runtime-button-pending')?{elapsed:performance.now()-window.syntheticButtonStarted,checked:e.getAttribute('aria-checked'),status:document.querySelector('[data-runtime-button-status]')?.textContent,global:!!document.querySelector('[data-runtime-button-pending-summary]')}:null})()",
      ),
    );
    assert.equal(
      feedback.checked,
      "false",
      "Input acknowledgement must not fabricate a selected value",
    );
    assert.equal(
      feedback.global,
      false,
      "Quick input should have local feedback without a global queue banner",
    );
    assert.match(feedback.status, /保管|보관|서버/);
    assert.equal(
      (await call("listJobs", "synthetic-chat")).length,
      0,
      "Feedback must precede the deliberately held server admission",
    );
    await a.evaluate(
      "document.querySelector('#synthetic-increment').click();document.querySelector('#synthetic-other').click();document.querySelector('#synthetic-details summary').click()",
    );
    await until(() =>
      a.evaluate(
        "Number(document.querySelector('[data-runtime-pending-count]')?.dataset.runtimePendingCount)===3",
      ),
    );
    assert.equal(
      await a.evaluate("document.querySelector('#synthetic-details').open"),
      true,
      "Unrelated local controls remain usable",
    );
    await a.evaluate(
      "(()=>{const old=document.querySelector('#synthetic-increment'),replacement=old.cloneNode(true);replacement.removeAttribute('data-runtime-button-pending');old.replaceWith(replacement)})()",
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('#synthetic-increment')?.hasAttribute('data-runtime-button-pending')",
      ),
    );
    assert.equal(
      await a.evaluate(
        "document.querySelector('#synthetic-increment').getAttribute('aria-checked')",
      ),
      "false",
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-button-pending-summary]')?.textContent.includes('서버 전송 대기 3개')",
      ),
    );
    // Before any server acknowledgement, the durable browser outbox must retain
    // the same invocation identities when its page disappears and opens again.
    await a.close();
    a = await open(contexts[0]);
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-pending-count]')?.dataset.runtimePendingCount==='3'",
      ),
    );
    assert.equal((await call("listJobs", "synthetic-chat")).length, 0);
    releaseAdmission();
    await until(
      () => call("listJobs", "synthetic-chat"),
      (jobs) => jobs.length === 3,
    );
    await until(() =>
      a.evaluate(
        "document.querySelector('[data-runtime-button-pending-summary]')?.textContent.includes('서버 접수 3개')",
      ),
    );
    await a.close();
    await b.close();
    const { executeExtensionJob } = await import(
      pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href
    );
    for (let i = 0; i < 3; i++) {
      const claimed = await call("claimJob", "synthetic-worker-" + i);
      assert.equal(claimed.command.type, "button");
      const outcome = await executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        fetch: async (path) =>
          new Response(
            await fs.readFile(join(__dirname, "../../public", path.slice(1))),
          ),
      });
      await call(
        "finishJob",
        claimed.job.id,
        claimed.job.owner,
        claimed.job.fence,
        { state: "completed", ...outcome },
      );
    }
    assert.equal(await call("claimJob", "synthetic-no-extra"), null);
    a = await open(contexts[0]);
    b = await open(contexts[1]);
    for (const page of [a, b]) {
      await until(() =>
        page.evaluate(
          "document.querySelector('#synthetic-increment')?.textContent.trim()==='Increment 3'&&document.querySelector('#synthetic-increment')?.getAttribute('aria-checked')==='true'&&document.querySelector('[data-runtime-pending-count]')?.dataset.runtimePendingCount==='0'",
        ),
      );
      assert.equal(
        await page.evaluate(
          "!!document.querySelector('[data-runtime-button-pending]')",
        ),
        false,
      );
    }
    assert.equal(
      new Set(admissions).size,
      3,
      "All deliberate clicks run once despite all-tab exit/reopen",
    );
    assert.equal((await call("listJobs", "synthetic-chat")).length, 3);
    assert.deepEqual(errors, []);
    const result = {
      scenario: process.env.RISU_DISPLAY_WORKER_BUILD_PATH ? "built" : "vite",
      feedbackBeforeAdmission: true,
      feedbackElapsedMs: feedback.elapsed,
      invocations: 3,
      counter: 3,
      authoritativeSelection: true,
      replacementBusy: true,
      localControlUsable: true,
      allTabExitSafe: true,
      localOutboxSurvivesBeforeAcknowledgement: true,
      twoClientsConverged: true,
    };
    if (process.env.RISU_BUTTON_UI_OUTPUT)
      await fs.writeFile(
        process.env.RISU_BUTTON_UI_OUTPUT,
        JSON.stringify(result, null, 2),
      );
    console.log(JSON.stringify(result));
  },
);
