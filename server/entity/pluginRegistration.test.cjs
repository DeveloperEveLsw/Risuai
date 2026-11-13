"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { EntityStore } = require("./store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-plugin-registration-"));
  const file = join(directory, "entity.sqlite");
  let store = new EntityStore(file);
  t.after(() => {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initializeState({
    settings: { pluginIds: [], marker: "Synthetic settings retained" },
    resources: [],
  });
  return {
    file,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new EntityStore(file);
      return store;
    },
    close() {
      store.close();
      store = null;
    },
  };
}

function save(id, payload = {}, revision = 0, epoch = 0) {
  return {
    type: "save-library-resource",
    kind: "plugin",
    resourceId: id,
    expectedRevision: revision,
    expectedEpoch: epoch,
    payload: {
      name: "Synthetic plugin",
      version: "3.0",
      script: "//@name Synthetic plugin\n//@api 3.0\n",
      enabled: true,
      ...payload,
      id,
    },
  };
}

function edit(store, id, key, value) {
  const target = {
    scope: "resource",
    resourceKind: "plugin",
    entityId: id,
    key,
  };
  const field = store.readFields([target]).fields[0];
  return {
    ...target,
    expectedRevision: field.revision,
    expectedEpoch: field.entityEpoch,
    value,
  };
}

