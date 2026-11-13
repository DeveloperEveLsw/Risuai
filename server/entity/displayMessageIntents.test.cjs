"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic source" },
    chat: { chatId: "a", metadata: { name: "Synthetic" } },
  });
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: {
      role: "char",
      data: "Synthetic raw MARKER",
      syntheticUnknown: { retained: true },
    },
  });
  return store;
}
const row = (store) => store.snapshot("a").messages.find((m) => m.id === "m");
const value = (store) =>
  store.snapshot("a").variables.find((v) => v.key === "$flag") ?? null;
const receipts = (store) =>
  store.db.prepare("SELECT COUNT(*) AS count FROM display_effects").get().count;
function command(store, extra = {}) {
  const state = store.displayState("a"),
    m = row(store);
  return {
    type: "apply-display-effects",
    chatId: "a",
    expectedChatEpoch: state.chatEpoch,
    expectedCharacterEpoch: state.characterEpoch,
    inputClock: state.inputClock,
    codeHash: "b".repeat(64),
    source: {
      kind: "message",
      messageId: m.id,
      expectedRevision: m.revision,
      contentHash: createHash("sha256").update(m.message.data).digest("hex"),
    },
    reads: [],
    edits: [],
    messageEdits: [
      {
        messageId: m.id,
        expectedRevision: m.revision,
        text: "Synthetic processed MARKER",
      },
    ],
    ...extra,
  };
}

test("stable source rewrite, variable effects and receipt are atomic; other-device retries and derived source echoes cannot rewrite again", (t) => {
  const store = fixture(t),
    before = store.displayState("a");
  const packet = command(store, {
    edits: [
      {
        scope: "chat",
        chatId: "a",
        key: "$flag",
        expectedRevision: 0,
        value: 1,
      },
    ],
  });
  const result = store.applyCommand("first-device", packet),
    cursor = store.cursor();
  assert.equal(row(store).revision, 2);
  assert.equal(row(store).message.data, "Synthetic processed MARKER");
  assert.deepEqual(row(store).message.syntheticUnknown, { retained: true });
  assert.equal(value(store).value, 1);
  assert.equal(receipts(store), 1);
  assert.equal(store.displayState("a").inputClock, before.inputClock);
  assert.deepEqual(store.applyCommand("first-device", packet), result);
  assert.equal(store.applyCommand("other-device", packet).deduplicated, true);
  assert.equal(store.cursor(), cursor);
  const events = store.changes(before.cursor).changes;
  assert.deepEqual(
    events.map((e) => e.type),
    ["variable", "message", "display-effect"],
  );
  assert.ok(
    events.every((e) => e.payload.displayEffectId === result.displayKey),
  );
  assert.equal(events[1].payload.displayCodeHash, packet.codeHash);
  assert.deepEqual(row(store).displayOrigin, events[1].payload.displayOrigin);
  assert.equal(row(store).displayOrigin.displayKey, result.displayKey);
  assert.equal(row(store).displayOrigin.messageRevision, 2);
  const echo = command(store, {
    edits: [
      {
        scope: "chat",
        chatId: "a",
        key: "$flag",
        expectedRevision: 1,
        value: 2,
      },
    ],
    messageEdits: [
      {
        messageId: "m",
        expectedRevision: 2,
        text: "Synthetic recursive change",
      },
    ],
  });
  const ignored = store.applyCommand("source-echo", echo);
  assert.equal(ignored.deduplicated, true);
  assert.equal(ignored.derivedFrom, result.displayKey);
  assert.equal(row(store).revision, 2);
  assert.equal(value(store).value, 1);
  assert.equal(store.cursor(), cursor);
  assert.equal(receipts(store), 1);
  store.applyCommand("new-external-input", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$input",
    value: "Synthetic next",
    expectedRevision: 0,
  });
  const next = store.applyCommand("next-occurrence", {
    ...echo,
    inputClock: store.displayState("a").inputClock,
  });
  assert.equal(next.deduplicated, false);
  assert.equal(row(store).revision, 3);
  assert.equal(value(store).value, 2);
  assert.equal(receipts(store), 2);
  assert.equal(
    store.db
      .prepare(
        "SELECT message_revision FROM display_message_origins WHERE message_id='m'",
      )
      .get().message_revision,
    3,
  );
});

