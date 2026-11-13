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
  timeout: 15000,
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
    payload: { ...settings.payload, pluginIds: ["wyglore"] },
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
      script: fs.readFileSync(path, "utf8"),
      enabled: true,
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
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
          rerankerApiKey: "synthetic-no-real-key",
        }),
      },
    ],
  });
  store.releasePluginStorage(lease);
  let requests = 0;
  const owners = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    store.close();
  });
  return {
    store,
    namespace,
    requests: () => requests,
    async open() {
      const owner = await createPluginUIRuntime({
        store: { call: async (method, ...args) => store[method](...args) },
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
    canonicalDigest() {
      const rows = ["characters", "chats", "messages", "resources"].map(
        (table) =>
          store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    },
  };
}
function click(view, element) {
  assert.ok(element, "the original control must exist");
  return {
    scope: view.scope,
    revision: view.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: element.getAttribute("data-risu-plugin-node"),
    type: "click",
  };
}
async function backup(owner) {
  let view = await owner.snapshot();
  view = (
    await owner.dispatch(
      click(
        view,
        parse(view.html).querySelector('button[data-tab="dataRecovery"]'),
      ),
    )
  ).snapshot;
  view = (
    await owner.dispatch(
      click(
        view,
        parse(view.html)
          .querySelectorAll("button")
          .find((element) => element.textContent.trim() === "백업 · 정리"),
      ),
    )
  ).snapshot;
  return view;
}
function button(view, label) {
  return parse(view.html)
    .querySelectorAll("button")
    .find((element) => element.textContent.trim() === label);
}
function answer(effect, fields) {
  return {
    effectId: effect.id,
    eventId: effect.eventId,
    kind: effect.kind,
    ...fields,
  };
}
async function waitEffect(owner, kind) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const view = await owner.snapshot({ whileBusy: true });
    const effect = view.effects.find((effect) => effect.kind === kind);
    if (effect) return effect;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Original ${kind} interaction was not advertised`);
}
for (const [label, expectedKind] of [
  ["설정만 내보내기", "association-tree-settings"],
  ["전체 내보내기 (뜰 포함)", "association-tree-snapshot"],
]) {
  test(
    `original ${label} produces its exact JSON only after a completed checkpoint`,
    actual,
    async (t) => {
      const f = await fixture(t),
        owner = await f.open(),
        view = await backup(owner),
        request = click(view, button(view, label));
      const completed = await owner.dispatch(request),
        [download] = completed.snapshot.effects;
      assert.equal(download.kind, "download");
      assert.equal(download.eventId, request.eventId);
      assert.equal(download.mime, "application/json");
      const receipt = f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: request.eventId,
      });
      assert.equal(receipt.state, "completed");
      const input = { effectId: download.id, eventId: download.eventId };
      const artifact = await owner.readArtifact(input),
        repeat = await owner.readArtifact(input);
      assert.equal(artifact.bytes.length, download.bytes);
      assert.deepEqual(artifact.bytes, repeat.bytes);
      assert.equal(JSON.parse(artifact.bytes.toString()).kind, expectedKind);
      assert.ok(!JSON.stringify(receipt).includes("synthetic-no-real-key"));
      await assert.rejects(
        owner.readArtifact({ ...input, eventId: "plugin-ui:" + randomUUID() }),
        { code: "INVALID_PLUGIN_UI_EFFECT" },
      );
      assert.deepEqual(
        await owner.resolveEffect(answer(download, { received: true })),
        {
          effectId: download.id,
          eventId: download.eventId,
          kind: "download",
          resolved: true,
        },
      );
      await assert.rejects(owner.readArtifact(input), {
        code: "PLUGIN_UI_EFFECT_CLOSED",
      });
      assert.equal(f.requests(), 0);
    },
  );
}
for (const label of ["설정만 가져오기", "전체 가져오기 (뜰 포함)"]) {
  test(
    `original ${label} cancellation wakes its own FileList/change handler without any canonical or graph mutation`,
    actual,
    async (t) => {
      const f = await fixture(t),
        owner = await f.open(),
        view = await backup(owner),
        request = click(view, button(view, label));
      const beforeGraph = f.store.readAllPluginStorage(f.namespace),
        beforeCanonical = f.canonicalDigest();
      const pending = owner.dispatch(request);
      pending.catch(() => {});
      const file = await waitEffect(owner, "file");
      await assert.rejects(
        owner.resolveEffect(
          answer(file, { eventId: "plugin-ui:" + randomUUID(), file: null }),
        ),
        { code: "INVALID_PLUGIN_UI_EFFECT" },
      );
      await assert.rejects(
        owner.resolveEffect(
          answer(file, {
            file: { name: "bad.json", text: "{}", path: "/private" },
          }),
        ),
        { code: "INVALID_PLUGIN_UI_EFFECT" },
      );
      await owner.resolveEffect(answer(file, { file: null }));
      const result = await pending;
      assert.equal(result.snapshot.visible, false);
      assert.equal(result.snapshot.busy, false);
      assert.deepEqual(result.snapshot.effects, []);
      assert.deepEqual(f.store.readAllPluginStorage(f.namespace), beforeGraph);
      assert.equal(f.canonicalDigest(), beforeCanonical);
      assert.equal(
        f.store.readPluginUIEvent({
          sessionId: owner.scope.sessionId,
          eventId: request.eventId,
        }).state,
        "completed",
      );
      await assert.rejects(owner.snapshot(), { code: "PLUGIN_UI_CLOSED" });
      assert.equal(f.requests(), 0);
    },
  );
}
test(
  "a reviewed original settings confirmation rejection cannot apply the uploaded params or flush a partial graph",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backup(owner),
      request = click(view, button(view, "설정만 가져오기"));
    const beforeGraph = f.store.readAllPluginStorage(f.namespace),
      beforeCanonical = f.canonicalDigest();
    const pending = owner.dispatch(request);
    pending.catch(() => {});
    const file = await waitEffect(owner, "file");
    await owner.resolveEffect(
      answer(file, {
        file: {
          name: "fixture.json",
          text: JSON.stringify({
            kind: "association-tree-settings",
            exportVersion: 1,
            params: { ...owner.parameters(), backgroundFirstEnabled: false },
          }),
        },
      }),
    );
    const confirm = await waitEffect(owner, "confirm");
    assert.equal(confirm.eventId, request.eventId);
    await owner.resolveEffect(answer(confirm, { accepted: false }));
    await pending;
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), beforeGraph);
    assert.equal(f.canonicalDigest(), beforeCanonical);
    assert.equal(f.requests(), 0);
  },
);
