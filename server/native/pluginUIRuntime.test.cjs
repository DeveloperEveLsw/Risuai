"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { parse } = require("node-html-parser");
const { EntityStore } = require("../entity/store.cjs");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const {
  WYGLORE_RELEASE,
  getWygloreRelease,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const path =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(path) ? false : "Fetch the pinned public WygLore fixture",
  timeout: 15000,
};
async function fixture(t, options = {}) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const directory = options.worker
    ? fs.mkdtempSync(join(tmpdir(), "risu-plugin-ui-runtime-"))
    : undefined;
  const file = directory ? join(directory, "entity.sqlite") : ":memory:";
  const store = new EntityStore(file);
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
  const row = store.getResource("plugin", "wyglore");
  const namespace = {
    pluginId: "wyglore",
    bundleSha: getWygloreRelease(row.payload.script).sha256,
    pluginEpoch: row.entityEpoch,
  };
  if (!options.fresh) {
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
  }
  const client = options.worker ? new EntityStoreClient(file) : undefined;
  await client?.ready;
  const owners = [];
  const completions = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    await client?.close();
    store.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  let requests = 0;
  async function open() {
    const owner = await createPluginUIRuntime({
      store: {
        call: async (method, ...args) => {
          if (method === "completePluginUIEvent" && options.completeDelayMs)
            await delay(options.completeDelayMs);
          const result = client
            ? await client.call(method, ...args)
            : store[method](...args);
          if (method === "completePluginUIEvent")
            completions.push({ input: args[0], result });
          return result;
        },
      },
      pluginId: "wyglore",
      chatId: "chat",
      expectedChatEpoch: 0,
      providerFetch: async (url, init = {}) => {
        if (
          options.fresh &&
          String(url) ===
            "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/main/version.json" &&
          (init.method ?? "GET").toUpperCase() === "GET" &&
          init.body == null &&
          !new Headers(init.headers).has("authorization")
        ) {
          if (options.manifestDelayMs) {
            await delay(options.manifestDelayMs);
            return Response.json({
              latest: "3.1.6",
              message: "Synthetic update metadata",
            });
          }
          return new Response("Offline synthetic update manifest", {
            status: 503,
          });
        }
        requests++;
        throw new Error("Unexpected synthetic provider request");
      },
    });
    owners.push(owner);
    return owner;
  }
  return { store, namespace, open, completions, requests: () => requests };
}
function event(snapshot, element, type, values = {}) {
  return {
    scope: snapshot.scope,
    revision: snapshot.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: element.getAttribute("data-risu-plugin-node"),
    type,
    ...values,
  };
}
test(
  "original server setting UI commits its original toggle, reopens with it, and replays acknowledgements without effects",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open();
    let view = await owner.snapshot();
    assert.equal(
      parse(view.html).querySelectorAll("button[data-tab]").length,
      7,
    );
    let settings = parse(view.html).querySelector(
      'button[data-tab="settings"]',
    );
    view = (await owner.dispatch(event(view, settings, "click"))).snapshot;
    const label = parse(view.html)
      .querySelectorAll("label")
      .find((label) => label.textContent.includes("백그라운드 진행 우선 켜기"));
    assert.ok(label);
    const toggle = label.querySelector('input[type="checkbox"]');
    const request = event(view, toggle, "change", { checked: false });
    const response = await owner.dispatch(request);
    assert.equal(owner.parameters().backgroundFirstEnabled, false);
    const stored = f.store.readPluginStorage(
      f.namespace,
      "wl.globalSettings.v1",
    ).value;
    assert.equal(JSON.parse(stored).backgroundFirstEnabled, false);
    assert.equal(
      f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: request.eventId,
      }).state,
      "completed",
    );
    const revision = f.store.readAllPluginStorage(f.namespace).revision;
    assert.equal((await owner.dispatch(request)).replayed, true);
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, revision);
    assert.equal(response.snapshot.scope.chatId, "chat");
    await owner.close();
    const reopened = await f.open();
    assert.equal(reopened.parameters().backgroundFirstEnabled, false);
    assert.equal(f.requests(), 0);
  },
);
test(
  "a second device cannot boot a second original UI writer and changed sources invalidate the old UI owner",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open();
    await assert.rejects(f.open(), { code: "PLUGIN_STORAGE_BUSY" });
    const view = await owner.snapshot();
    const row = f.store.getResource("settings", "global");
    f.store.applyCommand("peer", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: row.revision,
      payload: { ...row.payload, mainPrompt: "A different synthetic rule." },
    });
    await assert.rejects(
      owner.dispatch(
        event(
          view,
          parse(view.html).querySelector('button[data-tab="settings"]'),
          "click",
        ),
      ),
      { code: "REVISION_CONFLICT" },
    );
    assert.equal(f.requests(), 0);
  },
);

