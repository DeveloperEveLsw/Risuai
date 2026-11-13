"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID, createHash } = require("node:crypto");
const { parse } = require("node-html-parser");
const { EntityStore } = require("../entity/store.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const path =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(path) ? false : "Fetch the pinned public WygLore fixture",
  timeout: 20000,
};
const config = {
  automaticCachePoint: true,
  claude1HourCaching: true,
  claudeRetrivalCaching: true,
  promptTemplate: [{ type: "cache" }],
};
async function fixture(t) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(":memory:");
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: { ...settings.payload, ...config, pluginIds: ["wyglore"] },
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
          speedMode: "fast",
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  store.releasePluginStorage(lease);
  const owners = [];
  let requests = 0,
    beforeComplete;
  t.after(async () => {
    for (const owner of owners) await owner.close();
    store.close();
  });
  return {
    store,
    namespace,
    requests: () => requests,
    intercept(callback) {
      beforeComplete = callback;
    },
    async open() {
      const owner = await createPluginUIRuntime({
        store: {
          call: async (method, ...args) => {
            if (method === "completePluginUIEvent")
              await beforeComplete?.(...args);
            return store[method](...args);
          },
        },
        pluginId: "wyglore",
        chatId: "chat",
        expectedChatEpoch: 0,
        providerFetch: async () => {
          requests++;
          throw new Error("Unexpected synthetic provider request");
        },
      });
      owners.push(owner);
      return owner;
    },
    chatDigest() {
      return createHash("sha256")
        .update(
          JSON.stringify(
            ["characters", "chats", "messages"].map((table) =>
              store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            ),
          ),
        )
        .digest("hex");
    },
  };
}
function providersEvent(view) {
  const element = parse(view.html).querySelector(
    'button[data-tab="providers"]',
  );
  assert.ok(element, "The original providers control must exist");
  return {
    scope: view.scope,
    revision: view.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: element.getAttribute("data-risu-plugin-node"),
    type: "click",
  };
}
test(
  "the original providers tab and root server card read only reviewed cache configuration without network requests",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await owner.snapshot();
    const response = await owner.dispatch(providersEvent(view)),
      text = parse(response.snapshot.html).textContent;
    assert.match(text, /프롬프트에 캐시 자리가 적혀 있습니다 \(프리셋\)/);
    assert.match(text, /1h TTL/);
    assert.match(text, /자동 연장 \(본체\)/);
    assert.match(text, /기억뜰 뿌리 서버/);
    for (const [field, value] of Object.entries(config))
      assert.deepEqual(
        f.store.getResource("settings", "global").payload[field],
        value,
      );
    const original = f.store.getResource("plugin", "wyglore").payload.script;
    assert.equal(
      createHash("sha256").update(original).digest("hex"),
      WYGLORE_RELEASE.sha256,
    );
    assert.equal(f.requests(), 0);
  },
);
for (const [field, nextValue] of [
  ["automaticCachePoint", false],
  ["claude1HourCaching", false],
  ["claudeRetrivalCaching", false],
  ["promptTemplate", [{ type: "plain", text: "A changed synthetic template" }]],
]) {
  test(
    `a concurrent ${field} change rejects the original providers checkpoint before graph/chat writes`,
    actual,
    async (t) => {
      const f = await fixture(t),
        owner = await f.open(),
        request = providersEvent(await owner.snapshot()),
        beforeGraph = f.store.readAllPluginStorage(f.namespace),
        beforeChat = f.chatDigest();
      const settings = f.store.getResource("settings", "global");
      let checked = false;
      f.intercept((input) => {
        assert.ok(
          input.pluginStorage.reads.resources.some(
            (row) =>
              row.kind === "settings" &&
              row.id === "global" &&
              row.revision === settings.revision,
          ),
        );
        checked = true;
        f.store.applyCommand("peer:" + field, {
          type: "put-resource",
          kind: "settings",
          resourceId: "global",
          expectedRevision: settings.revision,
          payload: { ...settings.payload, [field]: nextValue },
        });
      });
      await assert.rejects(owner.dispatch(request), {
        code: "REVISION_CONFLICT",
      });
      assert.equal(checked, true);
      assert.deepEqual(f.store.readAllPluginStorage(f.namespace), beforeGraph);
      assert.equal(f.chatDigest(), beforeChat);
      assert.deepEqual(
        f.store.getResource("settings", "global").payload[field],
        nextValue,
      );
      const receipt = f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: request.eventId,
      });
      assert.equal(receipt.state, "failed");
      assert.equal(receipt.code, "REVISION_CONFLICT");
      assert.equal(f.requests(), 0);
    },
  );
}
