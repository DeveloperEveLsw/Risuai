"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const ui = (value) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${value}})()`;
async function until(read, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Render cache condition timed out: " + JSON.stringify(value));
}

test(
  "original parser reuses only pure formatting, preserves stateful Lua and fresh CSS/settings, and releases mounted owners",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-display-render-cache-"),
    );
    let runtime, frontend, browser;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend) await frontend.close();
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
        hideAllImages: false,
        customQuotes: true,
        customQuotesData: ["[", "]", "{", "}"],
        unformatQuotes: true,
      },
    });
    const source =
      'render-cache-probe "Synthetic quote"\n\n<img id="render-cache-image" src="https://synthetic.invalid/image.png" alt="Synthetic image">\n\n```risuerror\nSynthetic error\n```\n\n$$a+b$$';
    const cssSource = "render-cache-css-source";
    const cssOutput =
      '<style>.cache-style{content:"{{getvar::cache_css}}"}</style><span class="cache-style">Synthetic CSS</span>';
    await runtime.store.call("applyCommand", "character", {
      type: "create-character",
      characterId: "c",
      chat: { chatId: "a", metadata: { name: "Synthetic cache chat" } },
      definition: {
        type: "character",
        name: "Synthetic cache fixture",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
local calls=0
listenEdit('editDisplay',function(id,data)
  if not string.find(data,'render-cache-',1,true) then return data end
  calls=calls+1
  log({fixture='render-cache-state',calls=calls})
  if data=='${cssSource}' then return ${JSON.stringify(cssOutput)} end
  return data..'<span id="render-cache-fixed">Synthetic unchanged result</span>'
end)`,
              },
            ],
          },
        ],
      },
    });
    await runtime.store.call("applyCommand", "message", {
      type: "append-message",
      chatId: "a",
      messageId: "m",
      message: { role: "char", data: source },
    });
    await runtime.store.call("applyCommand", "other", {
      type: "create-character",
      characterId: "other",
      chat: { chatId: "other-chat", metadata: { name: "Synthetic other" } },
      definition: {
        type: "character",
        name: "Synthetic other",
        desc: "Synthetic",
        firstMessage: "Synthetic other greeting",
      },
    });
    await runtime.store.call("applyCommand", "css-before", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$cache_css",
          expectedRevision: 0,
          value: "before",
        },
      ],
    });
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
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1280, height: 900 },
      blockHttps: true,
    });
    let luaCalls = 0;
    const stop = page.on("Runtime.consoleAPICalled", (event) => {
      for (const arg of event.args ?? []) {
        const props = arg.preview?.properties;
        if (!props) continue;
        const value = Object.fromEntries(props.map((p) => [p.name, p.value]));
        if (value.fixture === "render-cache-state")
          luaCalls = Number(value.calls);
      }
    });
    t.after(stop);
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=\"true\"]')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=c]').click()",
    );
    await until(() => page.evaluate(ui("s.scopeReady")));
    await until(() =>
      page.evaluate("!!document.querySelector('#render-cache-fixed')"),
    );
    await delay(250);
    await page.evaluate(`(async()=>{
    const {DisplayRenderCache,displayRenderCacheDiagnostics}=await import('/src/ts/runtime/displayRenderCache.ts');
    const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');
    const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');
    window.cacheOwner=new DisplayRenderCache();window.cacheStats=displayRenderCacheDiagnostics;
    window.cacheParse=async(source)=>{const p={renderCache:window.cacheOwner};const raw=await ParseMarkdown(source,getCurrentCharacter(),'notrim',0,{messageId:'m'},p);return {html:await p.finalize(raw),stats:displayRenderCacheDiagnostics()};};
  })()`);
    const parse = (value) =>
      page.evaluate(`window.cacheParse(${JSON.stringify(value)})`);
    const beforeLua = luaCalls;
    const first = await parse(source),
      second = await parse(source);
    assert.equal(second.html, first.html);
    assert.match(second.html, /\[Synthetic quote\]/);
    assert.match(second.html, /Synthetic error/);
    assert.match(second.html, /<math/);
    assert.equal(
      luaCalls - beforeLua,
      2,
      "Pure formatting reuse skipped a stateful Lua call",
    );
    assert.equal(second.stats.markdownHits - first.stats.markdownHits, 1);
    assert.equal(second.stats.sanitizeHits - first.stats.sanitizeHits, 1);
    // Finalizer accepts a distinct translation/watermark input without reusing
    // the previous sanitizer input or bypassing its image policy.
    const changed = await page.evaluate(
      `(async()=>{const {ParseMarkdown}=await import('/src/ts/parser/parser.svelte.ts');const {getCurrentCharacter}=await import('/src/ts/storage/database.svelte.ts');const p={renderCache:window.cacheOwner};const raw=await ParseMarkdown(${JSON.stringify(source)},getCurrentCharacter(),'notrim',0,{messageId:'m'},p);return p.finalize(raw+'<img id="cache-extra" src="https://synthetic.invalid/extra.png" onerror="window.unsafe=true">');})()`,
    );
    assert.match(changed, /cache-extra/);
    assert.doesNotMatch(changed, /onerror/);
    await page.evaluate(
      ui(
        "r().setFields([{target:{scope:'resource',resourceKind:'settings',entityId:'global',key:'hideAllImages'},value:true},{target:{scope:'resource',resourceKind:'settings',entityId:'global',key:'customQuotesData'},value:['«','»','‹','›']}])",
      ),
    );
    await until(() => page.evaluate(ui("s.pending.length===0")));
    await until(
      async () =>
        (await runtime.store.call("getResource", "settings", "global"))?.payload
          ?.hideAllImages === true,
    );
    await until(() =>
      page.evaluate(
        "document.querySelector('#render-cache-image')?.getAttribute('src')==='/none.webp'",
      ),
    );
    await delay(150);
    const policy = await parse(source),
      policyAgain = await parse(source);
    assert.match(policy.html, /«Synthetic quote»/);
    assert.match(policy.html, /src="\/none.webp"/);
    assert.equal(policy.html, policyAgain.html);
    assert.equal(policyAgain.stats.markdownHits - policy.stats.markdownHits, 1);
    assert.equal(policyAgain.stats.sanitizeHits - policy.stats.sanitizeHits, 1);
    const cssBefore = await parse(cssSource),
      cssAgain = await parse(cssSource);
    assert.match(cssBefore.html, /content:\s*"before"/);
    assert.equal(cssAgain.html, cssBefore.html);
    assert.equal(cssAgain.stats.markdownHits - cssBefore.stats.markdownHits, 1);
    assert.equal(cssAgain.stats.sanitizeHits - cssBefore.stats.sanitizeHits, 0);
    assert.equal(cssAgain.stats.cssBypasses - cssBefore.stats.cssBypasses, 1);
    await runtime.store.call("applyCommand", "css-after", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$cache_css",
          expectedRevision: 1,
          value: "after",
        },
      ],
    });
    await until(() =>
      page.evaluate(
        ui("r().model.activeChat.scriptstate?.$cache_css==='after'"),
      ),
    );
    await delay(150);
    const cssAfter = await parse(cssSource);
    assert.match(cssAfter.html, /content:\s*"after"/);
    assert.doesNotMatch(cssAfter.html, /content:\s*"before"/);
    const mounted = await page.evaluate(
      "(window.cacheOwner.close(),window.cacheStats())",
    );
    assert.equal(mounted.owners, 2);
    const afterClosed = await page.evaluate(
      `(async()=>{const before=window.cacheStats();await window.cacheParse(${JSON.stringify(source)});return {before,after:window.cacheStats()};})()`,
    );
    assert.equal(afterClosed.after.owners, afterClosed.before.owners);
    assert.equal(
      afterClosed.after.retainedBytes,
      afterClosed.before.retainedBytes,
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=other]').click()",
    );
    await until(() =>
      page.evaluate(ui("s.scopeReady&&r().model.activeChatId==='other-chat'")),
    );
    await until(() =>
      page.evaluate(
        "document.body.textContent.includes('Synthetic other greeting')",
      ),
    );
    const afterNavigation = await until(
      () => page.evaluate("window.cacheStats()"),
      (s) => s.owners === 1,
    );
    assert.ok(afterNavigation.retainedBytes < mounted.retainedBytes);
    const result = {
      syntheticOnly: true,
      actualOriginalParser: true,
      actualOriginalUi: true,
      actualLuaWorker: true,
      statefulLuaCallsPreserved: true,
      exactPolicyAndSanitizerInput: true,
      freshCssCbs: true,
      mountedOwners: mounted.owners,
      ownersAfterNavigation: afterNavigation.owners,
      retentionBeforeNavigation: mounted.retainedBytes,
      retentionAfterNavigation: afterNavigation.retainedBytes,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "src/ts/runtime/displayRenderCache.ts",
            "src/ts/parser/parser.svelte.ts",
            "src/lib/ChatScreens/ChatBody.svelte",
            "server/browser/displayRenderCacheUi.test.cjs",
          ].map(async (path) => [
            path,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]),
        ),
      ),
    };
    if (process.env.RISU_DISPLAY_RENDER_CACHE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_RENDER_CACHE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result));
  },
);
