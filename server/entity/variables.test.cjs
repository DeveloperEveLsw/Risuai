"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { EntityStore } = require("./store.cjs");

function fixture(t, metadata = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-variable-"));
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
  for (const chatId of ["a", "b"])
    store.applyCommand("chat-" + chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata,
    });
  const edit = (requestId, edits, after) =>
    store.applyCommand(requestId, {
      type: "change-variables",
      edits,
      ...(after ? { after } : {}),
    });
  const read = (target) => store.readVariables([target]).variables[0];
  return { store, file, edit, read };
}
const local = (key = "toggle_test", chatId = "a") => ({
  scope: "chat-global",
  chatId,
  key,
});
const global = (key = "toggle_test") => ({ scope: "global", key });
const code = (expected) => (error) => error.code === expected;

test("chat-local globals are separate rows and preserve optional map shape, scalar values and unknown fields", (t) => {
  const variables = JSON.parse(
    '{"toggle_test":"1","__proto__":"literal","empty":"","nil":null}',
  );
  const { store, read } = fixture(t, {
    GLGlobalVariables: variables,
    unknown: { kept: true },
  });
  const snapshot = store.snapshot("a");
  assert.deepEqual(snapshot.chat.metadata.GLGlobalVariables, variables);
  assert.equal(snapshot.chat.metadata.unknown.kept, true);
  assert.equal(snapshot.chat.revision, 1);
  assert.equal(snapshot.chatGlobalVariables.length, 4);
  assert.deepEqual(
    JSON.parse(
      store.db.prepare("SELECT metadata FROM chats WHERE id='a'").get()
        .metadata,
    ).GLGlobalVariables,
    {},
  );
  assert.equal(read(local("__proto__")).value, "literal");
  for (const [chatId, metadata] of [
    ["absent", {}],
    ["empty", { GLGlobalVariables: {} }],
    ["nil", { GLGlobalVariables: null }],
  ]) {
    store.applyCommand(chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata,
    });
    assert.deepEqual(store.snapshot(chatId).chat.metadata, {
      ...metadata,
      id: chatId,
    });
  }
});

test("unpin and global replacement commit atomically; either stale revision rolls back every effect and admission", (t) => {
  const { store, edit, read } = fixture(t, {
    GLGlobalVariables: { toggle_test: "local" },
  });
  edit("global-first", [{ ...global(), expectedRevision: 0, value: "global" }]);
  const cursor = store.cursor();
  const edits = [
    { ...local(), expectedRevision: 1, remove: true },
    { ...global(), expectedRevision: 0, value: "stale" },
  ];
  assert.throws(() => edit("atomic", edits), code("REVISION_CONFLICT"));
  assert.equal(read(local()).value, "local");
  assert.equal(read(global()).value, "global");
  assert.equal(store.cursor(), cursor);
  assert.equal(
    store.db.prepare("SELECT id FROM commands WHERE id='atomic'").get(),
    undefined,
  );
  edits[1].expectedRevision = 1;
  const result = edit("atomic", edits);
  assert.equal(read(local()).exists, false);
  assert.equal(read(local()).revision, 2);
  assert.equal(read(global()).value, "stale");
  assert.deepEqual(edit("atomic", edits), result);
  assert.deepEqual(store.snapshot("a").chat.metadata.GLGlobalVariables, {});
});

test("three scopes have independent revisions and deletions cannot permit stale recreation", (t) => {
  const { edit, read, store } = fixture(t);
  const targets = [
    global(),
    local(),
    local("toggle_test", "b"),
    { scope: "chat", chatId: "a", key: "$toggle_test" },
  ];
  edit(
    "initial",
    targets.map((target, i) => ({
      ...target,
      expectedRevision: 0,
      value: String(i),
    })),
  );
  edit(
    "delete",
    targets.map((target) => ({ ...target, expectedRevision: 1, remove: true })),
  );
  for (const target of targets) {
    assert.equal(read(target).revision, 2);
    assert.equal(read(target).exists, false);
    assert.throws(
      () =>
        edit("stale-" + JSON.stringify(target), [
          { ...target, expectedRevision: 0, value: "old" },
        ]),
      code("REVISION_CONFLICT"),
    );
  }
  edit(
    "recreate",
    targets.map((target) => ({ ...target, expectedRevision: 2, value: "new" })),
  );
  for (const target of targets) assert.equal(read(target).revision, 3);
  assert.equal(store.snapshot("a").deletedChatGlobalVariables.length, 0);
});

test("a child cannot overwrite remote state when its rejected parent's expected successor happens to match", (t) => {
  const { edit, read, store } = fixture(t);
  edit("remote", [{ ...global(), expectedRevision: 0, value: "remote" }]);
  assert.throws(
    () =>
      edit("parent", [{ ...global(), expectedRevision: 0, value: "local-1" }]),
    code("REVISION_CONFLICT"),
  );
  const cursor = store.cursor();
  assert.throws(
    () =>
      edit(
        "child",
        [{ ...global(), expectedRevision: 1, value: "local-2" }],
        ["parent"],
      ),
    code("DEPENDENCY_PENDING"),
  );
  assert.equal(read(global()).value, "remote");
  assert.equal(store.cursor(), cursor);
  edit("reconciled", [{ ...global(), expectedRevision: 1, value: "explicit" }]);
  edit(
    "valid-child",
    [{ ...global(), expectedRevision: 2, value: "next" }],
    ["reconciled"],
  );
  assert.equal(read(global()).value, "next");
  assert.throws(
    () =>
      edit(
        "self",
        [{ ...global("new"), expectedRevision: 0, value: "bad" }],
        ["self"],
      ),
    code("INVALID_COMMAND"),
  );
});

