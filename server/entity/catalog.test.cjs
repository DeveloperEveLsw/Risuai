"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { EntityStore } = require("./store.cjs");
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => store.close());
  if (file === ":memory:")
    store.initializeState({
      settings: { moduleIds: [], enabledModules: [] },
      resources: [],
    });
  let next = 0;
  const command = (value) =>
    store.applyCommand("catalog-fixture-" + ++next, value);
  const save = (id, payload = {}, revision = 0, epoch = 0) =>
    command({
      type: "save-library-resource",
      kind: "module",
      resourceId: id,
      expectedRevision: revision,
      expectedEpoch: epoch,
      payload: { ...payload, id },
    });
  return { store, command, save };
}
test("bounded catalog pages/search never read or serialize inactive definition payloads", (t) => {
  const { store, save } = fixture(t);
  const large = "Synthetic".repeat(65536);
  for (let i = 0; i < 63; i++)
    save("module-" + i, {
      name: "Synthetic " + String(i).padStart(2, "0"),
      description: "Summary",
      regex: [{ out: large }],
    });
  const statements = [],
    prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    statements.push(sql);
    return prepare(sql);
  };
  const page = store.listLibrary("module"),
    next = store.listLibrary("module", { after: page.next });
  assert.equal(page.items.length, 50);
  assert.equal(next.items.length, 13);
  assert.equal(next.next, null);
  assert.equal(
    new Set([...page.items, ...next.items].map((item) => item.id)).size,
    63,
  );
  assert.equal(page.items[0].payloadBytes > 500000, true);
  assert.equal(Buffer.byteLength(JSON.stringify(page)) < 20000, true);
  assert.equal(
    statements.some((sql) => /\bFROM resources\b/i.test(sql)),
    false,
  );
  assert.equal(
    statements.some((sql) => /\bpayload\b/i.test(sql)),
    false,
  );
  assert.deepEqual(
    store
      .listLibrary("module", { search: "Synthetic 06" })
      .items.map((item) => item.id),
    ["module-6"],
  );
});
test("catalog labels are bounded, literal wildcard searches and exact namespace resolution retain source fidelity", (t) => {
  const { store, save } = fixture(t);
  const namespace = "Synthetic".repeat(100),
    name = "a".repeat(255) + "😀";
  save("bounded", {
    name,
    description: "d".repeat(2000),
    namespace,
    unknown: "Retained",
  });
  save("literal", { name: "100%_\\done", namespace: "Synthetic" });
  const bounded = store.resolveModuleCatalog([namespace]).items[0];
  assert.equal(bounded.summary.name, "a".repeat(255));
  assert.equal(bounded.summary.description.length, 768);
  assert.equal(bounded.summary.namespace.length, 512);
  assert.equal(store.getResource("module", "bounded").payload.name, name);
  assert.equal(
    store.getResource("module", "bounded").payload.namespace,
    namespace,
  );
  assert.deepEqual(
    store
      .listLibrary("module", { search: "%_\\" })
      .items.map((item) => item.id),
    ["literal"],
  );
  assert.deepEqual(
    store
      .resolveModuleCatalog(["bounded", "Synthetic"])
      .items.map((item) => item.id),
    ["bounded", "literal"],
  );
  for (const options of [
    { limit: 201 },
    { limit: 0 },
    { after: "broken" },
    { after: Buffer.from("[1,2]").toString("base64url") },
    { search: "a".repeat(257) },
  ])
    assert.throws(() => store.listLibrary("module", options), {
      code: "INVALID_COMMAND",
    });
});
test("whole and point writes atomically publish summaries, body snapshot headers and deletion epochs", (t) => {
  const { store, save, command } = fixture(t);
  save("module", { name: "Before", unknown: { retained: true } });
  const target = {
      scope: "resource",
      resourceKind: "module",
      entityId: "module",
      key: "name",
    },
    field = store.readFields([target]).fields[0];
  command({
    type: "change-fields",
    edits: [
      {
        ...target,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: "After",
      },
    ],
  });
  const page = store.listLibrary("module"),
    body = store.getResourceSnapshot("module", "module");
  assert.equal(page.items[0].summary.name, "After");
  assert.equal(page.items[0].revision, body.revision);
  assert.equal(page.cursor, body.cursor);
  assert.deepEqual(body.payload.unknown, { retained: true });
  assert.equal(
    store
      .changes(0, 100)
      .changes.find((event) => event.type === "fields" && event.payload.catalog)
      ?.payload.catalog.summary.name,
    "After",
  );
  command({
    type: "delete-library-resource",
    kind: "module",
    resourceId: "module",
    expectedRevision: body.revision,
    expectedEpoch: 0,
  });
  assert.equal(store.listLibrary("module").items.length, 0);
  const deleted = body.revision + 1;
  save("module", { name: "Recreated" }, deleted, deleted);
  const recreated = store.listLibrary("module").items[0];
  assert.equal(recreated.entityEpoch, deleted);
  assert.equal(recreated.revision, deleted + 1);
  assert.equal(
    store.getResourceSnapshot("module", "module").entityEpoch,
    deleted,
  );
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
test("native write sets update or delete catalog entries in the same result transaction", (t) => {
  const { store, command, save } = fixture(t);
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  command({ type: "create-chat", characterId: "c", chatId: "a", metadata: {} });
  save("module", { name: "Before" });
  store.enqueueJob("catalog-job", { type: "button", chatId: "a" });
  const claim = store.claimJob("synthetic-owner");
  store.finishJob("catalog-job", "synthetic-owner", claim.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: claim.snapshot.chat.revision,
      resources: [
        {
          kind: "module",
          id: "module",
          expectedRevision: 1,
          payload: { name: "Native", unknown: true },
        },
      ],
    },
  });
  assert.equal(store.listLibrary("module").items[0].summary.name, "Native");
  assert.deepEqual(store.getResource("module", "module").payload, {
    name: "Native",
    unknown: true,
  });
  store.enqueueJob("catalog-delete", { type: "button", chatId: "a" });
  const deletion = store.claimJob("synthetic-owner");
  store.finishJob("catalog-delete", "synthetic-owner", deletion.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: deletion.snapshot.chat.revision,
      deleteResources: [{ kind: "module", id: "module", expectedRevision: 2 }],
    },
  });
  assert.deepEqual(store.listLibrary("module").items, []);
});
test("v9 catalog migration preserves bodies, identity, journal and live job ownership/progress", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-catalog-v9-")),
    file = join(directory, "synthetic.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = new EntityStore(file);
  initial.applyCommand("char", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  initial.applyCommand("chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: {},
  });
  initial.applyCommand("module", {
    type: "put-resource",
    kind: "module",
    resourceId: "m",
    expectedRevision: 0,
    payload: { name: "Migrated", unknown: "Synthetic body".repeat(10000) },
  });
  initial.enqueueJob("job", {
    type: "send",
    chatId: "a",
    input: "Synthetic input",
  });
  const claim = initial.claimJob("synthetic-owner");
  initial.writeJobProgress("job", "synthetic-owner", claim.job.fence, {
    stage: 2,
  });
  const before = {
    serverId: initial.bootstrap().serverId,
    cursor: initial.cursor(),
    body: initial.getResource("module", "m"),
    job: initial.getJob("job"),
  };
  initial.close();
  const old = new DatabaseSync(file);
  old.exec("DROP TABLE resource_catalog; PRAGMA user_version=9;");
  old.close();
  const { store } = fixture(t, file);
  assert.equal(store.bootstrap().serverId, before.serverId);
  assert.equal(store.cursor(), before.cursor);
  assert.deepEqual(store.getResource("module", "m"), before.body);
  assert.deepEqual(store.getJob("job"), before.job);
  assert.equal(store.listLibrary("module").items[0].summary.name, "Migrated");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("catalog and body reads use WAL snapshots without reserving the database writer", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-catalog-reader-")),
    file = join(directory, "synthetic.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { store, command } = fixture(t, file);
  command({
    type: "put-resource",
    kind: "module",
    resourceId: "m",
    expectedRevision: 0,
    payload: { name: "Synthetic" },
  });
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA busy_timeout=50;");
  t.after(() => writer.close());
  const cursor = store.cursor.bind(store);
  store.cursor = () => {
    writer.exec(
      "BEGIN IMMEDIATE; UPDATE resources SET revision=revision WHERE kind='module'; COMMIT;",
    );
    return cursor();
  };
  assert.equal(store.listLibrary("module").items[0].id, "m");
  assert.equal(
    store.getResourceSnapshot("module", "m").payload.name,
    "Synthetic",
  );
  assert.equal(store.resolveModuleCatalog(["m"]).items[0].id, "m");
});
