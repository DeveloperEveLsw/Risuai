"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, rm, access, readFile } = require("node:fs/promises");
const { tmpdir, homedir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const ts = require("typescript");
const { launchChromium } = require("./chromium.cjs");

const scope = {
  sessionId: "synthetic-session",
  pluginId: "synthetic-plugin",
  bundleSha: "a".repeat(64),
  pluginEpoch: 0,
  characterId: "synthetic-character",
  chatId: "synthetic-chat",
  chatEpoch: 0,
  writerId: "synthetic-writer",
  writerFence: 1,
};
const html =
  '<div data-risu-plugin-node="panel" style="height:400px;overflow:auto"><div style="height:900px"><input id="editor" type="text" data-risu-plugin-node="editor" data-risu-plugin-events="input change"><textarea id="textarea" data-risu-plugin-node="textarea" data-risu-plugin-events="input change"></textarea><input id="check" type="checkbox" data-risu-plugin-node="check" data-risu-plugin-events="change"><select id="single" data-risu-plugin-node="single" data-risu-plugin-events="change"><option value="a">A</option><option value="b">B</option></select><select id="multi" multiple data-risu-plugin-node="multi" data-risu-plugin-events="change"><option value="one">1</option><option value="two">2</option><option value="three">3</option></select><button id="action" data-risu-plugin-node="action" data-risu-plugin-events="click">Original action</button></div></div>';
function control(nodeId, tag, type = "", value = "") {
  return {
    nodeId,
    tag,
    type,
    value,
    checked: false,
    indeterminate: false,
    selectedValues: tag === "SELECT" ? [value] : [],
    selectedIndex: tag === "SELECT" ? 0 : -1,
  };
}
const snapshot = {
  scope,
  revision: 1,
  html,
  styles: [],
  busy: false,
  visible: true,
  controlStates: [
    control("editor", "INPUT", "text"),
    control("textarea", "TEXTAREA"),
    control("check", "INPUT", "checkbox"),
    control("single", "SELECT", "", "a"),
    { ...control("multi", "SELECT"), selectedValues: [], selectedIndex: -1 },
  ],
};

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("opaque original-UI projection preserves typing, focus and scroll; controls forward exact values and CSP blocks plugin scripts", async (t) => {
  const executable =
    process.env.RISU_BROWSER_CHROMIUM ??
    join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
  try {
    await access(executable);
  } catch {
    t.skip(
      "Isolated Chromium executable is not installed; set RISU_BROWSER_CHROMIUM",
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "risu-plugin-renderer-"));
  const source = await readFile(
    join(__dirname, "../../src/ts/runtime/serverPluginUI.ts"),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const harness = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="mount" style="height:700px"></div><script type="module">
import{mountServerPluginUI}from'/bridge.js';
let snapshot=${JSON.stringify(snapshot)};const listeners=new Set();window.events=[];window.failures=[];
const publish=()=>{for(const listener of listeners)listener(structuredClone(snapshot));};
const session={get snapshot(){return structuredClone(snapshot)},subscribe(listener){listeners.add(listener);listener(structuredClone(snapshot));return()=>listeners.delete(listener)},async dispatch(event){window.events.push(structuredClone(event));await new Promise(resolve=>setTimeout(resolve,120));const state=snapshot.controlStates.find(s=>s.nodeId===event.nodeId);if(state){if(event.value!==undefined)state.value=event.value;if(event.checked!==undefined)state.checked=event.checked;if(event.selectedValues!==undefined)state.selectedValues=event.selectedValues;if(state.tag==='SELECT'&&event.value!==undefined){state.selectedValues=[event.value];state.selectedIndex=event.value==='a'?0:1;}}snapshot.revision++;publish();return{eventId:event.eventId,appliedRevision:snapshot.revision,replayed:false,snapshot:structuredClone(snapshot)};}};
window.bridge=mountServerPluginUI(document.getElementById('mount'),session,{onError:e=>window.failures.push(e.message)});
window.progress=()=>{snapshot.revision++;snapshot.busy=true;publish()};window.replaceTag=()=>{snapshot.revision++;snapshot.html=snapshot.html.replace('<button id="action"','<span id="action"').replace('Original action</button>','Original action</span>');publish()};window.inject=()=>{snapshot.revision++;snapshot.html+='<img src="https://should-not-load.invalid/x" onerror="globalThis.__pluginScriptRan=true"><button onclick="globalThis.__pluginScriptRan=true">Unsafe</button><script>globalThis.__pluginScriptRan=true<\\/script>';publish()};window.ready=true;
</script></body></html>`;
  const server = http.createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/bridge.js" ? "text/javascript" : "text/html",
    );
    response.end(request.url === "/bridge.js" ? compiled : harness);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await launchChromium(root);
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const context = await browser.newContext();
  const page = await browser.page(
    `http://127.0.0.1:${server.address().port}/`,
    context,
    { viewport: { width: 900, height: 750 }, blockHttps: true },
  );
  const contexts = new Map();
  page.on("Runtime.executionContextCreated", ({ context }) =>
    contexts.set(context.id, context),
  );
  await page.send("Runtime.disable");
  await page.send("Runtime.enable");
  await until(
    () => page.evaluate("window.ready===true"),
    "Browser harness did not initialize",
  );
  let frameId;
  let childSession;
  await until(async () => {
    const { targetInfos } = await browser.send("Target.getTargets");
    const child = targetInfos.find(
      (target) => target.type === "iframe" && target.url === "about:srcdoc",
    );
    if (child && !childSession) {
      childSession = (
        await browser.send("Target.attachToTarget", {
          targetId: child.targetId,
          flatten: true,
        })
      ).sessionId;
      await browser.send("Runtime.enable", {}, childSession);
    }
    if (childSession) {
      const result = await browser.send(
        "Runtime.evaluate",
        {
          expression: "!!document.querySelector('#editor')",
          returnByValue: true,
        },
        childSession,
      );
      if (result.result.value === true) return true;
    }
    for (const [id, value] of contexts) {
      if (!value.auxData?.isDefault) continue;
      const result = await page.send("Runtime.evaluate", {
        expression: "!!document.querySelector('#editor')",
        contextId: id,
        returnByValue: true,
      });
      if (result.result.value === true) {
        frameId = id;
        return true;
      }
    }
    return false;
  }, "Opaque plugin iframe did not receive its snapshot");
  async function inside(expression) {
    const request = {
      expression,
      ...(childSession ? {} : { contextId: frameId }),
      awaitPromise: true,
      returnByValue: true,
    };
    const result = childSession
      ? await browser.send("Runtime.evaluate", request, childSession)
      : await page.send("Runtime.evaluate", request);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  }
  assert.equal(
    await page.evaluate(
      "document.querySelector('iframe').getAttribute('sandbox')",
    ),
    "allow-scripts",
  );
  assert.equal(
    await inside(
      "(()=>{try{return parent.document===document}catch(e){return e.name}})()",
    ),
    "SecurityError",
  );
  assert.deepEqual(
    await inside(
      `(()=>{const select=document.createElement('select');for(const type of ['utterance','persona','event','environment','sensation','note','relation']){const option=document.createElement('option');option.value=type;option.textContent=type;if(type==='relation')option.selected=true;select.appendChild(option)}return[select.value,select.selectedIndex,[...select.selectedOptions].map(option=>option.value)]})()`,
    ),
    ["relation", 6, ["relation"]],
    "The server DOM option-insertion fixture must match an actual browser's selection semantics",
  );
  await inside(
    `(()=>{const input=document.querySelector('#editor');input.__identity='same-node';input.focus();input.value='a';input.dispatchEvent(new Event('input',{bubbles:true}));input.value='ab';input.dispatchEvent(new Event('input',{bubbles:true}));input.value='abc';input.setSelectionRange(2,2);input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-risu-plugin-node=panel]').scrollTop=80;return true})()`,
  );
  await page.evaluate("window.progress()");
  await until(
    async () =>
      (await inside("document.querySelector('#editor').value")) === "abc",
    "Draft disappeared during progress update",
  );
  assert.deepEqual(
    await inside(
      "(()=>{const e=document.querySelector('#editor');return[e.value,e.__identity,document.activeElement===e,e.selectionStart,document.querySelector('[data-risu-plugin-node=panel]').scrollTop]})()",
    ),
    ["abc", "same-node", true, 2, 80],
  );
  await until(
    () => page.evaluate("window.events.length===3"),
    "Queued original input events did not reach the owner",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(await page.evaluate("window.events.map(e=>e.value)"), [
    "a",
    "ab",
    "abc",
  ]);
  assert.equal(await inside("document.querySelector('#editor').value"), "abc");
  await inside("document.querySelector('#check').click()");
  await until(
    () => page.evaluate("window.events.some(e=>e.nodeId==='check')"),
    "Checkbox event missing",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    await page.evaluate(
      "window.events.filter(e=>e.nodeId==='check').map(e=>[e.type,e.checked])",
    ),
    [["change", true]],
  );
  await inside(
    `(()=>{const single=document.querySelector('#single');single.value='b';single.dispatchEvent(new Event('change',{bubbles:true}));const multi=document.querySelector('#multi');for(const option of multi.options)option.selected=['one','three'].includes(option.value);multi.dispatchEvent(new Event('change',{bubbles:true}));const text=document.querySelector('#textarea');text.value='line one\\nline two';text.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  await until(
    () => page.evaluate("window.events.length===7"),
    "Select/textarea events missing",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await page.evaluate("window.events.find(e=>e.nodeId==='single').value"),
    "b",
  );
  assert.deepEqual(
    await page.evaluate(
      "window.events.find(e=>e.nodeId==='multi').selectedValues",
    ),
    ["one", "three"],
  );
  assert.equal(
    await page.evaluate("window.events.find(e=>e.nodeId==='textarea').value"),
    "line one\nline two",
  );
  assert.deepEqual(await page.evaluate("window.failures"), []);
  await page.evaluate("window.replaceTag()");
  await until(
    async () =>
      (await inside("document.querySelector('#action').tagName")) === "SPAN",
    "Keyed node tag replacement failed",
  );
  await inside(
    "window.__rendererErrors=[];addEventListener('error',e=>window.__rendererErrors.push(e.message))",
  );
  await page.evaluate("window.inject()");
  await until(
    async () => await inside("!!document.querySelector('button[onclick]')"),
    "Injected CSP probe did not render",
  );
  await inside("document.querySelector('button[onclick]').click()");
  assert.equal(await inside("globalThis.__pluginScriptRan===true"), false);
  await page.evaluate("window.bridge.destroy()");
  assert.equal(
    await page.evaluate("document.querySelector('iframe')===null"),
    true,
  );
});
