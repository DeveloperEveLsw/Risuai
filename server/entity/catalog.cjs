"use strict";
const { RuntimeError } = require("./errors.cjs");
const kinds = new Set(["module", "preset", "persona", "plugin"]);
function label(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
function update(store, kind, id, payload, encoded, revision) {
  if (!kinds.has(kind)) return;
  const summary = {
    name: label(payload?.name, 256),
    description: label(payload?.description, 768),
    namespace: label(payload?.namespace, 512),
    mcp: Boolean(payload?.mcp),
  };
  store.db
    .prepare(
      `INSERT INTO resource_catalog(kind,id,summary,sort_key,namespace,payload_bytes,revision,entity_epoch)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET summary=excluded.summary,sort_key=excluded.sort_key,
    namespace=excluded.namespace,payload_bytes=excluded.payload_bytes,revision=excluded.revision,entity_epoch=excluded.entity_epoch`,
    )
    .run(
      kind,
      id,
      JSON.stringify(summary),
      summary.name.toLowerCase(),
      typeof payload?.namespace === "string" ? payload.namespace : "",
      Buffer.byteLength(encoded),
      revision,
      store.deletedRevision("resource", kind, id),
    );
}
function migrate(store) {
  for (const row of store.db
    .prepare(
      "SELECT kind,id,payload,revision FROM resources WHERE kind IN ('module','preset','persona','plugin')",
    )
    .all())
    update(
      store,
      row.kind,
      row.id,
      JSON.parse(row.payload),
      row.payload,
      row.revision,
    );
}
function view(row) {
  return {
    kind: row.kind,
    id: row.id,
    revision: row.revision,
    entityEpoch: row.entity_epoch,
    payloadBytes: row.payload_bytes,
    summary: JSON.parse(row.summary),
  };
}
function entry(store, kind, id) {
  if (!kinds.has(kind)) return null;
  const row = store.db
    .prepare(
      "SELECT kind,id,revision,entity_epoch,payload_bytes,summary FROM resource_catalog WHERE kind=? AND id=?",
    )
    .get(kind, id);
  return row ? view(row) : null;
}
function list(store, kind, options = {}) {
  if (!kinds.has(kind))
    throw new RuntimeError("INVALID_COMMAND", "Unknown library kind");
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Catalog limit must be between 1 and 200",
    );
  const search = options.search ?? "";
  if (typeof search !== "string" || search.length > 256)
    throw new RuntimeError("INVALID_COMMAND", "Catalog search is too long");
  let after = ["", ""];
  if (options.after) {
    if (typeof options.after !== "string" || options.after.length > 4096)
      throw new RuntimeError("INVALID_COMMAND", "Invalid catalog cursor");
    try {
      after = JSON.parse(Buffer.from(options.after, "base64url").toString());
    } catch {
      throw new RuntimeError("INVALID_COMMAND", "Invalid catalog cursor");
    }
    if (
      !Array.isArray(after) ||
      after.length !== 2 ||
      after.some((value) => typeof value !== "string" || value.length > 1024)
    )
      throw new RuntimeError("INVALID_COMMAND", "Invalid catalog cursor");
  }
  const pattern =
    "%" +
    search.toLowerCase().replace(/[\\%_]/g, (value) => "\\" + value) +
    "%";
  const rows = store.db
    .prepare(
      `SELECT kind,id,summary,sort_key,payload_bytes,revision,entity_epoch FROM resource_catalog
    WHERE kind=? AND sort_key LIKE ? ESCAPE '\\' AND (sort_key>? OR (sort_key=? AND id>?))
    ORDER BY sort_key,id LIMIT ?`,
    )
    .all(kind, pattern, after[0], after[0], after[1], limit + 1);
  const more = rows.length > limit;
  rows.length = Math.min(rows.length, limit);
  const last = rows.at(-1);
  return {
    kind,
    cursor: store.cursor(),
    items: rows.map(view),
    next: more
      ? Buffer.from(JSON.stringify([last.sort_key, last.id])).toString(
          "base64url",
        )
      : null,
  };
}
function resolve(store, tokens) {
  if (
    !Array.isArray(tokens) ||
    tokens.length > 256 ||
    tokens.some((value) => typeof value !== "string")
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Expected module identity/namespace tokens",
    );
  if (!tokens.length) return [];
  const slots = tokens.map(() => "?").join(",");
  return store.db
    .prepare(
      `SELECT kind,id,summary,payload_bytes,revision,entity_epoch FROM resource_catalog WHERE kind='module' AND (id IN (${slots}) OR namespace IN (${slots})) ORDER BY id`,
    )
    .all(...tokens, ...tokens)
    .map(view);
}
module.exports = { update, migrate, entry, list, resolve };
