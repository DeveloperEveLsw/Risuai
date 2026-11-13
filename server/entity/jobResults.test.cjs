"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-result-")),
    file = join(root, "state.sqlite");
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  store.applyCommand("chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
  });
  store.enqueueJob("source", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "input",
  });
  const job = store.claimJob("worker").job;
  const writeSet = {
    chatId: "a",
    expectedRevision: job.startedRevision,
    expectedContentRevision: job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "reply",
        expectedRevision: 0,
        message: {
          role: "char",
          data: "<script>synthetic()</script> Raw saved reply",
        },
      },
    ],
    variables: [{ key: "$effect", expectedRevision: 0, value: 1 }],
  };
  store.finishJob("source", "worker", job.fence, {
    state: "failed",
    result: {
      code: "DATABASE_ERROR",
      message: "Synthetic save failed",
      uncommitted: {
        writeSet,
        result: {
          syntheticSecret: "do-not-transfer",
          script: "do-not-transfer",
        },
      },
    },
  });
  const target = {
    jobId: "source",
    chatId: "a",
    expectedChatEpoch: 0,
    expectedContentRevision: job.startedContentRevision,
  };
  return { store, file, target, writeSet };
}

test("compact status excludes terminal progress and full execution; explicit preview is a rollback-only transaction", (t) => {
  const { store, writeSet } = fixture(t);
  store.db.prepare("UPDATE jobs SET progress=? WHERE id='source'").run(
    JSON.stringify({
      messages: [{ data: "large-private-progress".repeat(10000) }],
    }),
  );
  const before = store.cursor();
  const status = store.getJobStatus("source");
  assert.equal(status.result.retained, 1);
  assert.deepEqual(status.progress, {});
  assert.ok(JSON.stringify(status).length < 1000);
  assert.equal(JSON.stringify(status).includes("do-not-transfer"), false);
  const preview = store.previewJobResult("source");
  assert.deepEqual(preview.failure, {
    code: "DATABASE_ERROR",
    message: "Synthetic save failed",
  });
  assert.equal(JSON.stringify(preview).includes("do-not-transfer"), false);
  assert.equal(preview.canRecover, true);
  assert.equal(preview.messages[0].data, writeSet.messages[0].message.data);
  assert.equal(store.cursor(), before);
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal(store.snapshot("a").variables.length, 0);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM job_result_actions").get().n,
    0,
  );
});

test("empty failed execution exposes its original failure separately from recovery limits without applying or retrying anything", (t) => {
  const { store } = fixture(t);
  const failure = {
    code: "ENGINE_ERROR",
    message: "A complete server plugin host is required for native generation",
    reason: "Synthetic original reason",
  };
  store.db.prepare("UPDATE jobs SET result=? WHERE id='source'").run(
    JSON.stringify({
      ...failure,
      uncommitted: {
        snapshot: { settings: "do-not-transfer-config" },
        result: { prompt: "do-not-transfer-prompt" },
      },
      arbitrary: { credential: "do-not-transfer-credential" },
    }),
  );
  const cursor = store.cursor(),
    job = store.getJob("source"),
    snapshot = store.snapshot("a");
  const preview = store.previewJobResult("source");
  assert.deepEqual(preview.failure, failure);
  assert.equal(preview.blocked.code, "RESULT_NOT_RECOVERABLE");
  assert.equal(preview.canRecover, false);
  assert.equal(preview.complete, false);
  assert.equal(preview.canRetry, true);
  assert.deepEqual(preview.messages, []);
  assert.deepEqual(preview.providerOutputs, []);
  assert.equal(JSON.stringify(preview).includes("do-not-transfer"), false);
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(store.getJob("source"), job);
  assert.deepEqual(store.snapshot("a"), snapshot);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM job_result_actions").get().n,
    0,
  );
});

test("preview bounds original failure strings to compact status limits and excludes non-string error values", (t) => {
  const { store } = fixture(t);
  store.db.prepare("UPDATE jobs SET result=? WHERE id='source'").run(
    JSON.stringify({
      code: "c".repeat(5000),
      message: "m".repeat(5000),
      reason: "r".repeat(5000),
      snapshot: "do-not-transfer",
    }),
  );
  const preview = store.previewJobResult("source"),
    compact = store.getJobStatus("source").result;
  assert.deepEqual(preview.failure, {
    code: compact.code,
    message: compact.message,
    reason: compact.reason,
  });
  assert.equal(preview.failure.code.length, 80);
  assert.equal(preview.failure.message.length, 512);
  assert.equal(preview.failure.reason.length, 512);
  for (const result of [
    null,
    ["not a failure"],
    {
      code: { secret: "do-not-transfer" },
      message: ["do-not-transfer"],
      reason: 7,
    },
  ]) {
    store.db
      .prepare("UPDATE jobs SET result=? WHERE id='source'")
      .run(JSON.stringify(result));
    assert.equal(store.previewJobResult("source").failure, null);
  }
});

test("an interrupted job preserves its original reason even without retained messages or a recoverable transaction", (t) => {
  const { store } = fixture(t);
  store.db
    .prepare(
      "UPDATE jobs SET state='interrupted',result=?,progress='{}' WHERE id='source'",
    )
    .run(JSON.stringify({ reason: "Synthetic worker interrupted" }));
  const preview = store.previewJobResult("source");
  assert.deepEqual(preview.failure, {
    reason: "Synthetic worker interrupted",
  });
  assert.equal(preview.state, "interrupted");
  assert.equal(preview.complete, false);
  assert.equal(preview.canRecover, false);
  assert.equal(preview.blocked.code, "RESULT_NOT_RECOVERABLE");
  assert.deepEqual(preview.messages, []);
});

