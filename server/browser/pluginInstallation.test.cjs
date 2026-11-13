"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("../native/wygloreContract.cjs");

const build =
  process.env.RISU_PLUGIN_INSTALL_BUILD_PATH ??
  process.env.RISU_DISPLAY_WORKER_BUILD_PATH;
async function until(read, predicate = Boolean, description = "UI condition") {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Synthetic plugin installation timed out: " + description);
}

test(
  "built authenticated fresh plugin import persists activation and cold-open original memory edits across full reloads through HTTP into SQLite",
  {
    timeout: 120000,
    skip: build
      ? false
      : "Provide a built entity UI for installation acceptance",
  },
  async (t) => {
    const directory = await mkdtemp(
        join(tmpdir(), "risu-plugin-installation-"),
      ),
      file = join(directory, "entity.sqlite"),
      passwordFile = join(directory, "password.sha256"),
      pluginFile = join(directory, "WygLoreLeaf-original.js");
    let service, browser, provider;
    const providerRequests = [],
      pageErrors = [],
      admitted = [];
    t.after(async () => {
      await browser?.close();
      await service?.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const source = await readWygloreFixture();
    await writeFile(pluginFile, source);
    provider = createServer((request, response) => {
      providerRequests.push(request.url);
      request.resume();
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":"Unexpected synthetic model request"}');
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { createInitialRuntimeState } = await import(
      pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href
    );
    const initial = createInitialRuntimeState();
    Object.assign(initial.settings, {
      didFirstSetup: true,
      language: "en",
      autoTranslate: false,
      pluginIds: [],
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-never-called",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-never-used",
      presetChain: "",
    });
    const store = new EntityStore(file);
    try {
      store.initializeState(initial);
      store.applyCommand("synthetic-character", {
        type: "create-character",
        characterId: "synthetic-garden",
        definition: {
          type: "character",
          name: "Synthetic garden",
          desc: "A neutral synthetic gardening fixture.",
          firstMessage: "Welcome to the synthetic garden.",
          globalLore: [],
          triggerscript: [],
        },
        chat: {
          chatId: "synthetic-chat",
          metadata: { name: "Synthetic garden chat", localLore: [] },
        },
      });
      assert.equal(
        store.bootstrap().resources.filter((row) => row.kind === "plugin")
          .length,
        0,
        "The installation fixture must begin with no seeded plugin",
      );
    } finally {
      store.close();
    }
    await writeFile(
      passwordFile,
      createHash("sha256").update("synthetic-plugin-password").digest("hex"),
    );
    service = await createProductionService({
      file,
      passwordFile,
      staticDirectory: build,
      origin: "https://synthetic.risu.test",
      insecureLocalTest: true,
      host: "127.0.0.1",
      port: 0,
      runtime: {
        eventsPollMs: 20,
        scheduler: { reviewedPlugins: true, pollMs: 60000 },
      },
    });
    browser = await launchChromium(directory);
    const page = await browser.page(service.url, await browser.newContext(), {
      viewport: { width: 1440, height: 1000 },
      blockHttps: true,
    });
    page.on("Runtime.exceptionThrown", (event) => {
      pageErrors.push(
        event.exceptionDetails.exception?.description ??
          event.exceptionDetails.text,
      );
    });
    page.on("Network.requestWillBeSent", (event) => {
      if (
        event.request.method === "POST" &&
        new URL(event.request.url).pathname === "/api/runtime/commands"
      ) {
        const data = JSON.parse(event.request.postData);
        admitted.push({
          requestId: data.requestId,
          type: data.command.type,
          kind: data.command.kind,
        });
      }
    });
    async function click(expression) {
      const point = await page.evaluate(
        `(()=>{const element=(${expression});if(!element)throw Error('Synthetic UI control absent');element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2}})()`,
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await page.send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
    }
    async function openPluginSettings() {
      await until(
        () =>
          page.evaluate(
            "!!document.querySelector('[data-runtime-ready=true]')",
          ),
        Boolean,
        "Built entity runtime ready",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('svg.lucide-settings,svg.lucide-list')",
        ),
      );
      if (
        !(await page.evaluate(
          "!!document.querySelector('svg.lucide-settings')",
        ))
      ) {
        await click(
          "document.querySelector('svg.lucide-list').closest('button')",
        );
        await until(() =>
          page.evaluate("!!document.querySelector('svg.lucide-settings')"),
        );
      }
      await click(
        "document.querySelector('svg.lucide-settings')?.closest('button,[role=button]')",
      );
      await until(() =>
        page.evaluate("!!document.querySelector('.rs-setting-cont')"),
      );
      await click(
        "[...document.querySelectorAll('.rs-setting-cont button')].find(button=>button.textContent.trim()==='Plugin')",
      );
      await until(() =>
        page.evaluate(
          "[...document.querySelectorAll('h2')].some(heading=>heading.textContent.trim()==='Plugin')",
        ),
      );
    }
    const launch =
      "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='WygLore Leaf 설정 열기')";
    const toggle =
      "[...document.querySelectorAll('[role=button][aria-labelledby=show-params] button')].find(button=>button.querySelector('svg.lucide-power,svg.lucide-power-off'))";
    await until(() =>
      page.evaluate("!!document.querySelector('input[name=password]')"),
    );
    await page.evaluate(
      "document.querySelector('input[name=password]').value='synthetic-plugin-password';document.querySelector('form').requestSubmit()",
    );
    await openPluginSettings();
    assert.equal(await page.evaluate(`!!(${launch})`), false);
    assert.equal(
      await page.evaluate(
        "document.body.textContent.includes('No Plugins Installed')",
      ),
      true,
    );
    await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
    let chooser;
    page.on("Page.fileChooserOpened", (event) => {
      chooser = event;
    });
    await click(
      "[...document.querySelectorAll('h2')].find(heading=>heading.textContent.trim()==='Plugin').nextElementSibling.nextElementSibling.nextElementSibling.querySelector('button')",
    );
    await until(() => chooser, Boolean, "Original import native file chooser");
    await page.send("DOM.setFileInputFiles", {
      files: [pluginFile],
      backendNodeId: chooser.backendNodeId,
    });
    const installed = await until(
      async () => {
        const snapshot = await service.runtime.store.call("bootstrap");
        const row = snapshot.resources.find(
          (resource) => resource.kind === "plugin" && !resource.deleted,
        );
        return row
          ? service.runtime.store.call("getResource", "plugin", row.id)
          : null;
      },
      Boolean,
      "Original plugin persisted by UI import",
    );
    const id = installed.id;
    assert.equal(installed.payload.name, WYGLORE_RELEASE.name);
    assert.equal(installed.payload.enabled, true);
    assert.equal(
      createHash("sha256").update(installed.payload.script).digest("hex"),
      WYGLORE_RELEASE.sha256,
    );
    const namespace = {
      pluginId: id,
      bundleSha: WYGLORE_RELEASE.sha256,
      pluginEpoch: installed.entityEpoch,
    };
    assert.deepEqual(
      (await service.runtime.store.call("readAllPluginStorage", namespace))
        .items,
      [],
      "Opening settings must exercise a genuinely fresh plugin namespace",
    );
    await until(() => page.evaluate(`!!(${launch}) && !(${launch}).disabled`));
    assert.ok(
      admitted.some(
        (command) =>
          command.type === "save-library-resource" && command.kind === "plugin",
      ),
      "The actual browser controller must admit a plugin resource command",
    );
    async function reloadAndCheck(enabled) {
      await page.send("Page.reload", { ignoreCache: true });
      await openPluginSettings();
      await until(() => page.evaluate(`!!(${launch})`));
      assert.equal(await page.evaluate(`(${launch}).disabled`), !enabled);
      const persisted = await service.runtime.store.call(
        "getResource",
        "plugin",
        id,
      );
      assert.equal(persisted.payload.enabled, enabled);
      assert.equal(persisted.payload.script, source);
      const settings = await service.runtime.store.call(
        "getResource",
        "settings",
        "global",
      );
      assert.deepEqual(settings.payload.pluginIds, [id]);
    }
    await reloadAndCheck(true);
    async function selectSyntheticChat() {
      if (await page.evaluate("!!document.querySelector('.rs-setting-cont')")) {
        await click(
          "document.querySelector('.rs-setting-cont svg.lucide-circle-x').closest('button')",
        );
      }
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-character-id=synthetic-garden]')",
        ),
      );
      await click(
        "document.querySelector('[data-character-id=synthetic-garden]')",
      );
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-chat-id=synthetic-chat]') || !!document.querySelector('textarea')",
        ),
      );
      await openPluginSettings();
    }
    let frame;
    const uiRequests = new Map(),
      uiReplies = [],
      rejectedMessages = new Set();
    page.on("Network.requestWillBeSent", (event) => {
      if (
        event.request.method === "POST" &&
        /^\/api\/runtime\/plugin-ui\/[^/]+\/event$/.test(
          new URL(event.request.url).pathname,
        )
      ) {
        const request = JSON.parse(event.request.postData);
        uiRequests.set(event.requestId, {
          eventId: request.eventId,
          sessionId: request.scope.sessionId,
          revision: request.revision,
          type: request.type,
        });
      }
    });
    page.on("Network.loadingFinished", (event) => {
      if (!uiRequests.has(event.requestId)) return;
      void page
        .send("Network.getResponseBody", { requestId: event.requestId })
        .then((response) => {
          const reply = JSON.parse(response.body);
          uiReplies.push({
            request: uiRequests.get(event.requestId),
            eventId: reply.eventId,
            appliedRevision: reply.appliedRevision,
            revision: reply.snapshot?.revision,
            error: reply.error,
          });
        })
        .catch((error) =>
          uiReplies.push({
            error: {
              code: "SYNTHETIC_CDP_RESPONSE_FAILED",
              message: error.message,
            },
          }),
        )
        .finally(() => uiRequests.delete(event.requestId));
    });
    async function inside(expression) {
      const result = await browser.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        frame,
      );
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value;
    }
    async function openOriginalSettings() {
      await click(launch);
      const state = await until(
        () =>
          page.evaluate(
            "(()=>{const dialog=document.querySelector('[role=dialog][aria-label=\"WygLore Leaf 설정\"]');return dialog && {frame:!!dialog.querySelector('iframe'),error:dialog.querySelector('[role=alert]')?.textContent??''}})()",
          ),
        (state) => state?.frame || state?.error,
        "Fresh namespace original settings opened",
      );
      assert.equal(
        state.error,
        "",
        "Cold open must acknowledge the original plugin checkpoint",
      );
      const target = await until(async () =>
        (await browser.send("Target.getTargets")).targetInfos.find(
          (target) => target.type === "iframe" && target.url === "about:srcdoc",
        ),
      );
      frame = (
        await browser.send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        })
      ).sessionId;
      await browser.send("Runtime.enable", {}, frame);
      await until(() =>
        inside("document.querySelectorAll('button[data-tab]').length===7"),
      );
    }
    async function originalAction(expression) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = uiReplies.length;
        await inside(expression);
        await until(
          () => uiReplies.length > before && uiRequests.size === 0,
          Boolean,
          "Original handler completed its SQLite checkpoint",
        );
        const replies = uiReplies.slice(before);
        const rejected = replies.find(
          (reply) => reply.error?.code === "PLUGIN_UI_REVISION_CHANGED",
        );
        if (rejected) {
          // This is an explicit second test-driver interaction after a proven
          // pre-admission rejection, never a replay of an accepted mutation.
          assert.equal(
            await service.runtime.store.call("readPluginUIEvent", {
              eventId: rejected.request.eventId,
              sessionId: rejected.request.sessionId,
            }),
            null,
          );
          rejectedMessages.add(rejected.error.message);
          t.diagnostic(
            `Original DOM rejected a stale ${rejected.request.type} at revision ${rejected.request.revision} before admission; wait for its refreshed view and explicitly try again`,
          );
          await until(
            () =>
              inside(
                "document.querySelector('body>p[role=alert]')?.textContent??''",
              ),
            (message) => message === rejected.error.message,
            "Refreshed iframe acknowledged the pre-admission rejection",
          );
          await inside(
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
          );
          continue;
        }
        for (const reply of replies) {
          assert.equal(
            reply.error,
            undefined,
            "The original UI event must complete successfully",
          );
          assert.equal(reply.eventId, reply.request.eventId);
          assert.ok(reply.revision >= reply.appliedRevision);
          const receipt = await service.runtime.store.call(
            "readPluginUIEvent",
            {
              eventId: reply.eventId,
              sessionId: reply.request.sessionId,
            },
          );
          assert.equal(receipt.state, "completed");
          assert.equal(receipt.appliedRevision, reply.appliedRevision);
        }
        await inside(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
        );
        const warnings = await inside(
          "[...document.querySelectorAll('body>p[role=alert]')].map(element=>element.textContent)",
        );
        for (const warning of warnings)
          assert.ok(rejectedMessages.has(warning));
        const warning = await page.evaluate(
          "document.querySelector('[role=dialog][aria-label=\"WygLore Leaf 설정\"] [role=alert]')?.textContent??''",
        );
        assert.ok(!warning || rejectedMessages.has(warning));
        return;
      }
      assert.fail(
        "The original DOM did not stabilize after explicit pre-admission retries",
      );
    }
    await selectSyntheticChat();
    await openOriginalSettings();
    await originalAction(
      "document.querySelector('button[data-tab=web]').click()",
    );
    await originalAction(
      "[...document.querySelectorAll('button')].findLast(button=>button.textContent.trim()==='추가').click()",
    );
    await originalAction(
      "(()=>{const input=document.querySelector('input[placeholder=\"기억을 구분할 짧은 이름\"]');input.value='Synthetic flower agreement';input.dispatchEvent(new Event('input',{bubbles:true}))})()",
    );
    await originalAction(
      "(()=>{const select=document.querySelector('select');select.value='relation';select.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await originalAction(
      "(()=>{const input=document.querySelector('textarea[placeholder=\"이 기억이 점화될 때 LLM에게 환기시킬 정보.\"]');input.value='Green and Blue agreed to water the synthetic flowers.';input.dispatchEvent(new Event('input',{bubbles:true}))})()",
    );
    await originalAction(
      "[...document.querySelectorAll('button')].findLast(button=>button.textContent.trim()==='저장').click()",
    );
    await until(() =>
      inside(
        "document.body.textContent.includes('Synthetic flower agreement')",
      ),
    );
    await click(
      "document.querySelector('[role=dialog][aria-label=\"WygLore Leaf 설정\"] button')",
    );
    await reloadAndCheck(true);
    await selectSyntheticChat();
    await openOriginalSettings();
    await originalAction(
      "document.querySelector('button[data-tab=web]').click()",
    );
    await originalAction(
      "[...document.querySelectorAll('button')].findLast(button=>button.textContent.trim()==='관계').click()",
    );
    assert.equal(
      await inside(
        "document.body.textContent.includes('Synthetic flower agreement') && document.body.textContent.includes('Green and Blue agreed to water the synthetic flowers.')",
      ),
      true,
      "The original memory card must survive page reload and a fresh UI owner",
    );
    await click(
      "document.querySelector('[role=dialog][aria-label=\"WygLore Leaf 설정\"] button')",
    );
    await click(toggle);
    await until(
      () => service.runtime.store.call("getResource", "plugin", id),
      (row) => row.payload.enabled === false,
      "Disabled value persisted",
    );
    await reloadAndCheck(false);
    await click(toggle);
    await until(
      () => service.runtime.store.call("getResource", "plugin", id),
      (row) => row.payload.enabled === true,
      "Re-enabled value persisted",
    );
    await reloadAndCheck(true);
    assert.deepEqual(providerRequests, []);
    assert.deepEqual(pageErrors, []);
    const final = new EntityStore(file);
    try {
      assert.equal(
        final.db.prepare("SELECT count(*) AS n FROM jobs").get().n,
        0,
      );
    } finally {
      final.close();
    }
  },
);
