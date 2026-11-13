"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const code = (value) => (error) => error.code === value;
function fixture(t, count = 5) {
  const directory = mkdtempSync(join(tmpdir(), "risu-message-removal-"));
  const file = join(directory, "synthetic.sqlite");
  const store = new EntityStore(file);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let next = 0;
  const command = (value) => store.applyCommand("synthetic-" + ++next, value);
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
    chat: {
      chatId: "a",
      metadata: { name: "A", unknown: { retained: true }, bookmarks: ["m2"] },
    },
  });
  command({
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "B" },
  });
  for (let i = 0; i < count; i++)
    command({
      type: "append-message",
      chatId: "a",
      messageId: "m" + i,
      message: {
        role: "char",
        data: "Synthetic " + i,
        unknown: { retained: true },
      },
    });
  const remove = (id, mode = "one") => ({
    type: "remove-message",
    chatId: "a",
    messageId: id,
    mode,
    expectedRevision: store.db
      .prepare("SELECT revision FROM messages WHERE id=?")
      .get(id).revision,
    expectedChatRevision: store.requireChat("a").revision,
    expectedChatEpoch: store.fieldEpoch({ scope: "chat", entityId: "a" }),
  });
  return { store, command, remove, file };
}
test("message removal is durable, idempotent, monotonic and preserves remaining bodies/positions/metadata", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a", { limit: 1000 }),
    intent = f.remove("m2");
  const result = f.store.applyCommand("remove", intent);
  assert.equal(result.removedCount, 1);
  assert.equal(result.count, 4);
  const after = f.store.snapshot("a", { limit: 1000 });
  assert.deepEqual(
    after.messages,
    before.messages
      .filter((row) => row.id !== "m2")
      .map((row, ordinal) => ({ ...row, ordinal })),
  );
  assert.deepEqual(after.chat.metadata, before.chat.metadata);
  assert.equal(after.cursor, before.cursor + 1);
  assert.equal(f.store.deletedRevision("message", "a", "m2"), 2);
  const reopened = new EntityStore(f.file);
  try {
    assert.deepEqual(reopened.applyCommand("remove", intent), result);
    assert.equal(reopened.snapshot("a").messages.length, 4);
  } finally {
    reopened.close();
  }
  assert.throws(
    () => f.store.applyCommand("remove", { ...intent, mode: "from" }),
    code("IDEMPOTENCY_CONFLICT"),
  );
  // The public append command creates new IDs. The canonical mutator's
  // explicit tombstone revision models an internal restoration occurrence.
  f.store.transaction(() =>
    f.store.appendMessage(
      "a",
      "m2",
      { role: "char", data: "Synthetic recreated" },
      2,
    ),
  );
  assert.equal(f.store.snapshot("a").messages.at(-1).revision, 3);
  assert.throws(() => f.command(intent), code("REVISION_CONFLICT"));
});
test("large canonical range removal uses headers and one compact change without a browser page cutoff", (t) => {
  const f = fixture(t, 1200),
    intent = f.remove("m20", "from"),
    cursor = f.store.cursor();
  const queries = [],
    original = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    queries.push(sql);
    return original(sql);
  };
  const result = f.command(intent);
  f.store.db.prepare = original;
  assert.equal(result.removedCount, 1180);
  assert.equal(result.count, 20);
  assert.equal(f.store.cursor(), cursor + 1);
  assert.ok(
    queries
      .filter((q) => q.includes("FROM messages"))
      .every((q) => !q.includes("payload") && !q.includes("SELECT *")),
  );
  const changes = f.store.changes(cursor, 1000).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "messages-removed");
  assert.ok(Buffer.byteLength(JSON.stringify(changes[0])) < 600);
  assert.deepEqual(
    f.store.snapshot("a").messages.map((m) => m.id),
    Array.from({ length: 20 }, (_, i) => "m" + i),
  );
  assert.equal(f.store.deletedRevision("message", "a", "m1199"), 2);
});
test("stale message/chat/incarnation, foreign owner and invalid mode all reject atomically", (t) => {
  const f = fixture(t),
    base = f.remove("m2"),
    cursor = f.store.cursor(),
    before = f.store.snapshot("a");
  for (const [patch, expected] of [
    [{ expectedRevision: 0 }, "REVISION_CONFLICT"],
    [{ expectedChatRevision: 0 }, "REVISION_CONFLICT"],
    [{ expectedChatEpoch: 1 }, "REVISION_CONFLICT"],
    [{ mode: "invalid" }, "INVALID_COMMAND"],
  ])
    assert.throws(() => f.command({ ...base, ...patch }), code(expected));
  const b = f.store.requireChat("b");
  assert.throws(
    () => f.command({ ...base, chatId: "b", expectedChatRevision: b.revision }),
    code("INVALID_COMMAND"),
  );
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.deletedRevision("message", "a", "m2"), 0);
});
test("queued and running same-chat jobs block destructive removal while another chat remains independent", (t) => {
  const f = fixture(t);
  f.store.enqueueJob("queued", {
    type: "button",
    chatId: "a",
    data: "Synthetic",
  });
  assert.throws(() => f.command(f.remove("m2")), code("CHAT_BUSY"));
  f.command({
    type: "append-message",
    chatId: "b",
    messageId: "other",
    message: { role: "char", data: "Synthetic other" },
  });
  const other = {
    ...f.remove("m2"),
    chatId: "b",
    messageId: "other",
    expectedRevision: 1,
    expectedChatRevision: f.store.requireChat("b").revision,
  };
  assert.equal(f.command(other).removedCount, 1);
  f.store.claimJob("owner", 30000, { includeSnapshot: false });
  assert.throws(() => f.command(f.remove("m2", "from")), code("CHAT_BUSY"));
  assert.equal(f.store.snapshot("a").messages.length, 5);
});
test("failure after recording range tombstones rolls back rows, guards, receipt and journal together", (t) => {
  const f = fixture(t),
    intent = f.remove("m1", "from"),
    before = f.store.snapshot("a"),
    original = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql.startsWith("DELETE FROM messages"))
      throw Error("Synthetic delete failure");
    return original(sql);
  };
  assert.throws(
    () => f.store.applyCommand("failed", intent),
    /Synthetic delete failure/,
  );
  f.store.db.prepare = original;
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM entity_tombstones WHERE kind='message'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM commands WHERE id='failed'")
      .get().n,
    0,
  );
  assert.equal(f.store.applyCommand("failed", intent).removedCount, 4);
});

