"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("../entity/store.cjs");
const { createProgressCheckpoint } = require("./progress.cjs");
const {
  MAX_BYTES,
  upsert,
  project,
  read,
} = require("../entity/providerOutputs.cjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-provider-output-")),
    file = join(root, "state.sqlite");
  let now = 1;
  const store = new EntityStore(file, { now: () => now });
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
  });
  store.enqueueJob("job", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "input",
  });
  const job = store.claimJob("worker", 1000).job;
  const checkpoint = createProgressCheckpoint(
    { call: async (method, ...args) => store[method](...args) },
    job,
    { intervalMs: 100000 },
  );
  t.after(() => checkpoint.stop());
  const output = {
    request: 1,
    mode: "model",
    type: "success",
    complete: true,
    candidates: [
      {
        key: "0",
        role: "char",
        data: "<script>synthetic()</script> Raw output",
      },
    ],
  };
  return {
    store,
    file,
    checkpoint,
    job,
    output,
    advance: () => {
      now = 2000;
    },
  };
}

test("private output is ownership-fenced, absent from polling/journal bodies and durable on explicit failed preview", async (t) => {
  const f = fixture(t);
  f.checkpoint.receive({ type: "stage", stage: 3 });
  await f.checkpoint.retainProviderOutput(f.output);
  const running = f.store.getJobStatus("job");
  assert.equal(running.progress.stage, 3);
  assert.equal(running.progress.providerOutputs, undefined);
  assert.equal(running.result.retained, 1);
  assert.equal(JSON.stringify(running).includes("Raw output"), false);
  assert.ok(JSON.stringify(running).length < 1000);
  const journal = f.store.db
    .prepare("SELECT payload FROM changes WHERE entity_type='job-progress'")
    .all();
  assert.ok(journal.length);
  assert.equal(JSON.stringify(journal).includes("Raw output"), false);
  f.store.finishJob("job", "worker", f.job.fence, {
    state: "failed",
    result: { code: "ENGINE_ERROR", message: "Synthetic Lua error" },
  });
  const before = f.store.snapshot("a"),
    cursor = f.store.cursor();
  const preview = f.store.previewJobResult("job");
  assert.equal(preview.complete, false);
  assert.equal(preview.canRecover, false);
  assert.deepEqual(preview.providerOutputs, [f.output]);
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.snapshot("a"), before);
  const reopened = new EntityStore(f.file);
  try {
    assert.deepEqual(reopened.previewJobResult("job").providerOutputs, [
      f.output,
    ]);
  } finally {
    reopened.close();
  }
  assert.deepEqual(f.store.getJobStatus("job").progress, {});
});

test("raw provider output cannot be promoted to a successful transaction by recovery", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  f.store.finishJob("job", "worker", f.job.fence, { state: "failed" });
  const preview = f.store.previewJobResult("job"),
    before = f.store.snapshot("a");
  assert.throws(
    () =>
      f.store.applyCommand("recover", {
        type: "recover-job-result",
        ...preview.target,
      }),
    { code: "RESULT_NOT_RECOVERABLE" },
  );
  assert.deepEqual(f.store.snapshot("a"), before);
  assert.deepEqual(f.store.previewJobResult("job").providerOutputs, [f.output]);
});

test("successful finalization drops raw copies in the same canonical transaction", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  f.store.finishJob("job", "worker", f.job.fence, {
    state: "completed",
    messages: [{ id: "reply", message: { role: "char", data: "Processed" } }],
  });
  assert.equal(f.store.getJob("job").progress.providerOutputs, undefined);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM job_provider_outputs WHERE job_id='job'",
      )
      .get().count,
    0,
  );
  assert.equal(f.store.snapshot("a").messages[0].message.data, "Processed");
});

