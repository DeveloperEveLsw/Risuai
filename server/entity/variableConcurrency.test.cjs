"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const { readExecutionSnapshot } = require("../native/readSnapshot.cjs");

function fixture(t, metadata = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-variable-concurrency-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
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
    metadata,
  });
  let next = 0;
  const edit = (edits) =>
    store.applyCommand("variable-" + ++next, {
      type: "change-variables",
      edits,
    });
  const claim = () => {
    store.enqueueJob("job", { type: "send", chatId: "a" });
    return store.claimJob("worker", 30000);
  };
  const finish = (claimed, writes) =>
    store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claimed.snapshot.chat.revision,
        expectedContentRevision: claimed.snapshot.chat.contentRevision,
        ...writes,
      },
    });
  return { store, file, edit, claim, finish };
}
const local = (key) => ({ scope: "chat-global", chatId: "a", key });
const ordinary = (key) => ({ scope: "chat", chatId: "a", key });
const code = (expected) => (error) => error.code === expected;

test("running jobs preserve concurrently confirmed keys while committing unrelated variables, metadata and messages", (t) => {
  const f = fixture(t, {
    GLGlobalVariables: { retained: "before" },
    unknown: "kept",
  });
  f.edit([{ ...ordinary("$read"), expectedRevision: 0, value: "before" }]);
  const claimed = f.claim();
  f.edit([
    { ...ordinary("$read"), expectedRevision: 1, value: "after" },
    { ...local("retained"), expectedRevision: 1, value: "after" },
    { ...local("new"), expectedRevision: 0, value: "new" },
  ]);
  assert.equal(
    f.store.snapshot("a").chat.contentRevision,
    claimed.job.startedContentRevision,
  );
  assert.ok(f.store.snapshot("a").chat.revision > claimed.job.startedRevision);
  const metadata = { ...claimed.snapshot.chat.metadata, note: "engine" };
  delete metadata.GLGlobalVariables;
  const saved = f.finish(claimed, {
    metadata,
    variables: [{ key: "$output", value: "engine", expectedRevision: 0 }],
    chatGlobalVariables: [
      { key: "engine", value: "engine", expectedRevision: 0 },
    ],
    messages: [
      {
        id: "reply",
        expectedRevision: 0,
        message: { role: "char", data: "computed from the snapshot" },
      },
    ],
  });
  assert.equal(saved.job.state, "completed");
  const snapshot = f.store.snapshot("a");
  assert.equal(
    snapshot.variables.find((row) => row.key === "$read").value,
    "after",
  );
  assert.deepEqual(snapshot.chat.metadata.GLGlobalVariables, {
    retained: "after",
    new: "new",
    engine: "engine",
  });
  assert.equal(snapshot.chat.metadata.note, "engine");
  assert.equal(snapshot.chat.metadata.unknown, "kept");
  assert.equal(snapshot.messages[0].message.data, "computed from the snapshot");
});

test("an overlapping key conflict rolls back every engine effect and can retain computed output without replacing the user's value", (t) => {
  const f = fixture(t);
  f.edit([{ ...ordinary("$choice"), expectedRevision: 0, value: "before" }]);
  const claimed = f.claim();
  f.edit([{ ...ordinary("$choice"), expectedRevision: 1, value: "user" }]);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      f.finish(claimed, {
        metadata: { note: "must roll back" },
        messages: [
          {
            id: "reply",
            expectedRevision: 0,
            message: { role: "char", data: "computed" },
          },
        ],
        variables: [{ key: "$choice", expectedRevision: 1, value: "engine" }],
      }),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").messages.length, 0);
  assert.equal(f.store.snapshot("a").chat.metadata.note, undefined);
  assert.equal(f.store.snapshot("a").variables[0].value, "user");
  const saved = f.store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
    state: "failed",
    result: { uncommitted: "computed", conflict: true },
  });
  assert.equal(saved.job.result.uncommitted, "computed");
});

test("the native reader can acquire its consistent snapshot after variables changed between claim and engine start", (t) => {
  const f = fixture(t);
  const claimed = f.claim();
  f.edit([
    {
      ...ordinary("$choice"),
      expectedRevision: 0,
      value: "new before reading",
    },
  ]);
  const reader = new DatabaseSync(f.file, { readOnly: true });
  try {
    claimed.snapshot = readExecutionSnapshot(reader, claimed.job);
  } finally {
    reader.close();
  }
  assert.ok(claimed.snapshot.chat.revision > claimed.job.startedRevision);
  assert.equal(claimed.snapshot.variables[0].value, "new before reading");
  assert.equal(
    f.finish(claimed, {
      variables: [{ key: "$choice", expectedRevision: 1, value: "computed" }],
    }).job.state,
    "completed",
  );
});

