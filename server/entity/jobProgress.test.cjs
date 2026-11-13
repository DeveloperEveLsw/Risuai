"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-progress-")),
    file = join(directory, "state.sqlite"),
    store = new EntityStore(file, options);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
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
  });
  store.enqueueJob("job", { type: "send", chatId: "a", input: "synthetic" });
  return { store, file };
}

test("lean claims never load history and progress survives reopening without entering the canonical chat", (t) => {
  const { store, file } = fixture(t);
  store.executionSnapshot = () => {
    throw new Error("Admission must not load the engine snapshot");
  };
  const claimed = store.claimJob("worker", 30000, { includeSnapshot: false });
  assert.equal(claimed.snapshot, undefined);
  assert.ok(JSON.stringify(claimed).length < 1000);
  const cursor = store.cursor();
  store.writeJobProgress("job", "worker", claimed.job.fence, {
    providerStarted: true,
    streaming: true,
    messages: [
      { role: "char", data: "partial".repeat(1000), chatId: "stable" },
    ],
  });
  const changes = store.changes(cursor).changes;
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].payload, { jobId: "job", progressRevision: 1 });
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal("progress" in store.listJobs("a")[0], false);
  assert.throws(
    () => store.writeJobProgress("job", "wrong", claimed.job.fence, {}),
    { code: "STALE_WORKER" },
  );
  store.close();
  const observer = new EntityStore(file);
  t.after(() => observer.close());
  assert.equal(observer.getJob("job").progress.messages[0].chatId, "stable");
  assert.equal(observer.getJob("job").progressRevision, 1);
});

test("interruption fences older workers, retains output and never reclaims a potentially paid request", (t) => {
  const { store } = fixture(t),
    claimed = store.claimJob("worker");
  store.writeJobProgress("job", "worker", claimed.job.fence, {
    providerStarted: true,
    messages: [{ role: "char", data: "partial", chatId: "stable" }],
  });
  const result = store.interruptJob(
    "job",
    "worker",
    claimed.job.fence,
    "Synthetic worker stopped",
  );
  assert.equal(result.state, "interrupted");
  assert.equal(result.progress.messages[0].data, "partial");
  assert.equal(store.claimJob("another"), null);
  assert.throws(
    () =>
      store.finishJob("job", "worker", claimed.job.fence, {
        state: "completed",
        messages: [],
      }),
    { code: "STALE_WORKER" },
  );
  assert.equal(store.snapshot("a").messages.length, 0);
});

test("expired cancellation is terminal and future cursors require a new snapshot", (t) => {
  let now = 100;
  const { store } = fixture(t, { now: () => now }),
    claimed = store.claimJob("worker", 10);
  store.requestCancel("job");
  now = 111;
  assert.equal(store.claimJob("next"), null);
  assert.equal(store.getJob("job").state, "cancelled");
  assert.throws(
    () => store.writeJobProgress("job", "worker", claimed.job.fence, {}),
    { code: "STALE_WORKER" },
  );
  assert.throws(() => store.changes(store.cursor() + 1), {
    code: "RESYNC_REQUIRED",
  });
});

test("schema-v3 migration adds empty progress fields and preserves queued jobs and bookkeeping", (t) => {
  const { store, file } = fixture(t);
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: { statics: { messages: 12, imports: 2 } },
  });
  store.db.exec(
    "ALTER TABLE jobs DROP COLUMN progress; ALTER TABLE jobs DROP COLUMN progress_revision; PRAGMA user_version=3;",
  );
  store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  assert.equal(migrated.getJob("job").state, "queued");
  assert.deepEqual(migrated.getJob("job").progress, {});
  assert.equal(migrated.getJob("job").progressRevision, 0);
  assert.equal(
    migrated.getResource("settings", "global").payload.statics.messages,
    12,
  );
});

test("schema-v4 migration assigns an identity once and preserves progress, state and revisions", (t) => {
  const { store, file } = fixture(t);
  const claimed = store.claimJob("worker");
  store.writeJobProgress("job", "worker", claimed.job.fence, {
    stage: 2,
    messages: [{ data: "synthetic partial" }],
  });
  const before = store.getJob("job");
  store.db.exec("DROP TABLE runtime_identity; PRAGMA user_version=4;");
  store.close();
  const migrated = new EntityStore(file);
  const identity = migrated.bootstrap().serverId;
  assert.match(identity, /^[0-9a-f-]{36}$/);
  assert.deepEqual(migrated.getJob("job"), before);
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  migrated.close();
  const reopened = new EntityStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.bootstrap().serverId, identity);
  const other = new EntityStore(":memory:");
  try {
    assert.notEqual(other.bootstrap().serverId, identity);
  } finally {
    other.close();
  }
});
