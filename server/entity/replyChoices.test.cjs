"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");

function fixture(t, choices = ["cached-zero", "cached-one", "cached-two"]) {
  const root = mkdtempSync(join(tmpdir(), "risu-choice-")),
    file = join(root, "state.sqlite");
  const store = new EntityStore(file);
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
  store.applyCommand("a", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "Synthetic", note: "retain" },
  });
  store.enqueueJob("source", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "input",
  });
  const job = store.claimJob("worker").job;
  const outcome = {
    state: "completed",
    messages: [
      {
        id: "reply",
        message: {
          role: "char",
          chatId: "reply",
          data: "cached-zero:late-listener",
          generationInfo: { generationId: "generation", model: "synthetic" },
          saying: "c",
          time: 123,
          extension: { retain: true },
        },
      },
    ],
    variables: [{ key: "$output", value: 1, expectedRevision: 0 }],
    result: { rerolls: { generation: choices } },
  };
  store.finishJob(job.id, "worker", job.fence, outcome);
  const header = () => {
    const row = store.snapshot("a").messages.at(-1);
    return store.readReplyChoices("a", row.id, row.revision, 0);
  };
  const move = (requestId, direction, target = header().target) =>
    store.applyCommand(requestId, {
      type: "move-reply-choice",
      ...target,
      direction,
    });
  return { store, file, job, outcome, header, move };
}

test("provider choices persist across reopen, replace only data and replay a receipt without extra effects", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a"),
    target = f.header().target;
  assert.equal(f.header().count, 3);
  const receipt = f.move("select", "next", target);
  assert.equal(receipt.kind, "selected");
  const after = f.store.snapshot("a");
  assert.equal(after.messages[0].id, before.messages[0].id);
  assert.equal(after.messages[0].revision, before.messages[0].revision + 1);
  assert.deepEqual(after.messages[0].message, {
    ...before.messages[0].message,
    data: "cached-one",
  });
  assert.deepEqual(after.variables, before.variables);
  assert.deepEqual(after.chat.metadata, before.chat.metadata);
  assert.equal(f.store.listJobs("a").length, 1);
  assert.deepEqual(f.move("select", "next", target), receipt);
  assert.throws(() => f.move("peer", "next", target), {
    code: "REVISION_CONFLICT",
  });
  const cursor = f.store.cursor();
  f.store.close();
  const reopened = new EntityStore(f.file);
  t.after(() => reopened.close());
  const row = reopened.snapshot("a").messages[0];
  const head = reopened.readReplyChoices("a", row.id, row.revision, 0);
  assert.equal(head.selectedPosition, 1);
  assert.equal(reopened.cursor(), cursor);
  reopened.applyCommand("previous", {
    type: "move-reply-choice",
    ...head.target,
    direction: "previous",
  });
  assert.equal(reopened.snapshot("a").messages[0].message.data, "cached-zero");
  assert.deepEqual(reopened.snapshot("a").variables, before.variables);
});