test("invalid or oversized private outputs fail before changing the previous checkpoint", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  const before = f.store.getJob("job"),
    cursor = f.store.cursor();
  const candidate = f.output.candidates[0];
  for (const value of [
    { ...f.output, secret: "no" },
    { ...f.output, mode: "credential" },
    { ...f.output, request: 65 },
    { ...f.output, candidates: [candidate, candidate] },
    { ...f.output, candidates: [{ ...candidate, data: 1 }] },
    {
      ...f.output,
      candidates: [{ ...candidate, data: "\u0000".repeat(MAX_BYTES / 6) }],
    },
  ]) {
    await assert.rejects(f.checkpoint.retainProviderOutput(value), {
      code: "INVALID_COMMAND",
    });
    assert.deepEqual(f.store.getJob("job"), before);
    assert.equal(f.store.cursor(), cursor);
    assert.deepEqual(read(f.store, "job"), [f.output]);
  }
});

test("expired ownership cannot write raw output or advance the journal", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  f.advance();
  f.store.expireJobs();
  const before = f.store.getJob("job"),
    cursor = f.store.cursor();
  await assert.rejects(
    f.checkpoint.retainProviderOutput({ ...f.output, complete: false }),
    { code: "STALE_WORKER" },
  );
  assert.deepEqual(f.store.getJob("job"), before);
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(read(f.store, "job"), [f.output]);
  assert.deepEqual(f.store.previewJobResult("job").providerOutputs, [f.output]);
});

test("separate output rows enforce the aggregate budget and preserve unread response payloads", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  const second = {
    ...f.output,
    request: 2,
    candidates: [{ ...f.output.candidates[0], data: "" }],
  };
  const available =
    MAX_BYTES - Buffer.byteLength(JSON.stringify([f.output, second]));
  second.candidates[0].data = "x".repeat(available);
  await f.checkpoint.retainProviderOutput(second);
  const before = f.store.getJob("job"),
    cursor = f.store.cursor(),
    saved = read(f.store, "job");
  await assert.rejects(
    f.checkpoint.retainProviderOutput({
      ...second,
      candidates: [
        { ...second.candidates[0], data: second.candidates[0].data + "x" },
      ],
    }),
    { code: "INVALID_COMMAND" },
  );
  await assert.rejects(
    f.checkpoint.retainProviderOutput({ ...f.output, request: 3 }),
    { code: "INVALID_COMMAND" },
  );
  assert.deepEqual(read(f.store, "job"), saved);
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.getJob("job"), before);
  // Ordinary stage checkpoints neither copy nor delete the output relation.
  f.store.writeJobProgress("job", "worker", f.job.fence, { stage: 4 });
  assert.deepEqual(read(f.store, "job"), saved);
  assert.ok(JSON.stringify(f.store.getJob("job")).length < 1000);
  assert.throws(
    () =>
      f.store.writeJobProgress("job", "worker", f.job.fence, {
        providerOutputs: [f.output],
      }),
    { code: "INVALID_COMMAND" },
  );
});

test("writing or polling one response never parses another retained response", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput({
    ...f.output,
    candidates: [
      { ...f.output.candidates[0], data: "UNREAD-SYNTHETIC-OUTPUT" },
    ],
  });
  const parse = JSON.parse;
  try {
    JSON.parse = (text, ...args) => {
      assert.equal(
        typeof text === "string" && text.includes("UNREAD-SYNTHETIC-OUTPUT"),
        false,
      );
      return parse(text, ...args);
    };
    await f.checkpoint.retainProviderOutput({ ...f.output, request: 2 });
    f.store.getJobStatus("job");
    f.checkpoint.receive({ type: "stage", stage: 4 });
    await f.checkpoint.flush();
  } finally {
    JSON.parse = parse;
  }
  assert.equal(read(f.store, "job").length, 2);
});

