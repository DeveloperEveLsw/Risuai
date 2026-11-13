"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const catalog = require("./pluginCatalog.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.initializeState({ settings: {}, resources: [] });
  let next = 0;
  const command = (input) =>
    store.applyCommand("synthetic-catalog:" + ++next, input);
  for (const characterId of ["c1", "c2"])
    command({
      type: "create-character",
      characterId,
      definition: {
        name: "Synthetic " + characterId,
        desc: "PRIVATE STORY",
        systemPrompt: "PRIVATE PROMPT",
      },
    });
  for (const [chatId, characterId, metadata] of [
    [
      "a",
      "c1",
      {
        name: "Garden A",
        bindedPersona: "persona-1",
        note: "PRIVATE NOTE",
        localLore: [
          { key: "PRIVATE LORE", content: "PRIVATE STORY" },
          null,
          "PRIVATE BODY",
          9,
          {
            key: "__wl_marker__",
            comment: "PRIVATE MARKER COMMENT",
            content: JSON.stringify({
              webKey: "wl.web.v1.live-a",
              fingerprint: { private: "PRIVATE FINGERPRINT" },
            }),
          },
          {
            key: "__wl_marker__",
            content: JSON.stringify({ webKey: "wl.web.v1.later-must-not-win" }),
          },
        ],
      },
    ],
    [
      "b",
      "c1",
      {
        name: "Garden B",
        localLore: [
          {
            key: "PRIVATE KEY",
            comment: "WL.Marker.V12",
            content: JSON.stringify({
              webKey: "wl.web.v1.live-b",
              private: "PRIVATE FINGERPRINT",
            }),
          },
        ],
      },
    ],
    ["z", "c2", { name: "Garden Z", localLore: [] }],
  ])
    command({ type: "create-chat", characterId, chatId, metadata });
  for (const [messageId, chatId] of [
    ["first-a", "a"],
    ["second-a", "a"],
    ["first-b", "b"],
  ])
    command({
      type: "append-message",
      chatId,
      messageId,
      message: {
        role: "char",
        data: "PRIVATE MESSAGE BODY",
        chatId: "noncanonical-payload-id",
      },
    });
  const capture = () => store.transaction(() => catalog.capture(store), true);
  const validate = (guard) =>
    store.transaction(() => catalog.validate(store, guard), true);
  function edit(target, value) {
    const current = store.readFields([target]).fields[0];
    command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: current.revision,
          expectedEpoch: current.entityEpoch,
          value,
        },
      ],
    });
  }
  return { store, command, capture, validate, edit };
}

test("reviewed catalog is complete across characters/chats but contains only names, first IDs and first recognized marker web keys", (t) => {
  const f = fixture(t),
    result = f.capture();
  assert.equal(result.projection, catalog.PROJECTION);
  assert.deepEqual(result.characters, [
    {
      chaId: "c1",
      name: "Synthetic c1",
      chats: [
        {
          id: "a",
          name: "Garden A",
          bindedPersona: "persona-1",
          message: [{ chatId: "first-a" }],
          localLore: [
            { key: "__wl_marker__", content: '{"webKey":"wl.web.v1.live-a"}' },
          ],
        },
        {
          id: "b",
          name: "Garden B",
          message: [{ chatId: "first-b" }],
          localLore: [
            {
              comment: "WL.Marker.V12",
              content: '{"webKey":"wl.web.v1.live-b"}',
            },
          ],
        },
      ],
    },
    {
      chaId: "c2",
      name: "Synthetic c2",
      chats: [{ id: "z", name: "Garden Z", message: [], localLore: [] }],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|noncanonical-payload-id|second-a|fingerprint|_placeholder|_stub/,
  );
  assert.equal(result.guard.characters.length, 2);
  assert.equal(result.guard.chats.length, 3);
  assert.equal(f.validate(result.guard), true);
});

test("catalog projection refuses to skip a malformed first matching marker or accept a near-match legacy comment", (t) => {
  const f = fixture(t);
  for (const content of [
    "not JSON",
    JSON.stringify({ private: "PRIVATE FINGERPRINT" }),
    { webKey: "must-not-coerce-object" },
    JSON.stringify({ webKey: 42 }),
  ]) {
    f.edit({ scope: "chat", entityId: "a", key: "localLore" }, [
      {
        key: "unrelated",
        comment: "wl.marker.v1oops",
        content: '{"webKey":"bad-near-match"}',
      },
      { key: "__wl_marker__", content },
      { key: "__wl_marker__", content: '{"webKey":"later-must-not-win"}' },
    ]);
    assert.deepEqual(f.capture().characters[0].chats[0].localLore, [
      { key: "__wl_marker__", content: "{}" },
    ]);
  }
});

test("catalog guard validation reads only identities/revisions without loading any definition, lore or message payload", (t) => {
  const f = fixture(t),
    guard = f.capture().guard,
    cursor = f.store.cursor();
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(
      sql,
      /\b(?:definition|payload|metadata|name|data)\b|SELECT\s+\*/i,
    );
    return prepare(sql);
  };
  assert.equal(catalog.validate(f.store, guard), true);
  f.store.db.prepare = prepare;
  assert.equal(f.store.cursor(), cursor);
});

test("catalog capture does not select whole documents or message bodies and leaves the caller transaction untouched", (t) => {
  const f = fixture(t),
    prepare = f.store.db.prepare.bind(f.store.db),
    cursor = f.store.cursor();
  f.store.db.prepare = (sql) => {
    assert.doesNotMatch(
      sql,
      /\b(?:definition|payload)\b|SELECT\s+metadata\b|SELECT\s+\*\s+FROM\s+(?:characters|chats|messages)/i,
    );
    return prepare(sql);
  };
  const result = catalog.capture(f.store);
  f.store.db.prepare = prepare;
  assert.equal(result.characters.length, 2);
  assert.equal(f.store.cursor(), cursor);
});

test("the metadata catalog capability permits only an explicitly captured read-only cross-character dependency closure", (t) => {
  const f = fixture(t),
    snapshot = f.store.executionSnapshot("a");
  snapshot.pluginCatalog = f.capture();
  const reads = createPluginReadDependencies(snapshot);
  reads.observeDatabaseFields(["characters"]);
  const result = reads.snapshot();
  assert.deepEqual(result.gardenCatalog, snapshot.pluginCatalog.guard);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|"name"|"content"|"message"/,
  );
  assert.equal(validatePluginReadDependencies(f.store, result), true);
  result.gardenCatalog.chats[0].firstMessageId = "tampered";
  assert.equal(
    reads.snapshot().gardenCatalog.chats[0].firstMessageId,
    "first-a",
  );
  assert.throws(() => validatePluginReadDependencies(f.store, result), {
    code: "REVISION_CONFLICT",
  });
  for (const pluginCatalog of [
    undefined,
    {
      projection: "whole-db",
      characters: [],
      guard: snapshot.pluginCatalog.guard,
    },
    { projection: catalog.PROJECTION, characters: [], guard: { version: 1 } },
  ]) {
    assert.throws(
      () =>
        createPluginReadDependencies({
          ...snapshot,
          pluginCatalog,
        }).observeDatabaseFields(["characters"]),
      { code: "PLUGIN_READ_DEPENDENCY_INVALID" },
    );
  }
});

