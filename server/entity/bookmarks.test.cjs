"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
const code = (expected) => (error) => error.code === expected;
function fixture(t, count = 5) {
  const directory = mkdtempSync(join(tmpdir(), "risu-bookmark-")),
    file = join(directory, "synthetic.sqlite");
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
    chat: { chatId: "a", metadata: { name: "A", unknown: { retained: true } } },
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
  const intent = (messageId, action, name = "Synthetic bookmark") => {
    const h = store.readBookmark("a", messageId);
    return {
      type: "set-bookmark",
      chatId: "a",
      messageId,
      expectedRevision: h.revision,
      expectedChatEpoch: h.entityEpoch,
      expectedMessageRevision: h.messageRevision,
      action,
      ...(action === "remove" ? {} : { name }),
    };
  };
  const field = (key, value) => {
    const target = { scope: "chat", entityId: "a", key },
      before = store.readFields([target]).fields[0];
    return {
      ...target,
      value,
      expectedRevision: before.revision,
      expectedEpoch: before.entityEpoch,
    };
  };
  return { store, file, command, intent, field };
}
test("bookmark members merge independently, persist and deduplicate while same-member rename/removal/readd fences ABA", (t) => {
  const f = fixture(t),
    a = f.intent("m1", "add"),
    b = f.intent("m2", "add"),
    before = f.store.snapshot("a");
  const result = f.store.applyCommand("stable-add", a);
  f.command(b);
  assert.deepEqual(f.store.snapshot("a").chat.metadata.bookmarks, ["m1", "m2"]);
  assert.deepEqual(f.store.snapshot("a").messages, before.messages);
  assert.equal(
    f.store.snapshot("a").chat.contentRevision,
    before.chat.contentRevision,
  );
  assert.deepEqual(f.store.snapshot("a").chat.metadata.unknown, {
    retained: true,
  });
  const cursor = f.store.cursor();
  assert.deepEqual(f.store.applyCommand("stable-add", a), result);
  assert.equal(f.store.cursor(), cursor);
  assert.throws(
    () => f.store.applyCommand("stable-add", { ...a, name: "different" }),
    code("IDEMPOTENCY_CONFLICT"),
  );
  const rename = f.intent("m1", "rename", "Synthetic renamed");
  f.command(rename);
  assert.throws(() => f.command(rename), code("REVISION_CONFLICT"));
  const stale = f.intent("m1", "rename", "Synthetic stale ABA");
  f.command(f.intent("m1", "remove"));
  assert.equal(f.store.readBookmark("a", "m1").revision, 3);
  f.command(f.intent("m1", "add", "Synthetic renamed"));
  assert.throws(() => f.command(stale), code("REVISION_CONFLICT"));
  const reopened = new EntityStore(f.file);
  try {
    assert.deepEqual(reopened.applyCommand("stable-add", a), result);
    assert.equal(reopened.readBookmark("a", "m1").revision, 4);
    assert.equal(reopened.readBookmark("a", "m1").name, "Synthetic renamed");
  } finally {
    reopened.close();
  }
});
test("bookmark commands reject stale message/epoch, foreign ownership, invalid actions/names and accepted same-chat jobs atomically", (t) => {
  const f = fixture(t),
    base = f.intent("m1", "add"),
    before = f.store.cursor();
  for (const [patch, expected] of [
    [{ expectedMessageRevision: 0 }, "REVISION_CONFLICT"],
    [{ expectedChatEpoch: 1 }, "REVISION_CONFLICT"],
    [{ action: "toggle" }, "INVALID_COMMAND"],
    [{ name: {} }, "INVALID_COMMAND"],
    [{ chatId: "b" }, "INVALID_COMMAND"],
  ])
    assert.throws(() => f.command({ ...base, ...patch }), code(expected));
  assert.equal(f.store.cursor(), before);
  f.store.enqueueJob("job", { type: "button", chatId: "a" });
  assert.throws(() => f.command(base), code("CHAT_BUSY"));
  const claim = f.store.claimJob("synthetic-worker");
  assert.throws(() => f.command(base), code("CHAT_BUSY"));
  f.store.finishJob("job", "synthetic-worker", claim.job.fence, {
    state: "completed",
  });
  f.command({
    type: "edit-message",
    chatId: "a",
    messageId: "m1",
    expectedRevision: 1,
    text: "Synthetic edited",
  });
  assert.throws(() => f.command(base), code("REVISION_CONFLICT"));
  f.command(f.intent("m1", "add"));
});
test("ordinary fields and actual native whole/field write sets update the same bookmark member revisions", (t) => {
  const f = fixture(t);
  f.command(f.intent("m1", "add"));
  const captured = f.intent("m1", "rename", "Synthetic stale");
  f.command({
    type: "change-fields",
    edits: [f.field("bookmarkNames", { m1: "Synthetic field edit" })],
  });
  assert.equal(f.store.readBookmark("a", "m1").revision, 2);
  assert.throws(() => f.command(captured), code("REVISION_CONFLICT"));
  const native = (job, writes) => {
    f.store.enqueueJob(job, { type: "button", chatId: "a" });
    const claim = f.store.claimJob("native");
    return f.store.finishJob(job, "native", claim.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claim.snapshot.chat.revision,
        expectedContentRevision: claim.snapshot.chat.contentRevision,
        ...writes(claim.snapshot),
      },
    });
  };
  assert.equal(
    native("native-whole", (snapshot) => ({
      metadata: {
        ...snapshot.chat.metadata,
        bookmarks: ["m2"],
        bookmarkNames: { m2: "Synthetic native" },
      },
    })).job.state,
    "completed",
  );
  assert.equal(f.store.readBookmark("a", "m1").revision, 3);
  assert.equal(f.store.readBookmark("a", "m2").revision, 1);
  assert.equal(
    native("native-fields", () => ({
      metadataEpoch: 0,
      metadataFields: [
        {
          key: "bookmarkNames",
          expectedRevision: f.store.readFields([
            { scope: "chat", entityId: "a", key: "bookmarkNames" },
          ]).fields[0].revision,
          value: { m2: "Synthetic native field" },
        },
      ],
    })).job.state,
    "completed",
  );
  assert.equal(f.store.readBookmark("a", "m2").revision, 2);
});
test("bookmark journal failure rolls back metadata, member and field revisions, receipts and journal", (t) => {
  const f = fixture(t),
    intent = f.intent("m2", "add"),
    before = f.store.snapshot("a"),
    header = f.store.readBookmark("a", "m2"),
    event = f.store.event;
  f.store.event = function (type, ...args) {
    if (type === "bookmark") throw Error("Synthetic journal failure");
    return event.call(this, type, ...args);
  };
  assert.throws(
    () => f.store.applyCommand("retry", intent),
    /Synthetic journal failure/,
  );
  f.store.event = event;
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.deepEqual(f.store.readBookmark("a", "m2"), header);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS count FROM commands WHERE id='retry'")
      .get().count,
    0,
  );
  f.store.applyCommand("retry", intent);
  assert.equal(f.store.readBookmark("a", "m2").revision, 1);
});
test("schema13 bookmark migration is lossless and does not publish changes or rewrite portable metadata", (t) => {
  const f = fixture(t);
  f.command({
    type: "change-fields",
    edits: [
      f.field("bookmarks", ["m2", "missing", "m1", "m2", 123]),
      f.field("bookmarkNames", {
        m2: "Synthetic",
        missing: null,
        orphan: { unknown: true },
      }),
    ],
  });
  const before = f.store.snapshot("a"),
    raw = f.store.requireChat("a").metadata;
  f.store.db.exec("DROP TABLE chat_bookmarks; PRAGMA user_version=13;");
  const migrated = new EntityStore(f.file);
  try {
    assert.equal(migrated.schemaVersion(), 22);
    assert.deepEqual(migrated.snapshot("a"), before);
    assert.equal(migrated.requireChat("a").metadata, raw);
    assert.equal(migrated.readBookmark("a", "m2").occurrences, 2);
    assert.deepEqual(migrated.readBookmark("a", "orphan").name, {
      unknown: true,
    });
    assert.equal(migrated.listBookmarks("a").count, 2);
  } finally {
    migrated.close();
  }
});
test("bounded bookmark pages find messages outside loaded history, preserve order/ordinals and reject changed or malformed tokens", (t) => {
  const f = fixture(t, 220),
    ids = Array.from({ length: 80 }, (_, i) => "m" + i * 2);
  f.command({
    type: "change-fields",
    edits: [
      f.field("bookmarks", ids),
      f.field("bookmarkNames", { m0: "Synthetic early" }),
    ],
  });
  const before = f.store.snapshot("a"),
    first = f.store.listBookmarks("a", { limit: 50 });
  assert.ok(before.messages.every((m) => m.id !== "m0"));
  assert.equal(first.items.length, 50);
  assert.equal(first.count, 80);
  assert.equal(first.historyCount, 220);
  assert.deepEqual(
    first.items.map((m) => m.messageId),
    ids.slice(0, 50),
  );
  assert.equal(first.items[0].ordinal, 0);
  assert.equal(first.items[49].ordinal, 98);
  assert.deepEqual(
    f.store
      .listBookmarks("a", { limit: 50, after: first.next })
      .items.map((m) => m.messageId),
    ids.slice(50),
  );
  f.command(f.intent("m0", "rename", "Synthetic new name"));
  assert.throws(
    () => f.store.listBookmarks("a", { after: first.next }),
    code("PAGE_CHANGED"),
  );
  for (const after of [
    "!",
    Buffer.from("null").toString("base64url"),
    Buffer.from("{}").toString("base64url"),
  ])
    assert.throws(
      () => f.store.listBookmarks("a", { after }),
      code("INVALID_COMMAND"),
    );
  const next = f.store.listBookmarks("a", { limit: 50 }).next;
  f.command({
    type: "edit-message",
    chatId: "a",
    messageId: "m219",
    expectedRevision: 1,
    text: "Synthetic unrelated edit",
  });
  assert.throws(
    () => f.store.listBookmarks("a", { after: next }),
    code("PAGE_CHANGED"),
  );
  assert.equal(f.store.listBookmarks("a", { limit: 1000 }).items.length, 80);
});
test("bookmark updates publish compact deltas without message bodies and retain original duplicate/unknown/orphan metadata semantics", (t) => {
  const f = fixture(t),
    bulk = "Synthetic large unrelated marker ".repeat(40000);
  f.command({
    type: "edit-message",
    chatId: "a",
    messageId: "m2",
    expectedRevision: 1,
    text: bulk,
  });
  f.command({
    type: "change-fields",
    edits: [
      f.field("bookmarks", ["m2", "m1", "m2", "m3", "m2"]),
      f.field("bookmarkNames", { m2: "Synthetic", orphan: { kept: true } }),
    ],
  });
  const cursor = f.store.cursor(),
    original = f.store.db.prepare.bind(f.store.db),
    reads = [];
  f.store.db.prepare = (sql) => {
    if (sql.includes("FROM messages")) reads.push(sql);
    return original(sql);
  };
  f.command(f.intent("m2", "remove"));
  f.store.db.prepare = original;
  assert.ok(
    reads.every((sql) => !sql.includes("payload") && !sql.includes("SELECT *")),
  );
  const changes = f.store.changes(cursor).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "bookmark");
  assert.ok(JSON.stringify(changes).length < 800);
  assert.deepEqual(changes[0].payload.positions, [1, 3]);
  assert.deepEqual(f.store.snapshot("a").chat.metadata.bookmarks, [
    "m1",
    "m2",
    "m3",
    "m2",
  ]);
  assert.deepEqual(f.store.snapshot("a").chat.metadata.bookmarkNames, {
    orphan: { kept: true },
  });
  assert.equal(
    f.store.snapshot("a").messages.find((m) => m.id === "m2").message.data,
    bulk,
  );
});

