"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const {
  WYGLORE_RELEASE,
  getWygloreRelease,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");

const pluginPath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(pluginPath)
    ? false
    : "Fetch the pinned public WygLore fixture before compatibility validation",
  timeout: 15000,
};

async function fixture(t, options = {}) {
  let now = Date.now();
  const store = new EntityStore(":memory:", { now: () => now });
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      aiModel: "reverse_proxy",
      pluginIds: ["wyglore"],
      customProxyRequestModel: "synthetic-main",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: !options.failureAtHook,
      mainPrompt: "Help the gardener.",
      maxContext: 8000,
      maxResponse: 200,
      requestRetrys: 0,
    },
  });
  const script = fs.readFileSync(pluginPath, "utf8");
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      enabled: true,
      script,
      realArg: {},
    },
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "garden",
    definition: {
      type: "character",
      name: "Green",
      desc: "Green tends blue flowers.",
      firstMessage: "Welcome to the garden.",
      globalLore: [],
      triggerscript: [
        {
          comment: "Synthetic output processing",
          type: "output",
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: `listenEdit('editOutput', function(id, text, meta)
                setChatVar(id, 'outputDone', 'yes')
                ${options.luaFailure ? "error('synthetic Lua failure')" : "return text .. ':lua'"}
              end)`,
            },
          ],
        },
      ],
    },
    chat: {
      chatId: "a",
      metadata: { name: "Synthetic garden", localLore: [] },
    },
  });
  const plugin = store.getResource("plugin", "wyglore");
  const namespace = {
    pluginId: plugin.id,
    bundleSha: getWygloreRelease(plugin.payload.script).sha256,
    pluginEpoch: plugin.entityEpoch,
  };
  const initial = store.claimPluginStorage({
    namespace,
    writerId: "settings",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease: initial,
    expectedRevision: 0,
    commitId: "settings",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          speedMode: "fast",
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  store.releasePluginStorage(initial);
  const originalStorage = store.readAllPluginStorage(namespace);
  store.enqueueJob("generation", {
    type: "send",
    chatId: "a",
    input: "Tell me about blue flowers.",
    messageId: "synthetic-input",
  });
  const claimed = store.claimJob("worker:generation");
  const controller = new AbortController();
  const warnings = [],
    progress = [];
  let mainRequests = 0,
    memoryRequests = 0,
    realm,
    coordinator;
  const providerFetch = async (url, init) => {
    assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
    mainRequests++;
    assert.equal(mainRequests, 1, "The paid chat must never be replayed");
    if (options.failureAtHook)
      return Response.json({
        choices: [{ message: { content: "Synthetic blue flowers." } }],
      });
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Synthetic blue flowers" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const memoryFetch = async (url) => {
    assert.equal(String(url), "https://synthetic.invalid/memory");
    memoryRequests++;
    assert.equal(memoryRequests, 1, "An uncertain memory call must not replay");
    if (options.bodyFailure)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new TypeError("Synthetic memory stream loss"), {
                code: "ECONNRESET",
              }),
            );
          },
        }),
      );
    throw Object.assign(new TypeError("Synthetic memory transport loss"), {
      code: "ECONNRESET",
    });
  };
  coordinator = createNativePluginCoordinator({
    store: { call: async (method, ...args) => store[method](...args) },
    job: claimed.job,
    snapshot: claimed.snapshot,
    signal: controller.signal,
    createFetch: (context) =>
      native.createNativeTransport(context, {
        providerFetch: memoryFetch,
        signal: controller.signal,
        isolateProviderFailure: true,
      }).fetchNative,
    alertSelect: async () => {
      throw new Error("Unexpected synthetic interaction");
    },
    onWarning: (warning) => warnings.push(warning),
  });
  async function failMemory() {
    assert.ok(realm, "The actual pinned plugin realm must be running");
    await realm.risuai.pluginStorage.setItem("synthetic.private", {
      discarded: true,
    });
    await assert.rejects(
      async () => {
        const response = await realm.risuai.nativeFetch(
          "https://synthetic.invalid/memory",
          { method: "POST", body: "{}" },
        );
        await response.text();
      },
      { code: "PLUGIN_PROVIDER_UNCERTAIN" },
    );
  }
  async function run() {
    const originalCreateContext = vm.createContext;
    vm.createContext = (sandbox, ...args) => {
      const actualRealm = originalCreateContext(sandbox, ...args);
      if (
        sandbox.risuai &&
        sandbox.navigator?.userAgent === "Risu server native"
      ) {
        assert.equal(realm, undefined);
        realm = actualRealm;
        vm.createContext = originalCreateContext;
      }
      return actualRealm;
    };
    try {
      return await native.executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        signal: controller.signal,
        providerFetch,
        fetch: async (path) =>
          new Response(
            fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
          ),
        onProgress: (event) => progress.push(event),
        preparePluginSnapshot: coordinator.prepareSnapshot,
        openPluginRuntime: async (context) => {
          const installed = await coordinator.open(context);
          if (options.failureAtHook) {
            const original = [
              ...installed.requestHooks.replacerafterRequest,
            ][0];
            installed.requestHooks.replacerafterRequest = new Set([
              async (...args) => {
                await failMemory();
                return original(...args);
              },
            ]);
          }
          return {
            ...installed,
            async complete() {
              if (!options.failureAtHook) await failMemory();
              await options.beforeComplete?.({ store, controller, namespace });
              return installed.complete();
            },
          };
        },
      });
    } finally {
      vm.createContext = originalCreateContext;
    }
  }
  t.after(async () => {
    await coordinator.release();
    store.close();
  });
  return {
    store,
    namespace,
    originalStorage,
    claimed,
    warnings,
    progress,
    run,
    counts: () => ({ main: mainRequests, memory: memoryRequests }),
    finish: (outcome) =>
      store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
        state: "completed",
        ...outcome,
      }),
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test(
  "a memory response body failure after HTTP 200 preserves completed streaming chat and discards private plugin memory",
  actual,
  async (t) => {
    const f = await fixture(t, { bodyFailure: true });
    const outcome = await f.run();
    assert.deepEqual(f.counts(), { main: 1, memory: 1 });
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].diagnostic.phase, "body");
    assert.equal(f.warnings[0].diagnostic.status, 200);
    assert.deepEqual(outcome.pluginStorage.writes, []);
    f.finish(outcome);
    assert.equal(
      f.store.snapshot("a").messages.at(-1).message.data,
      "Synthetic blue flowers.:lua",
    );
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
  },
);