test("catalog changes fence cleanup before stale cross-character memory can be removed", (t) => {
  for (const change of [
    "character name",
    "other chat marker",
    "other chat persona",
    "new character",
    "new chat",
    "first message",
    "chat ordering",
  ]) {
    const f = fixture(t),
      guard = f.capture().guard;
    if (change === "character name")
      f.edit(
        { scope: "character", entityId: "c2", key: "name" },
        "Synthetic new name",
      );
    else if (change === "other chat marker")
      f.edit({ scope: "chat", entityId: "z", key: "localLore" }, [
        { key: "__wl_marker__", content: '{"webKey":"new-marker"}' },
      ]);
    else if (change === "other chat persona")
      f.edit(
        { scope: "chat", entityId: "z", key: "bindedPersona" },
        "different-persona",
      );
    else if (change === "new character")
      f.command({
        type: "create-character",
        characterId: "new",
        definition: { name: "New synthetic" },
      });
    else if (change === "new chat")
      f.command({ type: "create-chat", characterId: "c2", chatId: "new" });
    else if (change === "first message")
      f.command({
        type: "remove-message",
        chatId: "a",
        messageId: "first-a",
        expectedRevision: 1,
        expectedChatRevision: f.store.requireChat("a").revision,
        expectedChatEpoch: 0,
        mode: "one",
      });
    else
      f.store.db
        .prepare("UPDATE chats SET sort_position=-1 WHERE id='b'")
        .run();
    const cursor = f.store.cursor();
    assert.throws(() => f.validate(guard), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.validate(f.capture().guard), true);
  }
});

test("delete/recreate identities and even equal reused counters cannot satisfy old catalog incarnations", (t) => {
  const f = fixture(t),
    guard = f.capture().guard;
  f.command({
    type: "delete-character",
    characterId: "c2",
    expectedRevision: f.store.characterView("c2").revision,
    expectedEpoch: 0,
  });
  f.command({
    type: "create-character",
    characterId: "c2",
    definition: { name: "Synthetic c2" },
  });
  f.command({
    type: "create-chat",
    chatId: "z",
    characterId: "c2",
    metadata: { name: "Garden Z", localLore: [] },
  });
  assert.throws(() => f.validate(guard), { code: "REVISION_CONFLICT" });
  assert.ok(f.capture().guard.chats.find((row) => row.id === "z").epoch > 0);
  assert.equal(f.validate(f.capture().guard), true);
});

test("over-budget or unsupported catalogs fail explicitly rather than returning an incomplete live set", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.store.transaction(() => catalog.capture(f.store, { maxRows: 4 }), true),
    { code: "PLUGIN_CATALOG_LIMIT" },
  );
  assert.throws(() => catalog.capture(f.store, { maxRows: -1 }), {
    code: "PLUGIN_READ_DEPENDENCY_INVALID",
  });
  f.edit(
    { scope: "chat", entityId: "z", key: "bindedPersona" },
    { id: "malformed" },
  );
  assert.throws(() => f.capture(), { code: "PLUGIN_CATALOG_UNSUPPORTED" });
});

