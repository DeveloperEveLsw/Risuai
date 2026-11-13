// @vitest-environment node
import { expect, test, vi } from "vitest";
import { RuntimeClientError } from "./clientProtocol";
import {
  ServerPluginClient,
  type ServerPluginLease,
  type ServerPluginStorageCommit,
  type ServerPluginStorageReceipt,
  type ServerPluginStorageSnapshot,
} from "./serverPluginClient";

function fixture() {
  const namespace = {
    pluginId: "synthetic-plugin",
    bundleSha: "a".repeat(64),
    pluginEpoch: 3,
  };
  const lease: ServerPluginLease = {
    namespace,
    writerId: "synthetic-browser",
    token: "synthetic-lease-token",
    fence: 2,
    expiresAt: 1000,
    revision: 4,
  };
  const snapshot: ServerPluginStorageSnapshot = {
    namespace,
    revision: 4,
    items: [{ key: "wl.settings.v1", value: { speed: "normal" }, revision: 4 }],
  };
  const commits: ServerPluginStorageCommit[] = [];
  const transport = {
    readAll: vi.fn(async () => structuredClone(snapshot)),
    commit: vi.fn(async (command: ServerPluginStorageCommit) => {
      commits.push(structuredClone(command));
      if (command.expectedRevision !== snapshot.revision)
        throw new RuntimeClientError(
          "PLUGIN_STORAGE_CONFLICT",
          "Stale plugin graph",
        );
      snapshot.revision++;
      for (const write of command.writes) {
        snapshot.items = snapshot.items.filter(
          (item) => item.key !== write.key,
        );
        if ("value" in write)
          snapshot.items.push({
            key: write.key,
            value: structuredClone(write.value),
            revision: snapshot.revision,
          });
      }
      return {
        namespace,
        revision: snapshot.revision,
        commitId: command.commitId,
        changed: true,
        keys: command.writes.map((item) => item.key),
      } satisfies ServerPluginStorageReceipt;
    }),
  };
  let commitId = 0;
  const options = {
    now: () => 0,
    newCommitId: () => "synthetic-commit-" + ++commitId,
    onInvalidated: vi.fn(),
    commitMode: "per-operation" as const,
  };
  return { namespace, lease, snapshot, commits, transport, options };
}

test("parallel original pluginStorage calls serialize revisions and acknowledge before exposing values", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  const value = { enabled: true };
  const first = client.pluginStorage.setItem("wl.first", value);
  value.enabled = false;
  const second = client.pluginStorage.setItem("wl.second", "second");
  const read = client.pluginStorage.getItem("wl.first");
  await Promise.all([first, second]);
  expect(await read).toEqual({ enabled: true });
  expect(h.commits.map((command) => command.expectedRevision)).toEqual([4, 5]);
  expect(h.commits.map((command) => command.commitId)).toEqual([
    "synthetic-commit-1",
    "synthetic-commit-2",
  ]);
  expect(h.commits.map((command) => command.lease.revision)).toEqual([4, 5]);
  expect(h.lease.revision).toBe(4);
  expect(h.options.onInvalidated).not.toHaveBeenCalled();
});

test("getItem returns isolated JSON values and preserves false, zero and null", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  const settings = (await client.pluginStorage.getItem("wl.settings.v1")) as {
    speed: string;
  };
  settings.speed = "mutated";
  expect(await client.pluginStorage.getItem("wl.settings.v1")).toEqual({
    speed: "normal",
  });
  await client.pluginStorage.setItem("wl.false", false);
  await client.pluginStorage.setItem("wl.zero", 0);
  await client.pluginStorage.setItem("wl.null", null);
  expect(await client.pluginStorage.getItem("wl.false")).toBe(false);
  expect(await client.pluginStorage.getItem("wl.zero")).toBe(0);
  expect(await client.pluginStorage.getItem("wl.null")).toBeNull();
  expect(await client.pluginStorage.getItem("wl.absent")).toBeNull();
  expect(await client.pluginStorage.length()).toBe(4);
  expect(await client.pluginStorage.key(100)).toBeNull();
  expect(await client.pluginStorage.keys()).toEqual([
    "wl.settings.v1",
    "wl.false",
    "wl.zero",
    "wl.null",
  ]);
  expect(h.transport.readAll).toHaveBeenCalledTimes(1);
});

