"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");

function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  const command = (value) => store.applyCommand("synthetic-" + ++next, value);
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", unknown: { retained: true } },
    chat: {
      chatId: "a",
      metadata: {
        name: "A",
        unknown: { retained: true },
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
  const remove = (chatId) => ({
    type: "delete-chat",
    chatId,
    expectedRevision: store.requireChat(chatId).revision,
    expectedEpoch: store.fieldEpoch({ scope: "chat", entityId: chatId }),
  });
  const removeCharacter = () => ({
    type: "delete-character",
    characterId: "c",
    expectedRevision: store.getCharacter("c").revision,
    expectedEpoch: store.fieldEpoch({ scope: "character", entityId: "c" }),
  });
  return { store, command, remove, removeCharacter };
}

test("initial settings/resources commit once without overwriting configured or intentionally deleted settings", (t) => {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  const state = {
    settings: { username: "Synthetic initial", presetIds: ["default"] },
    resources: [
      {
        kind: "preset",
        id: "default",
        payload: { id: "default", name: "Synthetic preset" },
      },
    ],
  };
  assert.equal(store.initializeState(state).initialized, true);
  const cursor = store.cursor();
  assert.equal(
    store.initializeState({
      ...state,
      settings: { username: "Synthetic replacement" },
    }).initialized,
    false,
  );
  assert.equal(
    store.getResource("settings", "global").payload.username,
    "Synthetic initial",
  );
  assert.equal(store.cursor(), cursor);
  store.transaction(() => {
    store.rememberDeletion("resource", "settings", "global", 2);
    store.db
      .prepare("DELETE FROM resources WHERE kind='settings' AND id='global'")
      .run();
  });
  assert.equal(store.initializeState(state).initialized, false);
  assert.equal(store.getResource("settings", "global"), null);
});

test("initial character/chat creation is one durable transaction and invalid initial data leaves no character or receipt", (t) => {
  const { store } = fixture(t),
    cursor = store.cursor();
  const invalid = {
    type: "create-character",
    characterId: "new",
    definition: { name: "Synthetic new" },
    chat: { chatId: "new-chat", metadata: { message: [] } },
  };
  assert.throws(
    () => store.applyCommand("atomic", invalid),
    (e) => e.code === "INVALID_COMMAND",
  );
  assert.equal(store.getCharacter("new"), null);
  assert.equal(store.cursor(), cursor);
  assert.equal(
    store.db.prepare("SELECT id FROM commands WHERE id='atomic'").get(),
    undefined,
  );
  const valid = {
    ...invalid,
    chat: { chatId: "new-chat", metadata: { name: "Synthetic first" } },
  };
  const result = store.applyCommand("atomic", valid);
  assert.equal(result.chatId, "new-chat");
  assert.deepEqual(store.applyCommand("atomic", valid), result);
  assert.equal(store.listChats("new").length, 1);
  assert.throws(
    () => store.applyCommand("collision", valid),
    (e) => e.code === "IDENTITY_CONFLICT",
  );
});

test("server clone copies complete history and variable maps with new message IDs rather than a paginated browser window", (t) => {
  const { store, command } = fixture(t);
  for (let i = 0; i < 125; i++)
    command({
      type: "append-message",
      chatId: "a",
      messageId: "m" + i,
      message: { role: "char", data: "Synthetic " + i, unknown: { i } },
    });
  command({
    type: "set-chat-variable",
    chatId: "a",
    key: "$state",
    value: "synthetic value",
  });
  const metadata = {
    bookmarks: ["m0", "m124", "orphan"],
    bookmarkNames: { m0: "Synthetic bookmark", m124: "m0", orphan: "Kept" },
    lastMemory: "m124",
    supaMemoryData: "m124\nSynthetic summary contains m0\nunchanged text",
    hypaV2Data: {
      mainChunks: [
        {
          id: 1,
          chatMemos: ["m0", "m124", "orphan"],
          lastChatMemo: "m124",
          text: "m0",
          unknown: 1,
        },
      ],
      chunks: [],
    },
    hypaV3Data: {
      summaries: [{ chatMemos: ["m124", null], text: "m0", unknown: 2 }],
      categories: [],
    },
  };
  const fields = store.readFields(
    Object.keys(metadata).map((key) => ({ scope: "chat", entityId: "a", key })),
  ).fields;
  command({
    type: "change-fields",
    edits: fields.map((field) => ({
      ...field,
      expectedRevision: field.revision,
      expectedEpoch: field.entityEpoch,
      value: metadata[field.key],
    })),
  });
  assert.equal(store.snapshot("a", { limit: 2 }).messages.length, 2);
  const input = {
    type: "clone-chat",
    sourceChatId: "a",
    chatId: "copy",
    expectedRevision: store.requireChat("a").revision,
    expectedEpoch: 0,
    name: "Synthetic copy",
  };
  const result = store.applyCommand("copy-once", input);
  assert.deepEqual(store.applyCommand("copy-once", input), result);
  const copy = store.snapshot("copy", { limit: 1000 }),
    source = store.snapshot("a", { limit: 1000 });
  assert.equal(copy.messages.length, 125);
  assert.deepEqual(
    copy.messages.map((m) => m.message.data),
    source.messages.map((m) => m.message.data),
  );
  assert.ok(
    copy.messages.every(
      (m) =>
        !source.messages.some((s) => s.id === m.id) &&
        m.message.chatId === m.id,
    ),
  );
  assert.deepEqual(copy.messages[124].message.unknown, { i: 124 });
  assert.deepEqual(copy.chat.metadata.unknown, { retained: true });
  assert.equal(copy.variables[0].value, "synthetic value");
  assert.equal(copy.chat.metadata.GLGlobalVariables.local, false);
  const firstId = copy.messages[0].id,
    lastId = copy.messages[124].id;
  assert.deepEqual(copy.chat.metadata.bookmarks, [firstId, lastId, "orphan"]);
  assert.deepEqual(copy.chat.metadata.bookmarkNames, {
    [firstId]: "Synthetic bookmark",
    [lastId]: "m0",
    orphan: "Kept",
  });
  assert.equal(copy.chat.metadata.lastMemory, lastId);
  assert.equal(
    copy.chat.metadata.supaMemoryData,
    lastId + "\nSynthetic summary contains m0\nunchanged text",
  );
  assert.deepEqual(copy.chat.metadata.hypaV2Data.mainChunks, [
    {
      id: 1,
      chatMemos: [firstId, lastId, "orphan"],
      lastChatMemo: lastId,
      text: "m0",
      unknown: 1,
    },
  ]);
  assert.deepEqual(copy.chat.metadata.hypaV3Data.summaries, [
    { chatMemos: [lastId, null], text: "m0", unknown: 2 },
  ]);
  for (const [key, value] of Object.entries(metadata))
    assert.deepEqual(source.chat.metadata[key], value);
  assert.equal(store.listChats("c")[0].id, "copy");
});

test("clone remaps legacy Hypa message anchors and preserves malformed or orphaned memory without changing summary content", (t) => {
  const { store, command } = fixture(t);
  command({
    type: "append-message",
    chatId: "a",
    messageId: "synthetic-anchor",
    message: { role: "char", data: "Synthetic" },
  });
  const values = [
    "hypa:\n" +
      JSON.stringify([
        {
          id: "synthetic-anchor",
          supa: "synthetic-anchor",
          hypa: ["Synthetic"],
          unknown: { id: "synthetic-anchor" },
        },
        { id: "orphan", supa: "Kept", hypa: [] },
      ]),
    "hypa:\nmalformed synthetic memory",
    "hypa:\n{}",
  ];
  for (const [index, value] of values.entries()) {
    const field = store.readFields([
      { scope: "chat", entityId: "a", key: "supaMemoryData" },
    ]).fields[0];
    command({
      type: "change-fields",
      edits: [
        {
          ...field,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value,
        },
      ],
    });
    command({
      type: "clone-chat",
      sourceChatId: "a",
      chatId: "copy-" + index,
      expectedRevision: store.requireChat("a").revision,
      expectedEpoch: 0,
    });
    const copy = store.snapshot("copy-" + index);
    if (index === 0) {
      const saved = JSON.parse(copy.chat.metadata.supaMemoryData.slice(6));
      assert.equal(saved[0].id, copy.messages[0].id);
      assert.equal(saved[0].supa, "synthetic-anchor");
      assert.deepEqual(saved[0].unknown, { id: "synthetic-anchor" });
      assert.equal(saved[1].id, "orphan");
    } else assert.equal(copy.chat.metadata.supaMemoryData, value);
    assert.equal(store.snapshot("a").chat.metadata.supaMemoryData, value);
  }
});

test("last-chat guard and accepted-job guard roll back destructive commands", (t) => {
  const { store, command, remove, removeCharacter } = fixture(t);
  store.enqueueJob("accepted", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "user",
  });
  const cursor = store.cursor();
  assert.throws(
    () => command(remove("a")),
    (e) => e.code === "CHAT_BUSY",
  );
  assert.throws(
    () => command(removeCharacter()),
    (e) => e.code === "CHAT_BUSY",
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.listChats("c").length, 2);
  store.requestCancel("accepted");
  command(remove("a"));
  assert.throws(
    () => command(remove("b")),
    (e) => e.code === "LAST_CHAT",
  );
  assert.equal(store.listChats("c").length, 1);
});

