"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  store.applyCommand("char", {
    type: "create-character",
    characterId: "c",
    definition: { type: "character", name: "Synthetic" },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand(chatId, {
      type: "create-chat",
      chatId,
      characterId: "c",
    });
  function add(serial, chatId = "a") {
    const jobId = "job-" + serial;
    store.enqueueJob(jobId, {
      type: "send",
      chatId,
      text: "Authored input marker",
    });
    // Authored terminal history, no provider execution. Large unsupported bodies
    // detect accidental JSON hydration in metadata reads.
    store.db
      .prepare("UPDATE jobs SET type=?,state=?,result=?,progress=? WHERE id=?")
      .run(
        serial % 3 ? "send" : "memory-summary",
        serial % 5 ? "completed" : "failed",
        JSON.stringify({ marker: "Body must stay unloaded".repeat(1000) }),
        JSON.stringify({ text: "Progress must stay unloaded" }),
        jobId,
      );
    return jobId;
  }
  for (let i = 0; i < 137; i++) add(i);
  for (let i = 137; i < 160; i++) add(i, "b");
  const read = (options = {}) =>
    store.listJobHistory("a", { expectedEpoch: 0, ...options });
  return { store, add, read };
}
test("body-free pages reach every old job across all filters without loading a whole archive", (t) => {
  const f = fixture(t);
  assert.ok(!f.store.listJobs("a").some((j) => j.id === "job-0"));
  for (const filter of ["all", "memory", "failed"]) {
    const ids = [];
    let after;
    do {
      const page = f.read({ filter, limit: 7, ...(after ? { after } : {}) });
      assert.ok(page.items.length <= 7);
      assert.ok(!JSON.stringify(page).includes("Body must stay unloaded"));
      assert.ok(!JSON.stringify(page).includes("Progress must stay unloaded"));
      assert.ok(page.items.every((j) => j.chatId === "a"));
      ids.push(...page.items.map((j) => j.id));
      after = page.older;
    } while (after);
    const expected = Array.from({ length: 137 }, (_, i) => i)
      .reverse()
      .filter(
        (i) =>
          filter === "all" || (filter === "memory" ? i % 3 === 0 : i % 5 === 0),
      )
      .map((i) => "job-" + i);
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, ids.length);
  }
});
test("older/newer navigation preserves an admission high-water mark when new work arrives", (t) => {
  const f = fixture(t),
    first = f.read({ limit: 10 });
  const second = f.read({ limit: 10, after: first.older });
  const third = f.read({ limit: 10, after: second.older });
  f.add(160);
  assert.deepEqual(
    f.read({ limit: 10, after: third.newer }).items,
    second.items,
  );
  assert.deepEqual(
    f.read({ limit: 10, after: second.newer }).items,
    first.items,
  );
  assert.equal(f.read({ limit: 10, after: second.newer }).newer, null);
  assert.equal(f.read().items[0].id, "job-160");
});
test("cursors reject other chats, databases and filters and reads never write", (t) => {
  const f = fixture(t),
    other = fixture(t),
    page = f.read({ filter: "memory", limit: 4 });
  const before = f.store.cursor();
  const identity = (e) => e.code === "IDENTITY_CONFLICT";
  assert.throws(
    () =>
      f.store.listJobHistory("b", {
        expectedEpoch: 0,
        filter: "memory",
        after: page.older,
      }),
    identity,
  );
  assert.throws(
    () => other.read({ filter: "memory", after: page.older }),
    identity,
  );
  assert.throws(() => f.read({ filter: "all", after: page.older }), identity);
  assert.throws(
    () => f.read({ expectedEpoch: 1 }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.equal(f.store.cursor(), before);
});
test("limits, filter shapes and malformed/unbounded cursors are rejected", (t) => {
  const f = fixture(t),
    invalid = (e) => e.code === "INVALID_COMMAND";
  for (const limit of [0, 101, 1.5, "20", Infinity])
    assert.throws(() => f.read({ limit }), invalid);
  for (const filter of ["__proto__", "unknown", ["all"], {}])
    assert.throws(() => f.read({ filter }), invalid);
  for (const after of [
    "",
    "x".repeat(2049),
    "[",
    Buffer.from("{}").toString("base64url"),
  ])
    assert.throws(() => f.read({ after }), invalid);
});
test("deletion and recreation of the same chat invalidates old cursors and hides old incarnation jobs", (t) => {
  const f = fixture(t),
    old = f.read({ limit: 4 });
  f.store.applyCommand("remove", {
    type: "delete-chat",
    chatId: "a",
    expectedRevision: f.store.requireChat("a").revision,
    expectedEpoch: 0,
  });
  f.store.applyCommand("recreate", {
    type: "create-chat",
    chatId: "a",
    characterId: "c",
  });
  const epoch = f.store.fieldEpoch({ scope: "chat", entityId: "a" });
  assert.ok(epoch > 0);
  assert.throws(
    () => f.read({ after: old.older }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () => f.read({ expectedEpoch: epoch, after: old.older }),
    (e) => e.code === "IDENTITY_CONFLICT",
  );
  const fresh = f.read({ expectedEpoch: epoch });
  assert.deepEqual(fresh.items, []);
  assert.equal(fresh.older, null);
  assert.equal(fresh.newer, null);
});
test("each sparse history filter and directional range uses its matching index", (t) => {
  const f = fixture(t);
  for (const [index, suffix] of [
    ["jobs_history", ""],
    ["memory_jobs_history", " AND type='memory-summary'"],
    [
      "failed_jobs_history",
      " AND state IN ('failed','cancelled','interrupted')",
    ],
  ]) {
    for (const order of ["ASC", "DESC"]) {
      const plan = f.store.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE chat_id=? AND chat_epoch=? ${suffix} AND queue_position<? ORDER BY queue_position ${order} LIMIT 20`,
        )
        .all("a", 0, 100)
        .map((r) => r.detail)
        .join(" ");
      assert.ok(plan.includes(index), plan);
      assert.ok(!plan.includes("TEMP B-TREE"), plan);
    }
  }
});
test("same-database reopen retains cursor scope and additive indexes without changing portable rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "risu-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "authored.sqlite"),
    f = fixture(t, file),
    first = f.read({ limit: 10 });
  f.store.close();
  const reopened = new EntityStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.schemaVersion(), 22);
  assert.equal(
    reopened.listJobHistory("a", {
      expectedEpoch: 0,
      limit: 10,
      after: first.older,
    }).items[0].id,
    "job-126",
  );
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM jobs").get().n, 160);
});
