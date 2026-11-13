"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");

function fixture(t, folders = true) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  const command = (value) =>
    store.applyCommand("synthetic-branch-" + ++next, value);
  store.initializeState({
    settings: { createFolderOnBranch: folders },
    resources: [],
  });
  command({
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      chatFolders: null,
      unknown: { retained: true },
    },
    chat: {
      chatId: "a",
      metadata: {
        name: "Synthetic :: A (Copy 2)",
        unknown: { id: "m0" },
        GLGlobalVariables: { local: false },
      },
    },
  });
  command({
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "B" },
  });
  store.transaction(() => {
    for (let i = 0; i < 220; i++)
      store.appendMessage("a", "m" + i, {
        role: i % 2 ? "user" : "char",
        data: "Synthetic " + i,
        unknown: { i },
        ...(i === 10
          ? {
              multimodals: [{ type: "image", data: "assets/synthetic.png" }],
              disabled: "allBefore",
            }
          : {}),
      });
  });
  for (const messageId of ["m3", "m5"])
    command({
      type: "remove-message",
      chatId: "a",
      messageId,
      mode: "one",
      expectedRevision: 1,
      expectedChatRevision: store.requireChat("a").revision,
      expectedChatEpoch: 0,
    });
  command({
    type: "set-chat-variable",
    chatId: "a",
    key: "$state",
    value: "Synthetic current state",
  });
  function fields(scope, entityId, values, resourceKind) {
    const read = store.readFields(
      Object.keys(values).map((key) => ({
        scope,
        entityId,
        key,
        ...(resourceKind ? { resourceKind } : {}),
      })),
    ).fields;
    return command({
      type: "change-fields",
      edits: read.map((field) => ({
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: values[field.key],
      })),
    });
  }
  function branch(chatId = "copy", messageId = "m124") {
    const setting = store.readFields([
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "createFolderOnBranch",
      },
    ]).fields[0];
    return {
      type: "branch-chat",
      sourceChatId: "a",
      chatId,
      messageId,
      expectedRevision: 1,
      expectedChatRevision: store.requireChat("a").revision,
      expectedChatEpoch: store.fieldEpoch({ scope: "chat", entityId: "a" }),
      expectedCharacterEpoch: store.fieldEpoch({
        scope: "character",
        entityId: "c",
      }),
      expectedSettingRevision: setting.revision,
      expectedSettingEpoch: setting.entityEpoch,
      expectedFolderRevision:
        store.fieldRevisions({ scope: "character", entityId: "c" })
          .chatFolders ?? 0,
    };
  }
  return { store, command, fields, branch };
}

test("branch copies the canonical prefix across deleted gaps, creates a shared folder atomically and retries once without body events", (t) => {
  const { store, branch } = fixture(t);
  const source = store.snapshot("a", { limit: 1000 }),
    cursor = store.cursor();
  assert.equal(store.snapshot("a", { limit: 2 }).messages.length, 2);
  const input = branch(),
    result = store.applyCommand("once", input);
  const copy = store.snapshot("copy", { limit: 1000 });
  assert.deepEqual(store.applyCommand("once", input), result);
  assert.equal(copy.messages.length, 124);
  assert.deepEqual(
    copy.messages.slice(0, -1).map((m) => m.message.data),
    source.messages.filter((m) => m.position <= 124).map((m) => m.message.data),
  );
  assert.ok(
    copy.messages.every(
      (m) =>
        !source.messages.some((s) => s.id === m.id) &&
        m.id === m.message.chatId,
    ),
  );
  assert.deepEqual(copy.messages[8].message.multimodals, [
    { type: "image", data: "assets/synthetic.png" },
  ]);
  assert.equal(copy.messages[8].message.disabled, "allBefore");
  assert.deepEqual(copy.messages[8].message.unknown, { i: 10 });
  assert.deepEqual(copy.chat.metadata.unknown, { id: "m0" });
  assert.equal(copy.variables[0].value, "Synthetic current state");
  assert.deepEqual(copy.chat.metadata.GLGlobalVariables, { local: false });
  assert.equal(copy.chat.metadata.name, "Synthetic :: A (Branch)");
  assert.equal(
    copy.chat.metadata.folderId,
    store.snapshot("a").chat.metadata.folderId,
  );
  const folder = store.getCharacter("c").definition.chatFolders;
  assert.deepEqual(folder, [
    {
      id: result.folderId,
      name: "Branches of Synthetic :: A (Copy 2)",
      folded: false,
    },
  ]);
  const comment = copy.messages.at(-1).message;
  assert.equal(comment.disabled, true);
  assert.equal(comment.isComment, true);
  assert.deepEqual(comment.branchOrigin, {
    characterId: "c",
    chatId: "a",
    messageId: "m124",
    name: "Synthetic :: A (Copy 2)",
  });
  assert.equal(result.boundaryMessageId, copy.messages.at(-2).id);
  const events = store.changes(cursor, 1000).changes;
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["fields", "fields", "chat"],
  );
  assert.ok(events.every((e) => !e.payload.message));
  assert.equal(events.at(-1).payload.historyCount, 124);
  assert.equal(store.listChats("c")[0].id, "copy");
  assert.equal(store.listBookmarks("copy", { limit: 100 }).items.length, 0);
  assert.deepEqual(
    store.snapshot("a", { limit: 1000 }).messages,
    source.messages,
  );
});

