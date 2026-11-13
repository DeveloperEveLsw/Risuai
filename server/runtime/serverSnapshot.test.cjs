"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { AssetStorage } = require("./assets.cjs");
const { prepareSnapshot, snapshotChunks } = require("./serverSnapshot.cjs");
const { restoreServerSnapshot } = require("./restoreServerSnapshot.cjs");
const { createRuntimeService } = require("./service.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-server-snapshot-"));
  const file = join(root, "source.sqlite"),
    directory = join(root, "capture");
  await fs.mkdir(directory);
  const store = new EntityStore(file),
    authority = store.bootstrap().serverId;
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  store.initializeState({
    settings: { unknownRoot: { retained: true } },
    resources: [],
  });
  store.applyCommand("extra-settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "auxiliary",
    payload: { unknown: "Synthetic extra" },
    expectedRevision: 0,
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", unknown: { kept: true } },
  });
  for (const id of ["a", "failed", "running", "queued"])
    store.applyCommand("chat-" + id, {
      type: "create-chat",
      characterId: "c",
      chatId: id,
      metadata: { unknown: true },
    });
  // Real public outcome methods populate durable reply choices and batches.
  store.enqueueJob("completed", {
    type: "send",
    chatId: "a",
    input: "Synthetic",
    messageId: "input",
  });
  let job = store.claimJob("original-worker").job;
  store.finishJob(job.id, job.owner, job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [{ id: "c", expectedEpoch: 0 }],
      messages: [
        {
          id: "input",
          expectedRevision: 0,
          message: { role: "user", data: "Synthetic" },
        },
        {
          id: "reply",
          expectedRevision: 0,
          message: {
            role: "char",
            data: "Synthetic reply",
            generationInfo: { generationId: "gen" },
          },
        },
      ],
    },
    result: { rerolls: { gen: ["Synthetic reply", "Synthetic alternative"] } },
  });
  const first = store.snapshot("a").messages.at(-1);
  store.enqueueJob("regenerated", {
    type: "reroll",
    chatId: "a",
    messageId: first.id,
    expectedRevision: first.revision,
    expectedChatEpoch: 0,
  });
  job = store.claimJob("original-worker").job;
  store.finishJob(job.id, job.owner, job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [{ id: "c", expectedEpoch: 0 }],
      deleteMessages: [{ id: first.id, expectedRevision: first.revision }],
      messages: [
        {
          id: "replacement",
          expectedRevision: 0,
          message: {
            role: "char",
            data: "Synthetic regenerated",
            generationInfo: { generationId: "regenerated" },
          },
        },
      ],
    },
    result: {},
  });
  store.enqueueJob("failure", {
    type: "send",
    chatId: "failed",
    input: "Synthetic",
    messageId: "failed-input",
  });
  job = store.claimJob("original-worker").job;
  store.writeJobProgress(job.id, job.owner, job.fence, {}, [
    {
      request: 1,
      mode: "model",
      type: "success",
      complete: true,
      candidates: [
        { key: "0", role: "char", data: "Synthetic retained provider output" },
      ],
    },
  ]);
  const writeSet = {
    chatId: "failed",
    expectedRevision: job.startedRevision,
    expectedContentRevision: job.startedContentRevision,
    characterReads: [{ id: "c", expectedEpoch: 0 }],
    messages: [
      {
        id: "failed-reply",
        expectedRevision: 0,
        message: { role: "char", data: "Synthetic retained complete reply" },
      },
    ],
  };
  store.finishJob(job.id, job.owner, job.fence, {
    state: "failed",
    result: { code: "SYNTHETIC_FAILURE", uncommitted: { writeSet } },
  });
  store.enqueueJob("active", {
    type: "send",
    chatId: "running",
    input: "Synthetic",
    messageId: "running-input",
  });
  job = store.claimJob("original-worker", 300000).job;
  store.writeJobProgress(
    job.id,
    job.owner,
    job.fence,
    { messages: [{ role: "char", data: "Synthetic partial live output" }] },
    [
      {
        request: 1,
        mode: "model",
        type: "streaming",
        complete: false,
        candidates: [
          { key: "0", role: "char", data: "Synthetic partial provider output" },
        ],
      },
    ],
  );
  store.publishJobInteraction(job.id, job.owner, job.fence, 1, {
    kind: "input",
    prompt: "Synthetic pending question",
  });
  store.enqueueJob("pending", {
    type: "send",
    chatId: "queued",
    input: "Synthetic",
    messageId: "queued-input",
  });
  const storage = new AssetStorage(
    file,
    { call: (method, ...args) => store[method](...args) },
    authority,
  );
  const audio = Buffer.from("RIFF synthetic inert audio");
  const wav = await storage.upload([audio], "wav"),
    alias = await storage.upload([audio], "ogg");
  store.db.exec(
    "CREATE TABLE synthetic_extra(key TEXT PRIMARY KEY, bytes BLOB); INSERT INTO synthetic_extra VALUES ('neutral',X'01020304');",
  );
  store.db.exec(
    'CREATE TABLE "schema"(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO "schema" VALUES (1,9223372036854775807); CREATE TABLE "__proto__"(value TEXT); INSERT INTO "__proto__" VALUES (\'Synthetic unknown table\');',
  );
  return { root, file, directory, store, authority, job, audio, wav, alias };
}
async function capture(f, options = {}) {
  const prepared = await prepareSnapshot({
    file: f.file,
    directory: f.directory,
    serverId: f.authority,
    ...options,
  });
  const chunks = [];
  for await (const c of snapshotChunks(prepared)) chunks.push(c);
  const bytes = Buffer.concat(chunks),
    backup = join(f.root, "backup.risusnapshot");
  await fs.writeFile(backup, bytes);
  return { prepared, bytes, backup };
}
test("complete snapshot restores all tables, jobs, variants, clocks, receipts, opaque extras and asset aliases, with a fresh authority and no automatic execution", async (t) => {
  const f = await fixture(t),
    c = await capture(f),
    file = join(f.root, "restored.sqlite");
  const oldBootstrap = f.store.bootstrap(),
    oldFailed = f.store.getJob("failure"),
    oldChoices = f.store.db.prepare("SELECT * FROM reply_choices").all(),
    oldBatches = f.store.db.prepare("SELECT * FROM reply_batches").all();
  assert.ok(oldChoices.length);
  assert.ok(oldBatches.length);
  const report = await restoreServerSnapshot({
    backup: c.backup,
    file,
    expectedSha256: sha(c.bytes),
  });
  assert.equal(report.untouchedDataIdentical, true);
  assert.equal(report.unfinishedJobsInterrupted, 2);
  assert.equal(report.pendingInteractionsClosed, 1);
  assert.notEqual(report.serverId, f.authority);
  const restored = new EntityStore(file);
  try {
    assert.deepEqual(restored.getJob("failure"), oldFailed);
    assert.deepEqual(
      restored.db.prepare("SELECT * FROM reply_choices").all(),
      oldChoices,
    );
    assert.deepEqual(
      restored.db.prepare("SELECT * FROM reply_batches").all(),
      oldBatches,
    );
    assert.deepEqual(
      restored.getResource("settings", "auxiliary"),
      f.store.getResource("settings", "auxiliary"),
    );
    assert.deepEqual(
      restored.db.prepare("SELECT * FROM synthetic_extra").all(),
      f.store.db.prepare("SELECT * FROM synthetic_extra").all(),
    );
    assert.equal(restored.getJob("active").state, "interrupted");
    assert.deepEqual(
      restored.getJob("active").progress,
      f.store.getJob("active").progress,
    );
    assert.equal(restored.getJob("active").fence, f.job.fence + 1);
    assert.equal(restored.getJob("pending").state, "interrupted");
    assert.equal(restored.listInteractions().items.length, 0);
    assert.equal(restored.claimJob("new-worker"), null);
    assert.throws(
      () => restored.writeJobProgress("active", f.job.owner, f.job.fence, {}),
      { code: "STALE_WORKER" },
    );
    assert.equal(restored.previewJobResult("failure").canRecover, true);
    const choice = restored.snapshot("a").messages.at(-1);
    const header = restored.readReplyChoices(
      "a",
      choice.id,
      choice.revision,
      0,
    );
    assert.equal(header.batch.count, 2);
    restored.applyCommand("restored-choice", {
      type: "move-reply-choice",
      ...header.target,
      direction: "previous",
    });
    assert.equal(
      restored.snapshot("a").messages.at(-1).message.data,
      "Synthetic reply",
    );
    const storage = new AssetStorage(
      file,
      { call: (method, ...args) => restored[method](...args) },
      report.serverId,
    );
    assert.deepEqual(Buffer.from(await storage.read(f.wav.path)), f.audio);
    assert.deepEqual(Buffer.from(await storage.read(f.alias.path)), f.audio);
  } finally {
    restored.close();
  }
  assert.deepEqual(f.store.bootstrap(), oldBootstrap);
  assert.equal(f.store.getJob("active").state, "running");
  const runtime = await createRuntimeService({
    file,
    scheduler: { pollMs: 20 },
  });
  try {
    await delay(80);
    assert.equal(
      (await runtime.store.call("getJob", "pending")).state,
      "interrupted",
    );
    const rejected = await fetch(runtime.url + "/api/runtime/server-snapshot", {
      headers: { "risu-runtime-id": f.authority },
    });
    assert.equal(rejected.status, 409);
  } finally {
    await runtime.close();
  }
  await assert.rejects(
    () =>
      restoreServerSnapshot({
        backup: c.backup,
        file,
        expectedSha256: sha(c.bytes),
      }),
    { code: "DESTINATION_EXISTS" },
  );
});
test("restoration preserves recorded cancellation, rejects a wrong whole-file digest and checks SQLite authority against an internally rehashed manifest", async (t) => {
  const f = await fixture(t);
  f.store.requestCancel("active");
  const c = await capture(f),
    file = join(f.root, "cancelled.sqlite");
  await restoreServerSnapshot({
    backup: c.backup,
    file,
    expectedSha256: sha(c.bytes),
  });
  const restored = new EntityStore(file);
  try {
    assert.equal(restored.getJob("active").state, "cancelled");
    assert.equal(restored.getJob("active").cancelRequested, true);
    assert.deepEqual(
      restored.getJob("active").progress,
      f.store.getJob("active").progress,
    );
    assert.equal(restored.listInteractions().items.length, 0);
  } finally {
    restored.close();
  }
  const wrong = join(f.root, "wrong-hash.sqlite");
  await assert.rejects(
    () =>
      restoreServerSnapshot({
        backup: c.backup,
        file: wrong,
        expectedSha256: "0".repeat(64),
      }),
    { code: "SNAPSHOT_CHECKSUM_MISMATCH" },
  );
  await assert.rejects(() => fs.stat(wrong), { code: "ENOENT" });
  const manifest = {
      ...c.prepared.manifest,
      serverId: "another-synthetic-authority",
    },
    json = Buffer.from(JSON.stringify(manifest)),
    length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  const body = c.bytes.subarray(12 + c.bytes.readUInt32LE(8)),
    tampered = Buffer.concat([c.bytes.subarray(0, 8), length, json, body]);
  const backup = join(f.root, "rehashed-metadata.risusnapshot"),
    target = join(f.root, "metadata.sqlite");
  await fs.writeFile(backup, tampered);
  await assert.rejects(
    () =>
      restoreServerSnapshot({
        backup,
        file: target,
        expectedSha256: sha(tampered),
      }),
    { code: "SNAPSHOT_METADATA_MISMATCH" },
  );
  await assert.rejects(() => fs.stat(target), { code: "ENOENT" });
  assert.equal(
    (await fs.readdir(f.root)).some((n) =>
      n.startsWith(".risu-snapshot-restore-"),
    ),
    false,
  );
});
test("pinned WAL backup remains one source state across later peer writes and explicit limits do not change source state", async (t) => {
  const f = await fixture(t),
    before = f.store.getResource("settings", "global");
  const c = await capture(f, {
    afterPinned: () =>
      f.store.applyCommand("peer-setting", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: before.revision,
        payload: { ...before.payload, afterCapture: true },
      }),
  });
  const report = await restoreServerSnapshot({
    backup: c.backup,
    file: join(f.root, "restored.sqlite"),
    expectedSha256: sha(c.bytes),
  });
  const r = new EntityStore(join(f.root, "restored.sqlite"));
  try {
    assert.equal(
      r.getResource("settings", "global").payload.afterCapture,
      undefined,
    );
    assert.equal(
      f.store.getResource("settings", "global").payload.afterCapture,
      true,
    );
  } finally {
    r.close();
  }
  assert.equal(report.sourceCursor, c.prepared.manifest.cursor);
  await assert.rejects(
    () =>
      prepareSnapshot({
        file: f.file,
        directory: f.directory,
        serverId: f.authority,
        limits: { databaseBytes: 1 },
      }),
    { code: "ARCHIVE_TOO_LARGE" },
  );
});
test("truncation, checksum damage and existing assets reject without publishing a database or leaving staged data", async (t) => {
  const f = await fixture(t),
    c = await capture(f);
  for (const [label, bytes] of [
    ["truncated", c.bytes.subarray(0, c.bytes.length - 8)],
    ["corrupt", Buffer.from(c.bytes)],
  ]) {
    if (label === "corrupt") bytes[bytes.length - 9] ^= 1;
    const backup = join(f.root, label + ".bin"),
      file = join(f.root, label + ".sqlite");
    await fs.writeFile(backup, bytes);
    await assert.rejects(() =>
      restoreServerSnapshot({ backup, file, expectedSha256: sha(bytes) }),
    );
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(file + ".assets"), { code: "ENOENT" });
  }
  assert.equal(
    (await fs.readdir(f.root)).some((n) =>
      n.startsWith(".risu-snapshot-restore-"),
    ),
    false,
  );
  await assert.rejects(
    () =>
      restoreServerSnapshot({
        backup: join(f.root, "absent.risusnapshot"),
        file: join(f.root, "missing.sqlite"),
        expectedSha256: sha(c.bytes),
      }),
    { code: "ENOENT" },
  );
  assert.equal(
    (await fs.readdir(f.root)).some((n) =>
      n.startsWith(".risu-snapshot-restore-"),
    ),
    false,
  );
  const file = join(f.root, "blocked.sqlite");
  await fs.mkdir(file + ".assets");
  await fs.writeFile(join(file + ".assets", "keep"), "Synthetic preserve");
  await assert.rejects(
    () =>
      restoreServerSnapshot({
        backup: c.backup,
        file,
        expectedSha256: sha(c.bytes),
      }),
    { code: "DESTINATION_EXISTS" },
  );
  assert.equal(
    await fs.readFile(join(file + ".assets", "keep"), "utf8"),
    "Synthetic preserve",
  );
});