test("deletion retains job receipts and rejects old field/job/character intents after ID recreation", (t) => {
  const { store, command, remove, removeCharacter } = fixture(t);
  const oldField = store.readFields([
    { scope: "chat", entityId: "a", key: "note" },
  ]).fields[0];
  store.enqueueJob("old-job", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "old-user",
  });
  store.requestCancel("old-job");
  const deleted = command(remove("a"));
  command({
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "Synthetic recreated" },
  });
  assert.equal(store.getJob("old-job").state, "cancelled");
  assert.equal(store.listJobs("a").length, 0);
  assert.equal(store.requireChat("a").revision, deleted.revision + 1);
  assert.throws(
    () =>
      command({
        type: "change-fields",
        edits: [
          {
            scope: "chat",
            entityId: "a",
            key: "note",
            expectedEpoch: oldField.entityEpoch,
            expectedRevision: oldField.revision,
            value: "stale",
          },
        ],
      }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () =>
      store.enqueueJob("stale-job", {
        type: "send",
        chatId: "a",
        expectedChatEpoch: 0,
        input: "Synthetic stale",
        messageId: "stale",
      }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  command(removeCharacter());
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic incarnation" },
    chat: { chatId: "new", metadata: {} },
  });
  assert.throws(
    () =>
      command({
        type: "create-chat",
        characterId: "c",
        expectedCharacterEpoch: 0,
        chatId: "stale-chat",
        metadata: {},
      }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.equal(store.getJob("old-job").state, "cancelled");
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("trash summary is updated by field commands and restore keeps the archive", (t) => {
  const { store, command } = fixture(t);
  const target = { scope: "character", entityId: "c", key: "trashTime" };
  const change = (value) => {
    const field = store.readFields([target]).fields[0];
    command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          ...(value === undefined ? { remove: true } : { value }),
        },
      ],
    });
  };
  change(1234);
  assert.equal(store.bootstrap().characters[0].trashTime, 1234);
  change(undefined);
  assert.equal(store.bootstrap().characters[0].trashTime, null);
  assert.equal(store.listChats("c").length, 2);
});

