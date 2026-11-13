"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");

function fixture(t, file = ":memory:") {
  const f = { store: new EntityStore(file), n: 0 };
  t.after(() => f.store.close());
  f.command = (command) =>
    f.store.applyCommand("synthetic-navigation-" + ++f.n, command);
  f.command({
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      chatFolders: [
        {
          id: "f1",
          name: "Synthetic one",
          folded: false,
          unknown: { preserve: true },
        },
        { id: "f2", name: "Synthetic two", folded: false },
      ],
    },
  });
  for (const chatId of ["a", "b", "c-chat"])
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: {
        name: chatId,
        folderId: "f1",
        note: "Synthetic note",
        unknown: { preserve: chatId },
      },
      messages: [
        {
          id: "synthetic-" + chatId,
          message: { role: "char", data: "Synthetic message" },
        },
      ],
    });
  f.header = () => {
    const value = f.store.getCharacter("c");
    return {
      characterId: "c",
      expectedCharacterEpoch: value.entityEpoch,
      expectedFolderRevision: value.fieldRevisions.chatFolders,
      expectedNavigationRevision: value.navigationRevision,
    };
  };
  f.reorder = (extra = {}) => ({
    type: "reorder-chat-navigation",
    ...f.header(),
    chatIds: ["c-chat", "a", "b"],
    folderIds: ["f2", "f1"],
    memberships: [],
    ...extra,
  });
  f.member = (chatId, folderId) => {
    const target = { scope: "chat", entityId: chatId, key: "folderId" },
      value = f.store.readFields([target]).fields[0];
    return {
      chatId,
      folderId,
      expectedRevision: value.revision,
      expectedEpoch: value.entityEpoch,
    };
  };
  f.set = (chatId, value) => {
    const member = f.member(chatId, value);
    return f.command({
      type: "change-fields",
      edits: [
        {
          scope: "chat",
          entityId: chatId,
          key: "folderId",
          expectedRevision: member.expectedRevision,
          expectedEpoch: member.expectedEpoch,
          value,
        },
      ],
    });
  };
  return f;
}

test("navigation order and membership commit atomically without changing message revisions or losing folder extension fields", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a"),
    cursor = f.store.cursor();
  const result = f.command(f.reorder({ memberships: [f.member("b", "f2")] }));
  assert.equal(result.navigationRevision, 4);
  assert.equal(result.changedMemberships, 1);
  assert.deepEqual(
    f.store.listChats("c").map((row) => row.id),
    ["c-chat", "a", "b"],
  );
  assert.deepEqual(
    f.store.getCharacter("c").definition.chatFolders.map((row) => row.id),
    ["f2", "f1"],
  );
  assert.deepEqual(
    f.store.getCharacter("c").definition.chatFolders[1].unknown,
    { preserve: true },
  );
  assert.deepEqual(f.store.snapshot("a").chat, before.chat);
  assert.deepEqual(f.store.snapshot("a").messages, before.messages);
  assert.equal(f.store.snapshot("b").chat.metadata.folderId, "f2");
  const changes = f.store.changes(cursor).changes;
  const order = changes.find((row) => row.type === "chat-order");
  assert.deepEqual(order.payload.order, [
    { id: "c-chat", position: 0, epoch: 0 },
    { id: "a", position: 1, epoch: 0 },
    { id: "b", position: 2, epoch: 0 },
  ]);
  assert.ok(!JSON.stringify(changes).includes("Synthetic note"));
  assert.ok(!JSON.stringify(changes).includes("Synthetic message"));
});

test("malformed permutations, cross-character members and missing folders roll back every change", (t) => {
  const f = fixture(t);
  f.command({
    type: "create-character",
    characterId: "other",
    definition: { name: "Synthetic other" },
    chat: { chatId: "foreign", metadata: { name: "Synthetic foreign" } },
  });
  const before = f.store.getCharacter("c"),
    cursor = f.store.cursor();
  for (const extra of [
    { chatIds: ["a", "a", "b"] },
    { chatIds: ["a", "b"] },
    { chatIds: ["a", "b", "foreign"] },
    { folderIds: ["f1", "f1"] },
    { folderIds: ["f1", "missing"] },
    { memberships: [f.member("a", "f2"), f.member("a", "f1")] },
    {
      memberships: [
        {
          chatId: "foreign",
          folderId: "f1",
          expectedRevision: 0,
          expectedEpoch: 0,
        },
      ],
    },
    { memberships: [f.member("a", "missing")] },
  ]) {
    assert.throws(() => f.command(f.reorder(extra)), {
      code: "INVALID_COMMAND",
    });
    assert.equal(f.store.cursor(), cursor);
    assert.deepEqual(f.store.getCharacter("c"), before);
  }
  assert.throws(
    () =>
      f.command(
        f.reorder({
          memberships: [
            f.member("a", "f2"),
            { ...f.member("b", "f2"), expectedRevision: 0 },
          ],
        }),
      ),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.store.snapshot("a").chat.metadata.folderId, "f1");
  assert.equal(f.store.cursor(), cursor);
});

