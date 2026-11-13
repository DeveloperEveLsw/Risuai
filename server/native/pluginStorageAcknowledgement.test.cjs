"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-plugin-storage-ack-"));
  const store = new EntityStoreClient(join(directory, "entity.sqlite"));
  let session;
  t.after(async () => {
    session?.discard();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const script = "//@name Synthetic acknowledgement fixture\n//@api 3.0\n";
  const namespace = {
    pluginId: "synthetic-plugin",
    bundleSha: createHash("sha256").update(script).digest("hex"),
    pluginEpoch: 0,
  };
  await store.call("initializeState", {
    settings: { pluginIds: [namespace.pluginId] },
    resources: [
      {
        kind: "plugin",
        id: namespace.pluginId,
        payload: {
          id: namespace.pluginId,
          name: "Synthetic acknowledgement fixture",
          script,
          enabled: true,
        },
      },
    ],
  });
  const lease = await store.call("claimPluginStorage", {
    namespace,
    writerId: "synthetic-writer",
    authority: { kind: "browser" },
  });
  session = createPluginStorageSession(
    await store.call("readAllPluginStorage", namespace),
    lease,
  );
  return { store, namespace, lease, session };
}

test("real SQLite worker acknowledgements accept changed, unchanged and canonical object checkpoints", async (t) => {
  const { store, namespace, session } = await fixture(t);
  await session.pluginStorage.setItem("synthetic-object", {
    z: 2,
    a: { y: 1, x: 0 },
  });
  const first = session.checkpoint("first");
  const result = await store.call("commitPluginStorage", first);
  assert.equal(result.revision, 1);
  session.acknowledge(result, first);
  assert.equal(session.checkpoint("next").expectedRevision, 1);
  assert.deepEqual(session.checkpoint("next").writes, []);

  const empty = session.checkpoint("empty");
  const emptyResult = await store.call("commitPluginStorage", empty);
  assert.equal(emptyResult.revision, 1);
  session.acknowledge(emptyResult, empty);

  // SQLite canonicalizes object property order; the prepared VM overlay must
  // still acknowledge its own unchanged data without treating it as a race.
  await session.pluginStorage.setItem("synthetic-object", {
    a: { x: 0, y: 1 },
    z: 2,
  });
  const reordered = session.checkpoint("reordered");
  const reorderedResult = await store.call("commitPluginStorage", reordered);
  assert.equal(reorderedResult.revision, 1);
  assert.equal(reorderedResult.changed, false);
  session.acknowledge(reorderedResult, reordered);
  assert.deepEqual(
    (await store.call("readPluginStorage", namespace, "synthetic-object"))
      .value,
    { a: { x: 0, y: 1 }, z: 2 },
  );
});

test("lease renewal and the initial lease revision do not invalidate sequential session acknowledgements", async (t) => {
  const { store, lease, session } = await fixture(t);
  for (let index = 1; index <= 3; index++) {
    await session.pluginStorage.setItem("synthetic-counter", index);
    const prepared = session.checkpoint("revision-" + index);
    assert.equal(prepared.lease.revision, 0);
    assert.equal(prepared.expectedRevision, index - 1);
    const renewed = await store.call("renewPluginStorage", { lease });
    assert.equal(renewed.fence, lease.fence);
    assert.equal(renewed.token, lease.token);
    const result = await store.call("commitPluginStorage", prepared);
    session.acknowledge(result, prepared);
    assert.equal(session.checkpoint("inspect").expectedRevision, index);
  }
});

test("a late original-plugin write during SQLite IPC fails acknowledgement without publishing or dropping it", async (t) => {
  const { store, namespace, session } = await fixture(t);
  await session.pluginStorage.setItem("synthetic-marker", "before");
  const prepared = session.checkpoint("late-write");
  const pending = store.call("commitPluginStorage", prepared);
  // An original persistence callback can resume after checkpoint capture while
  // the database worker is committing the earlier immutable checkpoint.
  await session.pluginStorage.setItem("synthetic-marker", "late");
  const result = await pending;
  assert.throws(() => session.acknowledge(result, prepared), {
    code: "PLUGIN_CHECKPOINT_CHANGED",
  });
  await assert.rejects(session.pluginStorage.getItem("synthetic-marker"), {
    code: "PLUGIN_CHECKPOINT_CHANGED",
  });
  assert.equal(
    (await store.call("readPluginStorage", namespace, "synthetic-marker"))
      .value,
    "before",
  );
  const cursor = (await store.call("bootstrap")).cursor;
  assert.deepEqual(
    await store.call("readPluginStorageCommit", { ...prepared, namespace }),
    result,
  );
  assert.deepEqual(await store.call("commitPluginStorage", prepared), result);
  assert.equal((await store.call("bootstrap")).cursor, cursor);
});

test("a stale, foreign or missing durable acknowledgement remains fail-closed", async (t) => {
  const { store, namespace, lease } = await fixture(t);
  const snapshot = await store.call("readAllPluginStorage", namespace);
  for (const wrong of [
    { namespace, revision: 0, commitId: "different" },
    {
      namespace: { ...namespace, pluginEpoch: 1 },
      revision: 0,
      commitId: "one",
    },
    { namespace, revision: 2, commitId: "one" },
    undefined,
  ]) {
    const session = createPluginStorageSession(snapshot, lease);
    const prepared = session.checkpoint("one");
    assert.throws(() => session.acknowledge(wrong, prepared), {
      code: "PLUGIN_CHECKPOINT_CHANGED",
    });
    session.discard();
  }
});
