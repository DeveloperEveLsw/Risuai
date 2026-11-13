"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir, cpus, platform, release } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw new Error(
    "Display performance condition timed out: " + JSON.stringify(value),
  );
}
const ui = (expression) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression}})()`;

function fixtureNumber(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, name);
  return value;
}

test(
  "large original UI display: real checkbox, Lua/CBS/regex/HTML, frame gaps and stable rows",
  { timeout: 240000 },
  async (t) => {
    const buildPath = process.env.RISU_DISPLAY_PERF_BUILD_PATH;
    const sourceOverrides = process.env.RISU_DISPLAY_PERF_SOURCE_OVERRIDES
      ? JSON.parse(
          await readFile(
            process.env.RISU_DISPLAY_PERF_SOURCE_OVERRIDES,
            "utf8",
          ),
        )
      : {};
    const overrideSources = new Map(
      Object.entries(sourceOverrides).map(([name, value]) => [
        resolve(name),
        value,
      ]),
    );
    const overrideLoads = new Set();
    const directory = await mkdtemp(
      join(tmpdir(), "risu-display-performance-"),
    );
    let runtime, frontend, browser;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend?.close) await frontend.close();
      else if (frontend) {
        frontend.httpServer.closeAllConnections();
        await new Promise((resolve) => frontend.httpServer.close(resolve));
      }
      if (runtime) await runtime.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
    });
    await runtime.store.call("applyCommand", "settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        chatLoadInitialPages:
          fixtureNumber("RISU_DISPLAY_PERF_ROWS", 50, 7, 100) + 1,
      },
    });
    assert.ok(
      !buildPath || overrideSources.size === 0,
      "Build comparisons cannot use development source overrides",
    );
    const count = fixtureNumber("RISU_DISPLAY_PERF_ROWS", 50, 7, 100),
      dependent = 6,
      cells = fixtureNumber("RISU_DISPLAY_PERF_CELLS", 48, 1, 512),
      loopIterations = fixtureNumber(
        "RISU_DISPLAY_PERF_LOOP",
        600000,
        0,
        2000000,
      );
    const expectedBaseline = process.env.RISU_DISPLAY_PERF_BASELINE === "TRUE";
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic performance" } },
      definition: {
        type: "character",
        name: "Synthetic performance fixture",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        customModuleToggle: "performance=Synthetic performance toggle",
        customscript: Array.from({ length: 16 }, (_, i) => ({
          in: "synthetic-token-" + i,
          out: "synthetic-result-" + i,
          type: "editdisplay",
          ableFlag: true,
          flag: "g",
        })),
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
local counts={}
listenEdit('editDisplay', function(id,data)
  local row=string.match(data,'data%-fixture%-row="(%d+)"')
  if not row then return data end
  counts[row]=(counts[row] or 0)+1
  local checksum=0
  for i=1,${loopIterations} do checksum=(checksum+i)%65521 end
  local choice='fixed'
  if string.find(data,'data-dependent="true"',1,true) then choice=cbs('{{getglobalvar::toggle_performance}}') end
  log({fixture='display-performance',row=row,calls=counts[row]})
  return data .. '<span class="fixture-lua" data-row="'..row..'" data-checksum="'..checksum..'">'..choice..'</span>'
end)`,
              },
            ],
          },
        ],
      },
    });
    let sourceBytes = 0;
    for (let i = 0; i < count; i++) {
      const data =
        `<section data-fixture-row="${i}" data-dependent="${i >= count - dependent}"><span class="fixture-cbs">${i >= count - dependent ? "{{getglobalvar::toggle_performance}}" : "fixed"}</span>` +
        Array.from(
          { length: cells },
          (_, j) =>
            `<div class="fixture-cell"><strong>Synthetic row ${i} cell ${j}</strong> synthetic-token-${j % 16} &amp; neutral text</div>`,
        ).join("") +
        "</section>";
      sourceBytes += Buffer.byteLength(data);
      await runtime.store.call("applyCommand", "message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m-" + i,
        message: { role: "char", data },
      });
    }
    const { createServer, preview } = await import("vite");
    const serverOptions = {
      plugins: overrideSources.size
        ? [
            {
              name: "synthetic-display-comparison",
              enforce: "pre",
              load(id) {
                const path = id.split("?")[0];
                if (overrideSources.has(path)) {
                  overrideLoads.add(path);
                  return overrideSources.get(path);
                }
              },
            },
          ]
        : [],
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      define: {
        "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
        "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
      },
      build: { outDir: buildPath },
      [buildPath ? "preview" : "server"]: {
        host: "127.0.0.1",
        hmr: false,
        port: 0,
        strictPort: false,
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    };
    frontend = buildPath
      ? await preview(serverOptions)
      : await createServer(serverOptions);
    if (!buildPath) await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const browserVersion = await browser.send("Browser.getVersion");
    t.diagnostic("Synthetic fixture seeded; browser launched");
    const observations = [];
    for (const scenario of ["desktop", "mobile-emulation-4x"]) {
      const page = await browser.page(
        buildPath ? "about:blank" : url,
        await browser.newContext(),
        {
          viewport: { width: 1280, height: 900 },
          blockHttps: true,
        },
      );
      const calls = new Map();
      // Production strips console.log. Observe completed native worker messages,
      // without changing Lua output or forcing unchanged rows to sanitize again.
      if (buildPath) {
        await page.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `
          window.fixtureWorkerCounts=new Map();
          window.fixtureWorkerPending=new Set();let fixtureWorkerSerial=0;
          const NativeWorker=window.Worker;
          window.Worker=class extends NativeWorker {
            constructor(url,options){
              super(url,options);this.fixtureRows=new Map();this.fixtureSerial=++fixtureWorkerSerial;
              if(options?.name==='risu-display-lua') this.addEventListener('message',event=>{
                const message=event.data;
                if(!['result','error'].includes(message?.type))return;
                const row=this.fixtureRows.get(message.id);this.fixtureRows.delete(message.id);
                window.fixtureWorkerPending.delete(this.fixtureSerial+':'+message.id);
                if(row!==undefined&&message.type==='result')window.fixtureWorkerCounts.set(row,(window.fixtureWorkerCounts.get(row)||0)+1);
              });
            }
            postMessage(message,...args){
              if(message?.type==='execute'){
                const row=message.input?.content?.match(/data-fixture-row="(\\d+)"/);
                if(row){this.fixtureRows.set(message.id,row[1]);window.fixtureWorkerPending.add(this.fixtureSerial+':'+message.id);}
              }
              return super.postMessage(message,...args);
            }
            terminate(){for(const id of this.fixtureRows.keys())window.fixtureWorkerPending.delete(this.fixtureSerial+':'+id);this.fixtureRows.clear();return super.terminate();}
          };
        `,
        });
        await page.send("Page.navigate", { url });
      }
      const readCalls = async () =>
        buildPath
          ? new Map(await page.evaluate("[...window.fixtureWorkerCounts]"))
          : new Map(calls);
      const exceptions = [];
      const stopExceptions = page.on("Runtime.exceptionThrown", (event) =>
        exceptions.push(event.exceptionDetails.text),
      );
      let navigations = 0;
      const stopNavigation = page.on("Page.frameNavigated", (event) => {
        if (!event.frame.parentId) navigations++;
      });
      const stopConsole = page.on("Runtime.consoleAPICalled", (event) => {
        for (const arg of event.args ?? []) {
          if (arg.type !== "object") continue;
          if (!arg.preview?.properties) continue;
          const value = Object.fromEntries(
            arg.preview.properties.map((p) => [p.name, p.value]),
          );
          if (value.fixture === "display-performance")
            calls.set(value.row, Number(value.calls));
        }
      });
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=\"true\"]')",
        ),
      );
      t.diagnostic(scenario + " ready");
      if (scenario !== "desktop") {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      await until(() =>
        page.evaluate("!!document.querySelector('[data-character-id=c]')"),
      );
      await page.evaluate(
        "document.querySelector('[data-character-id=c]').click()",
      );
      if (!buildPath) await until(() => page.evaluate(ui("s.scopeReady")));
      t.diagnostic(scenario + " selected");
      await until(
        () =>
          page.evaluate(
            "document.querySelectorAll('.x-risu-fixture-lua').length",
          ),
        (n) => n === count,
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('.x-risu-fixture-cell').length",
        ),
        count * cells,
      );
      assert.equal(
        await page.evaluate(
          "document.body.textContent.includes('synthetic-token-')",
        ),
        false,
      );
      const toggle =
        "document.querySelector('input[alt=\"Synthetic performance toggle\"]')";
      await until(() => page.evaluate(`!!${toggle}`));
      await delay(500);
      async function quiescentCalls() {
        if (!buildPath) {
          await delay(250);
          return readCalls();
        }
        let signature = "",
          unchangedAt = performance.now(),
          result;
        await until(async () => {
          result = await readCalls();
          const next = JSON.stringify([...result].sort());
          if (next !== signature) {
            signature = next;
            unchangedAt = performance.now();
          }
          return (
            result.size === count &&
            (await page.evaluate("window.fixtureWorkerPending.size===0")) &&
            performance.now() - unchangedAt >= 250
          );
        });
        return result;
      }
      const initialCalls = await quiescentCalls();
      t.diagnostic(
        JSON.stringify({
          scenario,
          initialCompletedCalls: [...initialCalls.values()].reduce(
            (a, b) => a + b,
            0,
          ),
          workerRequestsQuiescent: Boolean(buildPath),
        }),
      );
      if (buildPath)
        assert.equal(
          await page.evaluate(
            "[...document.scripts].every(s=>!s.src.includes('/src/'))",
          ),
          true,
        );
      const scopeDiagnosticsAvailable = buildPath
        ? false
        : await page.evaluate(
            "(async()=>{const m=await import('/src/ts/process/scriptings.ts');window.fixtureScopeRead=m.displayScopeDiagnostics??(()=>undefined);return typeof m.displayScopeDiagnostics==='function'})()",
          );
      if (!buildPath && !sourceOverrides["src/ts/process/scriptings.ts"])
        assert.equal(scopeDiagnosticsAvailable, true);
      if (!buildPath && process.env.RISU_DISPLAY_PERF_CAPTURE_PROBE)
        await page.evaluate(
          ui(`(()=>{
          const owner=r();window.fixtureCaptureProbe={full:0,header:0};
          for(const [method,key] of [['captureDisplay','full'],['captureDisplayHeader','header']]){
            const original=owner[method];if(!original)continue;
            owner[method]=function(...args){window.fixtureCaptureProbe[key]++;return original.apply(this,args)};
          }return true;
        })()`),
        );
      await page.evaluate(`(()=>{
      window.fixtureLongTasks=[];window.fixtureFrameGaps=[];window.fixtureFramesRunning=true;
      window.fixtureObserver=new PerformanceObserver(list=>window.fixtureLongTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));window.fixtureObserver.observe({type:'longtask'});
      let last=performance.now();function frame(now){if(!window.fixtureFramesRunning)return;window.fixtureFrameGaps.push({start:last,duration:now-last});last=now;requestAnimationFrame(frame);}requestAnimationFrame(frame);
      window.fixtureRows=[...document.querySelectorAll('[data-message-id]')];
      window.fixtureIndependentBodies=[...document.querySelectorAll('[data-dependent="false"]')];
    })()`);
      const samples = [];
      const measurementNavigation = navigations;
      const sampleCount = fixtureNumber("RISU_DISPLAY_PERF_SAMPLES", 6, 1, 100);
      for (let sample = 0; sample < sampleCount; sample++) {
        const before = await readCalls();
        if (process.env.RISU_DISPLAY_PERF_PROFILE && sample === 0) {
          await page.send("Profiler.enable");
          await page.send("Profiler.start");
        }
        const click = await page.evaluate(
          `new Promise(resolve=>{const input=${toggle};const expected=!input.checked;const preparations=window.fixtureScopeRead?.()?.preparations??null;const renderProbe=globalThis.__risuRenderProbe?{...globalThis.__risuRenderProbe}:null;const captureProbe=window.fixtureCaptureProbe?{...window.fixtureCaptureProbe}:null;const started=performance.now();input.click();requestAnimationFrame(()=>{requestAnimationFrame(()=>resolve({started,expected,preparations,renderProbe,captureProbe,checked:input.checked,feedbackMs:performance.now()-started}))});})`,
        );
        assert.equal(click.checked, click.expected);
        if (!buildPath)
          await until(
            () => page.evaluate(ui("s.pending.length")),
            (n) => n === 0,
          );
        else {
          await until(
            async () =>
              (
                await runtime.store.call("readVariables", [
                  { scope: "global", key: "toggle_performance" },
                ])
              ).variables[0]?.value,
            (value) => value === (click.expected ? "1" : "0"),
          );
          await until(
            () =>
              page.evaluate(
                "[...document.querySelectorAll('[data-runtime-status-message]')].map(e=>e.textContent.trim()).join('').trim()",
              ),
            (text) => text === "",
          );
        }
        // Every mounted row currently participates in the original display Lua. Capture the breadth, without bypassing its work.
        await until(async () => {
          const current = await readCalls();
          return (
            current.size === count &&
            [...current].every(([row, n]) => n > before.get(row))
          );
        });
        await until(
          () =>
            page.evaluate(
              `[...document.querySelectorAll('.x-risu-fixture-lua')].filter(e=>Number(e.dataset.row)>=${count - dependent}).map(e=>e.textContent)`,
            ),
          (rows) =>
            rows.length === dependent &&
            rows.every((text) => text === (click.expected ? "1" : "0")),
        );
        await page.evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const settled = await page.evaluate("performance.now()");
        if (process.env.RISU_DISPLAY_PERF_PROFILE && sample === 0) {
          const { profile } = await page.send("Profiler.stop");
          await writeFile(
            process.env.RISU_DISPLAY_PERF_PROFILE + "-" + scenario + ".json",
            JSON.stringify(profile),
          );
        }
        const after = await quiescentCalls();
        const computations = [...after].reduce(
          (n, [row, calls]) => n + calls - before.get(row),
          0,
        );
        if (!expectedBaseline && overrideSources.size === 0)
          t.diagnostic(
            JSON.stringify({
              scenario,
              sample,
              completedRowDeltas: [...after].map(([row, calls]) => ({
                row: Number(row),
                calls: calls - before.get(row),
              })),
            }),
          );
        if (!expectedBaseline && overrideSources.size === 0) {
          // BrowserDisplayLua retires an obsolete queued presentation before
          // entering Lua. A dependent row's old/new CBS inputs therefore take
          // one or two calls, depending on whether the first already started.
          // Check every row: an aggregate alone could hide a missing invocation
          // on one row and an extra stateful invocation on another.
          for (const [row, calls] of after) {
            const delta = calls - before.get(row);
            assert.ok(
              Number(row) >= count - dependent
                ? delta >= 1 && delta <= 2
                : delta === 1,
              "Display Lua invocation count violated its row scope: " +
                JSON.stringify({ row, delta }),
            );
          }
          assert.ok(computations >= count && computations <= count + dependent);
        }
        assert.equal(
          navigations,
          measurementNavigation,
          "Page navigation invalidated the measurement",
        );
        const metrics = await page.evaluate(
          `({scopePreparations:window.fixtureScopeRead?.()?.preparations??null,renderProbe:globalThis.__risuRenderProbe?{...globalThis.__risuRenderProbe}:null,longTasks:window.fixtureLongTasks.filter(e=>e.start+e.duration>=${click.started}&&e.start<=${settled}),frameGaps:window.fixtureFrameGaps.filter(e=>e.start+e.duration>=${click.started}&&e.start<=${settled}).map(e=>e.duration),stableRows:window.fixtureRows.every(row=>row===document.querySelector('[data-message-id="'+row.dataset.messageId+'"]')),stableIndependentBodies:window.fixtureIndependentBodies.every(body=>body===document.querySelector('[data-fixture-row="'+body.dataset.fixtureRow+'"]'))})`,
        );
        assert.equal(metrics.stableRows, true);
        assert.equal(metrics.stableIndependentBodies, true);
        const scopePreparations = scopeDiagnosticsAvailable
          ? metrics.scopePreparations - click.preparations
          : null;
        if (scopeDiagnosticsAvailable)
          assert.ok(
            scopePreparations > 0 && scopePreparations < count,
            "Display scopes were stale or rebuilt for every row: " +
              scopePreparations,
          );
        assert.ok(
          click.feedbackMs < 2000,
          "Checkbox feedback stalled: " + click.feedbackMs,
        );
        if (!expectedBaseline)
          assert.ok(
            Math.max(0, ...metrics.frameGaps) < 750,
            "Queued display Lua monopolized the browser: " +
              Math.max(...metrics.frameGaps),
          );
        samples.push({
          computations,
          coalescedDependentCalls: count + dependent - computations,
          feedbackMs: click.feedbackMs,
          settledMs: settled - click.started,
          scopePreparations,
          ...(click.captureProbe
            ? {
                captureCalls: await page.evaluate(
                  `({full:window.fixtureCaptureProbe.full-${click.captureProbe.full},header:window.fixtureCaptureProbe.header-${click.captureProbe.header}})`,
                ),
              }
            : {}),
          ...(click.renderProbe && metrics.renderProbe
            ? {
                renderStages: {
                  markdown:
                    metrics.renderProbe.markdown - click.renderProbe.markdown,
                  sanitize:
                    metrics.renderProbe.sanitize - click.renderProbe.sanitize,
                },
              }
            : {}),
          computations,
          independentRowsRecomputed: [...after].filter(
            ([row, n]) =>
              Number(row) < count - dependent && n > before.get(row),
          ).length,
          longTasks: metrics.longTasks,
          maxFrameGapMs: Math.max(0, ...metrics.frameGaps),
        });
      }
      const errors = await page.evaluate(
        buildPath
          ? "[...document.querySelectorAll('[data-runtime-status-message]')].map(e=>e.textContent.trim()).join('').trim()"
          : ui("s.error"),
      );
      assert.equal(errors, "");
      assert.deepEqual(exceptions, []);
      await page.evaluate(
        "(window.fixtureFramesRunning=false,window.fixtureObserver.disconnect(),true)",
      );
      const observation = { scenario, samples };
      observations.push(observation);
      t.diagnostic(JSON.stringify(observation));
      stopConsole();
      stopNavigation();
      stopExceptions();
      await page.close();
    }
    const sourceHashes = {};
    for (const file of [
      "src/lib/ChatScreens/Chat.svelte",
      "src/lib/ChatScreens/ChatBody.svelte",
      "src/ts/parser/parser.svelte.ts",
      "src/ts/parser/cbsRuntime.ts",
      "src/ts/process/scripts.ts",
      "src/ts/process/triggers.ts",
      "src/ts/runtime/displayCbsScope.ts",
      "src/ts/runtime/displayReadDependencies.ts",
      "src/ts/runtime/canonicalDisplayHistory.ts",
      "src/ts/runtime/browserDisplayMetadata.ts",
      "src/ts/runtime/displayRenderCache.ts",
      "src/ts/runtime/stableDisplayDom.ts",
      "src/ts/observer.svelte.ts",
      "src/ts/runtime/browserDisplayLua.ts",
      "src/ts/runtime/displayScheduling.ts",
      "src/ts/runtime/displayLuaContext.ts",
      "src/ts/runtime/displayWorkerExecutor.ts",
      "src/ts/runtime/displayWireBudget.ts",
      "src/ts/runtime/displayScopeCache.svelte.ts",
      "src/ts/runtime/displayScopeIdentity.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/risuReadModel.ts",
      "server/entity/store.cjs",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/ts/runtime/display.worker.ts",
      "src/ts/runtime/displayEffects.ts",
      "src/ts/process/scriptings.ts",
      "server/browser/chromium.cjs",
      "server/browser/displayPerformance.test.cjs",
    ])
      sourceHashes[file] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const result = {
      sourceOverrideLoads: [...overrideLoads].sort(),
      sourceOverrideHashes: Object.fromEntries(
        Object.entries(sourceOverrides).map(([name, value]) => [
          name,
          createHash("sha256").update(value).digest("hex"),
        ]),
      ),
      frameGuardActive: !expectedBaseline,
      syntheticOnly: true,
      actualMobileOS: false,
      viteDevelopmentBuild: !buildPath,
      optimizedBundle: !!buildPath,
      computationObserver: buildPath
        ? "completed display worker result messages"
        : "original Lua console.log",
      buildIndexHash: buildPath
        ? createHash("sha256")
            .update(await readFile(join(buildPath, "index.html")))
            .digest("hex")
        : null,
      hotModuleReload: false,
      workerThreadCpuThrottling:
        "not verified; CDP throttle is configured on the page target",
      environment: {
        node: process.version,
        chromium: browserVersion.product,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
      },
      sourceHashes,
      count,
      dependent,
      sourceBytes,
      htmlCells: count * cells,
      regexCount: 16,
      loopIterations,
      observations,
    };
    assert.deepEqual(
      [...overrideLoads].sort(),
      [...overrideSources.keys()].sort(),
      "Every declared comparison adapter must actually be loaded",
    );
    if (expectedBaseline)
      assert.ok(
        observations
          .find((o) => o.scenario === "mobile-emulation-4x")
          .samples.some((s) => s.maxFrameGapMs >= 750),
        "Negative control did not reproduce the display stall",
      );
    if (process.env.RISU_DISPLAY_PERF_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_PERF_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);