test("chat deletion/recreation fences old bookmark intent and full clone remaps only known references", (t) => {
  const f = fixture(t);
  f.command(f.intent("m1", "add", "Synthetic original"));
  f.command({
    type: "change-fields",
    edits: [
      f.field("bookmarkNames", {
        m1: "Synthetic original",
        orphan: { retained: true },
      }),
      f.field("unknownReference", "m1"),
    ],
  });
  const source = f.store.snapshot("a");
  f.command({
    type: "clone-chat",
    sourceChatId: "a",
    chatId: "copy",
    name: "Synthetic copy",
    expectedRevision: source.chat.revision,
    expectedEpoch: source.chat.entityEpoch,
  });
  const copy = f.store.snapshot("copy"),
    id = copy.messages[1].id;
  assert.notEqual(id, "m1");
  assert.deepEqual(copy.chat.metadata.bookmarks, [id]);
  assert.deepEqual(copy.chat.metadata.bookmarkNames, {
    [id]: "Synthetic original",
    orphan: { retained: true },
  });
  assert.equal(copy.chat.metadata.unknownReference, "m1");
  assert.equal(f.store.readBookmark("copy", id).present, true);
  assert.equal(f.store.readBookmark("copy", id).messageRevision, 1);
  f.command({
    type: "delete-chat",
    chatId: "a",
    expectedRevision: source.chat.revision,
    expectedEpoch: source.chat.entityEpoch,
  });
  f.command({
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "Synthetic recreation" },
  });
  assert.throws(
    () =>
      f.command({
        type: "set-bookmark",
        chatId: "a",
        messageId: "m1",
        expectedRevision: 0,
        expectedChatEpoch: 0,
        expectedMessageRevision: null,
        action: "add",
        name: "Synthetic stale",
      }),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.listBookmarks("a").count, 0);
});
test("bookmark names safely retain prototype-like saved IDs and foreign/dangling portable references remain untouched", (t) => {
  const f = fixture(t);
  f.command({
    type: "append-message",
    chatId: "a",
    messageId: "__proto__",
    message: { role: "char", data: "Synthetic safe key" },
  });
  f.command(f.intent("__proto__", "add", "Synthetic own property"));
  assert.equal(
    f.store.readBookmark("a", "__proto__").name,
    "Synthetic own property",
  );
  assert.ok(
    Object.hasOwn(
      f.store.snapshot("a").chat.metadata.bookmarkNames,
      "__proto__",
    ),
  );
  f.command({
    type: "append-message",
    chatId: "b",
    messageId: "foreign",
    message: { role: "char", data: "Synthetic other chat" },
  });
  f.command({
    type: "change-fields",
    edits: [f.field("bookmarks", ["foreign", "missing", "__proto__"])],
  });
  assert.deepEqual(f.store.snapshot("a").chat.metadata.bookmarks, [
    "foreign",
    "missing",
    "__proto__",
  ]);
  assert.deepEqual(
    f.store.listBookmarks("a").items.map((row) => row.messageId),
    ["__proto__"],
  );
  assert.throws(
    () => f.store.readBookmark("a", "foreign"),
    code("INVALID_COMMAND"),
  );
});