test(
  "a completed real-plugin streaming chat survives optional memory uncertainty without publishing plugin overlays or replaying",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.run();
    assert.deepEqual(f.counts(), { main: 1, memory: 1 });
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].code, "PLUGIN_PROVIDER_UNCERTAIN");
    assert.equal(f.warnings[0].diagnostic.category, "connection");
    assert.deepEqual(outcome.pluginStorage.writes, []);
    assert.equal(outcome.pluginStorage.expectedRevision, 1);
    assert.ok(outcome.pluginStorage.reads.currentScope);
    assert.equal(outcome.pluginStorage.lease.namespace.pluginEpoch, 0);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
    f.finish(outcome);
    const saved = f.store.snapshot("a");
    assert.equal(saved.messages.length, 2);
    assert.equal(
      saved.messages.at(-1).message.data,
      "Synthetic blue flowers.:lua",
    );
    assert.equal(
      saved.variables.find((row) => row.key === "$outputDone")?.value,
      "yes",
    );
    assert.equal(saved.chat.metadata.associationTree, undefined);
    assert.deepEqual(saved.chat.metadata.localLore, []);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
  },
);

test(
  "an uncertain real-plugin afterRequest hook returns the original response and still executes Lua exactly once",
  actual,
  async (t) => {
    const f = await fixture(t, { failureAtHook: true });
    const outcome = await f.run();
    f.finish(outcome);
    assert.deepEqual(f.counts(), { main: 1, memory: 1 });
    assert.equal(f.warnings.length, 1);
    assert.equal(
      f.store.snapshot("a").messages.at(-1).message.data,
      "Synthetic blue flowers.:lua",
    );
  },
);

test(
  "Lua failure after a quarantined plugin remains fatal and cannot produce a clean completed transaction",
  actual,
  async (t) => {
    const f = await fixture(t, { failureAtHook: true, luaFailure: true });
    await assert.rejects(f.run(), /synthetic Lua failure/);
    assert.deepEqual(f.counts(), { main: 1, memory: 1 });
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
  },
);

test(
  "an optional network failure cannot hide a cancelled generation job",
  actual,
  async (t) => {
    const f = await fixture(t, {
      beforeComplete: ({ store }) => store.requestCancel("generation"),
    });
    await assert.rejects(f.run(), { code: "JOB_CANCELLED" });
    assert.equal(f.warnings.length, 0);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
  },
);

test(
  "a read-only degraded checkpoint still rejects changed plugin source reads at atomic finish",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.run();
    const source = f.store.getResource("plugin", "wyglore");
    f.store.applyCommand("changed-plugin", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: source.revision,
      payload: { ...source.payload, realArg: { syntheticChanged: "yes" } },
    });
    assert.throws(() => f.finish(outcome), {
      code: "REVISION_CONFLICT",
    });
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
  },
);

test(
  "a read-only degraded checkpoint still rejects an expired generation lease",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.run();
    f.advance(120001);
    assert.throws(() => f.finish(outcome), {
      code: "STALE_WORKER",
    });
    assert.equal(f.store.snapshot("a").messages.length, 0);
  },
);

test(
  "a read-only degraded checkpoint cannot commit through a successor plugin writer fence",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.run();
    f.store.releasePluginStorage(outcome.pluginStorage.lease);
    const successor = f.store.claimPluginStorage({
      namespace: f.namespace,
      writerId: "synthetic-successor",
      authority: { kind: "browser" },
    });
    assert.ok(successor.fence > outcome.pluginStorage.lease.fence);
    assert.throws(() => f.finish(outcome), { code: "STALE_PLUGIN_WORKER" });
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.deepEqual(
      f.store.readAllPluginStorage(f.namespace),
      f.originalStorage,
    );
    f.store.releasePluginStorage(successor);
  },
);

test(
  "a read-only degraded checkpoint retains the admitted plugin incarnation",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.run();
    const plugin = f.store.getResource("plugin", "wyglore");
    f.store.applyCommand("remove-plugin", {
      type: "delete-library-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: plugin.revision,
      expectedEpoch: plugin.entityEpoch,
    });
    f.store.applyCommand("replace-plugin", {
      type: "save-library-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: f.store.deletedRevision(
        "resource",
        "plugin",
        "wyglore",
      ),
      expectedEpoch: f.store.deletedRevision("resource", "plugin", "wyglore"),
      payload: plugin.payload,
    });
    assert.ok(
      f.store.getResource("plugin", "wyglore").entityEpoch >
        outcome.pluginStorage.lease.namespace.pluginEpoch,
    );
    assert.throws(() => f.finish(outcome), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.snapshot("a").messages.length, 0);
  },
);
