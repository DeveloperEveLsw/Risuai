"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const vm = require("node:vm");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-batch-")),
    file = join(root, "state.sqlite");
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  let serial = 0;
  const command = (c) => store.applyCommand("cmd-" + ++serial, c);
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
  });
  for (const chatId of ["a", "b"])
    command({
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: { note: "retain" },
    });
  command({
    type: "append-message",
    chatId: "a",
    messageId: "prefix",
    message: {
      role: "user",
      data: "Synthetic prefix",
      extension: { retain: true },
    },
  });
  const snapshot = () => store.snapshot("a");
  const header = () => {
    const row = snapshot().messages.at(-1);
    return store.readReplyChoices("a", row.id, row.revision, 0);
  };
  const move = (
    direction,
    target = header().target,
    requestId = "move-" + ++serial,
  ) =>
    store.applyCommand(requestId, {
      type: "move-reply-choice",
      ...target,
      direction,
    });
  const start = (type, label, n, options = {}) => {
    const old = snapshot(),
      last = old.messages.at(-1),
      inputId = options.existingInput ?? "input-" + label;
    store.enqueueJob("job-" + label, {
      type,
      chatId: "a",
      ...(type === "send"
        ? {
            input: options.input === false ? "" : "Synthetic input",
            messageId: inputId,
          }
        : {
            messageId: last.id,
            expectedRevision: last.revision,
            expectedChatEpoch: 0,
          }),
    });
    const job = store.claimJob("worker").job;
    const selected = old.messages.filter((row) => row.message.role === "char");
    const output = Array.from({ length: n }, (_, i) => ({
      id: label + "-" + i,
      expectedRevision: 0,
      message: {
        role: "char",
        data: label + " text " + i,
        saying: "speaker-" + i,
        time: 100 + i,
        generationInfo: { generationId: label + "-g-" + i },
        unknown: { retain: label },
      },
    }));
    const writes = {
      chatId: "a",
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [{ id: "c", expectedEpoch: 0 }],
      messages: [
        ...(type === "send" && options.input !== false && !options.existingInput
          ? [
              {
                id: inputId,
                expectedRevision: 0,
                message: { role: "user", data: "Synthetic input" },
              },
            ]
          : []),
        ...output,
      ],
      ...(type === "reroll"
        ? {
            deleteMessages: selected.map((row) => ({
              id: row.id,
              expectedRevision: row.revision,
            })),
          }
        : {}),
      variables: [
        {
          key: "$effect",
          expectedRevision:
            old.variables.find((v) => v.key === "$effect")?.revision ?? 0,
          value: label,
        },
      ],
    };
    const result =
      options.choices === false
        ? {}
        : {
            rerolls: {
              [label + "-g-" + (n - 1)]: [label + " text " + (n - 1)],
            },
          };
    return { job, writes, result, output };
  };
  const finish = (type, label, n, options) => {
    const p = start(type, label, n, options);
    store.finishJob(p.job.id, "worker", p.job.fence, {
      state: "completed",
      writeSet: p.writes,
      result: p.result,
    });
    return p;
  };
  return { store, file, command, snapshot, header, move, start, finish };
}

