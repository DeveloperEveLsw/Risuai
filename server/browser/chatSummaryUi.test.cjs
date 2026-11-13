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
const ui = (v) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${v}})()`;
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error("Synthetic folder summary timed out: " + JSON.stringify(value));
}

test(
  "original chat folders restore unopened membership, reject delayed stale headers and keep orphan chats visible across devices and reload",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-chat-summary-ui-"));
    let runtime, frontend, browser, release;
    let hold = false,
      held = 0;
    const origins = [],
      requests = [],
      errors = [];
    t.after(async () => {
      release?.();
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
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    });
    const command = (requestId, command) =>
      runtime.store.call("applyCommand", requestId, command);
    await command("synthetic-summary-settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: 0,
      payload: {
        didFirstSetup: true,
        language: "en",
        autoTranslate: false,
        aiModel: "gpt35",
        useStreaming: false,
        maxContext: 8000,
        maxResponse: 128,
        zoomsize: 100,
        theme: "default",
        timeout: 120,
      },
    });
    await command("synthetic-summary-character", {
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic folders",
        desc: "Synthetic",
        firstMessage: "Synthetic greeting",
        chatFolders: [
          { id: "f1", name: "Synthetic one", folded: false },
          { id: "f2", name: "Synthetic two", folded: false },
        ],
      },
    });
    for (const [id, folderId, count] of [
      ["a", "f1", 110],
      ["b", "f1", 180],
      ["c-chat", "f2", 140],
      ["d", null, 9],
      ["orphan", "synthetic-missing-folder", 7],
    ]) {
      await command("synthetic-summary-chat-" + id, {
        type: "create-chat",
        characterId: "c",
        chatId: id,
        metadata: {
          name: "Synthetic chat " + id,
          folderId,
          note: "Synthetic hidden metadata marker ".repeat(1024),
          extension: { retained: true },
          fmIndex: -1,
        },
        messages: Array.from({ length: count }, (_, index) => ({
          id: id + "-message-" + index,
          message: { role: "char", data: "Synthetic " + id + " line " + index },
        })),
      });
    }
    const originalCall = runtime.store.call.bind(runtime.store);
    runtime.store.call = async (method, ...args) => {
      const value = await originalCall(method, ...args);
      if (hold && method === "getCharacter" && args[0] === "c") {
        hold = false;
        held++;
        await new Promise((resolve) => (release = resolve));
      }
      return value;
    };
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "synthetic-summary-observation",
          configureServer(server) {
            server.middlewares.use((req, _res, next) => {
              const path = new URL(req.url, "http://synthetic.invalid")
                .pathname;
              if (
                req.method === "GET" &&
                /^\/api\/runtime\/chats\/[^/]+$/.test(path)
              )
                requests.push(req.url);
              next();
            });
          },
        },
      ],
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
    const ready = async (page) => {
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
          ui(
            "s.scopeReady&&r().model.activeChatId==='a'&&!!document.querySelector('[data-chat-id=b]')",
          ),
        ),
      );
    };
    const open = async () => {
      const page = await browser.page(url, await browser.newContext(), {
        blockHttps: true,
        viewport: { width: 1280, height: 900 },
      });
      page.on("Runtime.exceptionThrown", (v) =>
        errors.push(v.exceptionDetails?.text),
      );
      await ready(page);
      return page;
    };
    const a = await open(),
      b = await open();
    const layout = (page) =>
      page.evaluate(
        "(()=>{const result={};for(const e of document.querySelectorAll('[data-chat-id][data-risu-chat-idx]')){const folder=e.closest('[data-risu-chat-folder-idx]');result[e.dataset.chatId]=folder?['f1','f2'][Number(folder.dataset.risuChatFolderIdx)]:'unassigned'}return result})()",
      );
    const expected = {
      a: "f1",
      b: "f1",
      "c-chat": "f2",
      d: "unassigned",
      orphan: "unassigned",
    };
    assert.deepEqual(await layout(a), expected);
    assert.deepEqual(await layout(b), expected);
    const initialBodyRequests = [...requests];
    assert.ok(initialBodyRequests.length > 0);
    assert.ok(
      initialBodyRequests.every(
        (path) => new URL(path, url).pathname === "/api/runtime/chats/a",
      ),
    );
    const unopened = await b.evaluate(
      ui(
        "({cursor:r().model.chatMetadataCursor('b'),messages:r().model.database.characters.find(c=>c.chaId==='c').chats.find(c=>c.id==='b').message.length})",
      ),
    );
    assert.deepEqual(unopened, { cursor: -1, messages: 0 });
    hold = true;
    await b.evaluate(
      ui(
        "(window.syntheticFolderRefresh=r().model.ensureCharacter('c',true),true)",
      ),
    );
    await until(() => held === 1);
    await a.evaluate(
      ui(
        "(r().setField({scope:'chat',entityId:'b',key:'folderId'},'f2'),true)",
      ),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(
      () => layout(b),
      (value) => value.b === "f2",
    );
    release();
    await b.evaluate("window.syntheticFolderRefresh.then(()=>true)");
    assert.equal((await layout(b)).b, "f2");
    assert.equal(await b.evaluate(ui("r().model.chatMetadataCursor('b')")), -1);
    assert.ok(
      requests.every(
        (path) => new URL(path, url).pathname === "/api/runtime/chats/a",
      ),
    );
    const beforeSelection = requests.length;
    await b.evaluate("document.querySelector('[data-chat-id=b]').click()");
    await until(() =>
      b.evaluate(
        ui(
          "s.scopeReady&&r().model.activeChatId==='b'&&r().model.activeChat.message.length===100",
        ),
      ),
    );
    assert.ok(
      requests
        .slice(beforeSelection)
        .some((path) => new URL(path, url).pathname === "/api/runtime/chats/b"),
    );
    assert.equal(
      await b.evaluate(
        ui(
          "r().model.activeChat.note.startsWith('Synthetic hidden metadata marker')&&r().model.activeChat.extension.retained",
        ),
      ),
      true,
    );
    await a.evaluate(
      ui(
        "(r().setField({scope:'chat',entityId:'b',key:'folderId'},undefined),true)",
      ),
    );
    await until(() => a.evaluate(ui("s.pending.length===0")));
    await until(
      () => layout(b),
      (value) => value.b === "unassigned",
    );
    await b.send("Page.reload");
    await ready(b);
    assert.deepEqual(await layout(b), { ...expected, b: "unassigned" });
    const stored = await runtime.store.call("snapshot", "orphan", { limit: 1 });
    assert.equal(stored.chat.metadata.folderId, "synthetic-missing-folder");
    assert.deepEqual(stored.chat.metadata.extension, { retained: true });
    assert.deepEqual(errors, []);
    const result = {
      syntheticOnly: true,
      actualOriginalUi: true,
      independentBrowserContexts: true,
      bodyFreeInitialFolders: true,
      initialLayout: expected,
      initialBodyRequests,
      unopened,
      delayedFieldProjectionRetained: true,
      unopenedMetadataRemainsUnloaded: true,
      selectedSnapshotLoadsNormally: true,
      orphanVisibleWithoutRewrite: true,
      fieldRemovalAndReload: true,
      held,
      requests,
      errors,
      sourceHashes: {},
    };
    for (const path of [
      "server/entity/store.cjs",
      "src/ts/runtime/risuReadModel.ts",
      "src/lib/SideBars/SideChatList.svelte",
      "server/browser/chatSummaryUi.test.cjs",
      "server/entity/chatSummary.test.cjs",
      "src/ts/runtime/risuReadModel.test.ts",
    ])
      result.sourceHashes[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    if (process.env.RISU_CHAT_SUMMARY_UI_OUTPUT)
      await writeFile(
        process.env.RISU_CHAT_SUMMARY_UI_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
  },
);
