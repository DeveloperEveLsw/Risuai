"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");

function fixture(t, { type = "send", state = "failed" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "risu-retry-")),
    file = join(root, "state.sqlite"),
    store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand(chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
    });
  if (["continue", "reroll"].includes(type))
    store.applyCommand("reply", {
      type: "append-message",
      chatId: "a",
      messageId: "old",
      message: { role: "char", data: "Old reply" },
    });
  const source = {
    type,
    chatId: "a",
    expectedChatEpoch: 0,
    ...(type === "send"
      ? { input: "Synthetic original input", messageId: "original-input" }
      : type === "button"
        ? { manualName: "Synthetic action", triggerId: "synthetic-trigger" }
        : { messageId: "old", expectedRevision: 1 }),
  };
  store.enqueueJob("source", source);
  const job = store.claimJob("worker").job;
  store.writeJobProgress(job.id, "worker", job.fence, {
    messages: [{ role: "char", chatId: "partial", data: "Synthetic partial" }],
  });
  const writeSet = {
    chatId: "a",
    expectedRevision: job.startedRevision,
    expectedContentRevision: job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "computed",
        expectedRevision: 0,
        message: { role: "char", data: "Computed" },
      },
    ],
    variables: [{ key: "$effect", expectedRevision: 0, value: "computed" }],
  };
  if (state === "interrupted")
    store.interruptJob(job.id, "worker", job.fence, "Synthetic interruption");
  else
    store.finishJob(job.id, "worker", job.fence, {
      state,
      result: { code: "SYNTHETIC", uncommitted: { writeSet } },
    });
  return { store, file, source, job };
}