test("unequal group batches replace the full tail, preserve the prefix and side effects, and resurrect stable IDs above tombstones", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 2);
  const first = f.snapshot(),
    base = f.header().batch;
  assert.equal(base.count, 1);
  assert.equal(base.available, true);
  f.finish("reroll", "B", 3);
  const second = f.snapshot(),
    cursor = f.store.cursor();
  assert.equal(f.header().batch.count, 2);
  const receipt = f.move("previous", f.header().target, "previous");
  assert.equal(receipt.kind, "batch");
  const restored = f.snapshot();
  assert.deepEqual(
    restored.messages.map((r) => r.message),
    first.messages.map((r) => r.message),
  );
  assert.equal(restored.messages[0].revision, first.messages[0].revision);
  for (const row of restored.messages.filter(
    (r) => r.message.role === "char",
  )) {
    assert.equal(row.revision, 3);
    assert.ok(row.revision > f.store.deletedRevision("message", "a", row.id));
  }
  assert.deepEqual(restored.variables, second.variables);
  assert.deepEqual(restored.chat.metadata, second.chat.metadata);
  assert.equal(f.store.listJobs("a").length, 2);
  const events = f.store.changes(cursor, 100).changes;
  assert.equal(events.filter((x) => x.type === "reply-batch").length, 1);
  assert.equal(
    events.filter((x) =>
      ["message", "messages-removed", "message-order"].includes(x.type),
    ).length,
    0,
  );
  assert.deepEqual(f.move("next").kind, "batch");
  assert.deepEqual(
    f.snapshot().messages.map((r) => r.message),
    second.messages.map((r) => r.message),
  );
  assert.equal(f.snapshot().messages.at(-1).revision, 3);
  assert.deepEqual(f.store.snapshot("b").messages, []);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("equal-length immutable snapshots match the original assignment loop, including complete metadata after a local edit", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 2, { choices: false });
  const original = execFileSync(
    "git",
    [
      "show",
      "f9728b14c733d073168d8d0c6a8f34f8febf0304:src/lib/ChatScreens/DefaultChatScreen.svelte",
    ],
    { cwd: join(__dirname, "../.."), encoding: "utf8" },
  );
  const loop = original.match(
    /for\(let i = 0; i < rerollData.length; i\+\+\)\{\s*msgs\[msgs.length - rerollData.length \+ i\] = rerollData\[i\]\s*\}/,
  )?.[0];
  assert.ok(loop);
  const a = f
    .snapshot()
    .messages.slice(-2)
    .map((r) => r.message);
  f.finish("reroll", "B", 2, { choices: false });
  const b = f
    .snapshot()
    .messages.slice(-2)
    .map((r) => r.message);
  const row = f.snapshot().messages.at(-1);
  f.command({
    type: "edit-message",
    chatId: "a",
    messageId: row.id,
    expectedRevision: row.revision,
    expectedChatEpoch: 0,
    text: "Synthetic manual edit",
  });
  for (const [direction, batch] of [
    ["previous", a],
    ["next", b],
    ["previous", a],
  ]) {
    const context = {
      msgs: structuredClone(f.snapshot().messages.map((r) => r.message)),
      rerollData: structuredClone(batch),
    };
    vm.runInNewContext(loop, context);
    assert.equal(f.move(direction).kind, "batch");
    assert.deepEqual(
      f.snapshot().messages.map((r) => r.message),
      context.msgs,
    );
  }
});

test("provider candidates take precedence, and cache misses move a saved batch without a provider or script rerun", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  const b = f.start("reroll", "B", 1);
  b.result.rerolls["B-g-0"] = ["B text 0", "B candidate 1"];
  f.store.finishJob(b.job.id, "worker", b.job.fence, {
    state: "completed",
    writeSet: b.writes,
    result: b.result,
  });
  assert.equal(f.move("next").kind, "selected");
  assert.equal(f.header().batch.selectedPosition, 1);
  assert.equal(f.move("previous").kind, "selected");
  assert.equal(f.move("previous").kind, "batch");
  assert.equal(f.snapshot().messages.at(-1).id, "A-0");
  // A's first next cache miss selects the saved future batch, not a new job.
  assert.equal(f.move("next").kind, "batch");
  assert.equal(f.snapshot().messages.at(-1).message.data, "B text 0");
  assert.equal(f.move("next").kind, "selected");
  assert.equal(f.store.listJobs("a").length, 2);
  assert.equal(f.snapshot().variables[0].value, "B");
});

