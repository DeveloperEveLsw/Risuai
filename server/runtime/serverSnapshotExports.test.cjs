"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { ServerSnapshotExports } = require("./serverSnapshotExports.cjs");
const { createRuntimeService } = require("./service.cjs");
const {
  snapshotEnd,
} = require("../../src/ts/runtime/serverSnapshotProtocol.mjs");

class Response extends EventEmitter {
  constructor(hold = false) {
    super();
    this.chunks = [];
    this.hold = hold;
    this.started = new Promise((resolve) => (this.startedResolve = resolve));
  }
  type(value) {
    this.contentType = value;
  }
  attachment(value) {
    this.filename = value;
  }
  write(value, callback) {
    this.chunks.push(Buffer.from(value));
    this.startedResolve();
    if (this.hold) this.resume = callback;
    else callback();
    return !this.hold;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-snapshot-export-")),
    file = join(root, "state.sqlite");
  const store = new EntityStore(file);
  store.initializeState({
    settings: { unknown: "Synthetic neutral" },
    resources: [],
  });
  const exports = new ServerSnapshotExports(
    file,
    store.bootstrap().serverId,
    options,
  );
  t.after(async () => {
    await exports.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { store, file, exports, root };
}
async function emptyStaging(file) {
  assert.deepEqual(await fs.readdir(file + ".snapshot-tmp"), []);
}
async function waitForCleanup(file) {
  const end = Date.now() + 3000;
  while ((await fs.readdir(file + ".snapshot-tmp")).length) {
    if (Date.now() >= end) throw Error("Snapshot cleanup timed out");
    await delay(10);
  }
}

test("snapshot stream applies backpressure, retains a readonly captured state and cleans owned staging on disconnect and shutdown", async (t) => {
  const f = await fixture(t),
    response = new Response(true),
    task = f.exports.stream(response);
  const runtime = await createRuntimeService({ file: f.file });
  t.after(() => runtime.close());
  const aborted = assert.rejects(task, { code: "ARCHIVE_ABORTED" });
  await response.started;
  await delay(30);
  assert.equal(response.chunks.length, 1);
  await assert.rejects(() => f.exports.stream(new Response()), {
    code: "ARCHIVE_BUSY",
  });
  await runtime.store.call("applyCommand", "peer", {
    type: "create-character",
    characterId: "peer",
    definition: { name: "Synthetic peer" },
  });
  assert.equal((await runtime.store.call("bootstrap")).characters.length, 1);
  response.emit("close");
  await aborted;
  await emptyStaging(f.file);
  assert.equal(f.exports.active.size, 0);
  const complete = new Response();
  await f.exports.stream(complete);
  assert.equal(complete.ended, true);
  assert.equal(complete.contentType, "application/octet-stream");
  assert.equal(complete.filename, "risu-server-backup.risusnapshot");
  assert.ok(
    Buffer.concat(complete.chunks)
      .subarray(-8)
      .equals(Buffer.from(snapshotEnd)),
  );
  await emptyStaging(f.file);
  const slow = new Response(true),
    closing = f.exports.stream(slow),
    stopped = assert.rejects(closing, { code: "ARCHIVE_FAILED" });
  await slow.started;
  await f.exports.close();
  await stopped;
  await emptyStaging(f.file);
  await assert.rejects(() => f.exports.stream(new Response()), {
    code: "STORE_CLOSED",
  });
});

test("all snapshot budgets fail before the body and premature response closure leaves no staging", async (t) => {
  const f = await fixture(t);
  for (const limits of [
    { databaseBytes: 1 },
    { totalBytes: 1 },
    { manifestBytes: 1 },
    { files: 0 },
  ]) {
    const exports = new ServerSnapshotExports(
        f.file,
        f.store.bootstrap().serverId,
        { limits },
      ),
      res = new Response();
    try {
      await assert.rejects(() => exports.stream(res), {
        code: "ARCHIVE_TOO_LARGE",
      });
      assert.deepEqual(res.chunks, []);
      await emptyStaging(f.file);
    } finally {
      await exports.close();
    }
  }
  const res = new Response();
  res.destroyed = true;
  await assert.rejects(() => f.exports.stream(res), {
    code: "ARCHIVE_ABORTED",
  });
  await emptyStaging(f.file);
});

test("actual HTTP snapshot checks authority and missing or changed immutable blobs cannot receive a completion marker", async (t) => {
  const f = await fixture(t),
    runtime = await createRuntimeService({ file: f.file });
  t.after(() => runtime.close());
  const serverId = f.store.bootstrap().serverId,
    headers = { "risu-runtime-id": serverId };
  const missing = await fetch(runtime.url + "/api/runtime/server-snapshot");
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "SERVER_CHANGED");
  const clean = await fetch(runtime.url + "/api/runtime/server-snapshot", {
    headers,
  });
  assert.equal(clean.status, 200);
  const cleanBytes = Buffer.from(await clean.arrayBuffer());
  assert.ok(cleanBytes.subarray(-8).equals(Buffer.from(snapshotEnd)));
  await waitForCleanup(f.file);
  const original = Buffer.from("Synthetic immutable blob"),
    asset = await runtime.assets.upload([original], "txt");
  const blob = join(f.file + ".assets", serverId, asset.digest + ".blob");
  for (const missingBlob of [false, true]) {
    if (missingBlob) await fs.unlink(blob);
    else {
      const corrupted = Buffer.from(original);
      corrupted[0] ^= 1;
      await fs.writeFile(blob, corrupted);
    }
    const response = await fetch(runtime.url + "/api/runtime/server-snapshot", {
      headers,
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(-8).equals(Buffer.from(snapshotEnd)), false);
    assert.equal((await runtime.store.call("bootstrap")).serverId, serverId);
    await waitForCleanup(f.file);
  }
  await runtime.close();
  await emptyStaging(f.file);
});
