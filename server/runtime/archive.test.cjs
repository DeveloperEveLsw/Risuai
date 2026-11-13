"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("../entity/store.cjs");
const { ArchiveExports } = require("./archive.cjs");
const { createRuntimeService } = require("./service.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const { createHash } = require("node:crypto");

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-archive-worker-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file);
  store.initializeState({
    settings: { unknown: "x".repeat(32700) + "😀 한글 ".repeat(9000) },
    resources: [],
  });
  const archives = new ArchiveExports(
    file,
    store.bootstrap().serverId,
    options,
  );
  t.after(async () => {
    await archives.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, archives, file };
}
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

test("export worker keeps Unicode intact, applies backpressure, rejects concurrent capture and releases its slot after disconnect", async (t) => {
  const { store, archives } = fixture(t);
  const response = new Response(true);
  const task = archives.stream(response);
  const rejection = assert.rejects(task, { code: "ARCHIVE_ABORTED" });
  await response.started;
  await delay(30);
  assert.equal(response.chunks.length, 1);
  await assert.rejects(() => archives.stream(new Response()), {
    code: "ARCHIVE_BUSY",
  });
  store.applyCommand("during-export", {
    type: "create-character",
    characterId: "during",
    definition: { name: "Synthetic" },
  });
  assert.equal(store.bootstrap().characters.length, 1);
  response.emit("close");
  await rejection;
  assert.equal(archives.active.size, 0);
  const complete = new Response();
  await archives.stream(complete);
  const archive = JSON.parse(Buffer.concat(complete.chunks));
  assert.equal(
    archive.database.unknown,
    store.getResource("settings", "global").payload.unknown,
  );
  assert.equal(archive.database.characters[0].chaId, "during");
  assert.equal(complete.contentType, "application/json");
  assert.equal(complete.ended, true);
});

test("export limits fail before any response body and shutdown terminates a slow export", async (t) => {
  const { archives, file, store } = fixture(t, { maxBytes: 10 });
  const tooLarge = new Response();
  await assert.rejects(() => archives.stream(tooLarge), {
    code: "ARCHIVE_TOO_LARGE",
  });
  assert.deepEqual(tooLarge.chunks, []);
  assert.equal(archives.active.size, 0);
  const slow = new ArchiveExports(file, store.bootstrap().serverId);
  const response = new Response(true);
  const task = slow.stream(response);
  const failed = assert.rejects(task, { code: "ARCHIVE_FAILED" });
  await response.started;
  await slow.close();
  await failed;
  await assert.rejects(() => slow.stream(new Response()), {
    code: "STORE_CLOSED",
  });
});

test("HTTP original archive requires current authority and leaves regular reads available", async (t) => {
  const { file } = fixture(t);
  const runtime = await createRuntimeService({ file });
  t.after(() => runtime.close());
  const authority = (await runtime.store.call("bootstrap")).serverId;
  const missing = await fetch(runtime.url + "/api/runtime/archive");
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "SERVER_CHANGED");
  const result = await fetch(runtime.url + "/api/runtime/archive", {
    headers: { "risu-runtime-id": authority },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).serverId, authority);
  assert.equal((await runtime.store.call("bootstrap")).serverId, authority);
});
test("original JSON export rejects server plugin memory before a body and explains complete snapshot preservation", async (t) => {
  const { store, archives } = fixture(t);
  const script = "// Synthetic public plugin fixture",
    namespace = {
      pluginId: "synthetic",
      bundleSha: createHash("sha256").update(script).digest("hex"),
      pluginEpoch: 0,
    };
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 0,
    payload: { script, enabled: true },
  });
  const lease = store.claimPluginStorage({
    namespace,
    writerId: "browser",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease,
    expectedRevision: 0,
    commitId: "graph",
    writes: [{ key: "wl.web.v1", value: "Synthetic private graph" }],
  });
  const response = new Response();
  await assert.rejects(
    () => archives.stream(response),
    (error) =>
      error.code === "ARCHIVE_PLUGIN_STORAGE_UNSUPPORTED" &&
      /complete server snapshot/.test(error.message),
  );
  assert.deepEqual(response.chunks, []);
  assert.equal(archives.active.size, 0);
  assert.equal(
    store.readPluginStorage(namespace, "wl.web.v1").value,
    "Synthetic private graph",
  );
  store.commitPluginStorage({
    lease,
    expectedRevision: 1,
    commitId: "empty",
    writes: [{ key: "wl.web.v1", deleted: true }],
  });
  const empty = new Response();
  await archives.stream(empty);
  assert.equal(
    JSON.parse(Buffer.concat(empty.chunks)).format,
    "risu-original-archive",
  );
});
