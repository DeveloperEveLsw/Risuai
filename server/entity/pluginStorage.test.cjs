"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs/promises");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");
const storage = require("./pluginStorage.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");
const capturedPluginReads = new WeakMap();
const {
  prepareSnapshot,
  snapshotChunks,
} = require("../runtime/serverSnapshot.cjs");
const {
  restoreServerSnapshot,
} = require("../runtime/restoreServerSnapshot.cjs");
const {
  validateSnapshotManifest,
} = require("../../src/ts/runtime/serverSnapshotProtocol.mjs");

const script = "// Synthetic public-plugin fixture\nconst fixture = true;";
const namespace = {
  pluginId: "public-fixture",
  bundleSha: createHash("sha256").update(script).digest("hex"),
  pluginEpoch: 0,
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "risu-plugin-storage-"));
  const file = join(root, "state.sqlite");
  let now = 1000;
  const store = new EntityStore(file, { now: () => now });
  const client = storage.createClient(store);
  client.initialize();
  store.initializeState({ settings: {}, resources: [] });
  const originalClaim = store.claimJob.bind(store);
  store.claimJob = (...args) => {
    const claimed = originalClaim(...args);
    if (claimed?.snapshot) {
      const reads = createPluginReadDependencies(claimed.snapshot);
      reads.observeCharacter();
      reads.observeChat();
      reads.observePlugin(namespace.pluginId);
      reads.observeDatabaseFields(["maxContext"]);
      capturedPluginReads.set(claimed.job, reads.snapshot());
    }
    return claimed;
  };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const payload = {
    name: "Public synthetic",
    script,
    enabled: true,
    version: "3.0",
  };
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 0,
    payload,
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "character",
    definition: { type: "character", name: "Synthetic" },
    chat: { chatId: "a", metadata: {} },
  });
  store.applyCommand("other-chat", {
    type: "create-chat",
    characterId: "character",
    chatId: "b",
    metadata: {},
  });
  const claimBrowser = (writerId = "browser-one", leaseMs = 30000) =>
    client.claim({
      namespace,
      writerId,
      authority: { kind: "browser" },
      leaseMs,
    });
  const claimJob = (
    chatId = "a",
    requestId = "job-one",
    writerId = "native-one",
  ) => {
    store.enqueueJob(requestId, { type: "button", chatId, data: "synthetic" });
    const { job } = store.claimJob(writerId);
    return {
      job,
      lease: client.claim({
        namespace,
        writerId,
        authority: {
          kind: "job",
          jobId: job.id,
          owner: job.owner,
          fence: job.fence,
        },
      }),
    };
  };
  const commit = (lease, expectedRevision, writes, commitId = "commit-one") =>
    client.commit({ lease, expectedRevision, writes, commitId });
  return {
    root,
    store,
    client,
    file,
    payload,
    claimBrowser,
    claimJob,
    commit,
    time: (value) => {
      now = value;
    },
  };
}

