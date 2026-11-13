"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-interactions-")),
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
    definition: { name: "Synthetic" },
    chat: { chatId: "a", metadata: {} },
  });
  store.enqueueJob("job", { type: "button", chatId: "a" });
  const { job } = store.claimJob("owner");
  return {
    store,
    file,
    job,
    time: (n) => {
      now = n;
    },
    publish: (position, descriptor) =>
      store.publishJobInteraction(
        job.id,
        job.owner,
        job.fence,
        position,
        descriptor,
      ),
  };
}
const answer = (id, value, revision = 1) => ({
  type: "answer-interaction",
  interactionId: id,
  expectedRevision: revision,
  answer: value,
});

test("interaction headers never leak prompt, answer or worker ownership; pending input survives DB reopen without changing display clocks", (t) => {
  const f = fixture(t),
    before = f.store.displayState("a", {});
  const descriptor = {
    kind: "input",
    prompt: "<b>Synthetic prompt</b>",
    defaultValue: "한글",
    datalist: [["one", "Synthetic suggestion"]],
  };
  const { interaction } = f.publish(1, descriptor);
  for (const value of [
    f.store.bootstrap(),
    f.store.changes(before.cursor),
    f.store.listInteractions(),
  ]) {
    const encoded = JSON.stringify(value);
    assert.equal(encoded.includes("Synthetic prompt"), false);
    if (value.items) {
      assert.equal(encoded.includes('"owner"'), false);
      assert.equal(encoded.includes('"fence"'), false);
    }
  }
  assert.equal(f.store.displayState("a", {}).inputClock, before.inputClock);
  assert.deepEqual(
    f.store.readInteraction(interaction.id).interaction.descriptor,
    descriptor,
  );
  const reopened = new EntityStore(f.file, { now: () => 1000 });
  try {
    assert.equal(reopened.listInteractions().items[0].id, interaction.id);
    assert.equal(reopened.schemaVersion(), 22);
  } finally {
    reopened.close();
  }
});
test("one pending call per job, ordered publication, immutable descriptors and typed answers are atomic", (t) => {
  const f = fixture(t),
    data = {
      kind: "select",
      prompt: "Synthetic choices",
      options: ["same", "same"],
    };
  const first = f.publish(1, data),
    cursor = f.store.cursor();
  assert.deepEqual(f.publish(1, data), first);
  assert.throws(() => f.publish(1, { ...data, options: ["changed"] }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.throws(() => f.publish(3, data), { code: "INVALID_INTERACTION" });
  assert.throws(() => f.publish(2, data), { code: "INTERACTION_BUSY" });
  for (const value of [false, 1, "01", "-1", "2", "same"])
    assert.throws(
      () =>
        f.store.applyCommand(
          "invalid-" + String(value),
          answer(first.interaction.id, value),
        ),
      { code: "INVALID_INTERACTION_ANSWER" },
    );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM commands WHERE id LIKE 'invalid-%'")
      .get().n,
    0,
  );
  f.store.applyCommand("valid", answer(first.interaction.id, "1"));
  assert.deepEqual(
    f.store.pollJobInteraction(
      f.job.id,
      f.job.owner,
      f.job.fence,
      first.interaction.id,
    ),
    { state: "answered", answer: "1" },
  );
  assert.equal(
    f.publish(2, { kind: "confirm", prompt: "Synthetic confirmation" })
      .interaction.position,
    2,
  );
});
test("first peer answer wins; shared same-value repeats emit no event and the original receipt remains replayable after terminal/reopen", (t) => {
  const f = fixture(t),
    first = f.publish(1, { kind: "confirm", prompt: "Synthetic" }).interaction;
  const command = answer(first.id, false),
    receipt = f.store.applyCommand("answer", command),
    cursor = f.store.cursor();
  const peer = new EntityStore(f.file, { now: () => 1000 });
  try {
    assert.throws(
      () => peer.applyCommand("different-answer", answer(first.id, true)),
      { code: "INTERACTION_ALREADY_ANSWERED" },
    );
    peer.applyCommand("same-answer", command);
    assert.equal(peer.cursor(), cursor);
    assert.deepEqual(peer.applyCommand("answer", command), receipt);
    f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
      state: "failed",
      result: {},
    });
    assert.deepEqual(peer.applyCommand("answer", command), receipt);
    assert.equal(peer.listInteractions().count, 0);
    assert.throws(
      () => peer.applyCommand("answer", { ...command, answer: true }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
  } finally {
    peer.close();
  }
});
test("cancel, failure, explicit interruption and expired ownership close unresolved prompts and reject late answers", (t) => {
  for (const outcome of ["cancel", "failed", "interrupt", "expire"]) {
    const f = fixture(t),
      pending = f.publish(1, {
        kind: "input",
        prompt: "Synthetic",
      }).interaction;
    if (outcome === "cancel") f.store.requestCancel(f.job.id);
    if (outcome === "failed")
      f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
        state: "failed",
        result: {},
      });
    if (outcome === "interrupt")
      f.store.interruptJob(
        f.job.id,
        f.job.owner,
        f.job.fence,
        "Synthetic worker loss",
      );
    if (outcome === "expire") f.time(f.job.leaseUntil);
    assert.equal(f.store.listInteractions().count, 0);
    const closed = f.store.readInteraction(pending.id).interaction;
    assert.equal(closed.state, "closed");
    assert.equal(closed.revision, 2);
    assert.throws(
      () => f.store.applyCommand("late", answer(pending.id, "late")),
      { code: "INTERACTION_CLOSED" },
    );
    assert.equal(f.store.snapshot("a").messages.length, 0);
  }
});
test("wrong owner/fence cannot publish, read an answer or reuse an interaction position", (t) => {
  const f = fixture(t),
    pending = f.publish(1, { kind: "input", prompt: "Synthetic" }).interaction;
  for (const [owner, fence] of [
    ["wrong", f.job.fence],
    [f.job.owner, f.job.fence + 1],
  ]) {
    assert.throws(
      () =>
        f.store.publishJobInteraction(f.job.id, owner, fence, 1, {
          kind: "input",
          prompt: "Synthetic",
        }),
      { code: "STALE_WORKER" },
    );
    assert.throws(
      () => f.store.pollJobInteraction(f.job.id, owner, fence, pending.id),
      { code: "STALE_WORKER" },
    );
  }
  f.store.applyCommand("empty-string", answer(pending.id, ""));
  assert.equal(
    f.store.pollJobInteraction(f.job.id, f.job.owner, f.job.fence, pending.id)
      .answer,
    "",
  );
});
test("an unresolved prompt prevents successful final writes; later failure closes it without a partial message", (t) => {
  const f = fixture(t),
    pending = f.publish(1, {
      kind: "confirm",
      prompt: "Synthetic",
    }).interaction,
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
        state: "completed",
        messages: [
          { id: "must-not-save", message: { role: "char", data: "Synthetic" } },
        ],
      }),
    { code: "INTERACTION_PENDING" },
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").messages.length, 0);
  f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
    state: "failed",
    result: {},
  });
  assert.equal(f.store.readInteraction(pending.id).interaction.state, "closed");
});
test("UTF8/option/count/total limits fail explicitly and schema19 migration preserves pending-independent data", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.publish(1, { kind: "input", prompt: "한".repeat(22000) }),
    { code: "INTERACTION_LIMIT" },
  );
  assert.throws(
    () =>
      f.publish(1, {
        kind: "select",
        prompt: "Synthetic",
        options: Array(129).fill("one"),
      }),
    { code: "INTERACTION_LIMIT" },
  );
  const pending = f.publish(1, {
    kind: "input",
    prompt: "Synthetic",
  }).interaction;
  assert.throws(
    () =>
      f.store.applyCommand("oversize", answer(pending.id, "한".repeat(22000))),
    { code: "INVALID_INTERACTION_ANSWER" },
  );
  f.store.applyCommand("empty", answer(pending.id, ""));
  for (let position = 2; position <= 128; position++) {
    const next = f.publish(position, {
      kind: "confirm",
      prompt: "Synthetic",
    }).interaction;
    f.store.applyCommand("count-" + position, answer(next.id, true));
  }
  assert.throws(
    () => f.publish(129, { kind: "confirm", prompt: "Synthetic" }),
    { code: "INTERACTION_LIMIT" },
  );
  const g = fixture(t);
  for (let position = 1; position <= 16; position++) {
    const next = g.publish(position, {
      kind: "input",
      prompt: "x".repeat(65000),
    }).interaction;
    g.store.applyCommand("bytes-" + position, answer(next.id, ""));
  }
  assert.throws(
    () => g.publish(17, { kind: "input", prompt: "x".repeat(65000) }),
    { code: "INTERACTION_LIMIT" },
  );
  const migrated = fixture(t);
  const retained = migrated.store.publishJobNotice(
    migrated.job.id,
    migrated.job.owner,
    migrated.job.fence,
    1,
    "Synthetic retained notice",
  ).notice;
  const originalJob = migrated.store.getJob(migrated.job.id);
  const before = migrated.store.bootstrap();
  migrated.store.db.exec(
    "DROP TABLE job_interactions; PRAGMA user_version=19;",
  );
  const reopen = new EntityStore(migrated.file, { now: () => 1000 });
  try {
    assert.equal(reopen.schemaVersion(), 22);
    assert.equal(reopen.listInteractions().count, 0);
    assert.deepEqual(reopen.bootstrap(), before);
    assert.deepEqual(reopen.getJob(migrated.job.id), originalJob);
    assert.equal(
      reopen.readNotice(retained.id).notice.message,
      "Synthetic retained notice",
    );
  } finally {
    reopen.close();
  }
});
test("captured interaction cancellation is durable, fences late answers and cannot cancel the next job on receipt replay", (t) => {
  const f = fixture(t),
    first = f.publish(1, {
      kind: "input",
      prompt: "Synthetic cancellation",
    }).interaction;
  const command = {
    type: "cancel-interaction",
    interactionId: first.id,
    expectedRevision: 1,
  };
  const receipt = f.store.applyCommand("cancel-captured", command);
  assert.equal(f.store.getJob(f.job.id).cancelRequested, true);
  assert.equal(f.store.readInteraction(first.id).interaction.state, "closed");
  assert.throws(
    () => f.store.applyCommand("late-answer", answer(first.id, "late")),
    { code: "INTERACTION_CLOSED" },
  );
  f.store.finishJob(f.job.id, f.job.owner, f.job.fence, {
    state: "cancelled",
    result: {},
  });
  f.store.enqueueJob("next", { type: "button", chatId: "a" });
  const { job } = f.store.claimJob("next-owner");
  const next = f.store.publishJobInteraction(job.id, job.owner, job.fence, 1, {
    kind: "confirm",
    prompt: "Synthetic next",
  }).interaction;
  assert.deepEqual(f.store.applyCommand("cancel-captured", command), receipt);
  assert.equal(f.store.getJob(job.id).cancelRequested, false);
  assert.equal(f.store.readInteraction(next.id).interaction.state, "pending");
  f.store.applyCommand("answer-next", answer(next.id, true));
  assert.throws(
    () =>
      f.store.applyCommand("too-late-cancel", {
        ...command,
        interactionId: next.id,
      }),
    { code: "INTERACTION_ALREADY_ANSWERED" },
  );
});
