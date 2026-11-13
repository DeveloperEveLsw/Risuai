"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
test("immutable asset metadata is idempotent, bounded and absent from normal bootstrap and change events", (t) => {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  const digest = "a".repeat(64),
    value = {
      id: digest + ".png",
      digest,
      extension: "png",
      mime: "image/png",
      byteLength: 73,
    };
  const before = store.bootstrap();
  const first = store.registerAsset(value);
  assert.deepEqual(store.registerAsset(value), first);
  assert.equal(first.path, "assets/runtime/" + value.id);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM assets").get().count,
    1,
  );
  assert.deepEqual(store.bootstrap(), before);
  for (const invalid of [
    { ...value, byteLength: 74 },
    { ...value, mime: "image/jpeg" },
  ])
    assert.throws(() => store.registerAsset(invalid), {
      code: "IDENTITY_CONFLICT",
    });
  for (const invalid of [
    { ...value, id: "../../bad.png" },
    { ...value, byteLength: 67108865 },
    { ...value, mime: "text/html" },
  ])
    assert.throws(() => store.registerAsset(invalid), {
      code: "INVALID_COMMAND",
    });
});
test("schema-ten migration adds asset metadata without changing existing identity, resources, cursor or live jobs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-asset-migration-")),
    file = join(directory, "state.sqlite");
  let store = new EntityStore(file);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initializeState({
    settings: { unknown: { retained: true } },
    resources: [],
  });
  store.applyCommand("synthetic-character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
    chat: { chatId: "chat", metadata: { name: "Synthetic" } },
  });
  store.enqueueJob("synthetic-job", {
    type: "button",
    chatId: "chat",
    data: "Synthetic",
  });
  const before = {
    bootstrap: store.bootstrap(),
    job: store.getJob("synthetic-job"),
    settings: store.getResource("settings", "global"),
  };
  store.db.exec("DROP TABLE assets; PRAGMA user_version=10;");
  store.close();
  store = new EntityStore(file);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(store.bootstrap(), before.bootstrap);
  assert.deepEqual(store.getJob("synthetic-job"), before.job);
  assert.deepEqual(store.getResource("settings", "global"), before.settings);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM assets").get().count,
    0,
  );
});
test("binary import accounting preserves the original attempt counter with durable exactly-once request replay", (t) => {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.initializeState({
    settings: { statics: { imports: 5, messages: 9 }, unknown: true },
    resources: [],
  });
  const before = store.getResource("settings", "global"),
    first = store.applyCommand("synthetic-import-one", {
      type: "record-import",
    });
  store.applyCommand("synthetic-import-two", { type: "record-import" });
  assert.deepEqual(
    store.applyCommand("synthetic-import-one", { type: "record-import" }),
    first,
  );
  const statistics = store
    .bootstrap()
    .statistics.find((row) => row.settingsId === "global");
  assert.equal(statistics.imports, 7);
  assert.equal(statistics.messages, 9);
  assert.equal(
    store.getResource("settings", "global").revision,
    before.revision,
  );
  assert.equal(store.getResource("settings", "global").payload.unknown, true);
});