test("the authoritative original cache agrees on previous/next, empty strings and index after failed generation", (t) => {
  const original = execFileSync(
    "git",
    [
      "show",
      "f9728b14c733d073168d8d0c6a8f34f8febf0304:src/ts/process/prereroll.ts",
    ],
    { cwd: join(__dirname, "../.."), encoding: "utf8" },
  );
  assert.equal(
    readFileSync(join(__dirname, "../../src/ts/process/prereroll.ts"), "utf8"),
    original,
  );
  const context = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(original, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  const values = ["zero", "", "two"],
    f = fixture(t, values);
  context.exports.addRerolls("g", values);
  let originalData = f.store.snapshot("a").messages[0].message.data;
  for (const [index, direction] of [
    "previous",
    "next",
    "previous",
    "next",
    "previous",
    "next",
    "previous",
  ].entries()) {
    const text =
      direction === "next"
        ? context.exports.Prereroll("g")
        : context.exports.PreUnreroll("g");
    const result = f.move("step-" + index, direction);
    if (text) {
      originalData = text;
      assert.equal(result.kind, "selected");
    } else if (direction === "next") {
      assert.equal(result.kind, "generation");
      // Simulate a failed new request; its cache/index remains available.
      const child = f.store.claimJob("child").job;
      f.store.finishJob(child.id, "child", child.fence, {
        state: "failed",
        result: { reason: "Synthetic failed reroll" },
      });
    } else assert.equal(result.kind, "boundary");
    assert.equal(f.store.snapshot("a").messages[0].message.data, originalData);
    assert.equal(f.store.snapshot("a").variables[0].value, 1);
  }
});

test("two database workers admit only one fallback job and receipt replay keeps its child identity", async (t) => {
  const f = fixture(t, ["zero"]),
    target = f.header().target;
  const a = new EntityStoreClient(f.file),
    b = new EntityStoreClient(f.file);
  t.after(async () => {
    await a.close();
    await b.close();
  });
  const command = { type: "move-reply-choice", ...target, direction: "next" };
  const results = await Promise.allSettled([
    a.call("applyCommand", "left", command),
    b.call("applyCommand", "right", command),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "REVISION_CONFLICT",
  );
  const child = results.find((r) => r.status === "fulfilled").value;
  const parent = results[0].status === "fulfilled" ? "left" : "right";
  assert.equal(child.kind, "generation");
  assert.equal(f.store.listJobs("a").length, 2);
  assert.deepEqual(await b.call("applyCommand", parent, command), child);
  const read = await a.call("readReplyChoices", "a", "reply", 1, 0);
  assert.equal(read.pendingJobId, child.jobId);
  assert.equal(read.selectedPosition, 1);
  assert.equal(read.target.expectedChoiceRevision, 2);
});

test("legacy replies create a head once; invalid or busy captures cannot mutate a choice", (t) => {
  const f = fixture(t);
  f.store.applyCommand("legacy", {
    type: "append-message",
    chatId: "a",
    messageId: "legacy",
    message: { role: "char", data: "legacy" },
  });
  assert.throws(
    () => f.move("old", "next", { ...f.header().target, messageId: "reply" }),
    { code: "REVISION_CONFLICT" },
  );
  const first = f.move("legacy-next", "next");
  assert.equal(f.header().target.expectedChoiceRevision, 1);
  assert.equal(f.header().pendingJobId, first.jobId);
  assert.throws(() => f.move("busy", "previous"), { code: "CHAT_BUSY" });
  f.store.requestCancel(first.jobId);
  assert.throws(
    () =>
      f.move("wrong-epoch", "next", {
        ...f.header().target,
        expectedChatEpoch: 1,
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () =>
      f.move("wrong-owner", "next", { ...f.header().target, setId: "wrong" }),
    { code: "IDENTITY_CONFLICT" },
  );
  const cursor = f.store.cursor();
  f.move("negative", "previous");
  assert.equal(f.store.cursor(), cursor);
});

test("invalid native caches roll back canonical writes, events and terminal disposition together", (t) => {
  const f = fixture(t);
  f.store.enqueueJob("bad", {
    type: "send",
    chatId: "a",
    input: "synthetic",
    messageId: "in",
  });
  const job = f.store.claimJob("worker").job,
    before = f.store.snapshot("a"),
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        messages: [
          {
            id: "invalid",
            message: {
              role: "char",
              data: "invalid",
              generationInfo: { generationId: "bad" },
            },
          },
        ],
        result: { rerolls: { bad: ["good", {}] } },
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.getJob("bad").state, "running");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM reply_choice_sets").get().n,
    1,
  );
});

test("full retained-result preview rolls back caches; explicit recovery captures them once", (t) => {
  const f = fixture(t);
  f.store.enqueueJob("failed", {
    type: "send",
    chatId: "a",
    input: "synthetic",
    messageId: "in",
  });
  const job = f.store.claimJob("worker").job;
  const writeSet = {
    chatId: "a",
    expectedRevision: job.startedRevision,
    expectedContentRevision: job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "recovered",
        expectedRevision: 0,
        message: {
          role: "char",
          data: "recovered-zero",
          generationInfo: { generationId: "recovered-gen" },
        },
      },
    ],
  };
  f.store.finishJob(job.id, "worker", job.fence, {
    state: "failed",
    result: {
      uncommitted: {
        writeSet,
        result: {
          rerolls: { "recovered-gen": ["recovered-zero", "recovered-one"] },
        },
      },
    },
  });
  const before = f.store.cursor(),
    preview = f.store.previewJobResult(job.id);
  assert.equal(preview.canRecover, true, JSON.stringify(preview.blocked));
  assert.equal(f.store.cursor(), before);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM reply_choice_sets").get().n,
    1,
  );
  f.store.applyCommand("recover", {
    type: "recover-job-result",
    ...preview.target,
  });
  assert.equal(f.header().count, 2);
  f.move("recovered-next", "next");
  assert.equal(
    f.store.snapshot("a").messages.at(-1).message.data,
    "recovered-one",
  );
  assert.equal(f.store.listJobs("a").length, 2);
});

test("schema16 migration preserves current data, jobs and identity and introduces empty choice relations", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a"),
    source = f.store.getJob("source"),
    serverId = f.store.bootstrap().serverId;
  f.store.db.exec(
    "DROP TABLE reply_choices; DROP TABLE reply_choice_sets; DROP INDEX message_generation; PRAGMA user_version=16;",
  );
  f.store.close();
  const migrated = new EntityStore(f.file);
  t.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), 22);
  assert.equal(migrated.bootstrap().serverId, serverId);
  assert.deepEqual(migrated.snapshot("a"), before);
  assert.deepEqual(migrated.getJob("source"), source);
  assert.equal(migrated.readReplyChoices("a", "reply", 1, 0).count, 0);
  assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
});
