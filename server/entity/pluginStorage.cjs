"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const { SUPPORTED_RELEASES } = require("../native/wygloreContract.cjs");

// EntityStore owns the transaction/migration boundary. Storage never replaces a
// settings payload or DBState. Leases cover one plugin across every chat/device.
// Commit receipts are deliberately retained: pruning requires an explicit
// archive/retention policy, otherwise an ambiguous write could lose its proof.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_storage_namespaces (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  bundle_sha TEXT NOT NULL CHECK (length(bundle_sha)=64),
  plugin_epoch INTEGER NOT NULL CHECK (plugin_epoch>=0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0),
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence>=0),
  writer_id TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  authority TEXT CHECK (authority IS NULL OR json_valid(authority)),
  UNIQUE(plugin_id,bundle_sha,plugin_epoch)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_storage_items (
  namespace_id TEXT NOT NULL REFERENCES plugin_storage_namespaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT CHECK (value IS NULL OR json_valid(value)),
  value_bytes INTEGER NOT NULL DEFAULT 0 CHECK (value_bytes>=0),
  revision INTEGER NOT NULL CHECK (revision>0),
  PRIMARY KEY(namespace_id,key)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_storage_commits (
  namespace_id TEXT NOT NULL REFERENCES plugin_storage_namespaces(id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(namespace_id,commit_id)
) STRICT;
`;

const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_NAMESPACE_BYTES = 256 * 1024 * 1024;
const MAX_ITEMS = 20000;
const MAX_WRITES = 512;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const checkedPlugins = new WeakMap();

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function invalid(message) {
  throw new RuntimeError("INVALID_COMMAND", message);
}
function text(value, label, maximum = 256) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum)
    invalid(`${label} must be nonempty text of at most ${maximum} bytes`);
  return value;
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    invalid(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      invalid("Plugin storage values must be JSON data");
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  invalid("Plugin storage values must be JSON data");
}
function encode(value) {
  return JSON.stringify(canonical(value));
}
function namespaceOf(input) {
  if (!input || typeof input !== "object")
    invalid("Plugin namespace is absent");
  const namespace = {
    pluginId: text(input.pluginId, "Plugin ID"),
    bundleSha: input.bundleSha,
    pluginEpoch: integer(input.pluginEpoch, "Plugin incarnation"),
  };
  if (
    typeof namespace.bundleSha !== "string" ||
    !/^[a-f0-9]{64}$/.test(namespace.bundleSha)
  )
    invalid("Plugin bundle SHA-256 is invalid");
  return namespace;
}
function identity(namespace) {
  return digest(encode(namespace));
}
function guardNamespace(store, input, write = false) {
  const namespace = namespaceOf(input);
  const row = store.db
    .prepare("SELECT revision FROM resources WHERE kind='plugin' AND id=?")
    .get(namespace.pluginId);
  const epoch = store.fieldEpoch({
    scope: "resource",
    resourceKind: "plugin",
    entityId: namespace.pluginId,
  });
  if (!row || epoch !== namespace.pluginEpoch)
    throw new RuntimeError(
      "PLUGIN_NAMESPACE_CHANGED",
      "Plugin was removed or replaced",
    );
  let cache = checkedPlugins.get(store);
  if (!cache) checkedPlugins.set(store, (cache = new Map()));
  let plugin = cache.get(namespace.pluginId);
  if (!plugin || plugin.revision !== row.revision || plugin.epoch !== epoch) {
    const payload = JSON.parse(
      store.db
        .prepare("SELECT payload FROM resources WHERE kind='plugin' AND id=?")
        .get(namespace.pluginId).payload,
    );
    plugin = {
      revision: row.revision,
      epoch,
      sha: typeof payload.script === "string" ? digest(payload.script) : null,
      enabled: payload.enabled === true,
    };
    cache.set(namespace.pluginId, plugin);
  }
  if (plugin.sha !== namespace.bundleSha)
    throw new RuntimeError(
      "PLUGIN_NAMESPACE_CHANGED",
      "Plugin bundle has changed",
    );
  if (write && !plugin.enabled)
    throw new RuntimeError(
      "PLUGIN_DISABLED",
      "Disabled plugins cannot write shared storage",
    );
  return { namespace, id: identity(namespace) };
}
function authorityOf(input) {
  if (input?.kind === "browser") return { kind: "browser" };
  if (input?.kind !== "job")
    invalid("Plugin writer authority must be browser or job");
  return {
    kind: "job",
    jobId: text(input.jobId, "Job ID"),
    owner: text(input.owner, "Job owner"),
    fence: integer(input.fence, "Job fence", 1),
  };
}
function guardAuthority(store, authority) {
  if (authority.kind !== "job") return null;
  const job = store.requireOwner(
    authority.jobId,
    authority.owner,
    authority.fence,
  );
  if (job.cancelRequested)
    throw new RuntimeError(
      "JOB_CANCELLED",
      "Cancelled jobs cannot write plugin storage",
    );
  store.requireChat(job.chatId);
  store.expectRevision(
    job.chatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: job.chatId }),
  );
  return job;
}
// A native host must renew both its job and plugin lease while hooks/providers
// run, and abort/close original plugin timers before releasing this lease. A
// terminal/cancelled job cannot persist a late background callback. A durable
// background task needs its own explicitly accepted job, never a detached timer.
function duration(value = 30000) {
  integer(value, "Plugin lease duration", 1);
  if (value > 120000) invalid("Plugin leases may last at most 120 seconds");
  return value;
}
function header(namespace, row) {
  return {
    namespace,
    writerId: row.writer_id,
    token: row.lease_token,
    fence: row.fence,
    expiresAt: row.lease_until,
    revision: row.revision,
  };
}
function initialize(store) {
  store.db.exec(SCHEMA);
}

// This is one reviewed, backwards-compatible author release transition. Other
// bundle changes still start isolated namespaces, including future Wyg releases.
const WYGLORE_UPGRADE = Object.freeze({
  from: "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
  to: "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
});
function inheritReviewedWygloreStorage(store, namespace, id) {
  if (
    namespace.bundleSha !== WYGLORE_UPGRADE.to ||
    !SUPPORTED_RELEASES.some(
      (release) =>
        release.version === "3.1.6" && release.sha256 === WYGLORE_UPGRADE.from,
    ) ||
    !SUPPORTED_RELEASES.some(
      (release) =>
        release.version === "3.2.0" && release.sha256 === WYGLORE_UPGRADE.to,
    )
  )
    return;
  const target = store.db
    .prepare(
      "SELECT revision,lease_token,lease_until FROM plugin_storage_namespaces WHERE id=?",
    )
    .get(id);
  if (
    target?.revision > 0 ||
    store.db
      .prepare(
        "SELECT 1 FROM plugin_storage_items WHERE namespace_id=? LIMIT 1",
      )
      .get(id) ||
    store.db
      .prepare(
        "SELECT 1 FROM plugin_storage_commits WHERE namespace_id=? LIMIT 1",
      )
      .get(id)
  )
    return;
  const sourceId = identity({ ...namespace, bundleSha: WYGLORE_UPGRADE.from });
  const source = store.db
    .prepare(
      "SELECT lease_token,lease_until FROM plugin_storage_namespaces WHERE id=?",
    )
    .get(sourceId);
  if (!source) return;
  // Even an empty target's existing owner may have read revision zero. Do not
  // change its snapshot underneath it, or inherit a still-running old writer.
  const active = [source, target].find(
    (row) => row?.lease_token && row.lease_until > store.now(),
  );
  if (active)
    throw new RuntimeError(
      "PLUGIN_STORAGE_BUSY",
      "Plugin storage upgrade requires its previous writer to finish",
      { expiresAt: active.lease_until },
    );
  // Validate stored budgets without decoding, transforming, or exposing values.
  // The namespace limits apply here; per-checkpoint write/batch limits do not
  // restrict copying an already accepted namespace inside one transaction.
  const totals = store.db
    .prepare(
      "SELECT COUNT(*) AS rows,COUNT(value) AS count,COALESCE(SUM(value_bytes),0) AS bytes,COALESCE(MAX(length(CAST(value AS BLOB))),0) AS largest,COALESCE(SUM(CASE WHEN length(CAST(key AS BLOB)) NOT BETWEEN 1 AND 1024 OR value_bytes<>COALESCE(length(CAST(value AS BLOB)),0) THEN 1 ELSE 0 END),0) AS invalid FROM plugin_storage_items WHERE namespace_id=?",
    )
    .get(sourceId);
  if (
    totals.invalid ||
    totals.largest > MAX_VALUE_BYTES ||
    totals.bytes > MAX_NAMESPACE_BYTES ||
    totals.count > MAX_ITEMS
  )
    throw new RuntimeError(
      "PLUGIN_STORAGE_LIMIT",
      "Previous plugin storage exceeds its storage budget",
    );
  if (!totals.rows) return;
  store.db
    .prepare(
      "INSERT OR IGNORE INTO plugin_storage_namespaces(id,plugin_id,bundle_sha,plugin_epoch) VALUES (?,?,?,?)",
    )
    .run(id, namespace.pluginId, namespace.bundleSha, namespace.pluginEpoch);
  store.db
    .prepare(
      "INSERT INTO plugin_storage_items(namespace_id,key,value,value_bytes,revision) SELECT ?,key,value,value_bytes,1 FROM plugin_storage_items WHERE namespace_id=?",
    )
    .run(id, sourceId);
  // New namespace identity, receipt IDs, fencing and leases remain independent.
  // The old namespace, item text, tombstones and commit receipts stay intact.
  store.db
    .prepare("UPDATE plugin_storage_namespaces SET revision=1 WHERE id=?")
    .run(id);
  store.event("plugin-storage", id, null, 1, {
    namespace,
    revision: 1,
    changedKeys: totals.rows,
  });
}

// All exported operations below run inside a caller-owned EntityStore
// transaction. A browser route must authenticate its user before supplying a
// browser authority. No request may choose another installed plugin's identity.
function claim(store, input) {
  const { namespace, id } = guardNamespace(store, input.namespace, true);
  const writerId = text(input.writerId, "Plugin writer ID");
  const authority = authorityOf(input.authority);
  const job = guardAuthority(store, authority);
  const encodedAuthority = encode(authority);
  const leaseMs = duration(input.leaseMs);
  // The installed source/incarnation and requesting owner were checked above.
  // Copying and the subsequent claim either commit together or roll back.
  inheritReviewedWygloreStorage(store, namespace, id);
  store.db
    .prepare(
      "INSERT OR IGNORE INTO plugin_storage_namespaces(id,plugin_id,bundle_sha,plugin_epoch) VALUES (?,?,?,?)",
    )
    .run(id, namespace.pluginId, namespace.bundleSha, namespace.pluginEpoch);
  const row = store.db
    .prepare("SELECT * FROM plugin_storage_namespaces WHERE id=?")
    .get(id);
  if (row.lease_token && row.lease_until > store.now()) {
    let usable = true;
    try {
      guardAuthority(store, JSON.parse(row.authority));
    } catch (error) {
      if (
        ![
          "STALE_WORKER",
          "JOB_CANCELLED",
          "NOT_FOUND",
          "REVISION_CONFLICT",
        ].includes(error.code)
      )
        throw error;
      usable = false;
    }
    if (usable) {
      if (row.writer_id === writerId && row.authority === encodedAuthority)
        return header(namespace, row);
      throw new RuntimeError(
        "PLUGIN_STORAGE_BUSY",
        "Another device or chat owns this plugin's writer lease",
        { expiresAt: row.lease_until },
      );
    }
  }
  const expiresAt = Math.min(
    store.now() + leaseMs,
    job?.leaseUntil ?? Infinity,
  );
  store.db
    .prepare(
      "UPDATE plugin_storage_namespaces SET fence=fence+1,writer_id=?,lease_token=?,lease_until=?,authority=? WHERE id=?",
    )
    .run(writerId, randomUUID(), expiresAt, encodedAuthority, id);
  return header(
    namespace,
    store.db
      .prepare("SELECT * FROM plugin_storage_namespaces WHERE id=?")
      .get(id),
  );
}
function guardLease(store, input) {
  if (!input || typeof input !== "object") invalid("Plugin lease is absent");
  const { namespace, id } = guardNamespace(store, input.namespace, true);
  text(input.writerId, "Plugin writer ID");
  text(input.token, "Plugin lease token");
  integer(input.fence, "Plugin lease fence", 1);
  const row = store.db
    .prepare("SELECT * FROM plugin_storage_namespaces WHERE id=?")
    .get(id);
  if (
    !row ||
    row.writer_id !== input.writerId ||
    row.lease_token !== input.token ||
    row.fence !== input.fence ||
    row.lease_until <= store.now()
  )
    throw new RuntimeError(
      "STALE_PLUGIN_WORKER",
      "Plugin writer lease is absent, expired or fenced",
    );
  const job = guardAuthority(store, JSON.parse(row.authority));
  return { namespace, id, row, job };
}
function renew(store, input) {
  const { namespace, id, row, job } = guardLease(store, input.lease);
  const expiresAt = Math.min(
    store.now() + duration(input.leaseMs),
    job?.leaseUntil ?? Infinity,
  );
  store.db
    .prepare("UPDATE plugin_storage_namespaces SET lease_until=? WHERE id=?")
    .run(expiresAt, id);
  return header(namespace, { ...row, lease_until: expiresAt });
}
function release(store, lease) {
  if (!lease || typeof lease !== "object") invalid("Plugin lease is absent");
  const namespace = namespaceOf(lease.namespace);
  text(lease.writerId, "Plugin writer ID");
  text(lease.token, "Plugin lease token");
  integer(lease.fence, "Plugin lease fence", 1);
  // Cleanup remains possible after cancellation, disable/removal, or expiry.
  // The old token/fence can never release a successor's lease.
  const result = store.db
    .prepare(
      "UPDATE plugin_storage_namespaces SET writer_id=NULL,lease_token=NULL,lease_until=NULL,authority=NULL WHERE id=? AND writer_id=? AND lease_token=? AND fence=?",
    )
    .run(identity(namespace), lease.writerId, lease.token, lease.fence);
  return { released: result.changes === 1 };
}
function readAll(store, input, options = {}) {
  const { namespace, id } = guardNamespace(store, input);
  const row = store.db
    .prepare("SELECT revision FROM plugin_storage_namespaces WHERE id=?")
    .get(id);
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  integer(maxBytes, "Plugin snapshot budget", 1);
  if (maxBytes > MAX_NAMESPACE_BYTES)
    invalid("Plugin snapshot budget exceeds the namespace limit");
  // Check before selecting/decoding values: a large archive is never an
  // ordinary bootstrap projection. The caller can use keys/read instead.
  const bytes = store.db
    .prepare(
      "SELECT COALESCE(SUM(value_bytes),0) AS bytes FROM plugin_storage_items WHERE namespace_id=? AND value IS NOT NULL",
    )
    .get(id).bytes;
  if (bytes > maxBytes)
    throw new RuntimeError(
      "PLUGIN_STORAGE_SNAPSHOT_LIMIT",
      "Plugin storage requires bounded key reads",
      { bytes, maxBytes },
    );
  return {
    namespace,
    revision: row?.revision ?? 0,
    items: store.db
      .prepare(
        "SELECT key,value,revision FROM plugin_storage_items WHERE namespace_id=? AND value IS NOT NULL ORDER BY key",
      )
      .all(id)
      .map((item) => ({
        key: item.key,
        value: JSON.parse(item.value),
        revision: item.revision,
      })),
  };
}
function keys(store, input) {
  const { namespace, id } = guardNamespace(store, input);
  const row = store.db
    .prepare("SELECT revision FROM plugin_storage_namespaces WHERE id=?")
    .get(id);
  return {
    namespace,
    revision: row?.revision ?? 0,
    keys: store.db
      .prepare(
        "SELECT key FROM plugin_storage_items WHERE namespace_id=? AND value IS NOT NULL ORDER BY key",
      )
      .all(id)
      .map((item) => item.key),
  };
}
function read(store, input, key) {
  const { namespace, id } = guardNamespace(store, input);
  text(key, "Plugin storage key", 1024);
  const ns = store.db
    .prepare("SELECT revision FROM plugin_storage_namespaces WHERE id=?")
    .get(id);
  const row = store.db
    .prepare(
      "SELECT value,revision FROM plugin_storage_items WHERE namespace_id=? AND key=?",
    )
    .get(id, key);
  return {
    namespace,
    revision: ns?.revision ?? 0,
    key,
    found: row?.value != null,
    value: row?.value != null ? JSON.parse(row.value) : null,
    itemRevision: row?.revision ?? 0,
  };
}
function prepareCommit(input) {
  const expectedRevision = integer(
    input.expectedRevision,
    "Plugin storage revision",
  );
  const commitId = text(input.commitId, "Plugin storage commit ID");
  if (!Array.isArray(input.writes))
    invalid(
      `Plugin storage checkpoints may contain at most ${MAX_WRITES} writes`,
    );
  const maximum = input.writes.every((write) => write?.deleted === true)
    ? MAX_ITEMS
    : MAX_WRITES;
  if (input.writes.length > maximum)
    invalid(`Plugin storage checkpoint exceeds its ${maximum} key budget`);
  const seen = new Set();
  let batchBytes = 0;
  const writes = input.writes.map((write) => {
    const key = text(write?.key, "Plugin storage key", 1024);
    if (seen.has(key)) invalid("Plugin checkpoint contains a duplicate key");
    seen.add(key);
    if (write.deleted === true) {
      if (Object.hasOwn(write, "value"))
        invalid("Deleted plugin keys cannot also have values");
      return { key, value: null, bytes: 0 };
    }
    if (write.deleted !== undefined && write.deleted !== false)
      invalid("Plugin deletion flag is invalid");
    const value = encode(write.value),
      bytes = Buffer.byteLength(value);
    if (bytes > MAX_VALUE_BYTES)
      throw new RuntimeError(
        "PLUGIN_STORAGE_LIMIT",
        "Plugin storage value exceeds 16 MiB",
      );
    batchBytes += bytes;
    return { key, value, bytes };
  });
  if (batchBytes > MAX_BATCH_BYTES)
    throw new RuntimeError(
      "PLUGIN_STORAGE_LIMIT",
      "Plugin storage checkpoint exceeds 32 MiB",
    );
  const requestHash = digest(encode({ expectedRevision, writes }));
  return { expectedRevision, commitId, writes, requestHash };
}
function readCommit(store, input) {
  const { namespace, id } = guardNamespace(store, input.namespace);
  const { commitId, requestHash } = prepareCommit(input);
  const row = store.db
    .prepare(
      "SELECT request_hash,result FROM plugin_storage_commits WHERE namespace_id=? AND commit_id=?",
    )
    .get(id, commitId);
  if (!row) return null;
  if (row.request_hash !== requestHash)
    throw new RuntimeError(
      "IDEMPOTENCY_CONFLICT",
      "Plugin commit ID was reused with different writes",
    );
  return JSON.parse(row.result);
}
function commit(store, input, expectedJob) {
  const { namespace, id, row, job } = guardLease(store, input.lease);
  if (
    expectedJob &&
    (!job ||
      job.id !== expectedJob.id ||
      job.owner !== expectedJob.owner ||
      job.fence !== expectedJob.fence)
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Final plugin checkpoint belongs to another execution",
    );
  const { expectedRevision, commitId, writes, requestHash } =
    prepareCommit(input);
  const previous = store.db
    .prepare(
      "SELECT request_hash,result FROM plugin_storage_commits WHERE namespace_id=? AND commit_id=?",
    )
    .get(id, commitId);
  if (previous) {
    if (previous.request_hash !== requestHash)
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Plugin commit ID was reused with different writes",
      );
    return JSON.parse(previous.result);
  }
  store.expectRevision(expectedRevision, row.revision);
  const changed = writes.filter((write) => {
    const previous = store.db
      .prepare(
        "SELECT value FROM plugin_storage_items WHERE namespace_id=? AND key=?",
      )
      .get(id, write.key);
    return (previous?.value ?? null) !== write.value;
  });
  if (changed.length) {
    const totals = store.db
      .prepare(
        "SELECT COALESCE(SUM(value_bytes),0) AS bytes,COUNT(*) AS count FROM plugin_storage_items WHERE namespace_id=? AND value IS NOT NULL",
      )
      .get(id);
    for (const write of changed) {
      const old = store.db
        .prepare(
          "SELECT value,value_bytes FROM plugin_storage_items WHERE namespace_id=? AND key=?",
        )
        .get(id, write.key);
      totals.bytes += write.bytes - (old?.value_bytes ?? 0);
      totals.count += Number(write.value !== null) - Number(old?.value != null);
    }
    if (totals.bytes > MAX_NAMESPACE_BYTES || totals.count > MAX_ITEMS)
      throw new RuntimeError(
        "PLUGIN_STORAGE_LIMIT",
        "Plugin namespace exceeds its storage budget",
      );
    for (const write of changed)
      store.db
        .prepare(
          "INSERT INTO plugin_storage_items(namespace_id,key,value,value_bytes,revision) VALUES (?,?,?,?,1) ON CONFLICT(namespace_id,key) DO UPDATE SET value=excluded.value,value_bytes=excluded.value_bytes,revision=plugin_storage_items.revision+1",
        )
        .run(id, write.key, write.value, write.bytes);
    store.db
      .prepare(
        "UPDATE plugin_storage_namespaces SET revision=revision+1 WHERE id=?",
      )
      .run(id);
  }
  const result = {
    namespace,
    revision: row.revision + Number(changed.length > 0),
    commitId,
    changed: changed.length > 0,
    keys: changed.map((write) => write.key),
  };
  store.db
    .prepare(
      "INSERT INTO plugin_storage_commits(namespace_id,commit_id,request_hash,result,created_at) VALUES (?,?,?,?,?)",
    )
    .run(id, commitId, requestHash, encode(result), store.now());
  if (changed.length)
    store.event("plugin-storage", id, null, result.revision, {
      namespace,
      revision: result.revision,
      changedKeys: changed.length,
    });
  return result;
}

// Useful outside EntityStore, including original-bundle fixtures. This facade
// gives every multi-key checkpoint a real SQLite snapshot/atomic boundary.
function createClient(store) {
  return {
    initialize: () => store.transaction(() => initialize(store)),
    claim: (input) => store.transaction(() => claim(store, input)),
    renew: (input) => store.transaction(() => renew(store, input)),
    release: (lease) => store.transaction(() => release(store, lease)),
    read: (namespace, key) =>
      store.transaction(() => read(store, namespace, key), true),
    readAll: (namespace, options) =>
      store.transaction(() => readAll(store, namespace, options), true),
    keys: (namespace) => store.transaction(() => keys(store, namespace), true),
    readCommit: (input) =>
      store.transaction(() => readCommit(store, input), true),
    commit: (input) => store.transaction(() => commit(store, input)),
  };
}

module.exports = {
  SCHEMA,
  initialize,
  namespaceOf,
  claim,
  renew,
  release,
  read,
  readAll,
  keys,
  commit,
  readCommit,
  createClient,
  MAX_VALUE_BYTES,
  MAX_BATCH_BYTES,
  MAX_NAMESPACE_BYTES,
  MAX_ITEMS,
  MAX_WRITES,
  MAX_SNAPSHOT_BYTES,
};
