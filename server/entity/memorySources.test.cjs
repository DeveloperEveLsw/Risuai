"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t, fmIndex = -1) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      firstMessage: "Greeting",
      alternateGreetings: ["Alternate"],
      desc: "unloaded".repeat(50000),
    },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand(chatId, {
      type: "create-chat",
      chatId,
      characterId: "c",
      metadata: {
        fmIndex,
        hypaV3Data: { summaries: [], unknown: "not returned" },
      },
    });
  for (let i = 0; i < 5; i++)
    store.applyCommand("m" + i, {
      type: "append-message",
      chatId: "a",
      messageId: "m" + i,
      message: {
        role: i % 2 ? "char" : "user",
        data: i === 4 ? "large".repeat(50000) : "Message " + i,
      },
    });
  const expectedEpoch = store.fieldEpoch({ scope: "chat", entityId: "a" });
  return {
    store,
    read: (options) =>
      store.readMemorySource("a", { expectedEpoch, ...options }),
    expectedEpoch,
  };
}
test("memory references use stable IDs outside a UI page and never return unrequested bodies", (t) => {
  const f = fixture(t);
  const value = f.read({
    mode: "membership",
    memos: [null, "m0", "m4", "missing", "m0"],
  });
  assert.deepEqual(value.present, [true, true, true, false, true]);
  assert.ok(JSON.stringify(value).length < 500);
  assert.equal(Object.hasOwn(value, "source"), false);
  const message = f.read({ mode: "message", memo: "m0" });
  assert.equal(message.source.message.data, "Message 0");
  assert.equal(message.source.index, 0);
  assert.ok(JSON.stringify(message).length < 500);
  assert.equal(
    f.store.readMemorySource("b", {
      expectedEpoch: 0,
      mode: "membership",
      memos: ["m0"],
    }).present[0],
    false,
  );
});
test("selected greetings and original next-source fallback are independent from loaded history", (t) => {
  const f = fixture(t, 0);
  assert.equal(
    f.read({ mode: "message", memo: null }).source.message.data,
    "Alternate",
  );
  assert.equal(
    f.read({ mode: "next", memo: "m1" }).source.message.data,
    "Message 2",
  );
  assert.equal(f.read({ mode: "next", memo: "m4" }).source, null);
  assert.equal(
    f.read({ mode: "next", memo: "missing" }).source.message.data,
    "Alternate",
  );
});
test("memory source ordinals remain dense after message deletion", (t) => {
  const f = fixture(t);
  const chat = f.store.requireChat("a");
  const row = f.store.db
    .prepare("SELECT revision FROM messages WHERE id='m1'")
    .get();
  f.store.applyCommand("remove", {
    type: "remove-message",
    mode: "one",
    chatId: "a",
    messageId: "m1",
    expectedRevision: row.revision,
    expectedChatEpoch: f.expectedEpoch,
    expectedChatRevision: chat.revision,
  });
  assert.equal(f.read({ mode: "message", memo: "m2" }).source.index, 1);
  assert.equal(f.read({ mode: "message", memo: "m1" }).source, null);
});
test("memory source requests enforce owner incarnation and bounded membership input", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.read({ mode: "membership", memos: Array(257).fill("m0") }),
    (e) => e.code === "INVALID_COMMAND",
  );
  assert.throws(
    () => f.read({ mode: "membership", memos: [{}] }),
    (e) => e.code === "INVALID_COMMAND",
  );
  assert.throws(
    () =>
      f.store.readMemorySource("a", {
        expectedEpoch: f.expectedEpoch + 1,
        mode: "message",
        memo: "m0",
      }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () => f.store.readMemorySource("a", null),
    (e) => e.code === "INVALID_COMMAND",
  );
});

test("a deleted and recreated chat rejects the old modal owner even with identical IDs", (t) => {
  const f = fixture(t);
  f.store.applyCommand("delete", {
    type: "delete-chat",
    chatId: "a",
    expectedRevision: f.store.requireChat("a").revision,
    expectedEpoch: f.expectedEpoch,
  });
  f.store.applyCommand("recreate", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: {},
  });
  assert.throws(
    () => f.read({ mode: "message", memo: null }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  const value = f.store.readMemorySource("a", {
    mode: "membership",
    expectedEpoch: f.store.fieldEpoch({ scope: "chat", entityId: "a" }),
    memos: ["m0", null],
  });
  assert.deepEqual(value.present, [false, true]);
});

for (const fmIndex of ["invalid", {}, -2, 0.5, 999, "00", "0e0"])
  test(`invalid or missing alternate greeting ${JSON.stringify(fmIndex)} is absent without a SQL failure`, (t) => {
    const f = fixture(t, fmIndex);
    assert.equal(f.read({ mode: "message", memo: null }).source, null);
    assert.deepEqual(
      f.read({ mode: "membership", memos: [null, "m0"] }).present,
      [false, true],
    );
    assert.equal(
      f.read({ mode: "next", memo: null }).source.message.data,
      "Message 0",
    );
  });

test("a canonical string greeting index preserves original array lookup compatibility", (t) => {
  const f = fixture(t, "0");
  assert.equal(
    f.read({ mode: "message", memo: null }).source.message.data,
    "Alternate",
  );
  assert.deepEqual(f.read({ mode: "membership", memos: [null] }).present, [
    true,
  ]);
});