test("conflicting browser graph never refreshes and overwrites the server", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  h.snapshot.revision = 5;
  await expect(
    client.pluginStorage.setItem("wl.graph", "old-graph"),
  ).rejects.toMatchObject({
    code: "PLUGIN_STORAGE_CONFLICT",
  });
  await expect(
    client.pluginStorage.setItem("wl.graph", "retry-old-graph"),
  ).rejects.toMatchObject({
    code: "PLUGIN_STORAGE_CONFLICT",
  });
  await expect(
    client.pluginStorage.getItem("wl.settings.v1"),
  ).rejects.toMatchObject({
    code: "PLUGIN_STORAGE_CONFLICT",
  });
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
  expect(h.transport.readAll).toHaveBeenCalledTimes(1);
  expect(h.options.onInvalidated).toHaveBeenCalledTimes(1);
  expect(h.snapshot.items.some((item) => item.key === "wl.graph")).toBe(false);
});

test("lost acknowledgement freezes the cache without replaying a possible committed write", async () => {
  const h = fixture();
  const commit = h.transport.commit.getMockImplementation()!;
  h.transport.commit.mockImplementation(async (command) => {
    await commit(command);
    throw new Error("connection lost after server commit");
  });
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  await expect(
    client.pluginStorage.setItem("wl.graph", "new-graph"),
  ).rejects.toThrow("connection lost");
  await expect(client.pluginStorage.clear()).rejects.toThrow("connection lost");
  expect(h.snapshot.items.find((item) => item.key === "wl.graph")?.value).toBe(
    "new-graph",
  );
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
  expect(h.options.onInvalidated).toHaveBeenCalledTimes(1);
});

test("own change event received before acknowledgement waits for the committed revision", async () => {
  const h = fixture();
  const commit = h.transport.commit.getMockImplementation()!;
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.transport.commit.mockImplementation(async (command) => {
    const result = await commit(command);
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return result;
  });
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  const write = client.pluginStorage.setItem("wl.graph", "new-graph");
  await began;
  const event = client.observeRevision(h.namespace, 5);
  release();
  await Promise.all([write, event]);
  expect(await client.pluginStorage.getItem("wl.graph")).toBe("new-graph");
  expect(h.options.onInvalidated).not.toHaveBeenCalled();
});

test("external revision invalidates original-plugin caches; old ordered events are harmless", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  await client.observeRevision(h.namespace, 3);
  await expect(client.observeRevision(h.namespace, 5)).rejects.toMatchObject({
    code: "STALE_PLUGIN_SESSION",
  });
  await expect(
    client.pluginStorage.setItem("wl.graph", "stale"),
  ).rejects.toMatchObject({ code: "STALE_PLUGIN_SESSION" });
  expect(h.transport.commit).not.toHaveBeenCalled();
});

test("bundle replacement and plugin recreation invalidate the old iframe identity", async () => {
  for (const namespaceChange of [
    { bundleSha: "b".repeat(64) },
    { pluginEpoch: 4 },
  ]) {
    const h = fixture();
    const client = await ServerPluginClient.open(
      h.transport,
      h.lease,
      h.options,
    );
    await expect(
      client.observeRevision({ ...h.namespace, ...namespaceChange }, 4),
    ).rejects.toMatchObject({ code: "STALE_PLUGIN_SESSION" });
    expect(h.transport.commit).not.toHaveBeenCalled();
  }
});

test("an acknowledgement for a different command does not promote unconfirmed state", async () => {
  const h = fixture();
  const commit = h.transport.commit.getMockImplementation()!;
  h.transport.commit.mockImplementation(async (command) => ({
    ...(await commit(command)),
    commitId: "unrelated-command",
  }));
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  await expect(
    client.pluginStorage.setItem("wl.graph", "new"),
  ).rejects.toMatchObject({ code: "INVALID_PLUGIN_RECEIPT" });
  await expect(client.pluginStorage.getItem("wl.graph")).rejects.toMatchObject({
    code: "INVALID_PLUGIN_RECEIPT",
  });
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
});

test("stale admission snapshot is rejected before original plugin boot", async () => {
  const h = fixture();
  h.snapshot.revision = 5;
  await expect(
    ServerPluginClient.open(h.transport, h.lease, h.options),
  ).rejects.toMatchObject({ code: "STALE_PLUGIN_SESSION" });
  expect(h.transport.commit).not.toHaveBeenCalled();
});

test("expired and closed sessions cannot send storage commands", async () => {
  const h = fixture();
  let now = 0;
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    now: () => now,
  });
  now = 1000;
  await expect(
    client.pluginStorage.setItem("wl.graph", "expired"),
  ).rejects.toMatchObject({ code: "PLUGIN_LEASE_EXPIRED" });
  expect(h.transport.commit).not.toHaveBeenCalled();
  const fresh = fixture();
  const closed = await ServerPluginClient.open(
    fresh.transport,
    fresh.lease,
    fresh.options,
  );
  closed.close();
  await expect(
    closed.pluginStorage.getItem("wl.settings.v1"),
  ).rejects.toMatchObject({ code: "PLUGIN_SESSION_CLOSED" });
});

