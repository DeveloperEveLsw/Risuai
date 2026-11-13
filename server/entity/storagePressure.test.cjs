"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs"),
  { tmpdir } = require("node:os"),
  { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-storage-pressure-")),
    store = new EntityStore(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  store.applyCommand("chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "Synthetic" },
  });
  return store;
}
function limit(store) {
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const count = store.db.prepare("PRAGMA page_count").get().page_count;
  store.db.exec("PRAGMA max_page_count=" + count);
}
function full(error) {
  return error.code === "ERR_SQLITE_ERROR" && (error.errcode & 255) === 13;
}
function release(store) {
  store.db.exec("PRAGMA max_page_count=100000");
}
const large = "authored synthetic text ".repeat(16000);
test("real SQLITE_FULL rolls back a message and journal atomically; the same command recovers once after capacity returns", (t) => {
  const store = fixture(t),
    before = store.snapshot("a"),
    cursor = store.cursor();
  const command = {
    type: "append-message",
    chatId: "a",
    messageId: "large",
    message: { role: "char", data: large },
  };
  limit(store);
  assert.throws(() => store.applyCommand("recover-message", command), full);
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal(store.snapshot("a").chat.revision, before.chat.revision);
  assert.equal(store.cursor(), cursor);
  release(store);
  const receipt = store.applyCommand("recover-message", command);
  assert.deepEqual(store.applyCommand("recover-message", command), receipt);
  assert.equal(store.snapshot("a").messages.length, 1);
  assert.equal(store.snapshot("a").messages[0].message.data, large);
  assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
test("real SQLITE_FULL during job admission leaves no accepted job or cursor; the same request can be admitted after capacity returns", (t) => {
  const store = fixture(t),
    cursor = store.cursor(),
    command = { type: "send", chatId: "a", input: large };
  limit(store);
  assert.throws(() => store.enqueueJob("recover-job", command), full);
  assert.equal(store.getJob("recover-job"), null);
  assert.equal(store.cursor(), cursor);
  release(store);
  const first = store.enqueueJob("recover-job", command);
  assert.equal(first.state, "queued");
  assert.equal(store.enqueueJob("recover-job", command).id, first.id);
  assert.equal(store.listJobs("a").length, 1);
});
test("real SQLITE_FULL at generation finalization commits neither messages nor variables; the same fenced result can be saved after capacity returns", (t) => {
  const store = fixture(t);
  store.enqueueJob("finish-full", { type: "send", chatId: "a" });
  const claimed = store.claimJob("worker", 60000),
    cursor = store.cursor();
  const result = {
    state: "completed",
    messages: [{ id: "reply", message: { role: "char", data: large } }],
    variables: [{ key: "saved", value: true }],
  };
  limit(store);
  assert.throws(
    () => store.finishJob("finish-full", "worker", claimed.job.fence, result),
    full,
  );
  assert.equal(store.getJob("finish-full").state, "running");
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal(store.snapshot("a").variables.length, 0);
  assert.equal(store.cursor(), cursor);
  release(store);
  store.finishJob("finish-full", "worker", claimed.job.fence, result);
  assert.equal(store.getJob("finish-full").state, "completed");
  assert.equal(store.snapshot("a").messages.length, 1);
  assert.equal(
    store.snapshot("a").variables.find((v) => v.key === "saved").value,
    true,
  );
});