test(
  "a fresh original plugin namespace opens and reopens through real worker IPC with a delayed checkpoint acknowledgement",
  actual,
  async (t) => {
    const f = await fixture(t, {
      fresh: true,
      worker: true,
      completeDelayMs: 800,
      manifestDelayMs: 400,
    });
    assert.equal(f.store.readAllPluginStorage(f.namespace).items.length, 0);
    const owner = await f.open();
    const view = await owner.snapshot();
    assert.equal(
      parse(view.html).querySelectorAll("button[data-tab]").length,
      7,
    );
    const persisted = f.store.readAllPluginStorage(f.namespace);
    assert.ok(persisted.revision > 0);
    assert.ok(
      persisted.items.some((item) => item.key === "wl.globalSettings.v1"),
    );
    const manifest = JSON.parse(
      f.store.readPluginStorage(f.namespace, "wl.updateCheck.v1").value,
    );
    assert.equal(manifest.manifest.latest, "3.1.6");
    const first = f.completions[0];
    assert.ok(
      first.input.pluginStorage.writes.some(
        (write) => write.key === "wl.updateCheck.v1",
      ),
    );
    assert.equal(
      first.result.pluginStorage.commitId,
      first.input.pluginStorage.commitId,
    );
    assert.equal(
      first.result.pluginStorage.revision,
      first.input.pluginStorage.expectedRevision + 1,
    );
    assert.deepEqual(first.result.scope, f.store.capturePluginUI("chat").scope);
    assert.equal(
      f.store.readPluginUIEvent({
        sessionId: first.input.sessionId,
        eventId: first.input.eventId,
      }).state,
      "completed",
    );
    await owner.close();
    const reopened = await f.open();
    const reopenedView = await reopened.snapshot();
    assert.equal(
      parse(reopenedView.html).querySelectorAll("button[data-tab]").length,
      7,
    );
    assert.equal(f.requests(), 0);
  },
);

test(
  "a cold settings owner preserves another installed chat's original memory through delayed worker checkpoints and reopen",
  actual,
  async (t) => {
    const f = await fixture(t, {
      fresh: true,
      worker: true,
      completeDelayMs: 800,
      manifestDelayMs: 400,
    });
    const otherMemoryKey = "wl.web.v1.5ca57e3a";
    const otherMemory = JSON.stringify({
      version: 3,
      pluginVersion: "3.1.6",
      chatFingerprint: { chaId: "another-garden", chatId: "another-chat" },
      params: { shortTermWindow: 11 },
      units: [
        {
          id: "existing-synthetic-memory",
          type: "note",
          name: "Existing blue flowers",
          content: "A different garden already remembers the blue flowers.",
          keywords: ["blue", "flowers"],
          flags: {},
          associations: {},
        },
      ],
    });
    const lease = f.store.claimPluginStorage({
      namespace: f.namespace,
      writerId: "preexisting-memory",
      authority: { kind: "browser" },
    });
    f.store.commitPluginStorage({
      lease,
      expectedRevision: lease.revision,
      commitId: "preexisting-memory",
      writes: [{ key: otherMemoryKey, value: otherMemory }],
    });
    f.store.releasePluginStorage(lease);
    assert.equal(
      f.store.readPluginStorage(f.namespace, "wl.globalSettings.v1").value,
      null,
    );
    const owner = await f.open();
    assert.equal(
      parse((await owner.snapshot()).html).querySelectorAll("button[data-tab]")
        .length,
      7,
    );
    assert.equal(
      f.store.readPluginStorage(f.namespace, otherMemoryKey).value,
      otherMemory,
    );
    await owner.close();
    const reopened = await f.open();
    assert.equal(
      parse((await reopened.snapshot()).html).querySelectorAll(
        "button[data-tab]",
      ).length,
      7,
    );
    assert.equal(
      f.store.readPluginStorage(f.namespace, otherMemoryKey).value,
      otherMemory,
    );
    assert.equal(f.requests(), 0);
  },
);
