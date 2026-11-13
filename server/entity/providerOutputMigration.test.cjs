"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os"),
  { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const outputs = require("./providerOutputs.cjs");
const output = {
  request: 1,
  mode: "model",
  type: "success",
  complete: true,
  candidates: [{ key: "0", role: "char", data: "Synthetic retained response" }],
};
function fixture(t, states = ["failed"]) {
  const root = mkdtempSync(join(tmpdir(), "risu-output-migration-")),
    file = join(root, "state.sqlite");
  let store = new EntityStore(file, { now: () => 1 });
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", unknown: { retained: true } },
  });
  const jobs = [];
  for (const state of states) {
    store.applyCommand("chat-" + state, {
      type: "create-chat",
      characterId: "c",
      chatId: state,
    });
    store.applyCommand("message-" + state, {
      type: "append-message",
      chatId: state,
      messageId: "message-" + state,
      message: { role: "char", data: "Synthetic canonical history" },
    });
    store.enqueueJob("job-" + state, {
      type: "send",
      chatId: state,
      input: "Synthetic",
    });
    const job = store.claimJob("worker", 300000).job;
    if (state === "interrupted")
      store.interruptJob(
        job.id,
        job.owner,
        job.fence,
        "Synthetic interruption",
      );
    else if (state !== "running")
      store.finishJob(job.id, job.owner, job.fence, {
        state,
        result: { code: "SYNTHETIC" },
      });
    const progress = {
      stage: 3,
      unknown: { nested: [1, 2] },
      providerOutputs: [{ ...output, request: 2 }, output],
    };
    store.db
      .prepare("UPDATE jobs SET progress=? WHERE id=?")
      .run(JSON.stringify(progress), job.id);
    jobs.push(store.getJob(job.id));
  }
  store.db.exec("DROP TABLE job_provider_outputs; PRAGMA user_version=20");
  return {
    file,
    jobs,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new EntityStore(file, { now: () => 1 });
      return store;
    },
  };
}

test("schema20 output migration preserves every job state, canonical data, identity, fences and cursor", (t) => {
  const f = fixture(t, [
      "running",
      "failed",
      "cancelled",
      "interrupted",
      "completed",
    ]),
    identity = f.store.bootstrap().serverId,
    cursor = f.store.cursor();
  const snapshots = f.jobs.map((job) => f.store.snapshot(job.chatId));
  const store = f.reopen();
  assert.equal(store.schemaVersion(), 22);
  assert.equal(store.bootstrap().serverId, identity);
  assert.equal(store.cursor(), cursor);
  for (let i = 0; i < f.jobs.length; i++) {
    const before = structuredClone(f.jobs[i]);
    delete before.progress.providerOutputs;
    assert.deepEqual(store.getJob(before.id), before);
    assert.deepEqual(store.snapshot(before.chatId), snapshots[i]);
    assert.deepEqual(
      outputs.read(store, before.id),
      before.state === "completed" ? [] : [output, { ...output, request: 2 }],
    );
  }
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  f.reopen();
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(outputs.read(f.store, "job-failed"), [
    output,
    { ...output, request: 2 },
  ]);
});

test("invalid legacy output rolls back prior moved rows, schema version and table creation", (t) => {
  const f = fixture(t, ["failed", "interrupted"]);
  f.store.db
    .prepare("UPDATE jobs SET progress=? WHERE id='job-interrupted'")
    .run(
      JSON.stringify({
        providerOutputs: [{ ...output, unexpected: "synthetic" }],
      }),
    );
  const before = f.store.db
      .prepare("SELECT id,progress FROM jobs ORDER BY id")
      .all(),
    cursor = f.store.cursor();
  assert.throws(() => f.reopen(), { code: "MIGRATION_ERROR" });
  const db = new DatabaseSync(f.file);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='job_provider_outputs'",
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      db.prepare("SELECT id,progress FROM jobs ORDER BY id").all(),
      before,
    );
    assert.equal(
      db.prepare("SELECT MAX(sequence) AS seq FROM changes").get().seq,
      cursor,
    );
  } finally {
    db.close();
  }
});

test("real SQLite full migration leaves the original version20 file restorable", (t) => {
  const f = fixture(t),
    db = f.store.db;
  const data = "synthetic ".repeat(20000);
  db.prepare("UPDATE jobs SET progress=? WHERE id='job-failed'").run(
    JSON.stringify({
      providerOutputs: [
        { ...output, candidates: [{ ...output.candidates[0], data }] },
      ],
    }),
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  // max_page_count is connection-local. Exercise migration on the same
  // constructor connection with a real SQLite page limit via a temporary
  // DatabaseSync subclass, then restore the original builtin immediately.
  const before = db
    .prepare("SELECT progress FROM jobs WHERE id='job-failed'")
    .get().progress;
  f.store.close();
  const sqlite = require("node:sqlite"),
    Original = sqlite.DatabaseSync;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args) {
      super(...args);
      this.exec("PRAGMA max_page_count=" + pages);
    }
  };
  const modulePath = require.resolve("./store.cjs"),
    cached = require.cache[modulePath];
  delete require.cache[modulePath];
  try {
    const LimitedStore = require("./store.cjs").EntityStore;
    assert.throws(
      () => new LimitedStore(f.file),
      (error) =>
        error.code === "ERR_SQLITE_ERROR" && (error.errcode & 255) === 13,
    );
  } finally {
    sqlite.DatabaseSync = Original;
    require.cache[modulePath] = cached;
  }
  const observer = new Original(f.file);
  try {
    assert.equal(
      observer.prepare("PRAGMA user_version").get().user_version,
      20,
    );
    assert.equal(
      observer.prepare("SELECT progress FROM jobs WHERE id='job-failed'").get()
        .progress,
      before,
    );
    observer.exec("PRAGMA max_page_count=100000");
  } finally {
    observer.close();
  }
  const restored = new EntityStore(f.file);
  try {
    assert.equal(restored.schemaVersion(), 22);
    assert.equal(
      outputs.read(restored, "job-failed")[0].candidates[0].data,
      data,
    );
  } finally {
    restored.close();
  }
});

test("a future schema is rejected without downgrading it", (t) => {
  const f = fixture(t);
  f.store.db.exec("PRAGMA user_version=23");
  assert.throws(() => f.reopen(), { code: "SCHEMA_TOO_NEW" });
  const db = new DatabaseSync(f.file);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  } finally {
    db.close();
  }
});
