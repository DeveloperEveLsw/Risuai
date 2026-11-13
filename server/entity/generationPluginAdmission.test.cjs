"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const {
  validateGenerationPluginAdmission,
} = require("./generationPluginAdmission.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");
const {
  HOLOCALL_BUTTON_RELEASE,
} = require("../native/holocallButtonContract.cjs");

function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let serial = 0;
  const command = (value) => store.applyCommand("setup-" + ++serial, value);
  store.initializeState({ settings: { pluginIds: ["holo"] }, resources: [] });
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
    chat: { chatId: "a" },
  });
  command({
    type: "put-resource",
    kind: "plugin",
    resourceId: "holo",
    expectedRevision: 0,
    payload: { id: "holo", enabled: true, script: "synthetic source" },
  });
  store.enqueueJob("send", {
    type: "send",
    chatId: "a",
    input: "Synthetic input",
    messageId: "input",
  });
  const claimed = store.claimJob("worker");
  const reads = createPluginReadDependencies(claimed.snapshot);
  reads.observeCharacter();
  reads.observeChat();
  reads.observeDatabaseFields(["plugins"]);
  const admission = {
    kind: "browser-generation-v1",
    pluginId: "holo",
    bundleSha: HOLOCALL_BUTTON_RELEASE.sha256,
    reads: reads.snapshot(),
  };
  const writeSet = {
    chatId: "a",
    expectedRevision: claimed.job.startedRevision,
    expectedContentRevision: claimed.job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "output",
        expectedRevision: 0,
        message: { role: "char", data: "Synthetic output" },
      },
    ],
  };
  function finish(extra = {}) {
    return store.finishJob("send", claimed.job.owner, claimed.job.fence, {
      state: "completed",
      writeSet,
      pluginAdmission: admission,
      ...extra,
    });
  }
  function fail(pluginAdmission = admission) {
    store.finishJob("send", claimed.job.owner, claimed.job.fence, {
      state: "failed",
      result: {
        code: "DATABASE_ERROR",
        uncommitted: { writeSet, pluginAdmission },
      },
    });
  }
  function edit() {
    const row = store.getResource("plugin", "holo");
    command({
      type: "put-resource",
      kind: "plugin",
      resourceId: "holo",
      expectedRevision: row.revision,
      payload: { ...row.payload, script: "changed source" },
    });
  }
  function recover() {
    return command({
      type: "recover-job-result",
      jobId: "send",
      chatId: "a",
      expectedChatEpoch: claimed.job.chatEpoch,
      expectedContentRevision: claimed.job.startedContentRevision,
    });
  }
  return {
    store,
    command,
    claimed,
    admission,
    writeSet,
    finish,
    fail,
    edit,
    recover,
  };
}

test("generation admission validates metadata without a plugin storage lease or payload reads", (t) => {
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
  for (const type of ["send", "continue", "reroll", "memory-summary"])
    assert.equal(
      validateGenerationPluginAdmission(
        f.store,
        { ...f.claimed.job, type },
        f.admission,
      ),
      true,
    );
  f.store.db.prepare = prepare;
  f.finish();
  assert.equal(f.store.getJob("send").state, "completed");
  assert.equal(
    f.store.snapshot("a").messages[0].message.data,
    "Synthetic output",
  );
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM plugin_storage_namespaces")
      .get().n,
    0,
  );
});

test("generation admission requires an exact protocol, bundle and complete source closure", (t) => {
  const f = fixture(t);
  for (const value of [
    null,
    [],
    {},
    { ...f.admission, kind: "browser-generation-v2" },
    { ...f.admission, bundleSha: "0".repeat(64) },
    { ...f.admission, pluginId: "" },
    { ...f.admission, unknown: true },
    { ...f.admission, [Symbol("unknown")]: true },
    Object.assign(Object.create({ kind: f.admission.kind }), {
      ...f.admission,
    }),
    { ...f.admission, reads: { ...f.admission.reads, collectionSets: [] } },
    { ...f.admission, reads: { ...f.admission.reads, characters: [] } },
    { ...f.admission, reads: { ...f.admission.reads, chats: [] } },
    { ...f.admission, reads: { ...f.admission.reads, resources: [] } },
  ])
    assert.throws(() =>
      validateGenerationPluginAdmission(f.store, f.claimed.job, value),
    );
  for (const type of ["button", "unknown", undefined])
    assert.throws(() =>
      validateGenerationPluginAdmission(
        f.store,
        { ...f.claimed.job, type },
        f.admission,
      ),
    );
});

