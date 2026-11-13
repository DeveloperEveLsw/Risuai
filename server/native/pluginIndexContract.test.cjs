"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("./wygloreContract.cjs");

// The original plugin includes numeric character/chat positions in its garden
// fingerprint. Exercise real, nonzero positions across original UI/native realms;
// an all-zero synthetic alias would silently replace the canonical garden here.
test(
  "original UI and compiled native jobs reuse one garden at nonzero character/chat positions",
  { timeout: 20000 },
  async (t) => {
    const source = await readWygloreFixture();
    const native = await import(
      pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
    );
    const store = new EntityStore(":memory:"),
      owners = [];
    t.after(async () => {
      for (const owner of owners) await owner.close();
      store.close();
    });
    store.initializeState(native.createInitialRuntimeState());
    const settings = store.getResource("settings", "global");
    store.applyCommand("settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        pluginIds: ["wyglore"],
        aiModel: "reverse_proxy",
        customProxyRequestModel: "synthetic-model",
        forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
        proxyKey: "synthetic-key",
        customTokenizer: "tik",
        mainPrompt: "Help the gardener.",
        maxContext: 8000,
        maxResponse: 200,
        useStreaming: false,
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
        script: source,
        realArg: {},
      },
    });
    for (const [characterId, chatId] of [
      ["first-character", "unrelated-chat"],
      ["garden", "older-chat"],
    ])
      store.applyCommand("character:" + characterId, {
        type: "create-character",
        characterId,
        definition: {
          type: "character",
          name: characterId === "garden" ? "Green" : "Unrelated",
          desc: "Green tends blue flowers.",
          firstMessage: "Welcome to the garden.",
          globalLore: [],
          triggerscript: [],
        },
        chat: { chatId, metadata: { name: chatId, localLore: [] } },
      });
    store.applyCommand("target-chat", {
      type: "create-chat",
      characterId: "garden",
      chatId: "target-chat",
      metadata: { name: "Synthetic current garden", localLore: [] },
    });
    const namespace = {
      pluginId: "wyglore",
      bundleSha: WYGLORE_RELEASE.sha256,
      pluginEpoch: store.getResource("plugin", "wyglore").entityEpoch,
    };
    const lease = store.claimPluginStorage({
      namespace,
      writerId: "initial",
      authority: { kind: "browser" },
    });
    store.commitPluginStorage({
      lease,
      expectedRevision: 0,
      commitId: "initial",
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
    store.releasePluginStorage(lease);
    const requests = [],
      rpc = { call: async (method, ...args) => store[method](...args) };
    const providerFetch = async (url, init) => {
      assert.equal(
        String(url),
        "https://synthetic.invalid/v1/chat/completions",
      );
      const body = JSON.parse(init.body);
      assert.equal(body.model, "synthetic-model");
      requests.push(body);
      return Response.json({
        choices: [{ message: { content: "The blue flowers bloom." } }],
      });
    };
    async function ui() {
      const owner = await createPluginUIRuntime({
        store: rpc,
        pluginId: "wyglore",
        chatId: "target-chat",
        expectedChatEpoch: 0,
        providerFetch: async () => {
          throw Error("Original UI must not request a model in this fixture");
        },
      });
      owners.push(owner);
      assert.equal((await owner.snapshot()).scope.chatId, "target-chat");
      await owner.close();
    }
    function marker() {
      const lore = store.snapshot("target-chat").chat.metadata.localLore;
      const value = lore.find((row) => row.key === "__wl_marker__");
      assert.ok(value, "Original canonical ownership marker is durable");
      return JSON.parse(value.content);
    }
    async function generate(id) {
      store.enqueueJob(id, {
        type: "send",
        chatId: "target-chat",
        input: "Green, tell me about the flowers.",
        messageId: id + ":input",
      });
      const claimed = store.claimJob("synthetic-index-worker");
      const coordinator = createNativePluginCoordinator({
        store: rpc,
        job: claimed.job,
        snapshot: claimed.snapshot,
        fetch: providerFetch,
      });
      try {
        const outcome = await native.executeExtensionJob(claimed, {
          appVer: "2026.8.250",
          providerFetch,
          resolveCharacter: (id) => store.getCharacter(id),
          fetch: async (path) =>
            new Response(
              fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
            ),
          preparePluginSnapshot: coordinator.prepareSnapshot,
          openPluginRuntime: coordinator.open,
        });
        assert.equal(
          outcome.pluginStorage.reads.currentScope.characterIndex,
          1,
        );
        assert.equal(outcome.pluginStorage.reads.currentScope.chatIndex, 1);
        store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
          state: "completed",
          ...outcome,
        });
      } finally {
        await coordinator.release();
      }
    }
    await ui();
    await generate("first");
    const initial = marker();
    assert.equal(initial.fingerprint.characterIndex, 1);
    assert.equal(initial.fingerprint.chatIndex, 1);
    await ui();
    assert.equal(marker().webKey, initial.webKey);
    await generate("second");
    assert.equal(marker().webKey, initial.webKey);
    assert.equal(requests.length, 2);
    for (const body of requests)
      assert.match(
        body.messages.map((message) => message.content).join("\n"),
        /WygLore Leaf — canonical layer/,
      );
    assert.equal(store.snapshot("target-chat").messages.length, 4);
    for (const id of ["unrelated-chat", "older-chat"]) {
      assert.equal(store.snapshot(id).messages.length, 0);
      assert.deepEqual(store.snapshot(id).chat.metadata.localLore, []);
    }
  },
);
