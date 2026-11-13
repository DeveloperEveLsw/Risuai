"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand("chat-" + chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
    });
  store.applyCommand("module", {
    type: "put-resource",
    kind: "module",
    resourceId: "m",
    expectedRevision: 0,
    payload: { id: "m", name: "Synthetic" },
  });
  function claim(chatId) {
    store.enqueueJob("job-" + chatId, {
      type: "send",
      chatId,
      input: "Synthetic",
    });
    return store.claimJob("worker");
  }
  const claimed = claim("a");
  const writes = {
    chatId: "a",
    expectedRevision: claimed.job.startedRevision,
    resourceReads: [{ kind: "module", id: "m", expectedEpoch: 0 }],
    messages: [
      {
        id: "result",
        expectedRevision: 0,
        message: { role: "char", data: "Synthetic result" },
      },
    ],
  };
  const finish = (value = writes) =>
    store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
      state: "completed",
      writeSet: value,
    });
  return { store, claim, claimed, writes, finish };
}
test("resource incarnation validation rolls back canonical writes and journal after deletion/recreation", (t) => {
  const f = fixture(t),
    peer = f.claim("b");
  f.store.finishJob(peer.job.id, "worker", peer.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "b",
      expectedRevision: peer.job.startedRevision,
      deleteResources: [{ kind: "module", id: "m", expectedRevision: 1 }],
    },
  });
  f.store.applyCommand("recreate", {
    type: "put-resource",
    kind: "module",
    resourceId: "m",
    expectedRevision: 2,
    payload: { id: "m", name: "Replacement" },
  });
  const before = f.store.snapshot("a"),
    cursor = f.store.cursor();
  assert.throws(() => f.finish(), { code: "REVISION_CONFLICT" });
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.getResource("module", "m").payload.name, "Replacement");
});
test("same-incarnation resource payload edits retain captured execution semantics and merge", (t) => {
  const f = fixture(t);
  f.store.applyCommand("edit", {
    type: "put-resource",
    kind: "module",
    resourceId: "m",
    expectedRevision: 1,
    payload: { id: "m", name: "Peer configuration" },
  });
  f.finish();
  assert.equal(
    f.store.snapshot("a").messages.at(-1).message.data,
    "Synthetic result",
  );
  assert.equal(
    f.store.getResource("module", "m").payload.name,
    "Peer configuration",
  );
});
test("invalid resource dependency records fail before partial messages and cursor advancement", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a"),
    cursor = f.store.cursor(),
    read = f.writes.resourceReads[0];
  for (const reads of [
    null,
    {},
    [{}],
    [{ ...read, kind: "global-variable" }],
    [{ ...read, expectedEpoch: -1 }],
    [{ ...read, chatId: "b" }],
    [read, read],
    Array(4097).fill(read),
  ]) {
    assert.throws(() => f.finish({ ...f.writes, resourceReads: reads }), {
      code: "INVALID_COMMAND",
    });
    assert.deepEqual(f.store.snapshot("a"), before);
    assert.equal(f.store.cursor(), cursor);
  }
});
test("an absent resource read rejects persistence while trusted legacy sets retain their old policy", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.finish({
        ...f.writes,
        resourceReads: [{ kind: "module", id: "absent", expectedEpoch: 0 }],
      }),
    { code: "NOT_FOUND" },
  );
  assert.deepEqual(f.store.snapshot("a").messages, []);
  const { resourceReads, ...legacy } = f.writes;
  f.finish(legacy);
  assert.equal(f.store.snapshot("a").messages.length, 1);
});