test("two workers select a batch once, replay receipts across reopen, and fence prefix text/structure changes", async (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  f.finish("reroll", "B", 2);
  const target = f.header().target,
    command = { type: "move-reply-choice", ...target, direction: "previous" };
  const left = new EntityStoreClient(f.file),
    right = new EntityStoreClient(f.file);
  t.after(async () => {
    await left.close();
    await right.close();
  });
  const results = await Promise.allSettled([
    left.call("applyCommand", "left", command),
    right.call("applyCommand", "right", command),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "REVISION_CONFLICT",
  );
  const winner = results[0].status === "fulfilled" ? "left" : "right",
    receipt = results.find((x) => x.status === "fulfilled").value;
  f.store.close();
  const reopened = new EntityStore(f.file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.applyCommand(winner, command), receipt);
  const row = reopened.snapshot("a").messages.at(-1),
    head = reopened.readReplyChoices("a", row.id, row.revision, 0);
  const prefix = reopened.snapshot("a").messages[0];
  reopened.applyCommand("prefix-edit", {
    type: "edit-message",
    chatId: "a",
    messageId: prefix.id,
    expectedRevision: prefix.revision,
    expectedChatEpoch: 0,
    text: "Changed prefix",
  });
  assert.throws(
    () =>
      reopened.applyCommand("stale-prefix", {
        type: "move-reply-choice",
        ...head.target,
        direction: "next",
      }),
    { code: "REVISION_CONFLICT" },
  );
  const fresh = reopened.readReplyChoices("a", row.id, row.revision, 0);
  assert.equal(
    reopened.applyCommand("fresh-prefix", {
      type: "move-reply-choice",
      ...fresh.target,
      direction: "next",
    }).kind,
    "batch",
  );
  assert.equal(
    reopened.snapshot("a").messages[0].message.data,
    "Changed prefix",
  );
  reopened.applyCommand("remove-prefix", {
    type: "remove-message",
    chatId: "a",
    messageId: "input-A",
    expectedRevision: 1,
    expectedChatRevision: reopened.snapshot("a").chat.revision,
    expectedChatEpoch: 0,
    mode: "one",
  });
  const last = reopened.snapshot("a").messages.at(-1),
    invalid = reopened.readReplyChoices("a", last.id, last.revision, 0);
  assert.equal(invalid.batch.available, false);
  assert.throws(
    () =>
      reopened.applyCommand("invalid-prefix", {
        type: "move-reply-choice",
        ...invalid.target,
        direction: "previous",
      }),
    { code: "REVISION_CONFLICT" },
  );
});

test("failed/cancelled/provisional rerolls leave history intact; full retained recovery creates it once and preview rolls back", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 2);
  const before = f.header().batch;
  const p = f.start("reroll", "B", 1);
  f.store.writeJobProgress(p.job.id, "worker", p.job.fence, {
    messages: [{ id: "provisional", data: "Synthetic" }],
  });
  assert.deepEqual(f.header().batch, before);
  f.store.finishJob(p.job.id, "worker", p.job.fence, {
    state: "failed",
    result: {
      code: "DATABASE_ERROR",
      uncommitted: { writeSet: p.writes, result: p.result },
    },
  });
  const cursor = f.store.cursor();
  assert.equal(f.store.previewJobResult(p.job.id).canRecover, true);
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.header().batch, before);
  const recovery = {
    type: "recover-job-result",
    jobId: p.job.id,
    chatId: "a",
    expectedChatEpoch: 0,
    expectedContentRevision: p.job.startedContentRevision,
  };
  f.command(recovery);
  f.command(recovery);
  assert.equal(f.header().batch.count, 2);
  assert.equal(f.move("previous").kind, "batch");
  const cancelled = f.start("reroll", "C", 1);
  const selected = f.header().batch;
  f.store.finishJob(cancelled.job.id, "worker", cancelled.job.fence, {
    state: "cancelled",
    result: { reason: "Synthetic" },
  });
  assert.deepEqual(f.header().batch, selected);
});

