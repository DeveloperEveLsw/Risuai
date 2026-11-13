"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");

function seed(store) {
  let n = 0;
  const command = (value) =>
    store.applyCommand("synthetic-summary-" + ++n, value);
  command({
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      chatFolders: [{ id: "f", name: "Synthetic folder", folded: false }],
    },
  });
  for (const [chatId, metadata] of [
    ["a", { folderId: "f" }],
    ["b", { folderId: null }],
    ["missing", {}],
    ["empty", { folderId: "" }],
    ["orphan", { folderId: "synthetic-orphan" }],
    ["unknown", { folderId: false }],
  ])
    command({
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: {
        name: chatId,
        note: "Synthetic metadata body marker".repeat(8192),
        extension: { retained: true },
        ...metadata,
      },
      messages: [
        {
          id: "synthetic-message-" + chatId,
          message: {
            role: "char",
            data: "Synthetic message body marker".repeat(8192),
          },
        },
      ],
    });
  return command;
}

test("chat summaries retain exact folder presence/value and field heads without exposing chat bodies", (t) => {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  const command = seed(store);
  const rows = store.listChats("c");
  const get = (id) => rows.find((row) => row.id === id);
  assert.deepEqual(get("a").navigation, {
    folderId: { exists: true, value: "f" },
  });
  assert.deepEqual(get("b").navigation, {
    folderId: { exists: true, value: null },
  });
  assert.deepEqual(get("missing").navigation, { folderId: { exists: false } });
  assert.deepEqual(get("empty").navigation, {
    folderId: { exists: true, value: "" },
  });
  assert.deepEqual(get("orphan").navigation, {
    folderId: { exists: true, value: "synthetic-orphan" },
  });
  assert.deepEqual(get("unknown").navigation, {
    folderId: { exists: true, value: false },
  });
  assert.equal(get("a").fieldRevisions.folderId, 1);
  assert.equal(get("missing").fieldRevisions.folderId, undefined);
  const encoded = JSON.stringify(rows);
  assert.ok(encoded.length < 4000);
  assert.ok(!encoded.includes("body marker"));
  for (const row of rows) {
    assert.equal(row.messageCount, 1);
    assert.ok(!Object.hasOwn(row, "metadata"));
    assert.ok(!Object.hasOwn(row, "messages"));
  }
  command({
    type: "change-fields",
    edits: [
      {
        scope: "chat",
        entityId: "a",
        key: "folderId",
        expectedRevision: 1,
        expectedEpoch: 0,
        remove: true,
      },
    ],
  });
  assert.deepEqual(
    store.getCharacter("c").chatSummaries.find((row) => row.id === "a")
      .navigation,
    { folderId: { exists: false } },
  );
  assert.equal(
    store.listChats("c").find((row) => row.id === "a").fieldRevisions.folderId,
    2,
  );
  const full = store.snapshot("a");
  assert.equal(full.chat.metadata.extension.retained, true);
  assert.ok(
    full.chat.metadata.note.startsWith("Synthetic metadata body marker"),
  );
  assert.ok(
    full.messages[0].message.data.startsWith("Synthetic message body marker"),
  );
});

test("standalone chat summaries read folder values and revisions from one WAL snapshot across a concurrent writer", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-chat-summary-snapshot-")),
    file = join(directory, "synthetic.sqlite");
  const first = new EntityStore(file);
  let second;
  t.after(() => {
    second?.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  seed(first);
  second = new EntityStore(file);
  const original = first.fieldRevisions.bind(first);
  let interleaved = false;
  first.fieldRevisions = (target) => {
    if (!interleaved && target.scope === "chat" && target.entityId === "a") {
      interleaved = true;
      second.applyCommand("synthetic-peer-folder", {
        type: "change-fields",
        edits: [
          {
            scope: "chat",
            entityId: "a",
            key: "folderId",
            expectedRevision: 1,
            expectedEpoch: 0,
            value: "synthetic-peer-folder",
          },
        ],
      });
    }
    return original(target);
  };
  const before = first.listChats("c").find((row) => row.id === "a");
  assert.equal(interleaved, true);
  assert.equal(
    before.fieldRevisions.folderId,
    1,
    "The old folder header must retain its old revision",
  );
  assert.deepEqual(before.navigation, {
    folderId: { exists: true, value: "f" },
  });
  first.fieldRevisions = original;
  const after = first.listChats("c").find((row) => row.id === "a");
  assert.equal(after.fieldRevisions.folderId, 2);
  assert.deepEqual(after.navigation, {
    folderId: { exists: true, value: "synthetic-peer-folder" },
  });
  assert.equal(
    first.getCharacter("c").chatSummaries.find((row) => row.id === "a")
      .fieldRevisions.folderId,
    2,
  );
});
