"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-notice-")),
    file = join(root, "state.sqlite");
  let now = 1000;
  const store = new EntityStore(file, { now: () => now });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: { type: "character", name: "Synthetic" },
    chat: { chatId: "a", metadata: {} },
  });
  store.enqueueJob("job", { type: "button", chatId: "a", data: "synthetic" });
  const { job } = store.claimJob("owner");
  return {
    store,
    file,
    job,
    time: (value) => {
      now = value;
    },
    emit: (position, message) =>
      store.publishJobNotice(job.id, job.owner, job.fence, position, message),
  };
}
test("notifications remain after failure/reopen; bootstrap, events and list contain no bodies and display clocks stay stable", (t) => {
  const f = fixture(t),
    before = f.store.displayState("a", {});
  const text = "<script>synthetic</script>한글";
  const first = f.emit(1, text);
  assert.equal(f.store.displayState("a", {}).inputClock, before.inputClock);
  assert.equal(JSON.stringify(f.store.bootstrap()).includes(text), false);
  assert.equal(
    JSON.stringify(f.store.changes(before.cursor)).includes(text),
    false,
  );
  assert.equal(JSON.stringify(f.store.listNotices()).includes(text), false);
  assert.equal(f.store.readNotice(first.notice.id).notice.message, text);
  f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
    state: "failed",
    result: { code: "SYNTHETIC", message: "later failure" },
  });
  const reopened = new EntityStore(f.file);
  try {
    assert.equal(reopened.listNotices().count, 1);
    assert.equal(reopened.readNotice(first.notice.id).notice.message, text);
  } finally {
    reopened.close();
  }
  assert.equal(f.store.snapshot("a").messages.length, 0);
});
test("worker publication is ordered, identical retries are idempotent and changed retries roll back", (t) => {
  const f = fixture(t),
    first = f.emit(1, "first"),
    cursor = f.store.cursor();
  assert.deepEqual(f.emit(1, "first"), first);
  assert.equal(f.store.cursor(), cursor);
  assert.throws(() => f.emit(1, "changed"), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => f.emit(3, "gap"), { code: "INVALID_COMMAND" });
  assert.equal(f.emit(2, "second").notice.position, 2);
  assert.equal(f.store.listNotices().count, 2);
});
test("expired, wrong-fence, cancelled and terminal workers cannot publish or replay", (t) => {
  const f = fixture(t);
  f.emit(1, "first");
  assert.throws(
    () =>
      f.store.publishJobNotice(
        f.job.id,
        f.job.owner,
        f.job.fence + 1,
        2,
        "wrong",
      ),
    { code: "STALE_WORKER" },
  );
  f.time(f.job.leaseUntil);
  assert.throws(() => f.emit(1, "first"), { code: "STALE_WORKER" });
  f.time(1000);
  f.store.requestCancel(f.job.id);
  assert.throws(() => f.emit(2, "cancelled"), { code: "JOB_CANCELLED" });
  f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
    state: "cancelled",
    result: {},
  });
  assert.throws(() => f.emit(1, "first"), { code: "STALE_WORKER" });
  assert.equal(f.store.listNotices().count, 1);
});
test("peer acknowledgement is shared and receipt replay after reopening cannot acknowledge a later item", (t) => {
  const f = fixture(t),
    first = f.emit(1, "first"),
    second = f.emit(2, "second");
  const command = {
    type: "acknowledge-notice",
    noticeId: first.notice.id,
    expectedRevision: 1,
  };
  const receipt = f.store.applyCommand("ack", command),
    cursor = f.store.cursor();
  const peer = new EntityStore(f.file, { now: () => 1000 });
  try {
    assert.equal(peer.listNotices().items[0].id, second.notice.id);
    assert.deepEqual(peer.applyCommand("ack", command), receipt);
    peer.applyCommand("peer-ack", command);
    assert.equal(peer.cursor(), cursor);
    assert.equal(peer.listNotices().count, 1);
    assert.throws(
      () =>
        peer.applyCommand("ack", { ...command, noticeId: second.notice.id }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    assert.throws(
      () =>
        peer.applyCommand("bad-revision", { ...command, expectedRevision: 2 }),
      { code: "REVISION_CONFLICT" },
    );
    assert.equal(
      peer.db
        .prepare("SELECT COUNT(*) AS n FROM commands WHERE id='bad-revision'")
        .get().n,
      0,
    );
  } finally {
    peer.close();
  }
});
test("body budgets count UTF-8 bytes and fail explicitly without partial events", (t) => {
  const f = fixture(t),
    cursor = f.store.cursor();
  assert.throws(() => f.emit(1, "가".repeat(21846)), { code: "NOTICE_LIMIT" });
  assert.equal(f.store.cursor(), cursor);
  for (let i = 1; i <= 16; i++) f.emit(i, "x".repeat(65536));
  const full = f.store.cursor();
  assert.throws(() => f.emit(17, "x"), { code: "NOTICE_LIMIT" });
  assert.equal(f.store.cursor(), full);
  assert.equal(f.store.listNotices().count, 16);
});
test("bounded unread pagination and count do not load bodies; deletion retains already emitted side effects", (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 60; i++) f.emit(i, "message" + i);
  const first = f.store.listNotices({ limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.count, 60);
  const last = f.store.listNotices({ limit: 50, after: first.next });
  assert.equal(last.items.length, 10);
  assert.equal(last.items[0].position, 51);
  assert.equal(last.next, null);
  assert.throws(() => f.store.listNotices({ limit: 51 }), {
    code: "INVALID_COMMAND",
  });
  f.store.applyCommand("spare-chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: {},
  });
  f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
    state: "failed",
    result: { reason: "synthetic terminal state" },
  });
  f.store.applyCommand("delete", {
    type: "delete-chat",
    chatId: "a",
    expectedRevision: f.store.requireChat("a").revision,
    expectedEpoch: f.store.fieldEpoch({ scope: "chat", entityId: "a" }),
  });
  assert.equal(f.store.listNotices().count, 60);
  assert.throws(() => f.emit(61, "obsolete"));
});
test("schema18 migration preserves canonical data, receipts and server identity while starting an empty notice queue", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a"),
    identity = f.store.bootstrap().serverId;
  f.store.db.exec("DROP TABLE job_notices; PRAGMA user_version=18;");
  const migrated = new EntityStore(f.file);
  try {
    assert.equal(migrated.schemaVersion(), 22);
    assert.equal(migrated.listNotices().count, 0);
    assert.deepEqual(migrated.snapshot("a"), before);
    assert.equal(migrated.bootstrap().serverId, identity);
    assert.equal(migrated.getJob("job").id, "job");
  } finally {
    migrated.close();
  }
});