test("catalog guard shape is strict and bounded before any database reads", (t) => {
  const f = fixture(t),
    good = f.capture().guard,
    cursor = f.store.cursor();
  for (const bad of [
    undefined,
    null,
    [],
    { ...good, version: 2 },
    { ...good, projection: "full-history" },
    { ...good, prompt: "PRIVATE" },
    { ...good, characters: [...good.characters, good.characters[0]] },
    { ...good, chats: [{ ...good.chats[0], characterId: "outside" }] },
    { ...good, chats: [{ ...good.chats[0], firstMessageId: undefined }] },
    { ...good, chats: [{ ...good.chats[0], metadataRevision: -1 }] },
    { ...good, chats: [{ ...good.chats[0], sortPosition: 0.5 }] },
    { ...good, chats: Array(1) },
    { ...good, characters: Array(4097).fill(good.characters[0]) },
  ]) {
    assert.throws(() => f.validate(bad), {
      code: "PLUGIN_READ_DEPENDENCY_INVALID",
    });
    assert.equal(f.store.cursor(), cursor);
  }
});

test("marker projection preserves JSON.parse's last duplicate property semantics", (t) => {
  const f = fixture(t);
  for (const [content, expected] of [
    ['{"webKey":"first","webKey":"last"}', '{"webKey":"last"}'],
    ['{"webKey":"first","webKey":42}', "{}"],
    ['{"webKey":42,"webKey":"last"}', '{"webKey":"last"}'],
  ]) {
    f.edit({ scope: "chat", entityId: "a", key: "localLore" }, [
      { key: "__wl_marker__", content },
    ]);
    assert.equal(
      f.capture().characters[0].chats[0].localLore[0].content,
      expected,
    );
    assert.equal(
      catalog.captureCurrentScope(f.store, "a").chats[0].localLore[0].content,
      expected,
    );
  }
});

test("current garden captures real indices and only same-character sibling headers", (t) => {
  const f = fixture(t),
    current = catalog.captureCurrentScope(f.store, "b"),
    other = catalog.captureCurrentScope(f.store, "z");
  assert.equal(current.projection, catalog.CURRENT_SCOPE_PROJECTION);
  assert.equal(current.characterIndex, 0);
  assert.equal(current.chatIndex, 1);
  assert.deepEqual(current.chats, f.capture().characters[0].chats);
  assert.equal(other.characterIndex, 1);
  assert.equal(other.chatIndex, 0);
  assert.deepEqual(other.chats, f.capture().characters[1].chats);
  assert.doesNotMatch(
    JSON.stringify(other),
    /PRIVATE|first-a|first-b|live-a|live-b/,
  );
  assert.equal(catalog.validateCurrentScope(f.store, current.guard), true);
  const snapshot = {
      ...f.store.executionSnapshot("b"),
      pluginCurrentScope: catalog.captureCurrentScope(f.store, "b"),
    },
    reads = createPluginReadDependencies(snapshot);
  reads.observeCurrentScope();
  assert.deepEqual(reads.snapshot().currentScope, current.guard);
  assert.doesNotMatch(
    JSON.stringify(reads.snapshot()),
    /PRIVATE|"name"|"content"|"message"/,
  );
  assert.equal(validatePluginReadDependencies(f.store, reads.snapshot()), true);
  const detached = reads.snapshot();
  detached.currentScope.chatIndex = 0;
  assert.equal(reads.snapshot().currentScope.chatIndex, 1);
  assert.throws(() => validatePluginReadDependencies(f.store, detached), {
    code: "PLUGIN_READ_DEPENDENCY_INVALID",
  });
});

test("native sibling guards detect changed membership and order without depending on other histories", (t) => {
  const f = fixture(t),
    current = catalog.captureCurrentScope(f.store, "b");
  f.edit(
    { scope: "chat", entityId: "z", key: "note" },
    "Changed unrelated private note",
  );
  assert.equal(catalog.validateCurrentScope(f.store, current.guard), true);
  f.command({ type: "create-chat", characterId: "c1", chatId: "new-sibling" });
  assert.throws(() => catalog.validateCurrentScope(f.store, current.guard), {
    code: "REVISION_CONFLICT",
  });
  const changed = catalog.captureCurrentScope(f.store, "b");
  f.store.db.prepare("UPDATE chats SET sort_position=-1 WHERE id='b'").run();
  assert.throws(() => catalog.validateCurrentScope(f.store, changed.guard), {
    code: "REVISION_CONFLICT",
  });
  const secondCharacter = catalog.captureCurrentScope(f.store, "z");
  f.command({
    type: "delete-character",
    characterId: "c1",
    expectedRevision: f.store.characterView("c1").revision,
    expectedEpoch: 0,
  });
  assert.throws(
    () => catalog.validateCurrentScope(f.store, secondCharacter.guard),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(catalog.captureCurrentScope(f.store, "z").characterIndex, 0);
});