test("two DB workers recover once across different requests and service reopen, retaining the original failure", async (t) => {
  const { store, file, target } = fixture(t);
  const original = store.getJob("source").result;
  const left = new EntityStoreClient(file),
    right = new EntityStoreClient(file);
  t.after(async () => {
    await left.close();
    await right.close();
  });
  const command = { type: "recover-job-result", ...target };
  const results = await Promise.all([
    left.call("applyCommand", "left", command),
    right.call("applyCommand", "right", command),
  ]);
  assert.equal(results.filter((r) => !r.alreadyApplied).length, 1);
  assert.equal(store.snapshot("a").messages.length, 1);
  assert.equal(store.snapshot("a").variables[0].value, 1);
  assert.deepEqual(store.getJob("source").result, original);
  const observer = new EntityStore(file);
  t.after(() => observer.close());
  assert.deepEqual(observer.applyCommand("left", command), results[0]);
  assert.equal(observer.previewJobResult("source").canRecover, false);
  assert.equal(observer.getJobStatus("source").disposition.action, "recover");
  assert.equal(observer.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

for (const scenario of [
  "content",
  "variable",
  "character-incarnation",
  "chat-incarnation",
  "queued",
  "payload",
]) {
  test(
    "recovery rejects " + scenario + " without partial writes or a disposition",
    (t) => {
      const { store, target } = fixture(t);
      if (scenario === "content")
        store.applyCommand("peer", {
          type: "append-message",
          chatId: "a",
          messageId: "peer",
          message: { role: "user", data: "Peer" },
        });
      if (scenario === "variable")
        store.applyCommand("peer", {
          type: "set-chat-variable",
          chatId: "a",
          key: "$effect",
          value: 7,
        });
      if (scenario === "character-incarnation") {
        // Synthetic ABA member dependency, without deleting its owner chat.
        store.db
          .prepare(
            "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES ('character','','c',9)",
          )
          .run();
      }
      if (scenario === "chat-incarnation") {
        store.applyCommand("other-chat", {
          type: "create-chat",
          characterId: "c",
          chatId: "b",
        });
        store.applyCommand("delete", {
          type: "delete-chat",
          chatId: "a",
          expectedRevision: store.requireChat("a").revision,
          expectedEpoch: 0,
        });
        store.applyCommand("recreate", {
          type: "create-chat",
          characterId: "c",
          chatId: "a",
        });
      }
      if (scenario === "queued")
        store.enqueueJob("next", { type: "send", chatId: "a", input: "Next" });
      const command = {
        type: "recover-job-result",
        ...target,
        ...(scenario === "payload" ? { writeSet: { messages: [] } } : {}),
      };
      const before = store.snapshot("a"),
        cursor = store.cursor();
      assert.throws(() => store.applyCommand("recovery", command));
      assert.deepEqual(store.snapshot("a"), before);
      assert.equal(store.cursor(), cursor);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM job_result_actions").get()
          .n,
        0,
      );
      assert.equal(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM commands WHERE id='recovery'")
          .get().n,
        0,
      );
      if (scenario !== "payload")
        assert.equal(store.previewJobResult("source").canRecover, false);
    },
  );
}

test("partial interrupted output and legacy write sets remain viewable but cannot be committed as complete results", (t) => {
  const { store, target } = fixture(t);
  store.db
    .prepare(
      "UPDATE jobs SET state='interrupted',result='{}',progress=? WHERE id='source'",
    )
    .run(
      JSON.stringify({
        messages: [{ role: "char", data: "Partial", chatId: "partial" }],
      }),
    );
  const partial = store.previewJobResult("source");
  assert.equal(partial.complete, false);
  assert.equal(partial.canRecover, false);
  assert.equal(partial.messages[0].data, "Partial");
  assert.throws(
    () =>
      store.applyCommand("partial", { type: "recover-job-result", ...target }),
    { code: "RESULT_NOT_RECOVERABLE" },
  );
  store.db
    .prepare("UPDATE jobs SET state='failed',result=? WHERE id='source'")
    .run(
      JSON.stringify({
        uncommitted: {
          writeSet: { chatId: "a", expectedRevision: 1, messages: [] },
        },
      }),
    );
  assert.equal(
    store.previewJobResult("source").blocked.code,
    "RESULT_NOT_RECOVERABLE",
  );
});

test("invalid retained message collections do not prevent inspecting a partial checkpoint", (t) => {
  const { store } = fixture(t);
  store.db.prepare("UPDATE jobs SET result=?,progress=? WHERE id='source'").run(
    JSON.stringify({ uncommitted: { writeSet: { messages: "invalid" } } }),
    JSON.stringify({
      messages: [null, { role: "char", data: "Checkpoint" }],
    }),
  );
  const preview = store.previewJobResult("source");
  assert.equal(preview.canRecover, false);
  assert.equal(preview.messages.length, 1);
  assert.equal(preview.messages[0].data, "Checkpoint");
});

test("schema15 migration preserves jobs, results, identity and revisions while adding an empty disposition relation", (t) => {
  const { store, file } = fixture(t);
  const before = store.getJob("source"),
    serverId = store.bootstrap().serverId,
    cursor = store.cursor();
  store.db.exec("DROP TABLE job_result_actions; PRAGMA user_version=15;");
  store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), 22);
  assert.deepEqual(migrated.getJob("source"), before);
  assert.equal(migrated.bootstrap().serverId, serverId);
  assert.equal(migrated.cursor(), cursor);
  assert.equal(migrated.previewJobResult("source").canRecover, true);
  assert.equal(migrated.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
