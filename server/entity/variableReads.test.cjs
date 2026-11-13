"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  store.applyCommand("a", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
  });
  let next = 0;
  const edit = (change) =>
    store.applyCommand("edit-" + ++next, {
      type: "change-variables",
      edits: [change],
    });
  return {
    store,
    edit,
    claim: () => {
      store.enqueueJob("job", { type: "send", chatId: "a" });
      return store.claimJob("worker");
    },
    writes: (job) => ({
      chatId: "a",
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [{ id: "c", expectedEpoch: 0 }],
      messages: [
        {
          id: "reply",
          expectedRevision: 0,
          message: { role: "char", data: "Synthetic computed output" },
        },
      ],
      variables: [{ key: "$derived", expectedRevision: 0, value: "computed" }],
    }),
    finish: (job, writes) =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: writes,
      }),
  };
}
const edit = (scope, key, expectedRevision, value, remove = false) => ({
  scope,
  ...(scope === "global" ? {} : { chatId: "a" }),
  key,
  expectedRevision,
  ...(remove ? { remove: true } : { value }),
});
const read = (scope, key, expectedRevision, expectedExists) => ({
  scope,
  key,
  expectedRevision,
  expectedExists,
});
test("all declared point-read scopes reject stale dependencies before messages, variables or journal change", (t) => {
  for (const scope of ["chat", "chat-global", "global"]) {
    const f = fixture(t);
    f.edit(edit(scope, "source", 0, "before"));
    const { job } = f.claim();
    const writes = {
      ...f.writes(job),
      variableReads: [read(scope, "source", 1, true)],
    };
    f.edit(edit(scope, "source", 1, "after"));
    const cursor = f.store.cursor();
    assert.throws(() => f.finish(job, writes), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.store.getJob(job.id).state, "running");
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(
      f.store.snapshot("a").variables.some((row) => row.key === "$derived"),
      false,
    );
  }
});
test("absent/tombstone/null/present dependencies distinguish creation, deletion and equal-value ABA", (t) => {
  for (const mode of ["absent", "deleted", "null", "aba"]) {
    const f = fixture(t);
    if (mode !== "absent")
      f.edit(edit("global", "source", 0, mode === "null" ? null : "same"));
    if (mode === "deleted")
      f.edit(edit("global", "source", 1, undefined, true));
    const { job } = f.claim(),
      expectedRevision = mode === "absent" ? 0 : mode === "deleted" ? 2 : 1;
    const writes = {
      ...f.writes(job),
      variableReads: [
        read(
          "global",
          "source",
          expectedRevision,
          ["null", "aba"].includes(mode),
        ),
      ],
    };
    if (mode === "aba") {
      f.edit(edit("global", "source", 1, undefined, true));
      f.edit(edit("global", "source", 2, "same"));
    } else
      f.edit(
        edit(
          "global",
          "source",
          expectedRevision,
          mode === "null" ? undefined : "new",
          mode === "null",
        ),
      );
    assert.throws(() => f.finish(job, writes), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.snapshot("a").messages.length, 0);
  }
});
test("distinct namespaces and unread keys merge; own writes validate against the snapshot before applying", (t) => {
  const f = fixture(t);
  f.edit(edit("global", "source", 0, "global"));
  const { job } = f.claim();
  const writes = {
    ...f.writes(job),
    variableReads: [
      read("global", "source", 1, true),
      read("chat", "$derived", 0, false),
    ],
  };
  f.edit(edit("chat", "source", 0, "peer"));
  f.edit(edit("global", "unread", 0, "peer"));
  assert.equal(f.finish(job, writes).job.state, "completed");
  assert.equal(
    f.store.snapshot("a").variables.find((row) => row.key === "$derived").value,
    "computed",
  );
});
test("malformed, duplicate, over-budget and redirected read records fail atomically", (t) => {
  const f = fixture(t),
    { job } = f.claim();
  const good = read("global", "source", 0, false);
  for (const records of [
    [good, good],
    [{ ...good, chatId: "other" }],
    [{ ...good, expectedExists: 0 }],
    [{ ...good, scope: "other" }],
    [{ ...good, expectedRevision: -1 }],
    [{ ...good, key: "" }],
    Array.from({ length: 4097 }, (_, i) => ({ ...good, key: String(i) })),
  ]) {
    const cursor = f.store.cursor();
    assert.throws(
      () => f.finish(job, { ...f.writes(job), variableReads: records }),
      { code: "INVALID_COMMAND" },
    );
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.store.snapshot("a").messages.length, 0);
  }
});
test("retained recovery rechecks the original read set and never strips a stale guard", (t) => {
  const f = fixture(t);
  f.edit(edit("global", "source", 0, "before"));
  const { job } = f.claim();
  const writes = {
    ...f.writes(job),
    variableReads: [read("global", "source", 1, true)],
  };
  f.edit(edit("global", "source", 1, "after"));
  f.store.finishJob(job.id, "worker", job.fence, {
    state: "failed",
    result: { code: "REVISION_CONFLICT", uncommitted: { writeSet: writes } },
  });
  const cursor = f.store.cursor();
  const preview = f.store.previewJobResult(job.id);
  assert.equal(preview.canRecover, false);
  assert.equal(f.store.cursor(), cursor);
  assert.throws(
    () =>
      f.store.applyCommand("recover", {
        type: "recover-job-result",
        jobId: job.id,
        chatId: "a",
        expectedChatEpoch: 0,
        expectedContentRevision: job.startedContentRevision,
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").messages.length, 0);
});
