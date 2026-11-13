"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, rm, access, readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir, homedir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const ts = require("typescript");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
  readWygloreFixture,
} = require("../native/wygloreContract.cjs");
const artifact =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
async function until(
  read,
  predicate = Boolean,
  message = "Original UI condition did not settle",
) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "browser original seven tabs, deferred provider config and help checkpoint through HTTP into SQLite, survive immediate closing and retain focused DOM during polling",
  {
    timeout: 60000,
    skip: existsSync(artifact)
      ? false
      : "Fetch the pinned public WygLore artifact before compatibility validation",
  },
  async (t) => {
    const executable =
      process.env.RISU_BROWSER_CHROMIUM ??
      join(
        homedir(),
        ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
      );
    try {
      await access(executable);
    } catch {
      t.skip("Install isolated Chromium or set RISU_BROWSER_CHROMIUM");
      return;
    }
    const directory = await mkdtemp(
      join(tmpdir(), "risu-original-plugin-browser-"),
    );
    const errors = [],
      providerRequests = [];
    let runtime, browser;
    const provider = http.createServer((request, response) => {
      providerRequests.push({ method: request.method, url: request.url });
      request.resume();
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":"Unexpected synthetic provider request"}');
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const source = await readFile(
      join(__dirname, "../../src/ts/runtime/serverPluginUI.ts"),
      "utf8",
    );
    const bridge = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const harness = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="mount" style="height:700px"></div><script type="module">
import{openServerPluginUI,mountServerPluginUI}from'/bridge.js';
window.failures=[];window.sent=[];window.replied=[];const request=async(path,init={})=>{let event;if(path.endsWith('/event')){event=JSON.parse(init.body);window.sent.push({eventId:event.eventId,sessionId:event.scope.sessionId,type:event.type})}const response=await fetch(path,init);if(event)window.replied.push({eventId:event.eventId,status:response.status});return response};
window.openOriginal=async()=>{window.session=await openServerPluginUI({pluginId:'wyglore',owner:{chatId:'chat',chatEpoch:0,selection:1},fetch:request,pollIntervalMs:1000,onError:e=>window.failures.push(e.message)});window.bridge=mountServerPluginUI(document.getElementById('mount'),window.session,{onError:e=>window.failures.push(e.message)});return window.session.snapshot.scope.sessionId};
window.closeOriginal=async()=>{window.bridge.destroy();await window.session.close()};
window.refreshOriginal=()=>window.session.refresh();await window.openOriginal();window.ready=true;
</script></body></html>`;
    const frontend = http.createServer((request, response) => {
      if (request.url.startsWith("/api/runtime/")) {
        const target = new URL(request.url, runtime.url);
        const outgoing = http.request(
          target,
          {
            method: request.method,
            headers: { ...request.headers, host: target.host },
          },
          (backend) => {
            response.writeHead(backend.statusCode, backend.headers);
            backend.pipe(response);
          },
        );
        outgoing.on("error", (error) => {
          errors.push(error.message);
          response.writeHead(502);
          response.end();
        });
        request.pipe(outgoing);
        return;
      }
      response.setHeader(
        "Content-Type",
        request.url === "/bridge.js" ? "text/javascript" : "text/html",
      );
      response.end(request.url === "/bridge.js" ? bridge : harness);
    });
    frontend.listen(0, "127.0.0.1");
    await once(frontend, "listening");
    t.after(async () => {
      if (browser) await browser.close();
      await runtime?.close();
      await Promise.all(
        [provider, frontend].map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve);
              server.closeAllConnections();
            }),
        ),
      );
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const url = `http://127.0.0.1:${frontend.address().port}/`;
    runtime = await createRuntimeService({
      file: join(directory, "state.sqlite"),
      initialize: true,
      origins: [url.slice(0, -1)],
      scheduler: {
        reviewedPlugins: true,
        pollMs: 60000,
        onError: (error) => errors.push(error.message),
      },
    });
    const command = (id, data) => runtime.store.call("applyCommand", id, data);
    const settings = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await command("settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        pluginIds: ["wyglore"],
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        requestRetrys: 0,
        forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        proxyKey: "synthetic-key",
        mainPrompt: "Help the synthetic gardener.",
      },
    });
    await command("plugin", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: 0,
      payload: {
        id: "wyglore",
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        enabled: true,
        script: await readWygloreFixture(artifact),
        realArg: {},
      },
    });
    await command("character", {
      type: "create-character",
      characterId: "garden",
      definition: {
        type: "character",
        name: "Green",
        desc: "Green tends blue flowers.",
        firstMessage: "Welcome to the garden.",
        globalLore: [],
        triggerscript: [],
      },
      chat: {
        chatId: "chat",
        metadata: { name: "Synthetic garden", localLore: [] },
      },
    });
    const row = await runtime.store.call("getResource", "plugin", "wyglore");
    const namespace = {
      pluginId: "wyglore",
      bundleSha: WYGLORE_RELEASE.sha256,
      pluginEpoch: row.entityEpoch,
    };
    const lease = await runtime.store.call("claimPluginStorage", {
      namespace,
      writerId: "synthetic-ui-initial",
      authority: { kind: "browser" },
    });
    await runtime.store.call("commitPluginStorage", {
      lease,
      expectedRevision: 0,
      commitId: "synthetic-ui-initial",
      writes: [
        {
          key: "wl.globalSettings.v1",
          value: JSON.stringify({
            coldStartAuto: false,
            backgroundFirstEnabled: true,
            canonicalIngestEnabled: true,
            speedMode: "fast",
            cbsToggleFloatEnabled: false,
            updateCheckEnabled: false,
          }),
        },
        {
          key: "wl.llm.config",
          value: JSON.stringify({
            completeProviderId: "custom-openai",
            completeModel: "synthetic-model",
            maxConcurrent: 1,
          }),
        },
        {
          key: "wl.ui.visibleProviders",
          value: JSON.stringify(["custom-openai"]),
        },
        { key: "wl.provider.custom-openai.apiKey", value: "synthetic-key" },
        {
          key: "wl.provider.custom-openai.baseUrl",
          value: `http://127.0.0.1:${provider.address().port}/v1`,
        },
      ],
    });
    await runtime.store.call("releasePluginStorage", lease);
    browser = await launchChromium(directory);
    const context = await browser.newContext();
    const page = await browser.page(url, context, {
      viewport: { width: 900, height: 750 },
      blockHttps: true,
    });
    await until(
      () => page.evaluate("window.ready===true"),
      Boolean,
      "Original settings owner did not open",
    );
    let frame;
    async function attachFrame() {
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
    async function inside(expression) {
      const result = await browser.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        frame,
      );
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value;
    }
    await attachFrame();
    const firstSession = await page.evaluate(
      "window.session.snapshot.scope.sessionId",
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('iframe').getAttribute('sandbox')",
      ),
      "allow-scripts",
    );
    await inside("document.querySelector('button[data-tab=settings]').click()");
    const locate =
      "[...document.querySelectorAll('label')].find(element=>element.textContent.includes('백그라운드 진행 우선 켜기')).querySelector('input[type=checkbox]')";
    await until(() =>
      inside(
        "!![...document.querySelectorAll('label')].find(element=>element.textContent.includes('백그라운드 진행 우선 켜기'))",
      ),
    );
    assert.equal(await inside(`(${locate}).checked`), true);
    await until(() => page.evaluate("window.sent.length===1"));
    await until(() => page.evaluate("window.session.snapshot.busy===false"));
    await inside(
      `(${locate}).closest('details').querySelector('summary').click()`,
    );
    await until(() => page.evaluate("window.sent.length===2"));
    await until(() =>
      page.evaluate(
        "[...new DOMParser().parseFromString(window.session.snapshot.html,'text/html').querySelectorAll('details')].find(e=>e.textContent.includes('백그라운드 진행 우선 켜기')).open",
      ),
    );
    assert.equal(
      await inside(`(${locate}).getBoundingClientRect().height>0`),
      true,
    );
    await inside(`(${locate}).click()`);
    await until(
      async () =>
        JSON.parse(
          (
            await runtime.store.call(
              "readPluginStorage",
              namespace,
              "wl.globalSettings.v1",
            )
          ).value,
        ).backgroundFirstEnabled === false,
    );
    await until(() =>
      page.evaluate("window.sent.some(event=>event.type==='change')"),
    );
    await until(() => inside(`(${locate}).checked===false`));
    const admitted = await page.evaluate(
      "window.sent.find(event=>event.type==='change')",
    );
    const proof = await runtime.store.call("readPluginUIEvent", {
      eventId: admitted.eventId,
      sessionId: admitted.sessionId,
    });
    assert.equal(proof.state, "completed");
    assert.equal(proof.commitId, admitted.eventId);
    assert.equal(proof.requestHash.length, 64);
    assert.equal(proof.value, undefined);
    assert.equal(proof.snapshot, undefined);
    const focused = await inside(
      `(()=>{const input=[...document.querySelectorAll('input')].find(element=>!element.disabled&&element.checkVisibility()&&['number','text','checkbox'].includes(element.type));if(!input)return null;input.focus();input.__originalIdentity='stable';input.closest('.wl-content').scrollTop=80;return input.getAttribute('data-risu-plugin-node')})()`,
    );
    assert.ok(
      focused,
      "Original settings exposes an editable field for focus retention validation",
    );
    assert.equal(
      await inside(
        `document.activeElement.getAttribute('data-risu-plugin-node')===${JSON.stringify(focused)}`,
      ),
      true,
    );
    await page.evaluate("window.refreshOriginal()");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(
      await inside(
        `(()=>{const input=[...document.querySelectorAll('[data-risu-plugin-node]')].find(element=>element.getAttribute('data-risu-plugin-node')===${JSON.stringify(focused)});return[input.__originalIdentity,document.activeElement===input,input.closest('.wl-content').scrollTop]})()`,
      ),
      ["stable", true, 80],
    );
    const tabIds = [
      "overview",
      "web",
      "providers",
      "semantic",
      "settings",
      "dataRecovery",
      "about",
    ];
    for (const tabId of tabIds) {
      await inside(
        `document.querySelector('button[data-tab="${tabId}"]').click()`,
      );
      await until(() =>
        inside(
          `(()=>{const selected=document.querySelector('button[data-tab="${tabId}"]');return selected?.classList.contains('is-active')&&[...document.querySelector('.wl-content').children].filter(node=>node.checkVisibility()).some(node=>node.textContent.trim().length>0&&!node.textContent.includes('동기화하는 중'))})()`,
        ),
      );
      await until(() => page.evaluate("window.session.snapshot.busy===false"));
      assert.deepEqual(await page.evaluate("window.failures"), []);
      assert.equal(
        await inside(
          "[...document.querySelector('.wl-content').children].filter(node=>node.checkVisibility()).some(node=>node.textContent.includes('탭을 그리는 중 오류가 발생했습니다'))",
        ),
        false,
        `The original ${tabId} tab renders without a caught capability error`,
      );
    }
    await inside(
      "document.querySelector('button[data-tab=providers]').click()",
    );
    const modelInput =
      "document.querySelector('.wl-active-slot-grid input[type=text]')";
    await until(() => inside(`!!(${modelInput})`));
    assert.equal(await inside(`(${modelInput}).value`), "synthetic-model");
    const sentBeforeModel = await page.evaluate("window.sent.length");
    await inside(
      `(()=>{const input=${modelInput};input.value='synthetic-model-updated';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await until(() => page.evaluate(`window.sent.length>${sentBeforeModel}`));
    const modelEvent = await page.evaluate(
      `window.sent.slice(${sentBeforeModel}).find(event=>event.type==='input')`,
    );
    await until(() =>
      page.evaluate(
        `window.replied.some(reply=>reply.eventId===${JSON.stringify(modelEvent.eventId)}&&reply.status===200)`,
      ),
    );
    await page.evaluate("window.closeOriginal()");
    await until(() => runtime.pluginOwners.sessions.size === 0);
    await page.evaluate("window.openOriginal()");
    await attachFrame();
    await inside(
      "document.querySelector('button[data-tab=providers]').click()",
    );
    await until(() => inside(`!!(${modelInput})`));
    const restoredModel = await inside(`(${modelInput}).value`);
    const modelProof = await runtime.store.call("readPluginUIEvent", {
      eventId: modelEvent.eventId,
      sessionId: modelEvent.sessionId,
    });
    assert.equal(modelProof.state, "completed");
    assert.equal(modelProof.commitId, modelEvent.eventId);
    await until(() =>
      inside(
        "[...document.querySelectorAll('.wl-content button[aria-expanded=false]')].some(button=>button.textContent.includes('Custom OpenAI'))",
      ),
    );
    await inside(
      "[...document.querySelectorAll('.wl-content button[aria-expanded=false]')].find(button=>button.textContent.includes('Custom OpenAI')).click()",
    );
    const apiInput =
      "[...document.querySelectorAll('input[data-at-field=apiKey]')].find(input=>input.value==='synthetic-key')";
    await until(() => inside(`!!(${apiInput})`));
    assert.equal(await inside(`(${apiInput}).checkVisibility()`), true);
    const sentBeforeApi = await page.evaluate("window.sent.length");
    await inside(
      `(()=>{const input=${apiInput};input.value='synthetic-key-updated';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await until(() => page.evaluate(`window.sent.length>${sentBeforeApi}`));
    const apiEvent = await page.evaluate(
      `window.sent.slice(${sentBeforeApi}).find(event=>event.type==='input')`,
    );
    await until(() =>
      page.evaluate(
        `window.replied.some(reply=>reply.eventId===${JSON.stringify(apiEvent.eventId)}&&reply.status===200)`,
      ),
    );
    await page.evaluate("window.closeOriginal()");
    await until(() => runtime.pluginOwners.sessions.size === 0);
    await page.evaluate("window.openOriginal()");
    await attachFrame();
    await inside(
      "document.querySelector('button[data-tab=providers]').click()",
    );
    await until(() => inside(`!!(${modelInput})`));
    await until(() =>
      inside(
        "[...document.querySelectorAll('.wl-content button[aria-expanded=false]')].some(button=>button.textContent.includes('Custom OpenAI'))",
      ),
    );
    await inside(
      "[...document.querySelectorAll('.wl-content button[aria-expanded=false]')].find(button=>button.textContent.includes('Custom OpenAI')).click()",
    );
    await until(() =>
      inside("!!document.querySelector('input[data-at-field=apiKey]')"),
    );
    const restoredApi = await inside(
      "document.querySelector('input[data-at-field=apiKey]').value",
    );
    const apiProof = await runtime.store.call("readPluginUIEvent", {
      eventId: apiEvent.eventId,
      sessionId: apiEvent.sessionId,
    });
    assert.equal(apiProof.state, "completed");
    assert.equal(apiProof.commitId, apiEvent.eventId);
    assert.deepEqual(
      { model: restoredModel, api: restoredApi },
      { model: "synthetic-model-updated", api: "synthetic-key-updated" },
      "Original deferred model and API config survive closing immediately after their admitted input replies",
    );
    const providerHelpAnchors = await inside(
      "[...document.querySelectorAll('.wl-helpbtn')].filter(element=>element.checkVisibility()).slice(0,2).map(element=>element.getAttribute('data-risu-plugin-node'))",
    );
    assert.equal(providerHelpAnchors.length, 2);
    assert.notEqual(providerHelpAnchors[0], providerHelpAnchors[1]);
    await openHelp(providerHelpAnchors[0], false);
    await inside("document.querySelector('.wl-header__brand').click()");
    await until(() => inside("!document.querySelector('.wl-popover')"));
    await openHelp(providerHelpAnchors[1], true);
    await inside("document.querySelector('.wl-header__brand').click()");
    await until(() => inside("!document.querySelector('.wl-popover')"));
    await inside("document.querySelector('button[data-tab=about]').click()");
    await until(() => inside("!!document.getElementById('wl-sub-tab-usage')"));
    await inside("document.getElementById('wl-sub-tab-usage').click()");
    await until(() =>
      inside(
        "[...document.querySelectorAll('#wl-sub-tab-panel-usage .wl-helpbtn')].some(element=>element.checkVisibility())",
      ),
    );
    const helpAnchor = await inside(
      `(()=>{const anchor=[...document.querySelectorAll('#wl-sub-tab-panel-usage .wl-helpbtn')].find(element=>element.checkVisibility());return anchor?.getAttribute('data-risu-plugin-node')})()`,
    );
    assert.ok(
      helpAnchor,
      "The original usage tab exposes a help anchor for real browser layout validation",
    );
    async function openHelp(nodeId, edge) {
      await inside(
        `(()=>{let style=document.getElementById('browser-help-layout-fixture');if(!style){style=document.createElement('style');style.id='browser-help-layout-fixture';document.head.appendChild(style)}style.textContent='[data-risu-plugin-node="'+${JSON.stringify(nodeId)}+'"]{position:fixed!important;'+${JSON.stringify(edge ? "right:2px!important;bottom:2px!important;left:auto!important;top:auto!important" : "left:20px!important;top:20px!important;right:auto!important;bottom:auto!important")}+';z-index:9999!important}'})()`,
      );
      await inside(
        `document.querySelector('[data-risu-plugin-node="'+${JSON.stringify(nodeId)}+'"]').click()`,
      );
      await until(() =>
        inside(
          `(()=>{const anchor=document.querySelector('[data-risu-plugin-node="'+${JSON.stringify(nodeId)}+'"]');return anchor?.getAttribute('aria-describedby')&&!!document.getElementById(anchor.getAttribute('aria-describedby'))})()`,
        ),
      );
      const bounds = await inside(
        `(()=>{const anchor=document.querySelector('[data-risu-plugin-node="'+${JSON.stringify(nodeId)}+'"]'),popover=document.getElementById(anchor.getAttribute('aria-describedby')),a=anchor.getBoundingClientRect(),p=popover.getBoundingClientRect();return{anchorTop:a.top,anchorBottom:a.bottom,left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:document.documentElement.clientWidth,height:document.documentElement.clientHeight}})()`,
      );
      assert.ok(
        bounds.left >= 0 && bounds.right <= bounds.width,
        "Original help popup stays inside the actual iframe viewport",
      );
      if (edge) {
        assert.ok(
          bounds.top < bounds.anchorTop && bounds.bottom <= bounds.height - 8,
          "Bottom-edge help popup opens above its actual anchor",
        );
        assert.ok(
          bounds.right <= bounds.width - 8,
          "Right-edge help popup respects the original eight-pixel inset",
        );
      } else
        assert.ok(
          Math.abs(bounds.top - bounds.anchorBottom - 6) <= 1,
          "Upper help popup uses its actual anchor with the original six-pixel gap",
        );
    }
    await openHelp(helpAnchor, false);
    await inside("document.querySelector('.wl-header__brand').click()");
    await until(() => inside("!document.querySelector('.wl-popover')"));
    await openHelp(helpAnchor, true);
    await inside("document.querySelector('.wl-header__brand').click()");
    await until(() => inside("!document.querySelector('.wl-popover')"));
    await page.evaluate("window.closeOriginal()");
    await until(() => runtime.pluginOwners.sessions.size === 0);
    await page.evaluate("window.openOriginal()");
    await attachFrame();
    assert.notEqual(
      await page.evaluate("window.session.snapshot.scope.sessionId"),
      firstSession,
    );
    await inside("document.querySelector('button[data-tab=settings]').click()");
    await until(() =>
      inside(
        "!![...document.querySelectorAll('label')].find(element=>element.textContent.includes('백그라운드 진행 우선 켜기'))",
      ),
    );
    assert.equal(await inside(`(${locate}).checked`), false);
    await page.evaluate("window.closeOriginal()");
    await until(() => runtime.pluginOwners.sessions.size === 0);
    assert.deepEqual(await page.evaluate("window.failures"), []);
    assert.deepEqual(providerRequests, []);
    assert.deepEqual(errors, []);
  },
);
