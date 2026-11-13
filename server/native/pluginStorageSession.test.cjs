"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const namespace = {
  pluginId: "synthetic",
  bundleSha: "a".repeat(64),
  pluginEpoch: 0,
};
const lease = {
  namespace,
  writerId: "worker",
  token: "token",
  fence: 1,
  revision: 3,
};
const snapshot = {
  namespace,
  revision: 3,
  items: [{ key: "manifest", value: { parts: [] }, revision: 1 }],
};
test("original plugin multi-key writes remain private until one immutable checkpoint", async () => {
  const session = createPluginStorageSession(snapshot, lease);
  await session.pluginStorage.setItem("part:0", "synthetic memory");
  await session.pluginStorage.setItem("manifest", { parts: ["part:0"] });
  await session.pluginStorage.removeItem("old:meta");
  assert.deepEqual(snapshot.items[0].value, { parts: [] });
  assert.equal(
    await session.pluginStorage.getItem("part:0"),
    "synthetic memory",
  );
  const checkpoint = session.checkpoint("atomic-one");
  assert.deepEqual(checkpoint.writes, [
    { key: "part:0", value: "synthetic memory" },
    { key: "manifest", value: { parts: ["part:0"] } },
    { key: "old:meta", deleted: true },
  ]);
  session.acknowledge(
    { namespace, revision: 4, commitId: "atomic-one" },
    checkpoint,
  );
  assert.deepEqual(session.checkpoint("atomic-two").writes, []);
});
test("changed work during checkpoint acknowledgement fails instead of dropping late writes", async () => {
  const session = createPluginStorageSession(snapshot, lease);
  await session.pluginStorage.setItem("manifest", { parts: ["a"] });
  const checkpoint = session.checkpoint("one");
  await session.pluginStorage.setItem("manifest", { parts: ["b"] });
  assert.throws(
    () =>
      session.acknowledge(
        { namespace, revision: 4, commitId: "one" },
        checkpoint,
      ),
    { code: "PLUGIN_CHECKPOINT_CHANGED" },
  );
  await assert.rejects(session.pluginStorage.getItem("manifest"), {
    code: "PLUGIN_CHECKPOINT_CHANGED",
  });
});
test("falsy JSON values and returned graph objects retain their semantics", async () => {
  const session = createPluginStorageSession(snapshot, lease);
  for (const [key, value] of [
    ["empty", ""],
    ["zero", 0],
    ["false", false],
    ["null", null],
  ]) {
    await session.pluginStorage.setItem(key, value);
    assert.equal(await session.pluginStorage.getItem(key), value);
  }
  const graph = await session.pluginStorage.getItem("manifest");
  graph.parts.push("private mutation");
  assert.deepEqual(await session.pluginStorage.getItem("manifest"), {
    parts: [],
  });
});
test("failure and cancellation discard the graph and reject late callbacks", async () => {
  const abort = new AbortController();
  const session = createPluginStorageSession(snapshot, lease, {
    signal: abort.signal,
  });
  await session.pluginStorage.setItem("pending", "partial memory");
  abort.abort(new Error("Synthetic cancellation"));
  assert.throws(() => session.checkpoint(), /Synthetic cancellation/);
  session.discard();
  await assert.rejects(
    session.pluginStorage.setItem("late", "discarded"),
    /closed/,
  );
});
test("non-JSON plugin values cannot silently change at the VM boundary", async () => {
  for (const value of [
    NaN,
    Infinity,
    undefined,
    () => {},
    { nested: undefined },
    new Date(),
  ]) {
    const session = createPluginStorageSession(snapshot, lease);
    await assert.rejects(session.pluginStorage.setItem("bad", value), {
      code: "INVALID_COMMAND",
    });
    assert.throws(() => session.checkpoint(), { code: "INVALID_COMMAND" });
  }
});
test("a snapshot from another incarnation or storage revision cannot open a realm", () => {
  assert.throws(
    () => createPluginStorageSession({ ...snapshot, revision: 2 }, lease),
    { code: "PLUGIN_SNAPSHOT_CHANGED" },
  );
  assert.throws(
    () =>
      createPluginStorageSession(
        { ...snapshot, namespace: { ...namespace, pluginEpoch: 1 } },
        lease,
      ),
    { code: "PLUGIN_SNAPSHOT_CHANGED" },
  );
});
