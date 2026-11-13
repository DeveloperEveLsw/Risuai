"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");

function fixture(t, definition = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-group-members-")),
    file = join(directory, "state.sqlite"),
    store = new EntityStore(file);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ["a", "b", "c"])
    store.applyCommand("character-" + id, {
      type: "create-character",
      characterId: id,
      definition: {
        type: "character",
        name: id,
        firstMessage: "Synthetic greeting " + id,
      },
    });
  store.applyCommand("group", {
    type: "create-character",
    characterId: "g",
    definition: {
      type: "group",
      name: "Synthetic group",
      characters: ["a", "b"],
      characterTalks: [0.5, 1],
      characterActive: [true, true],
      unknownExtension: { preserved: true },
      ...definition,
    },
    chat: { chatId: "chat", metadata: { name: "Synthetic" } },
  });
  return { store, file };
}
function command(store, memberId, action, value, position) {
  const h = store.readGroupMember("g", memberId);
  return {
    type: "change-group-member",
    groupId: "g",
    memberId,
    action,
    expectedEpoch: h.entityEpoch,
    expectedOrderRevision: h.orderRevision,
    expectedMemberRevision: h.member.revision,
    ...(value === undefined ? {} : { value }),
    ...(action === "add"
      ? {}
      : { position: position ?? h.member.slots[0].position }),
  };
}
test("member CAS merges concurrent independent settings and rejects a stale write to the same member", (t) => {
  const { store } = fixture(t),
    a = command(store, "a", "set-active", false),
    b = command(store, "b", "set-talkness", 0.25);
  store.applyCommand("a-active", a);
  store.applyCommand("b-talk", b);
  const d = store.getCharacter("g").definition;
  assert.deepEqual(d.characterActive, [false, true]);
  assert.deepEqual(d.characterTalks, [0.5, 0.25]);
  assert.throws(() => store.applyCommand("stale-a", { ...a, value: true }), {
    code: "REVISION_CONFLICT",
  });
  assert.deepEqual(d.unknownExtension, { preserved: true });
  assert.equal(store.readGroupMember("g", "a").member.revision, 2);
  assert.equal(store.readGroupMember("g", "b").member.revision, 2);
});
test("add with greeting is one idempotent transaction and removed members retain revisions", (t) => {
  const { store } = fixture(t),
    c = command(store, "c", "add"),
    source = store.getCharacter("c"),
    snap = store.snapshot("chat");
  c.greeting = {
    chatId: "chat",
    messageId: "greeting-c",
    expectedChatEpoch: snap.chat.entityEpoch,
    expectedChatRevision: snap.chat.revision,
    expectedMemberEpoch: source.entityEpoch,
    expectedGreetingRevision: source.fieldRevisions.firstMessage,
  };
  const result = store.applyCommand("add-c", c),
    cursor = store.cursor();
  assert.deepEqual(store.applyCommand("add-c", c), result);
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(
    store.snapshot("chat").messages.map((x) => x.message),
    [
      {
        role: "char",
        data: "Synthetic greeting c",
        saying: "c",
        chatId: "greeting-c",
      },
    ],
  );
  store.applyCommand("remove-c", command(store, "c", "remove"));
  assert.equal(store.readGroupMember("g", "c").member.revision, 2);
  assert.equal(store.readGroupMember("g", "c").member.slots.length, 0);
  store.applyCommand("readd-c", command(store, "c", "add"));
  assert.equal(store.readGroupMember("g", "c").member.revision, 3);
  assert.equal(store.snapshot("chat").messages.length, 1);
});
test("invalid greeting, stale source and running chat roll back membership, journal and command admission", (t) => {
  const { store } = fixture(t),
    c = command(store, "c", "add"),
    source = store.getCharacter("c"),
    snap = store.snapshot("chat"),
    cursor = store.cursor();
  const greeting = {
    chatId: "chat",
    messageId: "greeting",
    expectedChatEpoch: snap.chat.entityEpoch,
    expectedChatRevision: snap.chat.revision,
    expectedMemberEpoch: source.entityEpoch,
    expectedGreetingRevision: source.fieldRevisions.firstMessage + 1,
  };
  assert.throws(() => store.applyCommand("bad-greeting", { ...c, greeting }), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(store.getCharacter("g").definition.characters, ["a", "b"]);
  assert.equal(
    store.db.prepare("SELECT 1 FROM commands WHERE id='bad-greeting'").get(),
    undefined,
  );
  store.enqueueJob("running", {
    type: "send",
    chatId: "chat",
    input: "Synthetic",
  });
  store.claimJob("owner");
  const before = store.cursor();
  assert.throws(
    () =>
      store.applyCommand("busy-greeting", {
        ...c,
        greeting: {
          ...greeting,
          expectedGreetingRevision: source.fieldRevisions.firstMessage,
        },
      }),
    { code: "CHAT_BUSY" },
  );
  assert.equal(store.cursor(), before);
  assert.deepEqual(store.getCharacter("g").definition.characters, ["a", "b"]);
});
test("legacy and native field writes update member guards while unrelated character fields do not", (t) => {
  const { store } = fixture(t),
    stale = command(store, "a", "set-active", false),
    d = store.getCharacter("g");
  store.applyCommand("legacy-settings", {
    type: "change-fields",
    edits: [
      {
        scope: "character",
        entityId: "g",
        key: "characterTalks",
        value: [0.75, 1],
        expectedRevision: d.fieldRevisions.characterTalks,
        expectedEpoch: d.entityEpoch,
      },
    ],
  });
  assert.throws(() => store.applyCommand("old-member", stale), {
    code: "REVISION_CONFLICT",
  });
  const fresh = command(store, "a", "set-active", false),
    n = store.getCharacter("g");
  store.applyCommand("group-name", {
    type: "change-fields",
    edits: [
      {
        scope: "character",
        entityId: "g",
        key: "name",
        value: "Renamed",
        expectedRevision: n.fieldRevisions.name,
        expectedEpoch: n.entityEpoch,
      },
    ],
  });
  store.applyCommand("fresh-member", fresh);
  assert.equal(store.readGroupMember("g", "a").member.slots[0].active, false);
});
test("order and incarnation guards reject index movement and group delete/recreation", (t) => {
  const { store } = fixture(t),
    b = command(store, "b", "set-active", false);
  store.applyCommand("remove-a", command(store, "a", "remove"));
  assert.throws(() => store.applyCommand("old-position", b), {
    code: "REVISION_CONFLICT",
  });
  assert.deepEqual(store.getCharacter("g").definition.characters, ["b"]);
  assert.equal(store.readGroupMember("g", "b").member.revision, 1);
  assert.equal(store.readGroupMember("g", "b").member.slots[0].position, 0);
  const previous = command(store, "b", "set-active", false);
  const group = store.getCharacter("g");
  store.applyCommand("delete-group", {
    type: "delete-character",
    characterId: "g",
    expectedRevision: group.revision,
    expectedEpoch: group.entityEpoch,
  });
  store.applyCommand("recreate-group", {
    type: "create-character",
    characterId: "g",
    definition: group.definition,
  });
  assert.throws(() => store.applyCommand("old-incarnation", previous), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(store.readGroupMember("g", "b").member.revision, 1);
});
test("schema14 migration preserves exact duplicate/malformed portable arrays without journal changes", (t) => {
  const { store, file } = fixture(t, {
    characters: ["a", "a", "missing"],
    characterTalks: [0.2, null, 0.7, "extra"],
    characterActive: [true, false],
    extension: { arbitrary: [1, 2] },
  });
  const raw = store.db
      .prepare("SELECT definition FROM characters WHERE id='g'")
      .get().definition,
    cursor = store.cursor();
  store.db.exec("DROP TABLE group_members; PRAGMA user_version=14;");
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), 22);
  assert.equal(migrated.cursor(), cursor);
  assert.equal(
    migrated.db.prepare("SELECT definition FROM characters WHERE id='g'").get()
      .definition,
    raw,
  );
  assert.equal(migrated.readGroupMember("g", "a").member.slots.length, 2);
  assert.equal(
    migrated.readGroupMember("g", "missing").member.slots[0].talkness,
    0.7,
  );
  assert.throws(
    () =>
      migrated.applyCommand(
        "shape",
        command(migrated, "a", "set-active", false),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(migrated.cursor(), cursor);
});

test("failed append after membership writes rolls back member rows, arrays, journal and admission", (t) => {
  const { store } = fixture(t);
  store.applyCommand("existing-message", {
    type: "append-message",
    chatId: "chat",
    messageId: "duplicate",
    message: { role: "user", data: "Synthetic existing" },
  });
  const c = command(store, "c", "add"),
    snap = store.snapshot("chat"),
    source = store.getCharacter("c"),
    cursor = store.cursor();
  const greeting = {
    chatId: "chat",
    messageId: "duplicate",
    expectedChatEpoch: snap.chat.entityEpoch,
    expectedChatRevision: snap.chat.revision,
    expectedMemberEpoch: source.entityEpoch,
    expectedGreetingRevision: source.fieldRevisions.firstMessage,
  };
  assert.throws(
    () => store.applyCommand("duplicate-greeting", { ...c, greeting }),
    /UNIQUE constraint failed/,
  );
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(store.getCharacter("g").definition.characters, ["a", "b"]);
  assert.equal(store.readGroupMember("g", "c").member.revision, 0);
  assert.equal(
    store.db
      .prepare("SELECT 1 FROM commands WHERE id='duplicate-greeting'")
      .get(),
    undefined,
  );
  assert.equal(store.snapshot("chat").messages.length, 1);
  store.applyCommand("foreign-chat", {
    type: "create-chat",
    characterId: "a",
    chatId: "foreign",
    metadata: { name: "Synthetic foreign" },
  });
  const foreign = store.snapshot("foreign");
  assert.throws(
    () =>
      store.applyCommand("foreign-greeting", {
        ...c,
        greeting: {
          ...greeting,
          chatId: "foreign",
          expectedChatEpoch: foreign.chat.entityEpoch,
          expectedChatRevision: foreign.chat.revision,
        },
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.throws(
    () => store.applyCommand("malformed-greeting", { ...c, greeting: null }),
    { code: "INVALID_COMMAND" },
  );
});

test("whole native definition replacement advances member CAS and preserves guards after reopening", (t) => {
  const { store, file } = fixture(t),
    stale = command(store, "a", "set-active", false);
  store.enqueueJob("native", { type: "button", chatId: "chat" });
  const claimed = store.claimJob("engine"),
    before = store.getCharacter("g");
  store.finishJob("native", "engine", claimed.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "chat",
      expectedRevision: claimed.snapshot.chat.revision,
      expectedContentRevision: claimed.snapshot.chat.contentRevision,
      characters: [
        {
          id: "g",
          expectedRevision: before.revision,
          definition: { ...before.definition, characterTalks: [1, 0.2] },
        },
      ],
    },
  });
  assert.equal(store.readGroupMember("g", "a").member.revision, 2);
  assert.equal(store.readGroupMember("g", "b").member.revision, 2);
  const reopened = new EntityStore(file);
  t.after(() => reopened.close());
  assert.throws(() => reopened.applyCommand("old-native-member", stale), {
    code: "REVISION_CONFLICT",
  });
  assert.deepEqual(
    reopened.getCharacter("g").definition.characterTalks,
    [1, 0.2],
  );
});

test("legacy duplicate occurrences remain aligned when one occurrence changes or is removed", (t) => {
  const { store } = fixture(t, {
    characters: ["a", "a", "b"],
    characterTalks: [0.2, 0.8, 1],
    characterActive: [true, false, true],
  });
  store.applyCommand(
    "duplicate-slot",
    command(store, "a", "set-active", true, 1),
  );
  assert.deepEqual(store.getCharacter("g").definition.characterActive, [
    true,
    true,
    true,
  ]);
  assert.equal(store.readGroupMember("g", "a").member.revision, 2);
  store.applyCommand(
    "remove-first-slot",
    command(store, "a", "remove", undefined, 0),
  );
  const value = store.getCharacter("g").definition;
  assert.deepEqual(value.characters, ["a", "b"]);
  assert.deepEqual(value.characterTalks, [0.8, 1]);
  assert.deepEqual(value.characterActive, [true, true]);
  assert.equal(store.readGroupMember("g", "a").member.revision, 3);
  const cursor = store.cursor();
  for (const value of [-1, 1.1, "0.5", null])
    assert.throws(
      () =>
        store.applyCommand(
          "invalid-talk-" + String(value),
          command(store, "a", "set-talkness", value),
        ),
      { code: "INVALID_COMMAND" },
    );
  assert.equal(store.cursor(), cursor);
});
