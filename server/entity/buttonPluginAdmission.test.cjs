"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const {
  validateButtonPluginAdmission,
} = require("./buttonPluginAdmission.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");

function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  const command = (value) => store.applyCommand("synthetic-" + ++next, value);
  store.initializeState({
    settings: { pluginIds: ["p", "inactive"] },
    resources: [],
  });
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  command({ type: "create-chat", characterId: "c", chatId: "a" });
  const plugin = {
    id: "p",
    enabled: true,
    name: "Synthetic reviewed plugin",
    script: "/* synthetic */",
  };
  for (const payload of [plugin, { id: "inactive", enabled: false }])
    command({
      type: "put-resource",
      kind: "plugin",
      resourceId: payload.id,
      expectedRevision: 0,
      payload,
    });
  store.enqueueJob("button", { type: "button", chatId: "a", data: "blue" });
  const claimed = store.claimJob("synthetic-worker");
  const reads = createPluginReadDependencies(claimed.snapshot);
  reads.observeCharacter();
  reads.observeChat();
  reads.observeDatabaseFields(["plugins"]);
  const admission = { pluginId: "p", reads: reads.snapshot() };
  const writes = {
    chatId: "a",
    expectedRevision: claimed.job.startedRevision,
    expectedContentRevision: claimed.job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "result",
        expectedRevision: 0,
        message: { role: "char", data: "Synthetic button result" },
      },
    ],
    variables: [{ key: "$selected", value: "blue", expectedRevision: 0 }],
  };
  const finish = (outcome = {}) =>
    store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
      state: "completed",
      pluginAdmission: admission,
      writeSet: writes,
      ...outcome,
    });
  const target = {
    jobId: "button",
    chatId: "a",
    expectedChatEpoch: claimed.job.chatEpoch,
    expectedContentRevision: claimed.job.startedContentRevision,
  };
  function fail(uncommitted = {}) {
    return store.finishJob(
      claimed.job.id,
      claimed.job.owner,
      claimed.job.fence,
      {
        state: "failed",
        result: {
          code: "DATABASE_ERROR",
          uncommitted: {
            writeSet: writes,
            pluginAdmission: admission,
            ...uncommitted,
          },
        },
      },
    );
  }
  function editPlugin(id = "p", changes = { script: "/* changed */" }) {
    const row = store.getResource("plugin", id);
    return command({
      type: "put-resource",
      kind: "plugin",
      resourceId: id,
      expectedRevision: row.revision,
      payload: { ...row.payload, ...changes },
    });
  }
  function removePlugin(id = "inactive") {
    return command({
      type: "delete-library-resource",
      kind: "plugin",
      resourceId: id,
      expectedRevision: store.getResource("plugin", id).revision,
      expectedEpoch: store.deletedRevision("resource", "plugin", id),
    });
  }
  return {
    store,
    command,
    claimed,
    admission,
    writes,
    finish,
    target,
    fail,
    editPlugin,
    removePlugin,
  };
}

function assertUnchanged(f, operation) {
  const snapshot = f.store.snapshot("a");
  const cursor = f.store.cursor();
  const source = f.store.getJob("button");
  assert.throws(operation);
  assert.deepEqual(f.store.snapshot("a"), snapshot);
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.getJob("button"), source);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM job_result_actions").get().n,
    0,
  );
}

test("button admission reads metadata only and requires no plugin-storage namespace or lease", (t) => {
  const f = fixture(t);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(
      sql,
      /\b(?:payload|definition|metadata|message|value)\b|\*/i,
    );
    return prepare(sql);
  };
  assert.equal(
    validateButtonPluginAdmission(f.store, f.claimed.job, f.admission),
    true,
  );
  f.store.db.prepare = prepare;
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM plugin_storage_namespaces")
      .get().n,
    0,
  );
  f.finish();
  assert.equal(f.store.getJob("button").state, "completed");
  assert.equal(f.store.snapshot("a").variables[0].value, "blue");
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM plugin_storage_namespaces")
      .get().n,
    0,
  );
});