test("navigation guards reject stale order and collection incarnation while ordinary message edits remain independent", (t) => {
  const f = fixture(t),
    stale = f.reorder({ folderIds: ["f1", "f2"] });
  f.command({
    type: "edit-message",
    chatId: "a",
    messageId: "synthetic-a",
    expectedRevision: 1,
    text: "Synthetic changed body",
  });
  f.command(stale);
  assert.throws(() => f.command({ ...stale, chatIds: ["a", "b", "c-chat"] }), {
    code: "REVISION_CONFLICT",
  });
  const beforeCreation = f.reorder();
  f.command({
    type: "create-chat",
    characterId: "c",
    chatId: "new",
    metadata: { name: "Synthetic new" },
  });
  assert.throws(() => f.command(beforeCreation), { code: "REVISION_CONFLICT" });
  const old = f.header(),
    b = f.store.requireChat("b");
  f.command({
    type: "delete-chat",
    chatId: "b",
    expectedRevision: b.revision,
    expectedEpoch: 0,
  });
  f.command({
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "Synthetic recreated" },
  });
  assert.throws(
    () =>
      f.command({
        ...f.reorder(),
        ...old,
        chatIds: ["a", "b", "c-chat", "new"],
      }),
    { code: "REVISION_CONFLICT" },
  );
});

test("folder deletion clears more than128 canonical members, preserves peer movement, unrelated metadata and orphan references", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 131; index++)
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "unopened-" + index,
      metadata: {
        name: "Synthetic unopened",
        folderId: "f1",
        note: "Synthetic large metadata".repeat(128),
        unknown: { index },
      },
      messages: [
        {
          id: "synthetic-unopened-" + index,
          message: { role: "char", data: "Synthetic retained body" },
        },
      ],
    });
  f.command({
    type: "create-chat",
    characterId: "c",
    chatId: "orphan",
    metadata: { name: "Synthetic orphan", folderId: "unknown-folder" },
  });
  const captured = {
    type: "remove-chat-folder",
    ...f.header(),
    folderId: "f1",
  };
  f.set("unopened-0", "f2");
  const before = f.store.snapshot("unopened-1"),
    navigation = f.store.chatNavigationRevision("c");
  const result = f.command(captured);
  assert.equal(result.clearedMembers, 133);
  assert.equal(f.store.snapshot("unopened-0").chat.metadata.folderId, "f2");
  assert.equal(f.store.snapshot("unopened-1").chat.metadata.folderId, null);
  assert.equal(
    f.store.snapshot("unopened-1").chat.metadata.note,
    before.chat.metadata.note,
  );
  assert.deepEqual(f.store.snapshot("unopened-1").chat.metadata.unknown, {
    index: 1,
  });
  assert.deepEqual(f.store.snapshot("unopened-1").messages, before.messages);
  assert.equal(
    f.store.snapshot("orphan").chat.metadata.folderId,
    "unknown-folder",
  );
  assert.deepEqual(
    f.store.getCharacter("c").definition.chatFolders.map((row) => row.id),
    ["f2"],
  );
  assert.equal(f.store.chatNavigationRevision("c"), navigation);
  assert.ok(JSON.stringify(result).length < 220);
});

test("captured folder deletion conflicts with newer folder edits and character deletion/recreation", (t) => {
  const f = fixture(t),
    captured = { type: "remove-chat-folder", ...f.header(), folderId: "f1" };
  const folders = f.store.getCharacter("c").definition.chatFolders;
  f.command({
    type: "change-fields",
    edits: [
      {
        scope: "character",
        entityId: "c",
        key: "chatFolders",
        expectedRevision: captured.expectedFolderRevision,
        expectedEpoch: captured.expectedCharacterEpoch,
        value: folders.map((item) =>
          item.id === "f1" ? { ...item, name: "Synthetic peer rename" } : item,
        ),
      },
    ],
  });
  const cursor = f.store.cursor();
  assert.throws(() => f.command(captured), { code: "REVISION_CONFLICT" });
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").chat.metadata.folderId, "f1");
  const owner = f.store.getCharacter("c");
  f.command({
    type: "delete-character",
    characterId: "c",
    expectedRevision: owner.revision,
    expectedEpoch: owner.entityEpoch,
  });
  f.command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic reincarnation", chatFolders: folders },
  });
  assert.throws(
    () =>
      f.command({
        ...captured,
        expectedFolderRevision: f.header().expectedFolderRevision,
      }),
    { code: "REVISION_CONFLICT" },
  );
});

test("navigation request replay is exactly once and rejects different payloads under the same ID", (t) => {
  const f = fixture(t),
    command = f.reorder();
  const first = f.store.applyCommand("synthetic-durable-navigation", command),
    cursor = f.store.cursor();
  assert.deepEqual(
    f.store.applyCommand("synthetic-durable-navigation", command),
    first,
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.chatNavigationRevision("c"), first.navigationRevision);
  assert.throws(
    () =>
      f.store.applyCommand("synthetic-durable-navigation", {
        ...command,
        chatIds: ["b", "a", "c-chat"],
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("navigation counters survive journal pruning and reopen with schema15, bodies and identity intact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-navigation-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic.sqlite"),
    f = fixture(t, file);
  f.command(f.reorder());
  const identity = f.store.bootstrap().serverId,
    snapshot = f.store.snapshot("a"),
    revision = f.store.chatNavigationRevision("c");
  f.store.pruneChanges(f.store.cursor());
  f.store.close();
  f.store = new EntityStore(file);
  assert.equal(f.store.schemaVersion(), 22);
  assert.equal(f.store.bootstrap().serverId, identity);
  assert.equal(f.store.chatNavigationRevision("c"), revision);
  assert.deepEqual(f.store.snapshot("a"), snapshot);
  assert.equal(f.store.getCharacter("c").navigationRevision, revision);
});