test("multi-key graph/checkpoint commit survives reopen and emits only invalidation headers", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser(),
    cursor = f.store.cursor();
  const result = f.commit(lease, 0, [
    { key: "wl.web.v1.manifest", value: { chunks: ["wl.web.v1.0"] } },
    { key: "wl.web.v1.0", value: "synthetic private graph text" },
    { key: "wl.settings.v1", value: { speedMode: "fast" } },
  ]);
  assert.equal(result.revision, 1);
  assert.equal(f.client.readAll(namespace).items.length, 3);
  const journal = JSON.stringify(f.store.changes(cursor));
  assert.equal(journal.includes("synthetic private graph text"), false);
  assert.equal(journal.includes("speedMode"), false);
  assert.equal(journal.includes("plugin-storage"), true);
  assert.equal(
    JSON.stringify(f.store.bootstrap()).includes(
      "synthetic private graph text",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(f.store.snapshot("a")).includes("wl.web.v1"),
    false,
  );
  const peer = new EntityStore(f.file, { now: () => 1000 });
  try {
    assert.deepEqual(
      storage.createClient(peer).readAll(namespace),
      f.client.readAll(namespace),
    );
    assert.equal(
      storage.createClient(peer).read(namespace, "wl.web.v1.0").value,
      "synthetic private graph text",
    );
  } finally {
    peer.close();
  }
});
test("all original API JSON/falsy values survive with deletion and canonical no-op revisions", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  const values = [null, false, 0, "", [1, "x"], { z: 1, a: 2 }, "wlraw1:false"];
  const first = f.commit(
    lease,
    0,
    values.map((value, i) => ({ key: `wl.test.${i}`, value })),
  );
  assert.equal(first.revision, 1);
  values.forEach((value, i) =>
    assert.deepEqual(f.client.read(namespace, `wl.test.${i}`).value, value),
  );
  const same = f.commit(
    lease,
    1,
    [{ key: "wl.test.5", value: { a: 2, z: 1 } }],
    "same",
  );
  assert.equal(same.changed, false);
  assert.equal(same.revision, 1);
  const deleted = f.commit(
    lease,
    1,
    [{ key: "wl.test.0", deleted: true }],
    "delete",
  );
  assert.equal(deleted.revision, 2);
  assert.equal(f.client.read(namespace, "wl.test.0").found, false);
  assert.equal(f.client.read(namespace, "wl.test.0").itemRevision, 2);
  f.commit(lease, 2, [{ key: "wl.test.0", value: null }], "readd");
  assert.equal(f.client.read(namespace, "wl.test.0").found, true);
  assert.equal(f.client.read(namespace, "wl.test.0").itemRevision, 3);
});
test("lost acknowledgement retry is idempotent, changed reuse fails, stale snapshots cannot overwrite", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  const first = f.commit(lease, 0, [
    { key: "wl.settings.v1", value: { one: true } },
  ]);
  const cursor = f.store.cursor();
  assert.deepEqual(
    f.commit(lease, 0, [{ key: "wl.settings.v1", value: { one: true } }]),
    first,
  );
  assert.equal(f.store.cursor(), cursor);
  assert.throws(
    () =>
      f.commit(lease, 0, [{ key: "wl.settings.v1", value: { one: false } }]),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.throws(
    () =>
      f.commit(lease, 0, [{ key: "wl.web.v1", value: "stale" }], "fresh-id"),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.client.read(namespace, "wl.web.v1").found, false);
});
test("a rejected checkpoint leaves every graph fragment, revision and receipt unchanged", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser(),
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.commit(lease, 0, [
        { key: "wl.web.v1.manifest", value: { chunks: ["wl.web.v1.0"] } },
        { key: "wl.web.v1.0", value: undefined },
      ]),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(f.client.readAll(namespace).revision, 0);
  assert.equal(f.client.readAll(namespace).items.length, 0);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS count FROM plugin_storage_commits")
      .get().count,
    0,
  );
  assert.throws(
    () =>
      f.commit(lease, 0, [
        { key: "same", value: "a" },
        { key: "same", value: "b" },
      ]),
    { code: "INVALID_COMMAND" },
  );
  assert.throws(() => f.commit(lease, 0, [{ key: "invalid", value: NaN }]), {
    code: "INVALID_COMMAND",
  });
  assert.throws(
    () => f.commit(lease, 0, [{ key: "invalid", deleted: true, value: "a" }]),
    { code: "INVALID_COMMAND" },
  );
});
test("two database connections, devices and distinct chats share one writer lease", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  const peer = new EntityStore(f.file, { now: () => 1000 }),
    other = storage.createClient(peer);
  try {
    assert.throws(
      () =>
        other.claim({
          namespace,
          writerId: "browser-two",
          authority: { kind: "browser" },
        }),
      { code: "PLUGIN_STORAGE_BUSY" },
    );
    assert.deepEqual(f.claimBrowser(), lease);
    f.store.enqueueJob("job", {
      type: "button",
      chatId: "b",
      data: "synthetic",
    });
    const { job } = f.store.claimJob("native");
    assert.throws(
      () =>
        other.claim({
          namespace,
          writerId: "native",
          authority: {
            kind: "job",
            jobId: job.id,
            owner: job.owner,
            fence: job.fence,
          },
        }),
      { code: "PLUGIN_STORAGE_BUSY" },
    );
    assert.deepEqual(f.client.release(lease), { released: true });
    const next = other.claim({
      namespace,
      writerId: "native",
      authority: {
        kind: "job",
        jobId: job.id,
        owner: job.owner,
        fence: job.fence,
      },
    });
    assert.equal(next.fence, lease.fence + 1);
    assert.throws(
      () => f.commit(lease, 0, [{ key: "wl.web.v1", value: "old device" }]),
      { code: "STALE_PLUGIN_WORKER" },
    );
    assert.deepEqual(f.client.release(lease), { released: false });
    other.commit({
      lease: next,
      expectedRevision: 0,
      commitId: "successor",
      writes: [{ key: "wl.web.v1", value: "new writer" }],
    });
  } finally {
    peer.close();
  }
});
test("expired lease cannot write, renew or release a reclaimed successor", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser("one", 10);
  f.time(lease.expiresAt);
  assert.throws(() => f.commit(lease, 0, [{ key: "x", value: "expired" }]), {
    code: "STALE_PLUGIN_WORKER",
  });
  assert.throws(() => f.client.renew({ lease, leaseMs: 1000 }), {
    code: "STALE_PLUGIN_WORKER",
  });
  const next = f.claimBrowser("two");
  assert.equal(next.fence, lease.fence + 1);
  assert.deepEqual(f.client.release(lease), { released: false });
  f.commit(next, 0, [{ key: "x", value: "new" }]);
});
test("native cancellation fences writes and receipt replay, while another chat can reclaim immediately", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  f.commit(lease, 0, [{ key: "wl.web.v1", value: "committed before cancel" }]);
  f.store.requestCancel(job.id);
  assert.throws(
    () =>
      f.commit(lease, 1, [{ key: "wl.web.v1", value: "after cancel" }], "late"),
    { code: "JOB_CANCELLED" },
  );
  assert.throws(
    () =>
      f.commit(lease, 0, [
        { key: "wl.web.v1", value: "committed before cancel" },
      ]),
    { code: "JOB_CANCELLED" },
  );
  const next = f.claimJob("b", "second-job", "native-two");
  assert.equal(next.lease.fence, lease.fence + 1);
  f.commit(
    next.lease,
    1,
    [{ key: "wl.web.v1", value: "other chat" }],
    "second-commit",
  );
  assert.throws(
    () =>
      f.commit(
        lease,
        2,
        [{ key: "wl.web.v1", value: "cancelled old worker" }],
        "very-late",
      ),
    { code: "STALE_PLUGIN_WORKER" },
  );
});
test("native ownership/lease expiry, wrong job fence, and terminal state fence storage", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  assert.throws(
    () =>
      f.client.claim({
        namespace,
        writerId: "invalid",
        authority: {
          kind: "job",
          jobId: job.id,
          owner: job.owner,
          fence: job.fence + 1,
        },
      }),
    { code: "STALE_WORKER" },
  );
  f.time(job.leaseUntil);
  assert.throws(() => f.client.renew({ lease }), {
    code: "STALE_PLUGIN_WORKER",
  });
  f.time(1000);
  f.store.finishJob(job.id, job.owner, job.fence, {
    state: "failed",
    result: { code: "SYNTHETIC" },
  });
  assert.throws(() => f.commit(lease, 0, [{ key: "x", value: "late" }]), {
    code: "STALE_WORKER",
  });
  assert.deepEqual(f.client.release(lease), { released: true });
});
test("renew extends a plugin lease only within the current native job lease", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  f.time(2000);
  const renewed = f.client.renew({ lease, leaseMs: 120000 });
  assert.equal(renewed.expiresAt, job.leaseUntil);
  assert.equal(renewed.fence, lease.fence);
  assert.equal(renewed.token, lease.token);
  f.store.heartbeat(job.id, job.owner, job.fence, 60000);
  const extended = f.client.renew({ lease, leaseMs: 120000 });
  assert.equal(extended.expiresAt, 62000);
});
test("changing plugin code or enabled field invalidates cached guards without losing old storage", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  f.commit(lease, 0, [{ key: "wl.settings.v1", value: { synthetic: true } }]);
  f.store.applyCommand("disable", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 1,
    payload: { ...f.payload, enabled: false },
  });
  assert.throws(
    () =>
      f.commit(lease, 1, [{ key: "x", value: "disabled" }], "disabled-write"),
    { code: "PLUGIN_DISABLED" },
  );
  assert.equal(f.client.readAll(namespace).revision, 1);
  f.store.applyCommand("new-code", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 2,
    payload: { ...f.payload, script: script + "\nconst upgraded=true;" },
  });
  assert.throws(() => f.client.readAll(namespace), {
    code: "PLUGIN_NAMESPACE_CHANGED",
  });
  const nextNamespace = {
    ...namespace,
    bundleSha: createHash("sha256")
      .update(script + "\nconst upgraded=true;")
      .digest("hex"),
  };
  assert.equal(f.client.readAll(nextNamespace).revision, 0);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS count FROM plugin_storage_items")
      .get().count,
    1,
  );
});
test("plugin incarnation guard blocks removed/recreated resources even with identical script", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  f.commit(lease, 0, [{ key: "wl.web.v1", value: "old incarnation" }]);
  // Exercise the same tombstone clock used by library removal/recreation,
  // without depending on browser selection/catalog commands.
  f.store.transaction(() => {
    f.store.db
      .prepare("DELETE FROM resources WHERE kind='plugin' AND id=?")
      .run(namespace.pluginId);
    f.store.db
      .prepare(
        "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES ('resource','plugin',?,2)",
      )
      .run(namespace.pluginId);
  });
  f.store.applyCommand("recreate", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 2,
    payload: f.payload,
  });
  assert.throws(
    () =>
      f.commit(
        lease,
        1,
        [{ key: "wl.web.v1", value: "stale" }],
        "stale-incarnation",
      ),
    { code: "PLUGIN_NAMESPACE_CHANGED" },
  );
  const next = { ...namespace, pluginEpoch: 2 };
  assert.equal(f.client.readAll(next).revision, 0);
});
test("namespace identities isolate independent installed plugins", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  f.store.applyCommand("second-plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "second",
    expectedRevision: 0,
    payload: f.payload,
  });
  const second = { ...namespace, pluginId: "second" };
  const other = f.client.claim({
    namespace: second,
    writerId: "browser",
    authority: { kind: "browser" },
  });
  f.commit(lease, 0, [{ key: "same", value: "first" }]);
  f.commit(other, 0, [{ key: "same", value: "second" }], "second");
  assert.equal(f.client.read(namespace, "same").value, "first");
  assert.equal(f.client.read(second, "same").value, "second");
});
test("storage size limits reject oversized original-plugin keys/values before any write", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  assert.throws(
    () => f.commit(lease, 0, [{ key: "k".repeat(1025), value: "x" }]),
    { code: "INVALID_COMMAND" },
  );
  assert.throws(
    () =>
      f.commit(lease, 0, [
        { key: "wl.large", value: "x".repeat(storage.MAX_VALUE_BYTES) },
      ]),
    { code: "PLUGIN_STORAGE_LIMIT" },
  );
  assert.equal(f.client.readAll(namespace).revision, 0);
  assert.equal(f.client.readAll(namespace).items.length, 0);
});
test("read-only exact commit receipts remain available after lease release/expiry/cancellation", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  const writes = [{ key: "wl.web.v1", value: "private value" }];
  const result = f.commit(lease, 0, writes);
  const lookup = {
    namespace,
    expectedRevision: 0,
    commitId: "commit-one",
    writes,
  };
  f.store.requestCancel(job.id);
  assert.deepEqual(f.client.readCommit(lookup), result);
  f.client.release(lease);
  f.time(lease.expiresAt + 1000);
  assert.deepEqual(f.client.readCommit(lookup), result);
  assert.throws(() => f.commit(lease, 0, writes), {
    code: "STALE_PLUGIN_WORKER",
  });
  assert.throws(
    () =>
      f.client.readCommit({
        ...lookup,
        writes: [{ key: "wl.web.v1", value: "different" }],
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.equal(
    f.client.readCommit({ ...lookup, commitId: "not-committed" }),
    null,
  );
  assert.equal(JSON.stringify(result).includes("private value"), false);
});
test("caller-owned final-write transaction rolls back both chat and plugin graph plus receipt", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob(),
    cursor = f.store.cursor();
  const checkpoint = {
    lease,
    expectedRevision: 0,
    commitId: "atomic",
    writes: [{ key: "wl.web.v1", value: "new graph" }],
  };
  assert.throws(
    () =>
      f.store.transaction(() => {
        storage.commit(f.store, checkpoint, job);
        f.store.appendMessage("a", "message", {
          role: "char",
          data: "synthetic reply",
        });
        f.store.expectRevision(0, 1);
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.client.readAll(namespace).revision, 0);
  assert.equal(f.client.readAll(namespace).items.length, 0);
  assert.equal(f.client.readCommit({ ...checkpoint, namespace }), null);
  assert.equal(f.store.snapshot("a").messages.length, 0);
  assert.equal(f.store.cursor(), cursor);
});
test("a final transaction cannot borrow another live job or browser storage lease", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  f.store.enqueueJob("second-job", {
    type: "button",
    chatId: "b",
    data: "synthetic",
  });
  const second = f.store.claimJob("second-owner").job;
  const checkpoint = {
    lease,
    expectedRevision: 0,
    commitId: "foreign",
    writes: [{ key: "wl.web.v1", value: "wrong job" }],
  };
  assert.throws(
    () =>
      f.store.transaction(() => storage.commit(f.store, checkpoint, second)),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(f.client.readAll(namespace).revision, 0);
  f.client.release(lease);
  const browser = f.claimBrowser();
  assert.throws(
    () =>
      f.store.transaction(() =>
        storage.commit(f.store, { ...checkpoint, lease: browser }, job),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(f.client.readAll(namespace).revision, 0);
});
test("large delete-only clear checkpoints stay atomic beyond the write batch limit", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  const writes = Array.from({ length: storage.MAX_WRITES }, (_, i) => ({
    key: `key.${i}`,
    value: i,
  }));
  f.commit(lease, 0, writes);
  f.commit(lease, 1, [{ key: "extra", value: 513 }], "extra");
  const keys = f.client.keys(namespace);
  assert.equal(keys.keys.length, storage.MAX_WRITES + 1);
  const result = f.commit(
    lease,
    2,
    keys.keys.map((key) => ({ key, deleted: true })),
    "clear",
  );
  assert.equal(result.revision, 3);
  assert.equal(result.keys.length, 513);
  assert.deepEqual(f.client.keys(namespace).keys, []);
  assert.equal(f.client.readAll(namespace).items.length, 0);
});
test("bounded snapshot rejects before parsing graph data; keys and individual reads remain usable", (t) => {
  const f = fixture(t),
    lease = f.claimBrowser();
  f.commit(lease, 0, [{ key: "wl.web.v1.0", value: "a".repeat(100) }]);
  assert.throws(() => f.client.readAll(namespace, { maxBytes: 50 }), {
    code: "PLUGIN_STORAGE_SNAPSHOT_LIMIT",
  });
  assert.deepEqual(f.client.keys(namespace).keys, ["wl.web.v1.0"]);
  assert.equal(f.client.read(namespace, "wl.web.v1.0").value.length, 100);
  assert.equal(f.client.readAll(namespace, { maxBytes: 1024 }).items.length, 1);
});
function finalOutcome(job, lease, expectedPluginRevision = 0) {
  return {
    state: "completed",
    result: { ok: true },
    writeSet: {
      chatId: job.chatId,
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [{ id: "character", expectedEpoch: 0 }],
      messages: [
        {
          id: "reply",
          expectedRevision: 0,
          message: { role: "char", data: "Synthetic final reply" },
        },
      ],
    },
    pluginStorage: {
      lease,
      expectedRevision: expectedPluginRevision,
      commitId: "final",
      writes: [{ key: "wl.web.v1", value: "Synthetic final graph" }],
      reads: capturedPluginReads.get(job),
    },
  };
}
test("finishJob commits original plugin graph and native chat writeSet atomically and hides graph from job status", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  const result = f.store.finishJob(
    job.id,
    job.owner,
    job.fence,
    finalOutcome(job, lease),
  );
  assert.equal(result.job.state, "completed");
  assert.equal(
    f.store.snapshot("a").messages[0].message.data,
    "Synthetic final reply",
  );
  assert.equal(
    f.store.readPluginStorage(namespace, "wl.web.v1").value,
    "Synthetic final graph",
  );
  assert.equal(f.store.readAllPluginStorage(namespace).revision, 1);
  assert.equal(
    JSON.stringify(f.store.getJobStatus(job.id)).includes(
      "Synthetic final graph",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(result.job.result).includes("pluginStorage"),
    false,
  );
});
test("finishJob plugin CAS/code guard failure rolls back already applied chat output and leaves job running", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob(),
    cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.finishJob(
        job.id,
        job.owner,
        job.fence,
        finalOutcome(job, lease, 1),
      ),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.store.getJob(job.id).state, "running");
  assert.equal(f.store.snapshot("a").messages.length, 0);
  assert.equal(f.store.readAllPluginStorage(namespace).revision, 0);
  assert.equal(f.store.cursor(), cursor);
  f.store.applyCommand("disable-final", {
    type: "put-resource",
    kind: "plugin",
    resourceId: namespace.pluginId,
    expectedRevision: 1,
    payload: { ...f.payload, enabled: false },
  });
  assert.throws(
    () =>
      f.store.finishJob(job.id, job.owner, job.fence, finalOutcome(job, lease)),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(f.store.snapshot("a").messages.length, 0);
});
test("failed/cancelled jobs and foreign job leases cannot silently apply a plugin graph", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob();
  const checkpoint = finalOutcome(job, lease).pluginStorage;
  for (const state of ["failed", "cancelled"])
    assert.throws(
      () =>
        f.store.finishJob(job.id, job.owner, job.fence, {
          state,
          pluginStorage: checkpoint,
          result: {},
        }),
      { code: "INVALID_COMMAND" },
    );
  f.store.enqueueJob("foreign-job", {
    type: "button",
    chatId: "b",
    data: "synthetic",
  });
  const other = f.store.claimJob("other-owner").job;
  assert.throws(
    () =>
      f.store.finishJob(
        other.id,
        other.owner,
        other.fence,
        finalOutcome(other, lease),
      ),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(f.store.snapshot("b").messages.length, 0);
  assert.equal(f.store.readAllPluginStorage(namespace).revision, 0);
  f.store.requestCancel(job.id);
  assert.throws(
    () =>
      f.store.finishJob(job.id, job.owner, job.fence, finalOutcome(job, lease)),
    { code: "CANCEL_REQUESTED" },
  );
  assert.equal(f.store.readAllPluginStorage(namespace).revision, 0);
});
test("retained job recovery cannot discard an uncommitted plugin checkpoint", (t) => {
  const f = fixture(t),
    { job, lease } = f.claimJob(),
    outcome = finalOutcome(job, lease);
  f.store.finishJob(job.id, job.owner, job.fence, {
    state: "failed",
    result: {
      code: "REVISION_CONFLICT",
      uncommitted: {
        writeSet: outcome.writeSet,
        pluginStorage: outcome.pluginStorage,
        result: outcome.result,
      },
    },
  });
  const preview = f.store.previewJobResult(job.id);
  assert.equal(preview.canRecover, false);
  assert.equal(preview.blocked.code, "RESULT_NOT_RECOVERABLE");
  assert.throws(
    () =>
      f.store.applyCommand("unsafe-recovery", {
        type: "recover-job-result",
        jobId: job.id,
        chatId: "a",
        expectedChatEpoch: 0,
        expectedContentRevision: job.startedContentRevision,
      }),
    { code: "RESULT_NOT_RECOVERABLE" },
  );
  assert.equal(f.store.snapshot("a").messages.length, 0);
  assert.equal(f.store.readAllPluginStorage(namespace).revision, 0);
});
test("SQLite worker API exposes shared plugin storage without copying DBState", async (t) => {
  const f = fixture(t),
    worker = new EntityStoreClient(f.file);
  try {
    const lease = await worker.call("claimPluginStorage", {
      namespace,
      writerId: "worker-browser",
      authority: { kind: "browser" },
    });
    const writes = [{ key: "wl.settings.v1", value: { speedMode: "fast" } }];
    const result = await worker.call("commitPluginStorage", {
      lease,
      expectedRevision: 0,
      commitId: "worker-write",
      writes,
    });
    assert.equal(result.revision, 1);
    assert.equal(
      (await worker.call("readPluginStorage", namespace, "wl.settings.v1"))
        .value.speedMode,
      "fast",
    );
    assert.deepEqual(
      (await worker.call("readPluginStorageKeys", namespace)).keys,
      ["wl.settings.v1"],
    );
    assert.equal(
      (await worker.call("readAllPluginStorage", namespace)).revision,
      1,
    );
    assert.equal(
      (await worker.call("renewPluginStorage", { lease })).token,
      lease.token,
    );
    assert.equal(
      (await worker.call("releasePluginStorage", lease)).released,
      true,
    );
    assert.deepEqual(
      await worker.call("readPluginStorageCommit", {
        namespace,
        expectedRevision: 0,
        commitId: "worker-write",
        writes,
      }),
      result,
    );
  } finally {
    await worker.close();
  }
});
async function snapshot(f, file = f.file) {
  const directory = await fs.mkdtemp(join(f.root, "capture-"));
  const prepared = await prepareSnapshot({
    file,
    directory,
    serverId: f.store.bootstrap().serverId,
  });
  const chunks = [];
  for await (const part of snapshotChunks(prepared)) chunks.push(part);
  const bytes = Buffer.concat(chunks),
    backup = join(directory, "backup.risusnapshot");
  await fs.writeFile(backup, bytes);
  return {
    prepared,
    backup,
    sha: createHash("sha256").update(bytes).digest("hex"),
  };
}
function createSchema21Copy(f) {
  const file = join(f.root, "legacy21.sqlite");
  f.store.db.prepare("VACUUM INTO ?").run(file);
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(
      "DROP TABLE plugin_storage_commits; DROP TABLE plugin_storage_items; DROP TABLE plugin_storage_namespaces; PRAGMA user_version=21;",
    );
  } finally {
    legacy.close();
  }
  return file;
}
test("real schema21 without plugin relations migrates additively while preserving identity, clocks, jobs and opaque data", (t) => {
  const f = fixture(t);
  f.store.applyCommand("unknown-message", {
    type: "append-message",
    chatId: "a",
    messageId: "known",
    message: {
      role: "char",
      data: "Synthetic preserved",
      opaque: { kept: [1, true] },
    },
  });
  const { job } = f.claimJob(),
    before = f.store.snapshot("a"),
    bootstrap = f.store.bootstrap();
  const file = createSchema21Copy(f),
    reopen = new EntityStore(file, { now: () => 1000 });
  try {
    assert.equal(reopen.schemaVersion(), 22);
    assert.deepEqual(reopen.bootstrap(), bootstrap);
    assert.deepEqual(reopen.snapshot("a"), before);
    assert.deepEqual(reopen.getJob(job.id), f.store.getJob(job.id));
    assert.deepEqual(reopen.readAllPluginStorage(namespace), {
      namespace,
      revision: 0,
      items: [],
    });
    assert.equal(reopen.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    reopen.close();
  }
});
test("schema22 complete server snapshots retain graph/settings/commit proofs and fence restored writer tokens", async (t) => {
  const f = fixture(t),
    lease = f.claimBrowser(),
    writes = [
      {
        key: "wl.web.v1",
        value: { nodes: [{ id: "synthetic", text: "Synthetic memory graph" }] },
      },
      { key: "wl.settings.v1", value: { speedMode: "fast" } },
    ];
  const committed = f.commit(lease, 0, writes),
    before = f.store.readAllPluginStorage(namespace),
    capture = await snapshot(f);
  assert.equal(capture.prepared.manifest.schema, 22);
  const file = join(f.root, "restored22.sqlite"),
    report = await restoreServerSnapshot({
      backup: capture.backup,
      file,
      expectedSha256: capture.sha,
    });
  const restored = new EntityStore(file);
  try {
    assert.equal(report.schema, 22);
    assert.equal(report.sourceSchema, 22);
    assert.equal(report.schemaMigrated, false);
    assert.equal(report.pluginWriterLeasesReleased, 1);
    assert.equal(report.untouchedDataIdentical, true);
    assert.deepEqual(restored.readAllPluginStorage(namespace), before);
    assert.deepEqual(
      restored.readPluginStorageCommit({
        namespace,
        expectedRevision: 0,
        commitId: "commit-one",
        writes,
      }),
      committed,
    );
    assert.throws(
      () =>
        restored.commitPluginStorage({
          lease,
          expectedRevision: 1,
          commitId: "old-restored-lease",
          writes: [{ key: "wl.web.v1", value: "stale browser" }],
        }),
      { code: "STALE_PLUGIN_WORKER" },
    );
    const next = restored.claimPluginStorage({
      namespace,
      writerId: "fresh",
      authority: { kind: "browser" },
    });
    assert.equal(next.fence, lease.fence + 2);
  } finally {
    restored.close();
  }
  assert.equal(
    f.store.db.prepare("SELECT fence FROM plugin_storage_namespaces").get()
      .fence,
    lease.fence,
  );
});
test("schema21 server snapshots remain restorable through an explicitly verified empty-table upgrade", async (t) => {
  const f = fixture(t);
  f.store.applyCommand("legacy-history", {
    type: "append-message",
    chatId: "a",
    messageId: "legacy-reply",
    message: {
      role: "char",
      data: "Synthetic legacy history",
      opaque: { kept: true },
    },
  });
  const legacy = createSchema21Copy(f),
    capture = await snapshot(f, legacy),
    file = join(f.root, "restored21.sqlite");
  assert.equal(capture.prepared.manifest.schema, 21);
  const report = await restoreServerSnapshot({
      backup: capture.backup,
      file,
      expectedSha256: capture.sha,
    }),
    restored = new EntityStore(file);
  try {
    assert.equal(report.schema, 22);
    assert.equal(report.sourceSchema, 21);
    assert.equal(report.schemaMigrated, true);
    assert.equal(report.pluginWriterLeasesReleased, 0);
    assert.equal(report.untouchedDataIdentical, true);
    assert.deepEqual(
      restored.snapshot("a").messages,
      f.store.snapshot("a").messages,
    );
    assert.deepEqual(
      restored.getResource("plugin", namespace.pluginId),
      f.store.getResource("plugin", namespace.pluginId),
    );
    assert.deepEqual(restored.readAllPluginStorage(namespace), {
      namespace,
      revision: 0,
      items: [],
    });
  } finally {
    restored.close();
  }
});
test("snapshot manifests accept schema21/22 and reject unsupported versions", () => {
  const manifest = {
    format: "risu-server-snapshot",
    version: 1,
    serverId: "synthetic",
    cursor: 0,
    files: [{ name: "snapshot.sqlite", sha256: "a".repeat(64), bytes: 1 }],
  };
  for (const schema of [21, 22])
    assert.equal(
      validateSnapshotManifest({ ...manifest, schema }).schema,
      schema,
    );
  for (const schema of [20, 23, "22", null])
    assert.throws(
      () => validateSnapshotManifest({ ...manifest, schema }),
      /Invalid server snapshot manifest/,
    );
});