for (const scenario of [
  "source",
  "settings",
  "add",
  "remove",
  "recreate",
  "chat-epoch",
  "character-epoch",
])
  test(`generation completion atomically rejects a concurrent ${scenario} change`, (t) => {
    const f = fixture(t);
    if (scenario === "source") f.edit();
    if (scenario === "settings") {
      const row = f.store.getResource("settings", "global");
      f.command({
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: row.revision,
        payload: { ...row.payload, changed: true },
      });
    }
    if (scenario === "add")
      f.command({
        type: "put-resource",
        kind: "plugin",
        resourceId: "new",
        expectedRevision: 0,
        payload: { enabled: true },
      });
    if (["remove", "recreate"].includes(scenario)) {
      const row = f.store.getResource("plugin", "holo");
      f.command({
        type: "delete-library-resource",
        kind: "plugin",
        resourceId: "holo",
        expectedRevision: row.revision,
        expectedEpoch: row.entityEpoch ?? 0,
      });
      if (scenario === "recreate")
        f.command({
          type: "put-resource",
          kind: "plugin",
          resourceId: "holo",
          expectedRevision: f.store.deletedRevision(
            "resource",
            "plugin",
            "holo",
          ),
          payload: row.payload,
        });
    }
    if (scenario.endsWith("-epoch"))
      f.store.db
        .prepare(
          "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES (?,'',?,9)",
        )
        .run(
          scenario.startsWith("chat") ? "chat" : "character",
          scenario.startsWith("chat") ? "a" : "c",
        );
    const before = f.store.snapshot("a"),
      cursor = f.store.cursor();
    assert.throws(() => f.finish());
    assert.deepEqual(f.store.snapshot("a"), before);
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.store.getJob("send").state, "running");
  });

test("generation source admission cannot be combined with storage, failure or cancellation writes", (t) => {
  for (const extra of [
    { pluginStorage: {} },
    { state: "failed", writeSet: undefined },
    { state: "cancelled", writeSet: undefined },
  ]) {
    const f = fixture(t);
    assert.throws(() => f.finish(extra));
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(f.store.getJob("send").state, "running");
  }
});

test("a complete generation result can be explicitly recovered once without replaying its provider", (t) => {
  const f = fixture(t);
  f.fail();
  assert.equal(f.store.previewJobResult("send").canRecover, true);
  f.recover();
  assert.equal(
    f.store.snapshot("a").messages[0].message.data,
    "Synthetic output",
  );
  assert.equal(f.recover().disposition.action, "recover");
  assert.equal(f.store.snapshot("a").messages.length, 1);
});

for (const scenario of ["source", "bundle", "closure", "type"])
  test(`explicit generation recovery cannot bypass changed ${scenario} guards`, (t) => {
    const f = fixture(t);
    f.fail(
      scenario === "bundle"
        ? { ...f.admission, bundleSha: "unknown" }
        : scenario === "closure"
          ? {
              ...f.admission,
              reads: { ...f.admission.reads, collectionSets: [] },
            }
          : f.admission,
    );
    if (scenario === "source") f.edit();
    if (scenario === "type")
      f.store.db.prepare("UPDATE jobs SET type='button' WHERE id='send'").run();
    assert.equal(f.store.previewJobResult("send").canRecover, false);
    const before = f.store.snapshot("a"),
      cursor = f.store.cursor();
    assert.throws(() => f.recover());
    assert.deepEqual(f.store.snapshot("a"), before);
    assert.equal(f.store.cursor(), cursor);
  });