test("removing the whole local-global map fences new keys while compatible map creation can merge independent keys", (t) => {
  const f = fixture(t, { GLGlobalVariables: { base: "old" } });
  const claimed = f.claim();
  f.edit([{ ...local("new"), expectedRevision: 0, value: "user" }]);
  assert.throws(
    () =>
      f.finish(claimed, {
        deleteChatGlobalVariables: [{ key: "base", expectedRevision: 1 }],
        chatGlobalShape: {
          type: "absent",
          expectedRevision: claimed.snapshot.chat.chatGlobalRevision,
        },
      }),
    code("REVISION_CONFLICT"),
  );
  assert.deepEqual(f.store.snapshot("a").chat.metadata.GLGlobalVariables, {
    base: "old",
    new: "user",
  });
  f.store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
    state: "failed",
  });
  f.store.applyCommand("second-chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
  });
  f.store.enqueueJob("second-job", { type: "send", chatId: "b" });
  const second = f.store.claimJob("worker");
  f.edit([
    {
      scope: "chat-global",
      chatId: "b",
      key: "user",
      expectedRevision: 0,
      value: "user",
    },
  ]);
  const result = f.store.finishJob(second.job.id, "worker", second.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "b",
      expectedRevision: second.snapshot.chat.revision,
      expectedContentRevision: second.snapshot.chat.contentRevision,
      chatGlobalShape: {
        type: "object",
        expectedRevision: second.snapshot.chat.chatGlobalRevision,
      },
      chatGlobalVariables: [
        { key: "engine", expectedRevision: 0, value: "engine" },
      ],
    },
  });
  assert.equal(result.job.state, "completed");
  assert.deepEqual(f.store.snapshot("b").chat.metadata.GLGlobalVariables, {
    user: "user",
    engine: "engine",
  });
});

test("content changes and future snapshot revisions remain conflicts; legacy final formats keep their coarse guard", (t) => {
  const f = fixture(t);
  const claimed = f.claim();
  assert.throws(
    () =>
      f.finish(claimed, {
        expectedRevision: claimed.job.startedRevision + 100,
      }),
    code("REVISION_CONFLICT"),
  );
  assert.throws(
    () =>
      f.finish(claimed, {
        chatGlobalShape: {
          type: "absent",
          expectedRevision: claimed.snapshot.chat.chatGlobalRevision + 100,
        },
      }),
    code("REVISION_CONFLICT"),
  );
  f.edit([{ ...local("fast"), expectedRevision: 0, value: "confirmed" }]);
  assert.throws(
    () =>
      f.store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
        state: "completed",
        messages: [{ id: "legacy", message: { role: "char", data: "unsafe" } }],
      }),
    code("REVISION_CONFLICT"),
  );
  f.store.transaction(() =>
    f.store.appendMessage("a", "maintenance", {
      role: "char",
      data: "out of band content",
    }),
  );
  assert.throws(() => f.finish(claimed, {}), code("REVISION_CONFLICT"));
  assert.equal(f.store.snapshot("a").messages.length, 1);
});

test("schema-six migration preserves running progress and variable revisions while initializing content and range guards", (t) => {
  const f = fixture(t, { GLGlobalVariables: { retained: "legacy" } });
  f.edit([{ ...ordinary("$choice"), expectedRevision: 0, value: "legacy" }]);
  const claimed = f.claim();
  f.store.writeJobProgress("job", "worker", claimed.job.fence, {
    stage: 2,
    messages: [{ data: "partial" }],
  });
  const identity = f.store.bootstrap().serverId,
    cursor = f.store.cursor();
  const revision = f.store.snapshot("a").chat.revision;
  f.store.db.exec(
    "ALTER TABLE chats DROP COLUMN content_revision; ALTER TABLE chats DROP COLUMN chat_global_revision; ALTER TABLE jobs DROP COLUMN started_content_revision; PRAGMA user_version=6;",
  );
  f.store.close();
  const migrated = new EntityStore(f.file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  assert.equal(migrated.bootstrap().serverId, identity);
  assert.equal(migrated.cursor(), cursor);
  assert.equal(migrated.snapshot("a").chat.contentRevision, revision);
  assert.equal(migrated.snapshot("a").chat.chatGlobalRevision, 0);
  assert.equal(
    migrated.getJob("job").startedContentRevision,
    claimed.job.startedRevision,
  );
  assert.equal(migrated.getJob("job").progress.messages[0].data, "partial");
  assert.equal(
    migrated.snapshot("a").chat.metadata.GLGlobalVariables.retained,
    "legacy",
  );
  assert.equal(migrated.snapshot("a").variables[0].revision, 1);
});