function flag(f, id, disabled) {
  const target = f.remove(id);
  return {
    type: "set-message-disabled",
    chatId: target.chatId,
    messageId: target.messageId,
    expectedRevision: target.expectedRevision,
    expectedChatEpoch: target.expectedChatEpoch,
    disabled,
  };
}
test("flag writes read headers and publish a compact delta even for a large authored body", (t) => {
  const f = fixture(t),
    body = "Synthetic large flag body ".repeat(50000);
  f.command({
    type: "edit-message",
    messageId: "m2",
    expectedRevision: 1,
    text: body,
  });
  const cursor = f.store.cursor(),
    queries = [],
    prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  f.command(flag(f, "m2", true));
  f.store.db.prepare = prepare;
  assert.ok(
    queries
      .filter((sql) => sql.includes("FROM messages"))
      .every((sql) => !sql.includes("payload") && !sql.includes("SELECT *")),
  );
  const event = f.store.changes(cursor, 100).changes[0];
  assert.equal(event.type, "message-disabled");
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 500);
  assert.equal(event.payload.disabled, true);
  const message = f.store.snapshot("a").messages.find((m) => m.id === "m2");
  assert.equal(message.message.data, body);
  assert.deepEqual(message.message.unknown, { retained: true });
  assert.equal(message.message.disabled, true);
});
test("saved disabled/allBefore flags preserve history and metadata, survive reopen and deduplicate; different messages remain independent", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a", { limit: 1000 }),
    first = flag(f, "m2", true),
    other = flag(f, "m3", "allBefore");
  const result = f.store.applyCommand("flag", first);
  assert.equal(result.revision, 2);
  assert.deepEqual(f.store.applyCommand("flag", first), result);
  f.command(other);
  const snapshot = f.store.snapshot("a", { limit: 1000 });
  assert.equal(snapshot.cursor, before.cursor + 2);
  assert.deepEqual(snapshot.chat.metadata, before.chat.metadata);
  for (let i = 0; i < snapshot.messages.length; i++) {
    const row = snapshot.messages[i],
      original = before.messages[i];
    assert.deepEqual(
      {
        ...row,
        revision: original.revision,
        message: { ...row.message, disabled: undefined },
      },
      { ...original, message: { ...original.message, disabled: undefined } },
    );
  }
  assert.equal(snapshot.messages[2].message.disabled, true);
  assert.equal(snapshot.messages[3].message.disabled, "allBefore");
  const reopened = new EntityStore(f.file);
  try {
    assert.equal(reopened.snapshot("a").messages[2].message.disabled, true);
  } finally {
    reopened.close();
  }
  f.command(flag(f, "m2", "allBefore"));
  f.command(flag(f, "m2", false));
  assert.equal(f.store.snapshot("a").messages[2].message.disabled, false);
  assert.throws(() => f.command(first), code("REVISION_CONFLICT"));
});
test("flag ownership, revisions, epoch, invalid values and accepted same-chat work are fenced before any write", (t) => {
  const f = fixture(t),
    base = flag(f, "m2", true),
    before = f.store.snapshot("a");
  for (const [patch, expected] of [
    [{ expectedRevision: 0 }, "REVISION_CONFLICT"],
    [{ expectedChatEpoch: 1 }, "REVISION_CONFLICT"],
    [{ chatId: "b" }, "INVALID_COMMAND"],
    [{ disabled: "true" }, "INVALID_COMMAND"],
    [{ disabled: null }, "INVALID_COMMAND"],
    [{ disabled: {} }, "INVALID_COMMAND"],
  ])
    assert.throws(() => f.command({ ...base, ...patch }), code(expected));
  f.store.enqueueJob("queued-flags", {
    type: "button",
    chatId: "a",
    data: "Synthetic",
  });
  const cursor = f.store.cursor();
  assert.throws(() => f.command(base), code("CHAT_BUSY"));
  f.store.claimJob("owner", 30000, { includeSnapshot: false });
  assert.throws(
    () => f.command({ ...base, disabled: "allBefore" }),
    code("CHAT_BUSY"),
  );
  assert.deepEqual(f.store.snapshot("a").messages, before.messages);
  assert.equal(f.store.cursor(), cursor + 1);
  f.command({
    type: "append-message",
    chatId: "b",
    messageId: "other-flag",
    message: { role: "char", data: "Synthetic other" },
  });
  assert.equal(
    f.command({ ...base, chatId: "b", messageId: "other-flag" }).revision,
    2,
  );
});
test("flag failure after payload/chat updates rolls back receipt and journal, then the same request succeeds", (t) => {
  const f = fixture(t),
    intent = flag(f, "m2", true),
    before = f.store.snapshot("a"),
    event = f.store.event;
  f.store.event = function (type, ...args) {
    if (type === "message-disabled")
      throw Error("Synthetic flag journal failure");
    return event.call(this, type, ...args);
  };
  assert.throws(
    () => f.store.applyCommand("failed-flag", intent),
    /Synthetic flag journal failure/,
  );
  f.store.event = event;
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM commands WHERE id='failed-flag'")
      .get().n,
    0,
  );
  assert.equal(f.store.applyCommand("failed-flag", intent).revision, 2);
});