test("an invalid cache or archived ID collision rolls back canonical writes, selection heads and history atomically", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  const p = f.start("reroll", "B", 1),
    before = f.snapshot(),
    head = f.header().batch,
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.finishJob(p.job.id, "worker", p.job.fence, {
        state: "completed",
        writeSet: p.writes,
        result: { rerolls: { bad: [{}] } },
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.header().batch, head);
  assert.equal(f.store.cursor(), cursor);
  f.store.finishJob(p.job.id, "worker", p.job.fence, {
    state: "completed",
    writeSet: p.writes,
    result: p.result,
  });
  // A malformed restore/import cannot let an archived ID overwrite a live other-chat row.
  f.store.db
    .prepare(
      "INSERT INTO messages(id,chat_id,position,payload,revision) VALUES ('A-0','b',0,?,5)",
    )
    .run(
      JSON.stringify({
        role: "char",
        data: "Synthetic other owner",
        chatId: "A-0",
      }),
    );
  const collision = f.snapshot(),
    h = f.header(),
    seq = f.store.cursor();
  assert.throws(() => f.move("previous", h.target), {
    code: "IDENTITY_CONFLICT",
  });
  assert.deepEqual(f.snapshot(), collision);
  assert.deepEqual(f.header(), h);
  assert.equal(f.store.cursor(), seq);
});

test("a new send resets active history and excludes input; custom non-tail structural writes retain canonical effects without claiming a compatible batch", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  f.finish("reroll", "B", 2);
  const oldId = f.header().batch.setId;
  f.finish("send", "C", 1, { input: false });
  assert.notEqual(f.header().batch.setId, oldId);
  assert.equal(f.header().batch.count, 1);
  assert.equal(f.move("previous").kind, "boundary");
  f.finish("send", "E", 1, { existingInput: "input-A" });
  assert.equal(f.header().batch.count, 1);
  assert.deepEqual(
    f.store.db
      .prepare(
        "SELECT message_id FROM reply_batch_messages WHERE set_id=? ORDER BY position",
      )
      .all(f.header().batch.setId)
      .map((row) => row.message_id),
    ["E-0"],
  );
  const p = f.start("reroll", "D", 1);
  p.writes.deleteMessages = [{ id: "prefix", expectedRevision: 1 }];
  f.store.finishJob(p.job.id, "worker", p.job.fence, {
    state: "completed",
    writeSet: p.writes,
    result: p.result,
  });
  assert.equal(f.header().batch.setId, null);
  assert.ok(f.snapshot().messages.some((r) => r.id === "D-0"));
});

test("schema17 migration preserves identity, messages, provider indices and receipts, with empty legacy batch history", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  const target = f.header().target;
  const identity = f.store.bootstrap().databaseId,
    before = f.snapshot();
  f.store.db.exec(
    "DROP TABLE reply_batch_heads; DROP TABLE reply_batch_messages; DROP TABLE reply_batches; DROP TABLE reply_batch_sets; PRAGMA user_version=17;",
  );
  f.store.close();
  const migrated = new EntityStore(f.file);
  t.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), 22);
  assert.equal(migrated.bootstrap().databaseId, identity);
  assert.deepEqual(migrated.snapshot("a"), before);
  const header = migrated.readReplyChoices("a", "A-0", 1, 0);
  assert.equal(header.batch.setId, null);
  assert.equal(header.count, 1);
  assert.equal(
    header.target.expectedChoiceRevision,
    target.expectedChoiceRevision,
  );
  assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
});
test("unadmitted schema17 commands lacking batch/content guards reject without advancing any cache or generating work", (t) => {
  const f = fixture(t);
  f.finish("send", "A", 1);
  const head = f.header(),
    before = f.snapshot(),
    cursor = f.store.cursor();
  const {
    expectedContentRevision,
    expectedBatchSetId,
    expectedBatchRevision,
    ...legacy
  } = head.target;
  assert.throws(() => f.move("next", legacy), { code: "INVALID_COMMAND" });
  assert.deepEqual(f.header(), head);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.listJobs("a").length, 1);
});
