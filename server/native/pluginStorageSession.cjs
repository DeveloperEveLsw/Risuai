"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("../entity/errors.cjs");

/** One original-plugin realm sees a private overlay until a complete checkpoint. */
function createPluginStorageSession(snapshot, lease, options = {}) {
  if (
    !snapshot ||
    !lease ||
    !sameNamespace(snapshot.namespace, lease.namespace) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision !== lease.revision ||
    !Array.isArray(snapshot.items)
  )
    throw new RuntimeError(
      "PLUGIN_SNAPSHOT_CHANGED",
      "Plugin snapshot and lease do not match",
    );
  let closed = false,
    failure,
    revision = snapshot.revision;
  const values = new Map(
    snapshot.items.map(({ key, value }) => [key, clone(value)]),
  );
  const changed = new Map();
  function sameNamespace(a, b) {
    return (
      a &&
      b &&
      a.pluginId === b.pluginId &&
      a.bundleSha === b.bundleSha &&
      a.pluginEpoch === b.pluginEpoch
    );
  }
  function clone(value) {
    // Crossing a VM realm cannot preserve arbitrary prototypes or executable values.
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return Array.from(value, clone);
    if (
      value &&
      Object.prototype.toString.call(value) === "[object Object]" &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      !Object.hasOwn(value, "toJSON")
    )
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, clone(item)]),
      );
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Plugin storage values must be JSON data",
    );
  }
  function healthy() {
    if (closed)
      throw new RuntimeError(
        "PLUGIN_SESSION_CLOSED",
        "Plugin storage session is closed",
      );
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    options.check?.();
  }
  function key(value) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024)
      throw new RuntimeError("INVALID_COMMAND", "Invalid plugin storage key");
    return value;
  }
  function checked(action) {
    try {
      healthy();
      return action();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  }
  function writes() {
    return [...changed].map(([key, value]) =>
      value.deleted
        ? { key, deleted: true }
        : { key, value: clone(value.value) },
    );
  }
  return {
    pluginStorage: {
      getItem: async (input) =>
        checked(() => clone(values.get(key(input)) ?? null)),
      keys: async () => checked(() => [...values.keys()]),
      setItem: async (input, value) =>
        checked(() => {
          const name = key(input),
            copy = clone(value);
          values.set(name, copy);
          changed.set(name, { value: copy });
        }),
      removeItem: async (input) =>
        checked(() => {
          const name = key(input);
          values.delete(name);
          changed.set(name, { deleted: true });
        }),
    },
    /** Prepared once for atomic commit with the native chat write set. */
    checkpoint(commitId = randomUUID()) {
      return checked(() => ({
        lease: structuredClone(lease),
        expectedRevision: revision,
        commitId,
        writes: writes(),
      }));
    },
    /** An acknowledgement is required before a realm can start another checkpoint. */
    acknowledge(result, prepared) {
      return checked(() => {
        if (
          result?.commitId !== prepared?.commitId ||
          !sameNamespace(result.namespace, snapshot.namespace) ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < revision ||
          result.revision > revision + 1 ||
          JSON.stringify(writes()) !== JSON.stringify(prepared.writes)
        )
          throw new RuntimeError(
            "PLUGIN_CHECKPOINT_CHANGED",
            "Plugin checkpoint changed before acknowledgement",
          );
        revision = result.revision;
        changed.clear();
      });
    },
    ensureHealthy: healthy,
    discard() {
      changed.clear();
      closed = true;
    },
  };
}
module.exports = { createPluginStorageSession };