test("two DB workers admit one fresh send child and reopen/replay preserves that identity", async (t) => {
  const { store, file, source } = fixture(t, { state: "interrupted" });
  const original = store.getJob("source"),
    preview = store.previewJobResult("source");
  assert.equal(preview.canRetry, true);
  const left = new EntityStoreClient(file),
    right = new EntityStoreClient(file);
  t.after(async () => {
    await left.close();
    await right.close();
  });
  const command = { type: "retry-job-result", ...preview.target };
  const receipts = await Promise.all([
    left.call("applyCommand", "left", command),
    right.call("applyCommand", "right", command),
  ]);
  assert.equal(receipts.filter((r) => !r.alreadyApplied).length, 1);
  const child = receipts[0].disposition.resultJobId;
  assert.equal(child, receipts[1].disposition.resultJobId);
  assert.equal(store.getJob(child).state, "queued");
  assert.equal(store.getJobCommand(child).input, source.input);
  assert.notEqual(store.getJobCommand(child).messageId, source.messageId);
  assert.deepEqual(store.getJob("source"), original);
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal(store.snapshot("a").variables.length, 0);
  const reopened = new EntityStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.applyCommand("left", command), receipts[0]);
  assert.equal(reopened.listJobs("a").length, 2);
  assert.equal(reopened.previewJobResult("source").canRetry, false);
  assert.equal(reopened.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("recovery and retry race atomically chooses one disposition without an orphan child or duplicate effects", async (t) => {
  const { store, file } = fixture(t);
  const target = store.previewJobResult("source").target;
  const a = new EntityStoreClient(file),
    b = new EntityStoreClient(file);
  t.after(async () => {
    await a.close();
    await b.close();
  });
  const results = await Promise.all([
    a.call("applyCommand", "recover", {
      type: "recover-job-result",
      ...target,
    }),
    b.call("applyCommand", "retry", { type: "retry-job-result", ...target }),
  ]);
  assert.equal(results.filter((r) => !r.alreadyApplied).length, 1);
  assert.equal(results[0].disposition.action, results[1].disposition.action);
  const recovered = results[0].disposition.action === "recover";
  assert.equal(store.snapshot("a").messages.length, recovered ? 1 : 0);
  assert.equal(store.snapshot("a").variables.length, recovered ? 1 : 0);
  assert.equal(store.listJobs("a").length, recovered ? 1 : 2);
});

for (const type of ["continue", "reroll"])
  test(
    type +
      " binds a reviewed current tail instead of the source's obsolete target",
    (t) => {
      const { store } = fixture(t, { type });
      store.applyCommand("new-tail", {
        type: "append-message",
        chatId: "a",
        messageId: "new",
        message: { role: "char", data: "New reply" },
      });
      const preview = store.previewJobResult("source");
      assert.equal(preview.target.retryMessageId, "new");
      assert.equal(preview.retryTarget.data, "New reply");
      assert.equal(preview.canRetry, true);
      const result = store.applyCommand("retry", {
        type: "retry-job-result",
        ...preview.target,
      });
      const command = store.getJobCommand(result.disposition.resultJobId);
      assert.equal(command.type, type);
      assert.equal(command.messageId, "new");
      assert.equal(command.expectedRevision, 1);
    },
  );

test("button retry preserves the invocation while discarding unused client command fields", (t) => {
  const { store } = fixture(t, { type: "button", state: "cancelled" });
  const preview = store.previewJobResult("source");
  assert.equal(preview.canRetry, true);
  const result = store.applyCommand("retry", {
    type: "retry-job-result",
    ...preview.target,
  });
  assert.deepEqual(store.getJobCommand(result.disposition.resultJobId), {
    type: "button",
    chatId: "a",
    expectedChatEpoch: 0,
    manualName: "Synthetic action",
    triggerId: "synthetic-trigger",
  });
});

for (const scenario of [
  "content",
  "chat-incarnation",
  "owner",
  "injected-input",
  "tail",
  "busy-tail",
])
  test(
    "retry rejects " + scenario + " without child admission or a disposition",
    (t) => {
      const { store } = fixture(t, {
        type: scenario.includes("tail") ? "continue" : "send",
      });
      const target = store.previewJobResult("source").target;
      if (scenario === "content")
        store.applyCommand("peer", {
          type: "append-message",
          chatId: "a",
          messageId: "peer",
          message: { role: "user", data: "Peer" },
        });
      if (scenario === "chat-incarnation") {
        store.applyCommand("delete", {
          type: "delete-chat",
          chatId: "a",
          expectedRevision: store.requireChat("a").revision,
          expectedEpoch: 0,
        });
        store.applyCommand("recreate", {
          type: "create-chat",
          chatId: "a",
          characterId: "c",
        });
      }
      if (scenario === "owner") target.chatId = "b";
      if (scenario === "tail") target.retryMessageRevision++;
      if (scenario === "busy-tail")
        store.enqueueJob("queued", {
          type: "send",
          chatId: "a",
          input: "Next",
        });
      const command = {
        type: "retry-job-result",
        ...target,
        ...(scenario === "injected-input" ? { input: "Injected" } : {}),
      };
      const before = store.cursor(),
        count = store.listJobs("a").length;
      assert.throws(() => store.applyCommand("retry", command));
      assert.equal(store.cursor(), before);
      assert.equal(store.listJobs("a").length, count);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM job_result_actions").get()
          .n,
        0,
      );
    },
  );

test("disposition failure rolls back both parent and native child; a failed child requires a new explicit source", (t) => {
  const { store } = fixture(t);
  const target = store.previewJobResult("source").target;
  store.db.exec(
    "CREATE TRIGGER synthetic_disposition_failure BEFORE INSERT ON job_result_actions BEGIN SELECT RAISE(ABORT,'Synthetic disposition full'); END;",
  );
  const before = store.cursor();
  const command = { type: "retry-job-result", ...target };
  assert.throws(
    () => store.applyCommand("retry", command),
    /Synthetic disposition full/,
  );
  assert.equal(store.cursor(), before);
  assert.equal(store.listJobs("a").length, 1);
  assert.equal(
    store.db.prepare("SELECT 1 FROM commands WHERE id='retry'").get(),
    undefined,
  );
  store.db.exec("DROP TRIGGER synthetic_disposition_failure");
  const result = store.applyCommand("retry", command),
    child = result.disposition.resultJobId;
  const claimed = store.claimJob("worker");
  assert.equal(claimed.job.id, child);
  store.finishJob(child, "worker", claimed.job.fence, {
    state: "failed",
    result: { message: "Synthetic child failure" },
  });
  assert.equal(store.claimJob("next"), null);
  assert.equal(
    store.applyCommand("repeat-parent", command).disposition.resultJobId,
    child,
  );
  const next = store.previewJobResult(child);
  const grandchild = store.applyCommand("next-explicit", {
    type: "retry-job-result",
    ...next.target,
  }).disposition.resultJobId;
  assert.notEqual(child, grandchild);
  assert.notEqual(
    store.getJobCommand(child).messageId,
    store.getJobCommand(grandchild).messageId,
  );
});

test("send retry keeps same-chat queue order while an independent chat can be claimed", (t) => {
  const { store } = fixture(t);
  store.enqueueJob("prior", { type: "send", chatId: "a", input: "Prior" });
  const preview = store.previewJobResult("source");
  assert.equal(preview.canRetry, true);
  const retry = store.applyCommand("retry", {
    type: "retry-job-result",
    ...preview.target,
  });
  store.enqueueJob("independent", {
    type: "send",
    chatId: "b",
    input: "Independent",
  });
  assert.equal(store.claimJob("one").job.id, "prior");
  assert.equal(store.claimJob("two").job.id, "independent");
  assert.equal(store.getJob(retry.disposition.resultJobId).state, "queued");
});