test("v8 migration preserves identity, journal and running job ownership/progress while detaching terminal history from chat lifetime", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-lifecycle-migration-")),
    file = join(directory, "synthetic.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(file);
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8")
    .replace("    trash_time INTEGER,\n", "")
    .replace("    sort_position INTEGER NOT NULL DEFAULT 0,\n", "")
    .replace(
      "    chat_id TEXT NOT NULL,\n    chat_epoch INTEGER NOT NULL DEFAULT 0 CHECK (chat_epoch >= 0),",
      "    chat_id TEXT NOT NULL REFERENCES chats(id),",
    )
    .replace("user_version = 22", "user_version = 8");
  old.exec(schema);
  old.exec(`INSERT INTO runtime_identity VALUES (1,'synthetic-authority');
    INSERT INTO characters(id,name,kind,definition,revision,updated_at) VALUES ('c','Synthetic','character','{"trashTime":1234}',3,1);
    INSERT INTO chats(id,character_id,name,metadata,revision,updated_at) VALUES ('a','c','A','{}',5,1);
    INSERT INTO commands VALUES ('job','synthetic-hash','{"type":"send","chatId":"a"}',NULL,1);
    INSERT INTO jobs(id,chat_id,type,state,queue_position,owner,fence,lease_until,started_revision,started_content_revision,started_metadata_revision,progress,progress_revision,created_at,updated_at)
      VALUES ('job','a','send','running',1,'synthetic-owner',7,9999999999999,5,1,0,'{"stage":2}',9,1,2);
    INSERT INTO changes(entity_type,entity_id,payload,created_at) VALUES ('synthetic','c','{}',1);`);
  const before = { ...old.prepare("SELECT * FROM jobs").get() };
  old.close();
  const store = new EntityStore(file);
  t.after(() => store.close());
  const { chat_epoch, ...after } = store.db.prepare("SELECT * FROM jobs").get();
  assert.deepEqual(after, before);
  assert.equal(chat_epoch, 0);
  const historyIndexes = store.db
    .prepare("PRAGMA index_list(jobs)")
    .all()
    .map((row) => row.name);
  for (const name of [
    "jobs_history",
    "memory_jobs_history",
    "failed_jobs_history",
  ])
    assert.ok(historyIndexes.includes(name));
  assert.equal(
    store.listJobHistory("a", { expectedEpoch: 0 }).items[0].id,
    "job",
  );
  assert.equal(store.bootstrap().serverId, "synthetic-authority");
  assert.equal(store.cursor(), 1);
  assert.equal(store.bootstrap().characters[0].trashTime, 1234);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
