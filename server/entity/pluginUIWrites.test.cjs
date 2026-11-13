"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
const ui = require("./pluginUIWrites.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-plugin-ui-")),
    file = join(root, "state.sqlite");
  let now = 1000;
  const store = new EntityStore(file, { now: () => now });
  store.initializeState({ settings: {}, resources: [] });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const script = "// Synthetic UI plugin",
    namespace = {
      pluginId: "synthetic",
      bundleSha: createHash("sha256").update(script).digest("hex"),
      pluginEpoch: 0,
    };
  const plugin = { script, enabled: true };
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 0,
    payload: plugin,
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
    chat: { chatId: "a", metadata: { name: "Garden A" } },
  });
  store.applyCommand("chat-b", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "Garden B" },
  });
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: { role: "char", data: "Synthetic original message" },
  });
  const sessionId = randomUUID(),
    lease = store.claimPluginStorage({
      namespace,
      writerId: "ui:" + sessionId,
      authority: { kind: "browser" },
    });
  const scope = store.transaction(
    () => ui.capture(store, { chatId: "a" }),
    true,
  );
  const event = {
    eventId: "plugin-ui:" + randomUUID(),
    sessionId,
    requestHash: createHash("sha256").update("Synthetic action").digest("hex"),
  };
  function captureReads() {
    const reads = createPluginReadDependencies(store.executionSnapshot("a"));
    reads.observeCharacter();
    reads.observeChat();
    reads.observePlugin(namespace.pluginId);
    reads.observeDatabaseFields(["maxContext"]);
    return reads.snapshot();
  }
  const pluginReads = captureReads();
  function writeSet(captured = scope) {
    return {
      chatId: captured.chatId,
      expectedRevision: captured.revision,
      expectedContentRevision: captured.contentRevision,
      characterReads: [
        { id: captured.characterId, expectedEpoch: captured.characterEpoch },
      ],
      messages: [
        {
          id: "m",
          expectedRevision: 1,
          message: {
            role: "char",
            data: "Synthetic original message",
            pluginMarker: "Synthetic marker",
          },
        },
      ],
    };
  }
  function checkpoint(expectedRevision = 0) {
    return {
      lease,
      expectedRevision,
      commitId: event.eventId,
      writes: [{ key: "wl.web.v1", value: "Synthetic graph body" }],
      reads: pluginReads,
    };
  }
  const admission = () =>
    store.transaction(() => ui.admit(store, { ...event, scope, lease }));
  const complete = (writes = writeSet(), graph = checkpoint()) =>
    store.transaction(() =>
      ui.complete(store, {
        ...event,
        appliedRevision: 10,
        writeSet: writes,
        pluginStorage: graph,
      }),
    );
  return {
    root,
    file,
    store,
    namespace,
    plugin,
    scope,
    lease,
    event,
    pluginReads,
    captureReads,
    admission,
    complete,
    writeSet,
    checkpoint,
    time: (value) => {
      now = value;
    },
  };
}
test("UI event admission/graph/chat/completed proof are durable and receipt metadata excludes graph/marker/snapshot values", (t) => {
  const f = fixture(t),
    admitted = f.admission();
  assert.equal(admitted.state, "admitted");
  assert.equal(admitted.replayed, false);
  const result = f.complete();
  assert.equal(result.state, "completed");
  assert.equal(result.appliedRevision, 10);
  assert.equal(result.pluginRevision, 1);
  assert.equal(result.pluginStorage.revision, 1);
  assert.equal(
    result.snapshot.messages[0].message.pluginMarker,
    "Synthetic marker",
  );
  assert.equal(result.scope.revision, f.store.requireChat("a").revision);
  assert.equal(
    result.scope.contentRevision,
    f.store.requireChat("a").content_revision,
  );
  assert.equal(
    f.store.readPluginStorage(f.namespace, "wl.web.v1").value,
    "Synthetic graph body",
  );
  const row = f.store.db
    .prepare("SELECT payload,result FROM commands WHERE id=?")
    .get(f.event.eventId);
  for (const privateValue of [
    "Synthetic graph body",
    "Synthetic marker",
    "Synthetic original message",
    "snapshot",
  ])
    assert.equal(JSON.stringify(row).includes(privateValue), false);
  const peer = new EntityStore(f.file, { now: () => 1000 });
  try {
    const receipt = peer.transaction(() => ui.read(peer, f.event), true);
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.appliedRevision, 10);
    assert.equal("snapshot" in receipt, false);
    assert.equal("token" in receipt, false);
  } finally {
    peer.close();
  }
});
test("lost acknowledgement reads completed proof and duplicate completion performs no write even after lease expires", (t) => {
  const f = fixture(t);
  f.admission();
  const first = f.complete(),
    cursor = f.store.cursor();
  f.store.releasePluginStorage(f.lease);
  f.time(f.lease.expiresAt + 1);
  const replay = f.complete();
  assert.equal(replay.state, "completed");
  assert.equal(replay.appliedRevision, first.appliedRevision);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").messages[0].revision, 2);
});
test("graph CAS failure after chat mutation rolls back chat and leaves durable event admitted", (t) => {
  const f = fixture(t);
  f.admission();
  const cursor = f.store.cursor();
  assert.throws(() => f.complete(f.writeSet(), f.checkpoint(1)), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(f.store.snapshot("a").messages[0].revision, 1);
  assert.equal(
    f.store.snapshot("a").messages[0].message.pluginMarker,
    undefined,
  );
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.store.transaction(() => ui.read(f.store, f.event), true).state,
    "admitted",
  );
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS count FROM plugin_storage_commits")
      .get().count,
    0,
  );
});
test("message conflict prevents both graph writes and terminal receipt", (t) => {
  const f = fixture(t);
  f.admission();
  const writes = f.writeSet();
  writes.messages[0].expectedRevision = 0;
  assert.throws(() => f.complete(writes), { code: "REVISION_CONFLICT" });
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
  assert.equal(
    f.store.transaction(() => ui.read(f.store, f.event), true).state,
    "admitted",
  );
});
test("captured scope cannot be replaced by forged writeSet revision, content clock or another chat", (t) => {
  const f = fixture(t);
  f.admission();
  for (const change of [
    { expectedRevision: f.scope.revision + 1 },
    { expectedContentRevision: f.scope.contentRevision + 1 },
    { chatId: "b" },
    { characterReads: [] },
  ]) {
    assert.throws(() => f.complete({ ...f.writeSet(), ...change }));
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
    assert.equal(f.store.snapshot("a").messages[0].revision, 1);
  }
});
test("queued/running jobs block UI admission, preflight and final commit without graph/chat/receipt effects", (t) => {
  const f = fixture(t);
  f.admission();
  f.store.enqueueJob("native", {
    type: "button",
    chatId: "a",
    data: "synthetic",
  });
  assert.throws(() => f.complete(), { code: "CHAT_BUSY" });
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.check(f.store, {
          scope: f.scope,
          lease: f.lease,
          pluginReads: f.pluginReads,
        }),
      ),
    { code: "CHAT_BUSY" },
  );
  const fresh = { ...f.event, eventId: "plugin-ui:" + randomUUID() };
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.admit(f.store, {
          ...fresh,
          scope: f.scope,
          lease: f.lease,
          pluginReads: f.pluginReads,
        }),
      ),
    { code: "CHAT_BUSY" },
  );
  assert.equal(
    f.store.db.prepare("SELECT 1 FROM commands WHERE id=?").get(fresh.eventId),
    undefined,
  );
  f.store.claimJob("native-owner");
  assert.throws(() => f.complete(), { code: "CHAT_BUSY" });
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
});
test("expired browser writer or a different successor cannot complete the admitted event", (t) => {
  const f = fixture(t);
  f.admission();
  f.time(f.lease.expiresAt);
  assert.throws(() => f.complete(), { code: "STALE_PLUGIN_WORKER" });
  const successor = f.store.claimPluginStorage({
    namespace: f.namespace,
    writerId: "successor",
    authority: { kind: "browser" },
  });
  assert.throws(
    () => f.complete(f.writeSet(), { ...f.checkpoint(), lease: successor }),
    { code: "IDENTITY_CONFLICT" },
  );
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
});
test("plugin UI never borrows a native job lease", (t) => {
  const f = fixture(t);
  f.store.releasePluginStorage(f.lease);
  f.store.enqueueJob("native", {
    type: "button",
    chatId: "b",
    data: "synthetic",
  });
  const job = f.store.claimJob("native-owner").job;
  const native = f.store.claimPluginStorage({
    namespace: f.namespace,
    writerId: "native",
    authority: {
      kind: "job",
      jobId: job.id,
      owner: job.owner,
      fence: job.fence,
    },
  });
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.admit(f.store, { ...f.event, scope: f.scope, lease: native }),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(
    f.store.db
      .prepare("SELECT 1 FROM commands WHERE id=?")
      .get(f.event.eventId),
    undefined,
  );
});
test("preflight validates resource and variable read dependencies before an external UI callback", (t) => {
  const f = fixture(t);
  f.store.applyCommand("var", {
    type: "put-resource",
    kind: "global-variable",
    resourceId: "$ui",
    expectedRevision: 0,
    payload: "before",
  });
  const reads = {
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    resourceReads: [
      { kind: "plugin", id: f.namespace.pluginId, expectedEpoch: 0 },
    ],
    variableReads: [
      {
        scope: "global",
        key: "$ui",
        expectedExists: true,
        expectedRevision: 1,
      },
    ],
  };
  assert.equal(
    f.store.transaction(
      () =>
        ui.check(f.store, {
          scope: f.scope,
          lease: f.lease,
          reads,
          pluginReads: f.pluginReads,
        }),
      true,
    ).writerFence,
    f.lease.fence,
  );
  f.store.applyCommand("changed-var", {
    type: "put-resource",
    kind: "global-variable",
    resourceId: "$ui",
    expectedRevision: 1,
    payload: "after",
  });
  assert.throws(
    () =>
      f.store.transaction(
        () =>
          ui.check(f.store, {
            scope: f.scope,
            lease: f.lease,
            reads,
            pluginReads: f.pluginReads,
          }),
        true,
      ),
    { code: "REVISION_CONFLICT" },
  );
  f.admission();
  assert.throws(() => f.complete({ ...f.writeSet(), ...reads }), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
});
test("preflight/final completion reject disabled or changed plugin code", (t) => {
  const f = fixture(t);
  f.admission();
  f.store.applyCommand("disable", {
    type: "put-resource",
    kind: "plugin",
    resourceId: f.namespace.pluginId,
    expectedRevision: 1,
    payload: { ...f.plugin, enabled: false },
  });
  assert.throws(
    () =>
      f.store.transaction(
        () =>
          ui.check(f.store, {
            scope: f.scope,
            lease: f.lease,
            pluginReads: f.pluginReads,
          }),
        true,
      ),
    { code: "PLUGIN_DISABLED" },
  );
  assert.throws(() => f.complete(), { code: "PLUGIN_DISABLED" });
  f.store.applyCommand("change-code", {
    type: "put-resource",
    kind: "plugin",
    resourceId: f.namespace.pluginId,
    expectedRevision: 2,
    payload: { script: "// Updated synthetic", enabled: true },
  });
  assert.throws(() => f.complete(), { code: "PLUGIN_NAMESPACE_CHANGED" });
  assert.equal(f.store.snapshot("a").messages[0].revision, 1);
});
test("pending/failed receipts cannot automatically replay across session incarnations", (t) => {
  const f = fixture(t),
    first = f.admission();
  assert.equal(first.replayed, false);
  assert.equal(f.admission().replayed, true);
  assert.throws(
    () =>
      f.store.transaction(
        () => ui.read(f.store, { ...f.event, sessionId: "another-session" }),
        true,
      ),
    { code: "IDENTITY_CONFLICT" },
  );
  const failed = f.store.transaction(() =>
    ui.fail(f.store, { ...f.event, code: "SYNTHETIC_FAILURE" }),
  );
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "SYNTHETIC_FAILURE");
  assert.throws(() => f.complete(), { code: "PLUGIN_UI_EVENT_UNCERTAIN" });
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
});
test("event request hash mismatch/missing identity and private failure text never mutate a receipt", (t) => {
  const f = fixture(t);
  f.admission();
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.complete(f.store, {
          ...f.event,
          requestHash: "f".repeat(64),
          writeSet: f.writeSet(),
          pluginStorage: f.checkpoint(),
          appliedRevision: 10,
        }),
      ),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.complete(f.store, {
          ...f.event,
          requestHash: undefined,
          writeSet: f.writeSet(),
          pluginStorage: f.checkpoint(),
          appliedRevision: 10,
        }),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.throws(
    () =>
      f.store.transaction(() =>
        ui.fail(f.store, { ...f.event, code: "Private user body here" }),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(
    f.store.transaction(() => ui.read(f.store, f.event), true).state,
    "admitted",
  );
});
test("failure cannot replace a completed proof", (t) => {
  const f = fixture(t);
  f.admission();
  f.complete();
  const unchanged = f.store.transaction(() =>
    ui.fail(f.store, { ...f.event, code: "LATE_NETWORK_ERROR" }),
  );
  assert.equal(unchanged.state, "completed");
  assert.equal(unchanged.appliedRevision, 10);
});
test("fresh same-transaction completion scope/snapshot can rebase the next UI event", (t) => {
  const f = fixture(t);
  f.admission();
  const first = f.complete();
  const event = { ...f.event, eventId: "plugin-ui:" + randomUUID() };
  f.store.transaction(() =>
    ui.admit(f.store, { ...event, scope: first.scope, lease: f.lease }),
  );
  const writes = f.writeSet(first.scope);
  writes.messages[0].expectedRevision = 2;
  writes.messages[0].message.pluginMarker = "Second synthetic marker";
  const second = f.store.transaction(() =>
    ui.complete(f.store, {
      ...event,
      writeSet: writes,
      pluginStorage: {
        ...f.checkpoint(1),
        commitId: event.eventId,
        reads: f.captureReads(),
        writes: [{ key: "wl.web.v1", value: "Second synthetic graph" }],
      },
      appliedRevision: 11,
    }),
  );
  assert.equal(second.appliedRevision, 11);
  assert.equal(second.pluginRevision, 2);
  assert.equal(second.snapshot.messages[0].revision, 3);
  assert.equal(
    second.snapshot.messages[0].message.pluginMarker,
    "Second synthetic marker",
  );
});
test("minimum full plugin read closure is mandatory before UI dispatch or canonical persistence", (t) => {
  const f = fixture(t);
  f.admission();
  assert.throws(
    () =>
      f.store.transaction(
        () => ui.check(f.store, { scope: f.scope, lease: f.lease }),
        true,
      ),
    { code: "PLUGIN_READ_DEPENDENCY_INVALID" },
  );
  const graph = f.checkpoint();
  delete graph.reads;
  assert.throws(() => f.complete(f.writeSet(), graph), {
    code: "PLUGIN_READ_DEPENDENCY_INVALID",
  });
  assert.equal(f.store.snapshot("a").messages[0].revision, 1);
  assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
  assert.equal(
    f.store.transaction(() => ui.read(f.store, f.event), true).state,
    "admitted",
  );
});
test("same-incarnation character/settings changes invalidate cached UI derivations before any marker or graph write", (t) => {
  for (const target of [
    { scope: "character", entityId: "c", key: "desc" },
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "mainPrompt",
    },
  ]) {
    const f = fixture(t);
    f.admission();
    const field = f.store.readFields([target]).fields[0];
    f.store.applyCommand("source-change", {
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: "Synthetic changed source",
        },
      ],
    });
    assert.throws(
      () =>
        f.store.transaction(
          () =>
            ui.check(f.store, {
              scope: f.scope,
              lease: f.lease,
              pluginReads: f.pluginReads,
            }),
          true,
        ),
      { code: "REVISION_CONFLICT" },
    );
    assert.throws(() => f.complete(), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.snapshot("a").messages[0].revision, 1);
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 0);
    assert.equal(
      f.store.transaction(() => ui.read(f.store, f.event), true).state,
      "admitted",
    );
  }
});
