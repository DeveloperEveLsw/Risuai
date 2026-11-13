"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const {
  instrumentWygloreTransportCancellation,
  PROFILES,
} = require("./wygloreTransportCancellation.cjs");
const {
  defaultWygloreFixturePath,
  getWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");

const digest = (text) => createHash("sha256").update(text).digest("hex");
async function until(read) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() >= deadline)
      throw Error("Synthetic cancellation did not settle");
    await delay(5);
  }
}

async function fixture(t, version, mode = "headers", update = false) {
  const path = defaultWygloreFixturePath(version);
  const source = fs.readFileSync(path, "utf8");
  const network = { calls: 0, closed: 0, aborted: 0, originalSignals: [] };
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    } // Synthetic test body only; never record it.
    network.calls++;
    res.once("close", () => network.closed++);
    if (mode === "headers") return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
    if (mode === "success") res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const synthetic = makeWygloreContractFixture({
    storage: new Map([
      [
        "wl.llm.config",
        JSON.stringify({
          completeProviderId: "custom-openai",
          completeModel: "synthetic-cancel",
          maxConcurrent: 1,
        }),
      ],
      ["wl.provider.custom-openai.apiKey", "synthetic-key"],
      ["wl.provider.custom-openai.baseUrl", baseUrl],
    ]),
  });
  const namespace = {
    pluginId: "synthetic-plugin",
    bundleSha: getWygloreRelease(source).sha256,
    pluginEpoch: 0,
  };
  const storage = createPluginStorageSession(
    {
      namespace,
      revision: 0,
      items: [...synthetic.storage].map(([key, value]) => ({
        key,
        value,
        revision: 0,
      })),
    },
    {
      namespace,
      writerId: "synthetic-worker",
      token: "synthetic-token",
      fence: 1,
      revision: 0,
    },
  );
  const lifetime = new AbortController();
  let failure, sandbox;
  const context = {
    getCurrentCharacter: () => synthetic.character,
    getCurrentChat: () => synthetic.chat,
    setCurrentChat: (next) => Object.assign(synthetic.chat, next),
    getDatabase: () => synthetic.database,
    readResourceValue: (value) => value,
    ensureHealthy() {
      if (failure) throw failure;
    },
    fail(message) {
      failure ??= new Error(message);
      throw failure;
    },
  };
  const originalScript = vm.Script,
    originalCreate = vm.createContext;
  // Test-only observation inside the already reviewed execution copy. Production
  // exports neither private author helpers nor a way to override its program.
  vm.Script = class extends originalScript {
    constructor(executable, options) {
      if (options?.filename?.startsWith("WygLoreLeaf-")) {
        const end = executable.lastIndexOf("})();");
        executable =
          executable.slice(0, end) +
          "\nglobalThis.__SYNTHETIC_CANCEL={slot:testSlotConnection,client:getLLMClient,fetch:fetchWithFallback,hostInit:_hostSafeInit};\n" +
          executable.slice(end);
      }
      super(executable, options);
    }
  };
  vm.createContext = (value, ...args) => {
    if (value.risuai && value.navigator?.userAgent === "Risu server native") {
      sandbox = value;
      const nativeFetch = value.risuai.nativeFetch;
      value.risuai.nativeFetch = (url, init) => {
        network.originalSignals.push(init?.signal);
        return nativeFetch(url, init);
      };
    }
    return originalCreate(value, ...args);
  };
  let host;
  try {
    host = await createServerPluginHost({
      plugin: {
        id: namespace.pluginId,
        enabled: true,
        name: "◆ WygLore Leaf",
        version: "3.0",
        script: source,
      },
      context,
      storage,
      signal: lifetime.signal,
      fetch: (url, init) => {
        assert.equal(
          String(url),
          update
            ? "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/main/version.json"
            : baseUrl + "/chat/completions",
          "Only the explicitly mapped synthetic target is permitted",
        );
        init.signal.addEventListener("abort", () => network.aborted++, {
          once: true,
        });
        return fetch(update ? baseUrl + "/chat/completions" : url, init);
      },
    });
  } finally {
    vm.Script = originalScript;
    vm.createContext = originalCreate;
  }
  t.after(() => host?.close());
  assert.equal(digest(fs.readFileSync(path, "utf8")), namespace.bundleSha);
  return {
    host,
    network,
    lifetime,
    api: sandbox.__SYNTHETIC_CANCEL,
    url: baseUrl + "/chat/completions",
  };
}

test("cancellation profiles remain separately pinned to two original author artifacts", () => {
  assert.ok(Object.isFrozen(PROFILES));
  assert.deepEqual(Object.keys(PROFILES).sort(), [
    "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
    "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
  ]);
  assert.ok(Object.values(PROFILES).every(Object.isFrozen));
});

