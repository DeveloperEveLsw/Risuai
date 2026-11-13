"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  const command = (c) => store.applyCommand("synthetic-window-" + ++next, c);
  command({
    type: "create-character",
    characterId: "c",
    chat: { chatId: "a", metadata: { name: "Synthetic" } },
    definition: { name: "Synthetic", type: "character" },
  });
  command({
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "Other" },
  });
  for (let i = 0; i < 220; i++)
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
  return { store, command };
}
test("bounded stable-ID windows and bidirectional position pages preserve dense ordinals through deletion gaps and leave canonical data unchanged", (t) => {
  const { store, command } = fixture(t);
  for (const messageId of ["m3", "m5"])
    command({
      type: "remove-message",
      chatId: "a",
      messageId,
      expectedRevision: 1,
      expectedChatRevision: store.snapshot("a").chat.revision,
      expectedChatEpoch: 0,
      mode: "one",
    });
  const before = store.snapshot("a", { limit: 1000 });
  const around = store.snapshot("a", { around: "m60", limit: 20 });
  assert.deepEqual(
    around.messages.map((m) => m.id),
    Array.from({ length: 20 }, (_, i) => "m" + (50 + i)),
  );
  assert.deepEqual(around.history, { count: 218, offset: 48 });
  assert.equal(around.messages[10].ordinal, 58);
  assert.equal(around.hasEarlier, true);
  assert.equal(around.hasLater, true);
  const earlier = store.snapshot("a", { before: 50, limit: 20 });
  assert.deepEqual(
    earlier.messages.map((m) => m.position),
    Array.from({ length: 20 }, (_, i) => 30 + i),
  );
  const later = store.snapshot("a", { after: 69, limit: 20 });
  assert.deepEqual(
    later.messages.map((m) => m.position),
    Array.from({ length: 20 }, (_, i) => 70 + i),
  );
  const start = store.snapshot("a", { around: "m0", limit: 20 });
  assert.equal(start.hasEarlier, false);
  assert.equal(start.hasLater, true);
  assert.equal(start.messages[0].ordinal, 0);
  const end = store.snapshot("a", { around: "m219", limit: 20 });
  assert.equal(end.messages[0].id, "m200");
  assert.equal(end.hasLater, false);
  assert.deepEqual(store.snapshot("a", { limit: 1000 }), before);
  assert.equal(store.executionSnapshot("a").messages.length, 218);
});
test("window boundaries reject foreign/deleted IDs and conflicting or malformed seeks; empty boundary pages keep accurate direction metadata", (t) => {
  const { store } = fixture(t);
  for (const options of [
    { around: "m0", before: 1 },
    { after: 1, before: 1 },
    { after: -1 },
    { around: "missing" },
    { around: "" },
    { limit: 0 },
  ])
    assert.throws(
      () => store.snapshot("a", options),
      (e) => e.code === "INVALID_COMMAND",
    );
  assert.throws(
    () => store.snapshot("b", { around: "m0" }),
    (e) => e.code === "INVALID_COMMAND",
  );
  const low = store.snapshot("a", { before: 0, limit: 20 });
  assert.equal(low.messages.length, 0);
  assert.equal(low.history.offset, 0);
  assert.equal(low.hasLater, true);
  assert.equal(low.hasEarlier, false);
  const high = store.snapshot("a", { after: 219, limit: 20 });
  assert.equal(high.messages.length, 0);
  assert.equal(high.history.offset, 220);
  assert.equal(high.hasEarlier, true);
  assert.equal(high.hasLater, false);
  assert.equal(store.snapshot("b", { after: 0 }).hasEarlier, false);
});