test("plugin create receipt, membership, full resource and bootstrap survive SQLite restart", (t) => {
  const f = fixture(t);
  const command = save("synthetic-plugin", { unknown: { retained: true } });
  const result = f.store.applyCommand("install-plugin", command);
  const identity = f.store.bootstrap().serverId;
  const store = f.reopen();
  const bootstrap = store.bootstrap();
  assert.equal(bootstrap.serverId, identity);
  assert.ok(
    bootstrap.resources.some(
      (row) =>
        row.kind === "plugin" &&
        row.id === "synthetic-plugin" &&
        row.revision === 1 &&
        row.deleted === 0,
    ),
  );
  assert.deepEqual(
    store.getResource("plugin", "synthetic-plugin").payload,
    command.payload,
  );
  assert.deepEqual(store.getResource("settings", "global").payload.pluginIds, [
    "synthetic-plugin",
  ]);
  assert.equal(
    store.getResource("settings", "global").payload.marker,
    "Synthetic settings retained",
  );
  assert.equal(store.listLibrary("plugin").items[0].id, "synthetic-plugin");
  const cursor = store.cursor();
  assert.deepEqual(store.applyCommand("install-plugin", command), result);
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("guarded plugin enabled and argument edits persist without changing its stable identity or script", (t) => {
  const f = fixture(t);
  const original = save("synthetic-plugin", { realArg: { sample: "before" } });
  f.store.applyCommand("install-plugin", original);
  f.store.applyCommand("disable-plugin", {
    type: "change-fields",
    edits: [edit(f.store, "synthetic-plugin", "enabled", false)],
  });
  let store = f.reopen();
  assert.equal(
    store.getResource("plugin", "synthetic-plugin").payload.enabled,
    false,
  );
  store.applyCommand("enable-and-edit-plugin", {
    type: "change-fields",
    edits: [
      edit(store, "synthetic-plugin", "enabled", true),
      edit(store, "synthetic-plugin", "realArg", { sample: "after" }),
    ],
  });
  store = f.reopen();
  const resource = store.getResource("plugin", "synthetic-plugin");
  assert.equal(resource.payload.id, "synthetic-plugin");
  assert.equal(resource.payload.script, original.payload.script);
  assert.equal(resource.payload.enabled, true);
  assert.deepEqual(resource.payload.realArg, { sample: "after" });
  assert.equal(resource.entityEpoch, 0);
  assert.deepEqual(store.getResource("settings", "global").payload.pluginIds, [
    "synthetic-plugin",
  ]);
});

test("independent plugin registrations compose membership and stale saves publish no resource or receipt", (t) => {
  const f = fixture(t);
  f.store.applyCommand("install-a", save("a"));
  f.store.applyCommand("install-b", save("b"));
  const obsolete = save("a", { enabled: false }, 1);
  f.store.applyCommand("update-a", save("a", { name: "Current plugin" }, 1));
  const before = f.store.getResource("plugin", "a");
  const cursor = f.store.cursor();
  assert.throws(() => f.store.applyCommand("stale-update", obsolete), {
    code: "REVISION_CONFLICT",
  });
  assert.deepEqual(f.store.getResource("plugin", "a"), before);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS count FROM commands WHERE id='stale-update'")
      .get().count,
    0,
  );
  const store = f.reopen();
  assert.deepEqual(store.getResource("settings", "global").payload.pluginIds, [
    "a",
    "b",
  ]);
  assert.equal(store.getResource("plugin", "a").payload.enabled, true);
});

test("plugin deletion persists a bootstrap tombstone and recreating its ID requires the new incarnation", (t) => {
  const f = fixture(t);
  f.store.applyCommand("install-plugin", save("a"));
  const result = f.store.applyCommand("delete-plugin", {
    type: "delete-library-resource",
    kind: "plugin",
    resourceId: "a",
    expectedRevision: 1,
    expectedEpoch: 0,
  });
  const store = f.reopen();
  assert.equal(store.getResource("plugin", "a"), null);
  assert.deepEqual(
    store.getResource("settings", "global").payload.pluginIds,
    [],
  );
  assert.ok(
    store
      .bootstrap()
      .resources.some(
        (row) => row.kind === "plugin" && row.id === "a" && row.deleted === 1,
      ),
  );
  assert.throws(() => store.applyCommand("obsolete-install", save("a")), {
    code: "REVISION_CONFLICT",
  });
  store.applyCommand(
    "reinstall-plugin",
    save("a", {}, result.revision, result.revision),
  );
  assert.equal(store.getResource("plugin", "a").entityEpoch, result.revision);
  assert.deepEqual(store.getResource("settings", "global").payload.pluginIds, [
    "a",
  ]);
});

test(
  "HTTP plugin registration preserves the complete pinned public WygLore bundle across service restart",
  { timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "risu-plugin-registration-http-"),
    );
    const file = join(directory, "entity.sqlite");
    const seed = new EntityStore(file);
    seed.initializeState({ settings: { pluginIds: [] }, resources: [] });
    seed.close();
    const script = readFileSync(
      resolve(
        __dirname,
        "../../.local-runtime/public-plugins/wyglore-leaf/3.1.6/WygLoreLeaf-latest.js",
      ),
      "utf8",
    );
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    assert.equal(
      sha(script),
      "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
    );
    let runtime;
    let providerCalls = 0;
    t.after(async () => {
      await runtime?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const restart = async () => {
      await runtime?.close();
      runtime = await createRuntimeService({
        file,
        scheduler: {
          reviewedPlugins: true,
          executor: async () => {
            providerCalls++;
            throw new Error("Registration must not request a provider");
          },
        },
      });
    };
    const api = async (path, body) => {
      const response = await fetch(
        runtime.url + "/api/runtime" + path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    await restart();
    const command = save("public-wyglore", { name: "◆ WygLore Leaf", script });
    const result = await api("/commands", {
      requestId: "install-public-wyglore",
      command,
    });
    await restart();
    const bootstrap = await api("/bootstrap");
    assert.ok(
      bootstrap.resources.some(
        (row) =>
          row.kind === "plugin" && row.id === "public-wyglore" && !row.deleted,
      ),
    );
    const resource = await api("/resources/plugin/public-wyglore");
    assert.equal(resource.payload.script, script);
    assert.equal(sha(resource.payload.script), sha(script));
    assert.equal(resource.payload.enabled, true);
    assert.deepEqual(
      (await api("/resources/settings/global")).payload.pluginIds,
      ["public-wyglore"],
    );
    const capability = await api("/plugins/public-wyglore/capability");
    assert.equal(capability.supported, true);
    assert.deepEqual(
      await api("/commands", { requestId: "install-public-wyglore", command }),
      result,
    );
    assert.equal(providerCalls, 0);
  },
);
