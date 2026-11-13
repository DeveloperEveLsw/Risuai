"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const {
  WYGLORE_RELEASE,
  getWygloreRelease,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const path =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(path)
    ? false
    : "Fetch the pinned WygLore fixture before compatibility validation",
};
async function fixture(t, { streaming = false, longChat = false } = {}) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  store.initializeState(native.createInitialRuntimeState());
  const previous = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: previous.revision,
    payload: {
      ...previous.payload,
      aiModel: "reverse_proxy",
      pluginIds: ["wyglore"],
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: streaming,
      mainPrompt: "Help the gardener.",
      maxContext: 8000,
      maxResponse: 200,
    },
  });
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
      script: fs.readFileSync(path, "utf8"),
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
      triggerscript: [],
    },
    chat: {
      chatId: "chat",
      metadata: { name: "Synthetic garden", localLore: [] },
    },
  });
  const plugin = store.getResource("plugin", "wyglore");
  const namespace = {
    pluginId: "wyglore",
    bundleSha: getWygloreRelease(plugin.payload.script).sha256,
    pluginEpoch: plugin.entityEpoch,
  };
  const initial = store.claimPluginStorage({
    namespace,
    writerId: "synthetic-settings",
    authority: { kind: "browser" },
  });
  const memory = makeWygloreContractFixture({ longChat });
  if (longChat)
    for (const message of memory.chat.message)
      store.applyCommand("seed:" + message.chatId, {
        type: "append-message",
        chatId: "chat",
        messageId: message.chatId,
        message,
      });
  store.commitPluginStorage({
    lease: initial,
    expectedRevision: 0,
    commitId: "initial-settings",
    writes: longChat
      ? [...memory.storage].map(([key, value]) => ({ key, value }))
      : [
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
  const requests = [],
    memoryRequests = [],
    progress = [];
  const providerFetch = async (url, init) => {
    assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
    const body = JSON.parse(init.body);
    if (body.model === "synthetic-test") {
      memoryRequests.push(body);
      return memory.host.nativeFetch(url, init);
    }
    requests.push(body);
    if (streaming)
      return new Response(
        'data: {"choices":[{"delta":{"content":"The blue flowers bloom."}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json({
      choices: [{ message: { content: "The blue flowers bloom." } }],
    });
  };
  async function execute(id) {
    store.enqueueJob(id, {
      type: "send",
      chatId: "chat",
      input: "Green, tell me about the flowers.",
      messageId: id + ":input",
    });
    const claimed = store.claimJob("synthetic-worker");
    const coordinator = createNativePluginCoordinator({
      store: { call: async (method, ...args) => store[method](...args) },
      job: claimed.job,
      snapshot: claimed.snapshot,
      fetch: providerFetch,
      onProgress: (event) => progress.push(event),
      alertSelect: async () => {
        throw Error("Unexpected synthetic interaction");
      },
    });
    try {
      const result = await native.executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        providerFetch,
        fetch: async (path) =>
          new Response(
            fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
          ),
        onProgress: (event) => progress.push(event),
        preparePluginSnapshot: coordinator.prepareSnapshot,
        openPluginRuntime: coordinator.open,
      });
      return { result, claimed, coordinator };
    } catch (error) {
      await coordinator.release();
      throw error;
    }
  }
  return { store, namespace, requests, memoryRequests, progress, execute };
}
for (const streaming of [false, true])
  test(
    `compiled native ${streaming ? "streaming" : "non-streaming"} generation uses the real plugin and commits graph/chat atomically`,
    actual,
    async (t) => {
      const f = await fixture(t, { streaming });
      const outcome = await f.execute("first");
      try {
        assert.equal(f.requests.length, 1);
        assert.match(
          f.requests[0].messages.map((message) => message.content).join("\n"),
          /WygLore Leaf — canonical layer/,
        );
        assert.match(
          f.requests[0].messages.map((message) => message.content).join("\n"),
          /Green tends blue flowers/,
        );
        assert.equal(f.store.snapshot("chat").messages.length, 0);
        assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
        assert.ok(outcome.result.pluginStorage.writes.length > 0);
        f.store.finishJob(
          outcome.claimed.job.id,
          outcome.claimed.job.owner,
          outcome.claimed.job.fence,
          { state: "completed", ...outcome.result },
        );
        assert.equal(
          f.store.snapshot("chat").messages.at(-1).message.data,
          "The blue flowers bloom.",
        );
        assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 2);
        if (streaming)
          assert.ok(f.progress.some((event) => event.type === "messages"));
      } finally {
        await outcome.coordinator.release();
      }
      const restart = await f.execute("second");
      try {
        assert.match(
          f.requests[1].messages.map((message) => message.content).join("\n"),
          /canonical layer/,
        );
        f.store.finishJob(
          restart.claimed.job.id,
          restart.claimed.job.owner,
          restart.claimed.job.fence,
          { state: "completed", ...restart.result },
        );
        assert.equal(f.store.snapshot("chat").messages.length, 4);
      } finally {
        await restart.coordinator.release();
      }
    },
  );
test(
  "a final native chat conflict leaves the real plugin graph and receipt unchanged",
  actual,
  async (t) => {
    const f = await fixture(t),
      outcome = await f.execute("conflict");
    try {
      const before = f.store.readAllPluginStorage(f.namespace);
      const target = { scope: "chat", entityId: "chat", key: "localLore" };
      const field = f.store.readFields([target]).fields[0];
      f.store.applyCommand("peer-lore", {
        type: "change-fields",
        edits: [
          {
            ...target,
            expectedRevision: field.revision,
            expectedEpoch: field.entityEpoch,
            value: [
              {
                key: "synthetic-peer",
                content: "Peer lore edit",
                enabled: false,
              },
            ],
          },
        ],
      });
      assert.throws(
        () =>
          f.store.finishJob(
            outcome.claimed.job.id,
            outcome.claimed.job.owner,
            outcome.claimed.job.fence,
            { state: "completed", ...outcome.result },
          ),
        { code: "REVISION_CONFLICT" },
      );
      assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
      assert.equal(f.store.snapshot("chat").messages.length, 0);
    } finally {
      await outcome.coordinator.release();
    }
  },
);

test(
  "compiled native generation waits for original background memory before atomic persistence",
  actual,
  async (t) => {
    const f = await fixture(t, { longChat: true });
    const before = f.store.snapshot("chat").messages.length;
    const outcome = await f.execute("background");
    try {
      assert.equal(f.requests.length, 1);
      assert.equal(f.memoryRequests.length, 1);
      assert.equal(f.store.snapshot("chat").messages.length, before);
      assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
      assert.ok(
        outcome.result.pluginStorage.writes.some((write) =>
          JSON.stringify(write.value)?.includes(
            "Green waters the blue garden flowers",
          ),
        ),
      );
      f.store.finishJob(
        outcome.claimed.job.id,
        outcome.claimed.job.owner,
        outcome.claimed.job.fence,
        { state: "completed", ...outcome.result },
      );
      assert.equal(f.store.snapshot("chat").messages.length, before + 2);
      assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 2);
    } finally {
      await outcome.coordinator.release();
    }
  },
);