test("observed bookmark headers fence pre-read same-value ABA, isolate other members and reject expired/future history", (t) => {
  const f = fixture(t);
  f.command(f.intent("m1", "add", "Same synthetic name"));
  const before = f.store.readBookmark("a", "m1"),
    options = { observedCursor: before.cursor };
  assert.equal(
    f.store.readBookmark("a", "m1", options).changedAfterObservedCursor,
    false,
  );
  f.command(f.intent("m2", "add"));
  assert.equal(
    f.store.readBookmark("a", "m1", options).changedAfterObservedCursor,
    false,
  );
  f.command(f.intent("m1", "remove"));
  f.command(f.intent("m1", "add", "Same synthetic name"));
  const after = f.store.readBookmark("a", "m1", options);
  assert.equal(after.present, before.present);
  assert.equal(after.name, before.name);
  assert.equal(after.messageRevision, before.messageRevision);
  assert.equal(after.revision, before.revision + 2);
  assert.equal(after.changedAfterObservedCursor, true);
  assert.equal(
    f.store.readBookmark("a", "m1", { observedCursor: after.cursor })
      .changedAfterObservedCursor,
    false,
  );
  for (const observedCursor of [-1, 0.5, "0"])
    assert.throws(
      () => f.store.readBookmark("a", "m1", { observedCursor }),
      code("INVALID_COMMAND"),
    );
  assert.throws(
    () => f.store.readBookmark("a", "m1", { observedCursor: after.cursor + 1 }),
    code("RESYNC_REQUIRED"),
  );
  f.store.pruneChanges(after.cursor);
  assert.throws(
    () => f.store.readBookmark("a", "m1", options),
    code("RESYNC_REQUIRED"),
  );
  assert.equal(
    f.store.readBookmark("a", "m1", { observedCursor: after.cursor })
      .changedAfterObservedCursor,
    false,
  );
});
