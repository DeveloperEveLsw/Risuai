"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  access,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} = require("node:fs/promises");
const { tmpdir, homedir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const ts = require("typescript");
const { launchChromium } = require("./chromium.cjs");

async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "trusted Chromium effects select a real file, confirm, save exact bytes and copy under user activation while the original event is pending",
  { timeout: 30000 },
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
    const directory = await mkdtemp(join(tmpdir(), "risu-plugin-effects-"));
    const downloads = join(directory, "downloads");
    await mkdir(downloads);
    const inputPath = join(directory, "synthetic.json"),
      fileText = JSON.stringify({ flower: "푸른 꽃", synthetic: true });
    await writeFile(inputPath, fileText);
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
    const eventId = "plugin-ui:11111111-1111-4111-8111-111111111111";
    const file = {
      id: "22222222-2222-4222-8222-222222222222",
      eventId,
      kind: "file",
      accept: ".json",
      multiple: false,
    };
    const confirm = {
      id: "33333333-3333-4333-8333-333333333333",
      eventId,
      kind: "confirm",
      text: "Apply the synthetic flower import?",
    };
    const clipboard = {
      id: "44444444-4444-4444-8444-444444444444",
      eventId,
      kind: "clipboard",
      text: "Synthetic leaf clipboard text",
    };
    const download = {
      id: "55555555-5555-4555-8555-555555555555",
      eventId,
      kind: "download",
      name: "original.json",
      mime: "application/json",
      bytes: Buffer.byteLength(fileText),
    };
    let effects = [],
      busy = false,
      committed = false,
      closed = false,
      finishEvent;
    const answers = [],
      errors = [],
      artifactGets = [];
    const snapshot = () => ({
      scope,
      revision: committed ? 2 : 1,
      html: '<button data-risu-plugin-node="start" data-risu-plugin-events="click">Synthetic original action</button>',
      styles: [],
      controlStates: [],
      visible: !closed,
      busy,
      effects,
    });
    const base = "/api/runtime/plugin-ui/" + scope.sessionId;
    const harness = `<!doctype html><html><body><button id="start">Start original action</button><div id="effects"></div><p id="notice"></p><script type="module">
import{openServerPluginUI,readServerPluginUIFile,copyServerPluginUIToClipboard,saveServerPluginUIArtifact}from'/bridge.js';
window.failures=[];window.activated=false;window.completed=false;
const session=await openServerPluginUI({pluginId:'synthetic-plugin',owner:{chatId:'synthetic-chat',chatEpoch:0},pollIntervalMs:100,onError:error=>window.failures.push(error.message)});window.session=session;
const notice=document.getElementById('notice'),root=document.getElementById('effects');
const run=async action=>{try{await action();notice.textContent='Completed'}catch(error){window.failures.push(error.message);notice.textContent=error.message}};
session.subscribe(view=>{root.replaceChildren();for(const effect of view.effects??[]){if(effect.kind==='file'){const input=document.createElement('input');input.id='file';input.type='file';input.accept='.json,.txt,application/json,text/plain';input.onchange=()=>run(async()=>{const file=await readServerPluginUIFile(input.files[0]);await session.resolveEffect(effect,{kind:'file',file})});root.appendChild(input)}else{const button=document.createElement('button');button.id=effect.kind;button.textContent=effect.kind;button.onclick=()=>{window.activated=navigator.userActivation.isActive;button.disabled=true;return run(async()=>{if(effect.kind==='confirm')await session.resolveEffect(effect,{kind:'confirm',accepted:true});if(effect.kind==='clipboard')await copyServerPluginUIToClipboard(session,effect);if(effect.kind==='download')await saveServerPluginUIArtifact(session,effect)})};root.appendChild(button)}}});
document.getElementById('start').onclick=()=>run(async()=>{await session.dispatch({scope:session.snapshot.scope,revision:session.snapshot.revision,eventId:${JSON.stringify(eventId)},nodeId:'start',type:'click'});window.completed=true});window.ready=true;
</script></body></html>`;
    const json = (response, value, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    const server = http.createServer(async (request, response) => {
      try {
        if (request.url === "/bridge.js") {
          response.writeHead(200, { "Content-Type": "text/javascript" });
          response.end(bridge);
          return;
        }
        if (!request.url.startsWith("/api/runtime/")) {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(harness);
          return;
        }
        if (request.url.endsWith("/capability")) {
          json(response, {
            supported: true,
            enabled: true,
            serverId: "synthetic-server",
          });
          return;
        }
        assert.equal(request.headers["risu-runtime-id"], "synthetic-server");
        if (request.url === "/api/runtime/plugin-ui") {
          json(response, {
            sessionId: scope.sessionId,
            ownerToken: "synthetic-owner",
            snapshot: snapshot(),
          });
          return;
        }
        assert.equal(request.headers["risu-plugin-owner"], "synthetic-owner");
        if (request.url === base) {
          json(response, snapshot());
          return;
        }
        let body;
        if (request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString("utf8");
          body = text ? JSON.parse(text) : undefined;
        }
        if (request.url === base + "/event") {
          assert.equal(body.eventId, eventId);
          busy = true;
          effects = [file];
          finishEvent = () => {
            busy = false;
            json(response, {
              eventId,
              appliedRevision: 2,
              replayed: false,
              snapshot: snapshot(),
            });
            finishEvent = null;
          };
          return;
        }
        if (request.url === base + "/effect") {
          const effect = effects.find(
            (item) =>
              item.id === body.effectId &&
              item.eventId === body.eventId &&
              item.kind === body.kind,
          );
          assert.ok(
            effect,
            "Only the current exact advertised effect may be resolved",
          );
          answers.push(body);
          if (effect.kind === "file") {
            assert.deepEqual(body.file, {
              name: "synthetic.json",
              text: fileText,
            });
            effects = [confirm];
          }
          if (effect.kind === "confirm") {
            assert.equal(body.accepted, true);
            committed = true;
            effects = [download, clipboard];
            finishEvent();
          }
          if (effect.kind === "download") {
            assert.equal(body.received, true);
            effects = effects.filter((item) => item.id !== effect.id);
          }
          if (effect.kind === "clipboard") {
            assert.equal(body.ok, true);
            assert.equal(body.text, undefined);
            effects = effects.filter((item) => item.id !== effect.id);
          }
          json(response, {
            effectId: effect.id,
            eventId,
            kind: effect.kind,
            resolved: true,
          });
          return;
        }
        if (request.url.startsWith(base + "/artifact/")) {
          assert.equal(
            committed,
            true,
            "Artifacts must only be available after the original checkpoint",
          );
          assert.equal(
            request.url,
            `${base}/artifact/${download.id}?eventId=${encodeURIComponent(eventId)}`,
          );
          assert.ok(effects.some((item) => item.id === download.id));
          artifactGets.push(request.url);
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(fileText),
            "Cache-Control": "no-store",
          });
          response.end(fileText);
          return;
        }
        if (request.url === base + "/close") {
          closed = true;
          json(response, { closed: true });
          return;
        }
        json(
          response,
          {
            error: { code: "NOT_FOUND", message: "Synthetic route not found" },
          },
          404,
        );
      } catch (error) {
        errors.push(error.message);
        json(
          response,
          {
            error: {
              code: "SYNTHETIC_TEST_FAILED",
              message: "Synthetic harness failed",
            },
          },
          500,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await launchChromium(directory);
    t.after(async () => {
      await browser.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const context = await browser.newContext(),
      origin = `http://127.0.0.1:${server.address().port}`;
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
      browserContextId: context,
    });
    await browser.send("Browser.grantPermissions", {
      origin,
      browserContextId: context,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const page = await browser.page(origin + "/", context, {
      viewport: { width: 850, height: 700 },
      blockHttps: true,
    });
    await until(
      () => page.evaluate("window.ready===true"),
      "Effect harness did not open",
    );
    async function click(selector) {
      const box = await page.evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...box,
      });
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...box,
      });
    }
    await click("#start");
    await until(
      () => page.evaluate("!!document.querySelector('#file')"),
      "Pending file effect was not polled while original action waits",
    );
    assert.equal(await page.evaluate("window.completed"), false);
    await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
    let chooser;
    page.on("Page.fileChooserOpened", (event) => {
      chooser = event;
    });
    await click("#file");
    await until(
      () => !!chooser,
      "A trusted click did not open the native file chooser",
    );
    await page.send("DOM.setFileInputFiles", {
      files: [inputPath],
      backendNodeId: chooser.backendNodeId,
    });
    await until(
      () => page.evaluate("!!document.querySelector('#confirm')"),
      "Actual selected file did not reach the pending confirmation",
    );
    assert.equal(committed, false);
    assert.equal(artifactGets.length, 0);
    await click("#confirm");
    await until(
      () =>
        page.evaluate(
          "window.completed&&!!document.querySelector('#download')",
        ),
      "Confirmed original operation did not publish its download",
    );
    await click("#clipboard");
    await until(
      () => answers.some((answer) => answer.kind === "clipboard"),
      "Native clipboard effect was not acknowledged",
    );
    assert.equal(await page.evaluate("window.activated"), true);
    assert.equal(
      await page.evaluate("navigator.clipboard.readText()"),
      clipboard.text,
    );
    await click("#download");
    await until(async () => {
      try {
        return (
          (await readFile(join(downloads, "original.json"), "utf8")) ===
          fileText
        );
      } catch {
        return false;
      }
    }, "Browser did not save exact advertised artifact bytes");
    await until(
      () => answers.some((answer) => answer.kind === "download"),
      "Verified download did not receive its one-use acknowledgement",
    );
    assert.equal(artifactGets.length, 1);
    assert.deepEqual(
      answers.map((answer) => answer.kind),
      ["file", "confirm", "clipboard", "download"],
    );
    assert.deepEqual(await page.evaluate("window.failures"), []);
    assert.deepEqual(errors, []);
    await page.evaluate("window.session.close()");
  },
);