test("a newer chunk arriving during commit is not lost and later stage writes omit saved private bodies", async (t) => {
  const f = fixture(t),
    calls = [];
  let release, started;
  const held = new Promise((resolve) => (release = resolve)),
    admitted = new Promise((resolve) => (started = resolve));
  const checkpoint = createProgressCheckpoint(
    {
      call: async (method, ...args) => {
        calls.push(structuredClone(args));
        if (calls.length === 1) {
          started();
          await held;
        }
        return f.store[method](...args);
      },
    },
    f.job,
    { intervalMs: 100000 },
  );
  t.after(() => checkpoint.stop());
  const first = checkpoint.retainProviderOutput(f.output);
  await admitted;
  const newer = {
    ...f.output,
    candidates: [{ ...f.output.candidates[0], data: "Newer synthetic chunk" }],
  };
  const second = checkpoint.retainProviderOutput(newer);
  checkpoint.receive({ type: "stage", stage: 4 });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(read(f.store, "job"), [newer]);
  assert.equal(f.store.getJob("job").progress.stage, 4);
  checkpoint.receive({ type: "stage", stage: 5 });
  await checkpoint.flush();
  assert.deepEqual(calls.at(-1)[4], []);
  assert.equal(
    calls.some((args) => args[3].providerOutputs),
    false,
  );
  assert.equal(calls.length, 3);
});

test("separating rows preserves the combined16MiB logical checkpoint limit atomically", async (t) => {
  const f = fixture(t);
  const large = {
    ...f.output,
    candidates: [
      { ...f.output.candidates[0], data: "x".repeat(3 * 1024 * 1024) },
    ],
  };
  await f.checkpoint.retainProviderOutput(large);
  const before = f.store.getJob("job"),
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.writeJobProgress(
        "job",
        "worker",
        f.job.fence,
        { notice: "x".repeat(13 * 1024 * 1024) },
        [{ ...f.output, request: 2 }],
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.deepEqual(f.store.getJob("job"), before);
  assert.deepEqual(read(f.store, "job"), [large]);
  assert.equal(f.store.cursor(), cursor);
});

test("the budget covers UTF8, JSON escaping and all responses together", async (t) => {
  const { output } = fixture(t);
  for (const text of ["x", "한", "\u0000"]) {
    const overhead =
      Buffer.byteLength(JSON.stringify([output])) -
      Buffer.byteLength(JSON.stringify(output.candidates[0].data)) +
      2;
    const size = Buffer.byteLength(JSON.stringify(text)) - 2;
    const count = Math.floor((MAX_BYTES - overhead) / size);
    const value = {
      ...output,
      candidates: [{ ...output.candidates[0], data: text.repeat(count) }],
    };
    const saved = upsert([], value);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= MAX_BYTES);
    assert.throws(
      () =>
        upsert([], {
          ...value,
          candidates: [
            { ...value.candidates[0], data: text.repeat(count + 1) },
          ],
        }),
      { code: "INVALID_COMMAND" },
    );
    assert.throws(() => upsert(saved, { ...output, request: 2 }), {
      code: "INVALID_COMMAND",
    });
    assert.deepEqual(project([...saved, output]), []);
  }
});

test("real SQLITE_FULL rejects a larger raw checkpoint without losing the previous durable output", async (t) => {
  const f = fixture(t);
  await f.checkpoint.retainProviderOutput(f.output);
  const before = f.store.getJob("job"),
    cursor = f.store.cursor();
  f.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const count = f.store.db.prepare("PRAGMA page_count").get().page_count;
  f.store.db.exec("PRAGMA max_page_count=" + count);
  const full = (error) =>
    error.code === "ERR_SQLITE_ERROR" && (error.errcode & 255) === 13;
  await assert.rejects(
    f.checkpoint.retainProviderOutput({
      ...f.output,
      candidates: [
        {
          ...f.output.candidates[0],
          data: "Synthetic retained output ".repeat(16000),
        },
      ],
    }),
    full,
  );
  assert.deepEqual(f.store.getJob("job"), before);
  assert.equal(f.store.cursor(), cursor);
  f.store.db.exec("PRAGMA max_page_count=100000");
  await assert.rejects(f.checkpoint.flush(), full);
  f.checkpoint.stop();
  f.store.finishJob("job", "worker", f.job.fence, {
    state: "failed",
    result: { code: "DATABASE_ERROR" },
  });
  assert.deepEqual(f.store.previewJobResult("job").providerOutputs, [f.output]);
  assert.equal(f.store.snapshot("a").messages.length, 0);
  assert.equal(
    f.store.db.prepare("PRAGMA quick_check").get().quick_check,
    "ok",
  );
});
