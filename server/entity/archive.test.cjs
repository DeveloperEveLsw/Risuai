"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
const { readArchive } = require("./archive.cjs");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-archive-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file);
  const reader = new DatabaseSync(file, { readOnly: true });
  const peer = new EntityStore(file);
  t.after(() => {
    reader.close();
    peer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initializeState({
    settings: {
      moduleIds: ["second", "first"],
      statics: { messages: 7, imports: 3, unknown: true },
      unknownRoot: { kept: true },
    },
    resources: [
      {
        kind: "module",
        id: "first",
        payload: { name: "Synthetic first", unknown: 1 },
      },
      { kind: "module", id: "second", payload: { name: "Synthetic second" } },
      { kind: "preset", id: "preset", payload: { name: "Synthetic preset" } },
      {
        kind: "persona",
        id: "persona",
        payload: { name: "Synthetic persona", unknown: true },
      },
      {
        kind: "plugin",
        id: "plugin",
        payload: {
          name: "Synthetic plugin",
          code: "// authored inert fixture",
        },
      },
      { kind: "global-variable", id: "__proto__", payload: { retained: true } },
    ],
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      type: "character",
      lastInteraction: 123,
      unknown: { kept: true },
    },
  });
  store.applyCommand("group", {
    type: "create-character",
    characterId: "g",
    definition: {
      name: "Synthetic group",
      type: "group",
      characters: ["c"],
      characterTalks: [0.5],
      characterActive: [true],
    },
  });
  store.applyCommand("chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "chat",
    metadata: {
      name: "Synthetic",
      bookmarks: ["message"],
      bookmarkNames: { message: "Synthetic bookmark" },
      unknown: true,
      GLGlobalVariables: { global: "Synthetic global" },
    },
    messages: [
      {
        id: "message",
        message: {
          role: "char",
          data: "Synthetic neutral text",
          unknown: { retained: true },
        },
      },
    ],
  });
  store.setVariable("chat", "$flag", "Synthetic retained flag");
  store.registerAsset({
    id: "a".repeat(64) + ".wav",
    digest: "a".repeat(64),
    extension: "wav",
    mime: "audio/wav",
    byteLength: 76,
  });
  return { store, peer, reader };
}

test("original archive folds counters and separated variables while preserving resources, order, group, bookmarks and unknown values", (t) => {
  const { store, reader } = fixture(t);
  const before = store.bootstrap();
  const archive = JSON.parse(
    readArchive(reader, { serverId: before.serverId }),
  );
  const db = archive.database;
  assert.deepEqual(
    db.modules.map((m) => m.id),
    ["second", "first"],
  );
  assert.equal(db.moduleIds, undefined);
  assert.deepEqual(db.statics, { messages: 7, imports: 3, unknown: true });
  assert.deepEqual(db.unknownRoot, { kept: true });
  assert.equal(Object.hasOwn(db.globalChatVariables, "__proto__"), true);
  assert.deepEqual(db.globalChatVariables.__proto__, { retained: true });
  assert.deepEqual(
    [db.botPresets[0].id, db.personas[0].id, db.plugins[0].id],
    ["preset", "persona", "plugin"],
  );
  assert.equal(db.characters[0].lastInteraction, 123);
  const chat = db.characters[0].chats[0];
  assert.deepEqual(chat.scriptstate, { $flag: "Synthetic retained flag" });
  assert.deepEqual(chat.GLGlobalVariables, { global: "Synthetic global" });
  assert.deepEqual(chat.bookmarks, ["message"]);
  assert.deepEqual(chat.bookmarkNames, { message: "Synthetic bookmark" });
  assert.equal(chat.message[0].chatId, "message");
  assert.deepEqual(chat.message[0].unknown, { retained: true });
  assert.deepEqual(db.characters[1].characters, ["c"]);
  assert.equal(db.coldstorage, false);
  assert.equal(archive.assets[0].extension, "wav");
  assert.deepEqual(store.bootstrap(), before);
});

test("WAL export captures one pinned state even when a peer commits definitions, resources, history and assets between reads", (t) => {
  const { store, peer, reader } = fixture(t);
  const before = JSON.parse(readArchive(reader));
  const during = JSON.parse(
    readArchive(reader, {
      afterPinned: () => {
        const field = peer.readFields([
          { scope: "character", entityId: "c", key: "name" },
        ]).fields[0];
        peer.applyCommand("peer-character", {
          type: "change-fields",
          edits: [
            {
              ...field,
              expectedRevision: field.revision,
              expectedEpoch: field.entityEpoch,
              value: "Synthetic changed",
            },
          ],
        });
        const resource = peer.getResource("module", "first");
        peer.applyCommand("peer-module", {
          type: "put-resource",
          kind: "module",
          resourceId: "first",
          expectedRevision: resource.revision,
          payload: { ...resource.payload, name: "Synthetic changed module" },
        });
        peer.applyCommand("peer-message", {
          type: "append-message",
          chatId: "chat",
          messageId: "new",
          message: { role: "char", data: "Synthetic changed text" },
        });
        peer.registerAsset({
          id: "b".repeat(64) + ".png",
          digest: "b".repeat(64),
          extension: "png",
          mime: "image/png",
          byteLength: 68,
        });
      },
    }),
  );
  assert.deepEqual(during, before);
  const after = JSON.parse(readArchive(reader));
  assert.ok(after.cursor > before.cursor);
  assert.equal(after.database.characters[0].name, "Synthetic changed");
  assert.equal(after.database.modules[1].name, "Synthetic changed module");
  assert.equal(after.database.characters[0].chats[0].message.length, 2);
  assert.equal(after.assets.length, 2);
  assert.equal(store.bootstrap().cursor, after.cursor);
});

test("wrong identity, explicit size budget and unrepresentable settings fail without leaving a read transaction", (t) => {
  const { store, reader } = fixture(t);
  assert.throws(() => readArchive(reader, { serverId: "obsolete" }), {
    code: "SERVER_CHANGED",
  });
  assert.throws(() => readArchive(reader, { maxBytes: 10 }), {
    code: "ARCHIVE_TOO_LARGE",
  });
  assert.ok(JSON.parse(readArchive(reader)).database.characters.length);
  store.applyCommand("aux-settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "auxiliary",
    expectedRevision: 0,
    payload: { unknown: "Synthetic" },
  });
  assert.throws(() => readArchive(reader), {
    code: "ARCHIVE_UNSUPPORTED_RESOURCE",
  });
});

test("a missing ordered resource fails instead of silently compressing numeric library selection", (t) => {
  const { store, reader } = fixture(t);
  const field = store.readFields([
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "moduleIds",
    },
  ]).fields[0];
  store.applyCommand("broken-order", {
    type: "change-fields",
    edits: [
      {
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: ["second", "missing", "first"],
      },
    ],
  });
  assert.throws(() => readArchive(reader), {
    code: "ARCHIVE_MISSING_RESOURCE",
  });
  assert.deepEqual(store.getResource("settings", "global").payload.moduleIds, [
    "second",
    "missing",
    "first",
  ]);
});