for (const scenario of [
  "source",
  "enabled",
  "inactive-enabled",
  "add",
  "remove",
  "recreate",
  "character-epoch",
  "chat-epoch",
])
  test(`a concurrent ${scenario} change rejects the entire guarded button transaction`, (t) => {
    const f = fixture(t);
    if (scenario === "source") f.editPlugin();
    if (scenario === "enabled") f.editPlugin("p", { enabled: false });
    if (scenario === "inactive-enabled")
      f.editPlugin("inactive", { enabled: true });
    if (scenario === "add")
      f.command({
        type: "put-resource",
        kind: "plugin",
        resourceId: "new",
        expectedRevision: 0,
        payload: { id: "new", enabled: true },
      });
    if (scenario === "remove" || scenario === "recreate") f.removePlugin();
    if (scenario === "recreate")
      f.command({
        type: "put-resource",
        kind: "plugin",
        resourceId: "inactive",
        expectedRevision: f.store.deletedRevision(
          "resource",
          "plugin",
          "inactive",
        ),
        payload: { id: "inactive", enabled: false },
      });
    if (scenario === "character-epoch" || scenario === "chat-epoch")
      f.store.db
        .prepare(
          "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES (?,'',?,9)",
        )
        .run(
          scenario === "character-epoch" ? "character" : "chat",
          scenario === "character-epoch" ? "c" : "a",
        );
    assertUnchanged(f, () => f.finish());
  });

test("malformed/incomplete admission, unknown closure fields and non-button sources are rejected", (t) => {
  const f = fixture(t);
  const malformed = [
    null,
    [],
    {},
    Object.assign(Object.create({ inherited: true }), f.admission),
    { ...f.admission, pluginId: "" },
    { ...f.admission, pluginId: "x".repeat(257) },
    { ...f.admission, unknown: true },
    { ...f.admission, [Symbol("unknown")]: true },
    { ...f.admission, reads: { ...f.admission.reads, unknown: true } },
    { ...f.admission, reads: { ...f.admission.reads, collectionSets: [] } },
    {
      ...f.admission,
      reads: {
        ...f.admission.reads,
        collectionSets: [{ kind: "plugin", ids: ["p"] }],
      },
    },
    { ...f.admission, reads: { ...f.admission.reads, characters: [] } },
    { ...f.admission, reads: { ...f.admission.reads, chats: [] } },
    {
      ...f.admission,
      reads: {
        ...f.admission.reads,
        resources: f.admission.reads.resources.filter(
          (row) => row.kind !== "settings",
        ),
      },
    },
  ];
  for (const admission of malformed)
    assert.throws(() =>
      validateButtonPluginAdmission(f.store, f.claimed.job, admission),
    );
  assert.throws(
    () =>
      validateButtonPluginAdmission(
        f.store,
        { ...f.claimed.job, type: "send" },
        f.admission,
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(f.store.getJob("button").state, "running");
  assert.equal(f.store.snapshot("a").messages.length, 0);
});

test("admission cannot be combined with plugin checkpoints, cancellation or failed completion writes", (t) => {
  for (const outcome of [
    { pluginStorage: {} },
    { state: "failed", writeSet: undefined },
    { state: "cancelled", writeSet: undefined },
  ]) {
    const f = fixture(t);
    assertUnchanged(f, () => f.finish(outcome));
  }
});

test("an unchanged complete failed button result can be explicitly recovered without a storage lease", (t) => {
  const f = fixture(t);
  f.fail();
  const cursor = f.store.cursor();
  const preview = f.store.previewJobResult("button");
  assert.equal(preview.canRecover, true);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").messages.length, 0);
  const result = f.store.applyCommand("recover", {
    type: "recover-job-result",
    ...f.target,
  });
  assert.equal(result.disposition.action, "recover");
  assert.equal(f.store.getJob("button").state, "failed");
  assert.equal(f.store.snapshot("a").variables[0].value, "blue");
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM plugin_storage_namespaces")
      .get().n,
    0,
  );
});

for (const scenario of [
  "source",
  "enabled",
  "add",
  "malformed",
  "non-button",
  "mixed-checkpoint",
])
  test(`result recovery cannot bypass a ${scenario} admission guard`, (t) => {
    const f = fixture(t);
    f.fail(
      scenario === "malformed"
        ? {
            pluginAdmission: {
              ...f.admission,
              reads: { ...f.admission.reads, collectionSets: [] },
            },
          }
        : scenario === "mixed-checkpoint"
          ? { pluginStorage: {} }
          : {},
    );
    if (scenario === "source") f.editPlugin();
    if (scenario === "enabled") f.editPlugin("p", { enabled: false });
    if (scenario === "add")
      f.command({
        type: "put-resource",
        kind: "plugin",
        resourceId: "new",
        expectedRevision: 0,
        payload: { id: "new", enabled: true },
      });
    if (scenario === "non-button")
      f.store.db.prepare("UPDATE jobs SET type='send' WHERE id='button'").run();
    const preview = f.store.previewJobResult("button");
    assert.equal(preview.canRecover, false);
    assertUnchanged(f, () =>
      f.store.applyCommand("recover", {
        type: "recover-job-result",
        ...f.target,
      }),
    );
  });