test("message intent rejects unrelated/transient/oversized source proposals and stale read CAS without changing any value or receipt", (t) => {
  const store = fixture(t);
  store.applyCommand("dependency", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$dependency",
    expectedRevision: 0,
    value: "Synthetic source",
  });
  const packet = command(store),
    cursor = store.cursor();
  for (const extra of [
    { source: { kind: "view", contentHash: "a".repeat(64) } },
    {
      messageEdits: [
        { messageId: "other", expectedRevision: 1, text: "Synthetic" },
      ],
    },
    {
      messageEdits: [
        { messageId: "m", expectedRevision: 2, text: "Synthetic" },
      ],
    },
    {
      messageEdits: [
        { messageId: "m", expectedRevision: 1, text: "한".repeat(100000) },
      ],
    },
    { messageEdits: [packet.messageEdits[0], packet.messageEdits[0]] },
    { messageEdits: [{ ...packet.messageEdits[0], undeclared: true }] },
  ])
    assert.throws(
      () =>
        store.applyCommand("invalid-" + JSON.stringify(extra).length, {
          ...packet,
          ...extra,
        }),
      { code: "INVALID_COMMAND" },
    );
  assert.throws(
    () =>
      store.applyCommand("stale-read", {
        ...packet,
        reads: [
          {
            scope: "chat",
            chatId: "a",
            key: "$dependency",
            expectedRevision: 0,
          },
        ],
        edits: [
          {
            scope: "chat",
            chatId: "a",
            key: "$flag",
            expectedRevision: 0,
            value: 1,
          },
        ],
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(row(store).revision, 1);
  assert.equal(value(store), null);
  assert.equal(receipts(store), 0);
  assert.equal(store.cursor(), cursor);
});

test("running same-chat generation prevents the joint rewrite and rolls back its earlier variable effect; finishing permits the same durable request", (t) => {
  const store = fixture(t);
  store.enqueueJob("generation", { type: "button", chatId: "a" });
  const { job } = store.claimJob("synthetic-owner");
  const packet = command(store, {
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$flag",
          expectedRevision: 0,
          value: 1,
        },
      ],
    }),
    cursor = store.cursor();
  assert.throws(() => store.applyCommand("waiting-intent", packet), {
    code: "CHAT_BUSY",
  });
  assert.equal(value(store), null);
  assert.equal(row(store).revision, 1);
  assert.equal(receipts(store), 0);
  assert.equal(store.cursor(), cursor);
  store.finishJob(job.id, "synthetic-owner", job.fence, { state: "completed" });
  store.applyCommand("waiting-intent", packet);
  assert.equal(row(store).revision, 2);
  assert.equal(value(store).value, 1);
});

test("schema12 upgrades source-origin metadata atomically while preserving old variable receipts, message data and server identity", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-display-message-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic.sqlite");
  let store = fixture(t, file);
  const old = command(store, {
    messageEdits: undefined,
    edits: [
      {
        scope: "chat",
        chatId: "a",
        key: "$flag",
        expectedRevision: 0,
        value: 1,
      },
    ],
  });
  delete old.messageEdits;
  const receipt = store.applyCommand("old-proposal", old),
    before = store.bootstrap(),
    message = row(store);
  store.db.exec("DROP TABLE display_message_origins; PRAGMA user_version=12;");
  store.close();
  store = new EntityStore(file);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(store.bootstrap(), before);
  assert.deepEqual(row(store), message);
  assert.deepEqual(store.applyCommand("old-proposal", old), receipt);
  assert.equal(receipts(store), 1);
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM display_message_origins")
      .get().count,
    0,
  );
});

test("an identical source proposal preserves its revision and deletion removes relational origin headers", (t) => {
  const store = fixture(t);
  const unchanged = command(store);
  unchanged.messageEdits[0].text = row(store).message.data;
  const cursor = store.cursor();
  store.applyCommand("same-text", unchanged);
  assert.equal(row(store).revision, 1);
  assert.equal(row(store).displayOrigin, undefined);
  assert.deepEqual(
    store.changes(cursor).changes.map((e) => e.type),
    ["display-effect"],
  );
  store.applyCommand("external-clock", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$input",
    value: "next",
    expectedRevision: 0,
  });
  const result = store.applyCommand("rewrite", command(store));
  assert.equal(row(store).displayOrigin.displayKey, result.displayKey);
  store.applyCommand("retained-chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "Synthetic retained" },
  });
  store.applyCommand("delete", {
    type: "delete-chat",
    chatId: "a",
    expectedRevision: store.requireChat("a").revision,
    expectedEpoch: store.displayState("a").chatEpoch,
  });
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM display_message_origins")
      .get().count,
    0,
  );
  assert.equal(receipts(store), 0);
});