for (const version of ["3.1.6", "3.2.0"]) {
  const path = defaultWygloreFixturePath(version);
  const actual = {
    skip: fs.existsSync(path)
      ? false
      : "Preserve the pinned original WygLore fixture",
    timeout: 15000,
  };

  test(
    `${version} adapter preserves original bytes and rejects changed, colliding or doubled seams`,
    actual,
    () => {
      const source = fs.readFileSync(path, "utf8"),
        before = digest(source);
      const executable = instrumentWygloreLifecycle(source);
      const adapted = instrumentWygloreTransportCancellation(
        source,
        executable,
      );
      assert.equal(digest(source), before);
      assert.notEqual(adapted, executable);
      assert.throws(() =>
        instrumentWygloreTransportCancellation(source + "\n"),
      );
      assert.throws(() =>
        instrumentWygloreTransportCancellation(
          source,
          executable.replace(
            "function _hostSafeInit(init){",
            "function _hostSafeInit(init){void 0;",
          ),
        ),
      );
      assert.throws(() =>
        instrumentWygloreTransportCancellation(source, adapted),
      );
      assert.throws(() =>
        instrumentWygloreTransportCancellation(
          source,
          executable + "__wlServerSlotAbort",
        ),
      );
      assert.ok(
        adapted.includes("DEFAULT_TIMEOUT_MS=8e3"),
        "The original slot test budget is unchanged",
      );
      assert.ok(
        adapted.includes("HOST_TRANSPORT_TIMEOUT_MS=6e4"),
        "The original transport budget is unchanged",
      );
      assert.ok(
        adapted.includes("DEFAULT_LLM_TIMEOUT_MS=12e4"),
        "The original generation budget is unchanged",
      );
    },
  );

  test(
    `${version} only the exact measured Vertex model gets a 60s slot test and explicit budgets remain authoritative`,
    actual,
    async () => {
      const source = fs.readFileSync(path, "utf8");
      const adapted = instrumentWygloreTransportCancellation(source);
      let slot;
      walk.simple(acorn.parse(adapted, { ecmaVersion: "latest" }), {
        FunctionDeclaration(node) {
          if (node.id?.name === "testSlotConnection")
            slot = adapted.slice(node.start, node.end);
        },
      });
      assert.ok(slot);
      const timers = [],
        signals = [];
      const sandbox = {
        AbortController,
        DOMException,
        DEFAULT_TIMEOUT_MS: 8000,
        TEST_PROMPT: "ping",
        TEST_SYSTEM: "Reply with exactly: pong",
        estimateTokens2: () => 1,
        classifyProviderResponseFailure: () => null,
        safeRecord: async () => {},
        getLLMClient: () => ({
          complete: async (_prompt, options) => {
            signals.push(options.signal);
            return "pong";
          },
        }),
        setTimeout: (callback, ms) => {
          timers.push(ms);
          return setTimeout(callback, ms);
        },
        clearTimeout,
      };
      const context = vm.createContext(sandbox);
      vm.runInContext(slot, context);
      for (const [provider, model, options, expected] of [
        ["vertex", "gemini-3.8-flash", {}, 60000],
        ["vertex", " gemini-3.8-flash ", {}, 60000],
        ["vertex", "gemini-3.8-flash", { timeoutMs: 1234 }, 1234],
        ["vertex", "gemini-2.5-flash", {}, 8000],
        ["vertex", "gemini-3.8-flash-preview", {}, 8000],
        ["google-ai", "gemini-3.8-flash", {}, 8000],
        ["custom-google", "gemini-3.8-flash", {}, 8000],
      ]) {
        const before = timers.length;
        const result = await sandbox.testSlotConnection(
          "complete",
          provider,
          model,
          options,
        );
        assert.equal(result.ok, true);
        assert.equal(timers.length, before + 1);
        assert.equal(timers.at(-1), expected);
        assert.ok(signals.at(-1) instanceof AbortSignal);
        assert.equal(signals.at(-1).aborted, false);
      }
    },
  );

  for (const mode of ["headers", "body"])
    test(
      `${version} original slot deadline aborts physical ${mode} IO exactly once without aborting job lifetime`,
      actual,
      async (t) => {
        const f = await fixture(t, version, mode);
        const result = await f.api.slot(
          "complete",
          "custom-openai",
          "synthetic-cancel",
          { timeoutMs: 150 },
        );
        assert.equal(result.ok, false);
        assert.equal(result.error, "timeout 150ms");
        await until(() => f.network.closed === 1 && f.network.aborted === 1);
        assert.equal(f.network.calls, 1);
        assert.ok(f.network.originalSignals[0] instanceof AbortSignal);
        assert.equal(f.network.originalSignals[0].aborted, true);
        assert.equal(f.lifetime.signal.aborted, false);
        await until(() => f.api.client()._sem.active === 0);
        await delay(30);
        assert.equal(
          f.network.calls,
          1,
          "An uncertain paid call cannot replay through fallback",
        );
      },
    );

  test(
    `${version} original host-attempt deadline aborts a physical POST and cannot fall through to another transport`,
    actual,
    async (t) => {
      const f = await fixture(t, version);
      await assert.rejects(
        () =>
          f.api.fetch(f.url, {
            method: "POST",
            body: "{}",
            hostTimeoutMs: 150,
          }),
        { code: "WL_HOST_TIMEOUT" },
      );
      await until(() => f.network.closed === 1 && f.network.aborted === 1);
      assert.equal(f.network.calls, 1);
      assert.equal(f.network.originalSignals[0].aborted, true);
      assert.equal(f.lifetime.signal.aborted, false);
      await delay(30);
      assert.equal(f.network.calls, 1);
    },
  );

  test(
    `${version} the real client combines caller cancellation with its lifetime and cancels paid HTTP once`,
    actual,
    async (t) => {
      const f = await fixture(t, version);
      const caller = new AbortController();
      const request = f.api.client().complete("Synthetic cancellation", {
        providerOverride: "custom-openai",
        modelOverride: "synthetic-cancel",
        signal: caller.signal,
        useCache: false,
      });
      const rejected = assert.rejects(request);
      await until(() => f.network.calls === 1);
      caller.abort(
        new DOMException("Synthetic caller cancellation", "AbortError"),
      );
      await rejected;
      await until(() => f.network.closed === 1 && f.network.aborted === 1);
      assert.equal(f.network.calls, 1);
      assert.equal(f.lifetime.signal.aborted, false);
    },
  );

  test(
    `${version} cancelling a queued client call never sends it to the provider`,
    actual,
    async (t) => {
      const f = await fixture(t, version);
      const first = new AbortController(),
        second = new AbortController();
      const options = {
        providerOverride: "custom-openai",
        modelOverride: "synthetic-cancel",
        useCache: false,
      };
      const firstRejected = assert.rejects(
        f.api.client().complete("First synthetic request", {
          ...options,
          signal: first.signal,
        }),
      );
      await until(() => f.network.calls === 1);
      const secondRejected = assert.rejects(
        f.api.client().complete("Second synthetic request", {
          ...options,
          signal: second.signal,
        }),
      );
      await until(() => f.api.client()._sem.queue.length === 1);
      second.abort(
        new DOMException("Synthetic queued cancellation", "AbortError"),
      );
      await secondRejected;
      assert.equal(f.network.calls, 1);
      assert.equal(f.network.closed, 0);
      first.abort(
        new DOMException("Synthetic first cancellation", "AbortError"),
      );
      await firstRejected;
      await until(() => f.network.closed === 1);
      assert.equal(f.network.calls, 1);
      assert.equal(f.lifetime.signal.aborted, false);
    },
  );

  test(
    `${version} host lifetime cancellation also aborts a response body without a replacement paid call`,
    actual,
    async (t) => {
      const f = await fixture(t, version, "body");
      const rejected = assert.rejects(
        f.api.client().complete("Synthetic lifetime request", {
          providerOverride: "custom-openai",
          modelOverride: "synthetic-cancel",
          useCache: false,
        }),
      );
      await until(() => f.network.calls === 1);
      f.lifetime.abort(
        new DOMException("Synthetic job lifetime cancellation", "AbortError"),
      );
      await rejected;
      await until(() => f.network.closed === 1 && f.network.aborted === 1);
      assert.equal(f.network.calls, 1);
      assert.equal(f.lifetime.signal.aborted, true);
    },
  );

  test(
    `${version} successful original streaming test keeps its response and causes no synthetic abort`,
    actual,
    async (t) => {
      const f = await fixture(t, version, "success");
      const result = await f.api.slot(
        "complete",
        "custom-openai",
        "synthetic-cancel",
        { timeoutMs: 1000 },
      );
      assert.equal(result.ok, true);
      assert.equal(result.response, "pong");
      assert.equal(f.network.calls, 1);
      assert.equal(f.network.aborted, 0);
      assert.ok(f.network.originalSignals[0] instanceof AbortSignal);
      assert.equal(f.network.originalSignals[0].aborted, false);
      assert.equal(f.lifetime.signal.aborted, false);
      await f.host.close({ success: true });
    },
  );

  test(
    `${version} the exact free update probe retains caller cancellation without aborting the job lifetime`,
    actual,
    async (t) => {
      const f = await fixture(t, version, "headers", true);
      const caller = new AbortController();
      const rejected = assert.rejects(
        f.api.fetch(
          "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/main/version.json",
          { method: "GET", signal: caller.signal },
        ),
      );
      await until(() => f.network.calls === 1);
      caller.abort(
        new DOMException("Synthetic update cancellation", "AbortError"),
      );
      await rejected;
      await until(() => f.network.closed === 1 && f.network.aborted === 1);
      assert.equal(f.network.calls, 1);
      assert.equal(f.lifetime.signal.aborted, false);
    },
  );
}