test("branch remaps known kept anchors and removes future bookmark/memory anchors without guessing unknown content", (t) => {
  const { store, fields, branch } = fixture(t, false);
  fields("chat", "a", {
    bookmarks: ["m0", "m124", "m219", "orphan", "m0"],
    bookmarkNames: { m0: "m219", m219: "Future", orphan: "Kept" },
    lastMemory: "m219",
    supaMemoryData: "m219\nSynthetic future summary",
    hypaV2Data: {
      mainChunks: [
        {
          id: 1,
          chatMemos: ["m0", "m124"],
          lastChatMemo: "m124",
          text: "m219",
        },
        {
          id: 2,
          chatMemos: ["m0", "m219"],
          lastChatMemo: "m219",
          text: "Synthetic future",
        },
        { id: 3, chatMemos: ["orphan"], text: "Synthetic orphan" },
      ],
      chunks: [
        { mainChunkID: 1, text: "m219" },
        { mainChunkID: 2, text: "Synthetic future split" },
      ],
      lastMainChunkID: 2,
      unknown: 1,
    },
    hypaV3Data: {
      summaries: [
        { chatMemos: ["m0", null], text: "m219" },
        { chatMemos: ["m219"], text: "Synthetic future" },
      ],
      categories: [{ name: "m219" }],
    },
  });
  const before = store.snapshot("a", { limit: 1000 });
  store.applyCommand("references", branch());
  const copy = store.snapshot("copy", { limit: 1000 }),
    m = copy.chat.metadata,
    first = copy.messages[0].id,
    last = copy.messages.at(-2).id;
  assert.deepEqual(m.bookmarks, [first, last, "orphan", first]);
  assert.deepEqual(m.bookmarkNames, { [first]: "m219", orphan: "Kept" });
  assert.ok(!Object.hasOwn(m, "lastMemory"));
  assert.ok(!Object.hasOwn(m, "supaMemoryData"));
  assert.deepEqual(m.hypaV2Data.mainChunks, [
    { id: 1, chatMemos: [first, last], lastChatMemo: last, text: "m219" },
    { id: 3, chatMemos: ["orphan"], text: "Synthetic orphan" },
  ]);
  assert.deepEqual(m.hypaV2Data.chunks, [{ mainChunkID: 1, text: "m219" }]);
  assert.equal(m.hypaV2Data.lastMainChunkID, 3);
  assert.equal(m.hypaV2Data.unknown, 1);
  assert.deepEqual(m.hypaV3Data, {
    summaries: [{ chatMemos: [first, null], text: "m219" }],
    categories: [{ name: "m219" }],
  });
  assert.equal(store.listBookmarks("copy", { limit: 100 }).count, 2);
  assert.deepEqual(
    store.snapshot("a", { limit: 1000 }).chat.metadata,
    before.chat.metadata,
  );
});

test("branch retains eligible Supa and legacy Hypa anchor semantics and malformed original data", (t) => {
  const { store, fields, branch } = fixture(t, false);
  const values = [
    "m124\nSynthetic text m219",
    "hypa:\n" +
      JSON.stringify([
        { id: "m0", supa: "m219", hypa: [] },
        { id: "m219", supa: "Future" },
        { id: "orphan", unknown: "m219" },
      ]),
    "hypa:\nmalformed synthetic",
    "hypa:\n{}",
  ];
  for (const [i, value] of values.entries()) {
    fields("chat", "a", { supaMemoryData: value, lastMemory: "m124" });
    store.applyCommand("memory-" + i, branch("copy-" + i));
    const copy = store.snapshot("copy-" + i, { limit: 1000 }),
      m = copy.chat.metadata;
    assert.equal(m.lastMemory, copy.messages.at(-2).id);
    if (i === 0)
      assert.equal(
        m.supaMemoryData,
        copy.messages.at(-2).id + "\nSynthetic text m219",
      );
    else if (i === 1)
      assert.deepEqual(JSON.parse(m.supaMemoryData.slice(6)), [
        { id: copy.messages[0].id, supa: "m219", hypa: [] },
        { id: "orphan", unknown: "m219" },
      ]);
    else assert.equal(m.supaMemoryData, value);
  }
});