test("clear is a guarded key deletion batch and remove keeps unrelated keys", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, h.options);
  await client.pluginStorage.setItem("wl.other", "retained");
  await client.pluginStorage.removeItem("wl.settings.v1");
  expect(await client.pluginStorage.keys()).toEqual(["wl.other"]);
  await client.pluginStorage.clear();
  expect(h.commits.at(-1)?.writes).toEqual([
    { key: "wl.other", deleted: true },
  ]);
  expect(await client.pluginStorage.length()).toBe(0);
  expect(h.snapshot.items).toEqual([]);
});

test("default checkpoint mode keeps graph chunks and manifest invisible until one atomic commit", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    commitMode: "checkpoint",
  });
  await client.pluginStorage.setItem("wl.graph.chunk.1", "chunk");
  await client.pluginStorage.setItem("wl.graph.manifest", {
    chunks: ["wl.graph.chunk.1"],
  });
  expect(await client.pluginStorage.getItem("wl.graph.chunk.1")).toBe("chunk");
  expect(h.transport.commit).not.toHaveBeenCalled();
  expect(h.snapshot.items.some((item) => item.key.startsWith("wl.graph"))).toBe(
    false,
  );
  await client.checkpoint();
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
  expect(h.commits[0].writes).toHaveLength(2);
  expect(h.commits[0].expectedRevision).toBe(4);
  expect(h.snapshot.revision).toBe(5);
  await client.checkpoint();
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
});

test("discarding an incomplete staged session never submits a partial graph", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    commitMode: "checkpoint",
  });
  await client.pluginStorage.setItem("wl.graph.chunk.1", "incomplete");
  client.close();
  await expect(client.checkpoint()).rejects.toMatchObject({
    code: "PLUGIN_SESSION_CLOSED",
  });
  expect(h.transport.commit).not.toHaveBeenCalled();
});

test("checkpoint failure freezes staged graph without retry or partial acknowledgement", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    commitMode: "checkpoint",
  });
  await client.pluginStorage.setItem("wl.graph.chunk.1", "old chunk");
  await client.pluginStorage.setItem("wl.graph.manifest", "old manifest");
  h.snapshot.revision = 5;
  await expect(client.checkpoint()).rejects.toMatchObject({
    code: "PLUGIN_STORAGE_CONFLICT",
  });
  await expect(client.checkpoint()).rejects.toMatchObject({
    code: "PLUGIN_STORAGE_CONFLICT",
  });
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
  expect(h.snapshot.items).toHaveLength(1);
});

test("asynchronous close drains admitted writes and rejects delayed callbacks before lease release", async () => {
  const h = fixture();
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    commitMode: "checkpoint",
  });
  const chunk = client.pluginStorage.setItem(
    "wl.graph.chunk.1",
    "complete chunk",
  );
  const manifest = client.pluginStorage.setItem(
    "wl.graph.manifest",
    "complete manifest",
  );
  const closed = client.closeAndCheckpoint();
  expect(client.closeAndCheckpoint()).toBe(closed);
  await expect(
    client.pluginStorage.setItem("wl.graph.late", "delayed migration"),
  ).rejects.toMatchObject({ code: "PLUGIN_SESSION_CLOSING" });
  await Promise.all([chunk, manifest, closed]);
  expect(h.transport.commit).toHaveBeenCalledTimes(1);
  expect(h.commits[0].writes).toHaveLength(2);
  expect(h.snapshot.items.some((item) => item.key === "wl.graph.late")).toBe(
    false,
  );
  await expect(
    client.pluginStorage.getItem("wl.graph.manifest"),
  ).rejects.toMatchObject({ code: "PLUGIN_SESSION_CLOSED" });
});

test("renewal extends only the same fenced session and rejects lease takeover", async () => {
  const h = fixture();
  let now = 0;
  const client = await ServerPluginClient.open(h.transport, h.lease, {
    ...h.options,
    now: () => now,
  });
  await client.acceptLease({ ...h.lease, expiresAt: 2000 });
  now = 1500;
  expect(await client.pluginStorage.getItem("wl.settings.v1")).toEqual({
    speed: "normal",
  });
  await expect(
    client.acceptLease({
      ...h.lease,
      expiresAt: 3000,
      token: "new-writer-token",
    }),
  ).rejects.toMatchObject({ code: "STALE_PLUGIN_SESSION" });
  expect(h.transport.commit).not.toHaveBeenCalled();
});