test("variable reads are narrow, retain tombstones and share one snapshot cursor; malformed batches never commit", (t) => {
  const { store, edit } = fixture(t);
  store.applyCommand("archive", {
    type: "append-message",
    chatId: "a",
    messageId: "large",
    message: { role: "char", data: "synthetic archive ".repeat(20000) },
  });
  edit("set", [{ ...local(), expectedRevision: 0, value: "1" }]);
  edit("remove", [{ ...local(), expectedRevision: 1, remove: true }]);
  const result = store.readVariables([local(), global()]);
  assert.equal(result.cursor, store.cursor());
  assert.equal(result.variables[0].revision, 2);
  assert.equal(result.variables[1].revision, 0);
  assert.ok(JSON.stringify(result).length < 300);
  const cursor = store.cursor();
  for (const edits of [
    [],
    [{ ...global(), value: "x" }],
    [{ ...global(), expectedRevision: 0, value: {} }],
    [
      { ...global(), expectedRevision: 0, value: "x" },
      { ...global(), expectedRevision: 0, value: "y" },
    ],
  ]) {
    assert.throws(() => edit("bad", edits), code("INVALID_COMMAND"));
    assert.equal(store.cursor(), cursor);
  }
});

test("per-key variables remain writable during a chat job while content edits remain ordered", (t) => {
  const { store, edit } = fixture(t);
  store.enqueueJob("job", { type: "send", chatId: "a" });
  store.claimJob("worker");
  const content = store.snapshot("a").chat.contentRevision;
  edit("fast", [{ ...local(), expectedRevision: 0, value: "x" }]);
  assert.equal(store.snapshot("a").chat.contentRevision, content);
  assert.throws(
    () =>
      store.applyCommand("busy-message", {
        type: "append-message",
        chatId: "a",
        messageId: "busy",
        message: { role: "user", data: "wait" },
      }),
    code("CHAT_BUSY"),
  );
  edit("other", [
    { ...local("toggle_test", "b"), expectedRevision: 0, value: "b" },
    { ...global(), expectedRevision: 0, value: "g" },
  ]);
  assert.equal(
    store.snapshot("b").chat.metadata.GLGlobalVariables.toggle_test,
    "b",
  );
});

test("native metadata writes update only changed local keys and retain deletion revisions", (t) => {
  const { store, read } = fixture(t, {
    GLGlobalVariables: { toggle_test: "before", unchanged: "keep" },
    unknown: "kept",
  });
  store.enqueueJob("job", { type: "send", chatId: "a" });
  const { job, snapshot } = store.claimJob("worker");
  store.finishJob(job.id, "worker", job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: snapshot.chat.revision,
      metadata: {
        ...snapshot.chat.metadata,
        GLGlobalVariables: { unchanged: "keep", added: "new" },
      },
    },
  });
  assert.equal(read(local()).revision, 2);
  assert.equal(read(local()).exists, false);
  assert.equal(read(local("unchanged")).revision, 1);
  assert.equal(read(local("added")).value, "new");
  assert.equal(store.snapshot("a").chat.metadata.unknown, "kept");
  assert.deepEqual(
    store.snapshot("a").deletedChatGlobalVariables.map((row) => ({ ...row })),
    [{ key: "toggle_test", revision: 2 }],
  );
});

test("version-five migration preserves identity, jobs, revisions, unknown metadata and the optional local map", (t) => {
  const { store, file } = fixture(t);
  const identity = store.bootstrap().serverId;
  store.enqueueJob("queued", { type: "send", chatId: "a" });
  store.db.prepare("UPDATE chats SET metadata=? WHERE id='a'").run(
    JSON.stringify({
      id: "a",
      GLGlobalVariables: { toggle_test: "legacy" },
      unknown: { keep: 1 },
    }),
  );
  store.db.exec("DROP TABLE chat_global_variables; PRAGMA user_version=5;");
  const cursor = store.cursor();
  store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  assert.equal(migrated.bootstrap().serverId, identity);
  assert.equal(migrated.cursor(), cursor);
  assert.equal(migrated.getJob("queued").state, "queued");
  assert.equal(migrated.snapshot("a").chat.revision, 1);
  assert.deepEqual(migrated.snapshot("a").chat.metadata, {
    id: "a",
    GLGlobalVariables: { toggle_test: "legacy" },
    unknown: { keep: 1 },
  });
});

test("invalid legacy local maps roll back schema and all previously migrated rows", (t) => {
  const { store, file } = fixture(t);
  store.db
    .prepare("UPDATE chats SET metadata=? WHERE id='a'")
    .run('{"GLGlobalVariables":{"good":"1"}}');
  store.db
    .prepare("UPDATE chats SET metadata=? WHERE id='b'")
    .run('{"GLGlobalVariables":{"bad":{"nested":true}}}');
  store.db.exec("DROP TABLE chat_global_variables; PRAGMA user_version=5;");
  store.close();
  assert.throws(() => new EntityStore(file), code("INVALID_COMMAND"));
  const observer = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(observer.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(
      observer
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='chat_global_variables'",
        )
        .get(),
      undefined,
    );
    assert.deepEqual(
      JSON.parse(
        observer.prepare("SELECT metadata FROM chats WHERE id='a'").get()
          .metadata,
      ),
      { GLGlobalVariables: { good: "1" } },
    );
  } finally {
    observer.close();
  }
});