test("branch uses canonical unique names and existing folders without replacing concurrent collection values", (t) => {
  const { store, fields, branch } = fixture(t);
  const old = branch("stale-folder");
  fields("character", "c", {
    chatFolders: [{ id: "existing", name: "Synthetic peer", folded: true }],
  });
  const cursor = store.cursor();
  assert.throws(
    () => store.applyCommand("stale-folder", old),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.equal(store.cursor(), cursor);
  store.applyCommand("first", branch("first"));
  store.applyCommand("second", branch("second"));
  assert.equal(store.requireChat("first").name, "Synthetic :: A (Branch)");
  assert.equal(store.requireChat("second").name, "Synthetic :: A (Branch 2)");
  assert.equal(
    store.snapshot("first").chat.metadata.folderId,
    store.snapshot("second").chat.metadata.folderId,
  );
  assert.equal(store.getCharacter("c").definition.chatFolders.length, 2);
  assert.equal(
    store.getCharacter("c").definition.chatFolders[1].id,
    "existing",
  );
});

test("stale setting/boundary/epoch, wrong-chat message and accepted jobs cannot create a branch", (t) => {
  const { store, command, fields, branch } = fixture(t);
  const old = branch();
  fields("resource", "global", { createFolderOnBranch: false }, "settings");
  assert.throws(
    () => store.applyCommand("setting-stale", old),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () =>
      store.applyCommand("boundary-stale", {
        ...branch(),
        expectedRevision: 0,
      }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () =>
      store.applyCommand("epoch-stale", { ...branch(), expectedChatEpoch: 1 }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  command({
    type: "append-message",
    chatId: "b",
    messageId: "other",
    message: { role: "char", data: "Synthetic other" },
  });
  assert.throws(
    () => store.applyCommand("wrong-chat", branch("copy", "other")),
    (e) => e.code === "NOT_FOUND",
  );
  store.enqueueJob("accepted", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "new-user",
  });
  assert.throws(
    () => store.applyCommand("busy", branch()),
    (e) => e.code === "CHAT_BUSY",
  );
  assert.equal(store.listChats("c").length, 2);
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM commands WHERE id IN ('setting-stale','boundary-stale','epoch-stale','wrong-chat','busy')",
      )
      .get().n,
    0,
  );
});

test("late copy failure rolls back folder assignment, messages, variables, bookmark ledger, events and receipt", (t) => {
  const { store, branch } = fixture(t);
  const cursor = store.cursor(),
    revision = store.requireChat("a").revision;
  store.db.exec(
    "CREATE TEMP TRIGGER synthetic_failure BEFORE INSERT ON messages WHEN NEW.chat_id='broken' BEGIN SELECT RAISE(ABORT,'Synthetic copy failure'); END;",
  );
  assert.throws(
    () => store.applyCommand("atomic-broken", branch("broken")),
    /Synthetic copy failure/,
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.requireChat("a").revision, revision);
  assert.equal(store.snapshot("a").chat.metadata.folderId, undefined);
  assert.equal(store.getCharacter("c").definition.chatFolders, null);
  assert.equal(store.listChats("c").length, 2);
  for (const table of [
    "chats",
    "messages",
    "chat_variables",
    "chat_global_variables",
    "chat_bookmarks",
    "entity_field_revisions",
  ]) {
    const key =
      table === "chats"
        ? "id"
        : table === "entity_field_revisions"
          ? "entity_id"
          : "chat_id";
    assert.equal(
      store.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key}='broken'`)
        .get().n,
      0,
    );
  }
  assert.equal(
    store.db.prepare("SELECT id FROM commands WHERE id='atomic-broken'").get(),
    undefined,
  );
  store.db.exec("DROP TRIGGER synthetic_failure");
  assert.equal(
    store.applyCommand("atomic-broken", branch("broken")).historyCount,
    124,
  );
});

test("large canonical prefix remains one body-free creation event and ordinary snapshots remain bounded", (t) => {
  const { store, branch } = fixture(t, false);
  store.transaction(() => {
    for (let i = 220; i < 3200; i++)
      store.appendMessage("a", "m" + i, {
        role: "char",
        data: "Synthetic body " + i + "x".repeat(512),
      });
  });
  const cursor = store.cursor(),
    result = store.applyCommand("large", branch("large", "m3000"));
  assert.equal(result.historyCount, 3000);
  assert.equal(store.snapshot("large", { limit: 100 }).messages.length, 100);
  const events = store.changes(cursor, 1000).changes;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "chat");
  assert.ok(JSON.stringify(events).length < 3000);
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM messages WHERE chat_id='large'")
      .get().n,
    3000,
  );
});
