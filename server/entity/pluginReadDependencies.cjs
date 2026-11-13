"use strict";

const { RuntimeError } = require("./errors.cjs");
const pluginCatalog = require("./pluginCatalog.cjs");

const RESOURCE_KINDS = new Set([
  "settings",
  "module",
  "preset",
  "persona",
  "plugin",
]);
const MAX_READS = 4096;
const COLLECTION_KINDS = new Set(["module", "preset", "persona", "plugin"]);

function invalid(message) {
  throw new RuntimeError("PLUGIN_READ_DEPENDENCY_INVALID", message);
}
function object(value, fields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    invalid(`Invalid ${label}`);
}
function identity(value) {
  if (typeof value !== "string" || !value || value.length > 256)
    invalid("Plugin read identity is invalid");
  return value;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    invalid("Plugin read revision or incarnation is invalid");
  return value;
}
function array(value) {
  if (!Array.isArray(value) || value.length > MAX_READS)
    invalid("Expected at most 4096 plugin read dependencies");
  return Array.from(value);
}
function checkedRows(rows, kind) {
  const seen = new Set();
  return array(rows).map((row) => {
    const global = kind === "global-variable";
    object(
      row,
      [
        ...(global ? ["key"] : ["id"]),
        "revision",
        "epoch",
        ...(kind === "resource" ? ["kind"] : []),
      ],
      "plugin read dependency",
    );
    if (kind === "resource" && !RESOURCE_KINDS.has(row.kind))
      invalid("Unknown plugin read resource kind");
    const id = identity(global ? row.key : row.id);
    const key = JSON.stringify([kind === "resource" ? row.kind : kind, id]);
    if (seen.has(key)) invalid("Duplicate plugin read dependency");
    seen.add(key);
    return {
      ...(kind === "resource" ? { kind: row.kind } : {}),
      id,
      revision: integer(row.revision),
      epoch: integer(row.epoch),
    };
  });
}

/** Validate durable plugin derivations inside the caller's transaction.
 * Only identities, revisions and tombstone epochs are read. This function never
 * opens a transaction, loads a prompt/payload, or changes a canonical row.
 * A job caller must supply chatId and pluginId so an empty fabricated closure
 * cannot replace the minimum admitted character/chat/settings/plugin guards.
 */
function validatePluginReadDependencies(store, reads, options = {}) {
  object(
    reads,
    [
      "version",
      "characters",
      "chats",
      "resources",
      "globalVariables",
      "collectionSets",
      "gardenCatalog",
      "currentScope",
    ],
    "plugin read closure",
  );
  if (reads.version !== 1) invalid("Plugin read closure version 1 is required");
  const characters = checkedRows(reads.characters, "character"),
    chats = checkedRows(reads.chats, "chat"),
    resources = checkedRows(reads.resources, "resource");
  const collectionSets = [],
    seenKinds = new Set();
  if (Object.hasOwn(reads, "collectionSets")) {
    if (
      !Array.isArray(reads.collectionSets) ||
      reads.collectionSets.length > COLLECTION_KINDS.size
    )
      invalid("Expected at most four plugin collection enumerations");
    for (const collection of Array.from(reads.collectionSets)) {
      object(collection, ["kind", "ids"], "plugin collection enumeration");
      if (
        !COLLECTION_KINDS.has(collection.kind) ||
        seenKinds.has(collection.kind)
      )
        invalid("Invalid or duplicate plugin collection kind");
      seenKinds.add(collection.kind);
      const ids = array(collection.ids).map(identity),
        expected = new Set(ids);
      if (expected.size !== ids.length)
        invalid("Duplicate plugin collection enumeration identity");
      const guarded = new Set(
        resources
          .filter((row) => row.kind === collection.kind)
          .map((row) => row.id),
      );
      if (expected.size !== guarded.size || ids.some((id) => !guarded.has(id)))
        invalid(
          "Plugin collection enumeration does not match its source guards",
        );
      collectionSets.push({ kind: collection.kind, ids: expected });
    }
  }
  let globals;
  if (Object.hasOwn(reads, "globalVariables")) {
    object(
      reads.globalVariables,
      ["ids", "rows"],
      "plugin global-variable closure",
    );
    const ids = array(reads.globalVariables.ids).map(identity);
    if (new Set(ids).size !== ids.length)
      invalid("Duplicate plugin global-variable enumeration identity");
    const rows = checkedRows(reads.globalVariables.rows, "global-variable");
    if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.id)))
      invalid("Plugin global-variable enumeration does not match its guards");
    globals = { ids, rows };
  }
  const gardenCatalog = Object.hasOwn(reads, "gardenCatalog")
    ? pluginCatalog.checkedGuard(reads.gardenCatalog)
    : undefined;
  const currentScope = Object.hasOwn(reads, "currentScope")
    ? pluginCatalog.checkedScopeGuard(reads.currentScope)
    : undefined;
  if (
    characters.length +
      chats.length +
      resources.length +
      (globals?.rows.length || 0) +
      (gardenCatalog
        ? gardenCatalog.characters.length + gardenCatalog.chats.length
        : 0) +
      (currentScope ? currentScope.chats.length + 1 : 0) >
    MAX_READS
  )
    invalid("Plugin read dependency limit exceeded (4096 rows)");

  const settingsId = identity(options.settingsId ?? "global");
  if (options.pluginId !== undefined) {
    const pluginId = identity(options.pluginId);
    if (!resources.some((row) => row.kind === "plugin" && row.id === pluginId))
      invalid("Admitted plugin source guard is required");
    if (
      !resources.some((row) => row.kind === "settings" && row.id === settingsId)
    )
      invalid("Admitted plugin settings guard is required");
  }
  if (options.chatId !== undefined) {
    const chatId = identity(options.chatId);
    if (!chats.some((row) => row.id === chatId))
      invalid("Admitted plugin chat guard is required");
    const chat = store.db
      .prepare("SELECT character_id FROM chats WHERE id=?")
      .get(chatId);
    if (!chat)
      throw new RuntimeError("NOT_FOUND", "Read chat no longer exists");
    if (!characters.some((row) => row.id === chat.character_id))
      invalid("Admitted plugin character guard is required");
  }

  function validate(row, scope, resourceKind) {
    const current =
      scope === "resource"
        ? store.db
            .prepare("SELECT revision FROM resources WHERE kind=? AND id=?")
            .get(resourceKind, row.id)
        : store.db
            .prepare(
              `SELECT revision FROM ${scope === "character" ? "characters" : "chats"} WHERE id=?`,
            )
            .get(row.id);
    if (!current)
      throw new RuntimeError(
        "NOT_FOUND",
        "Plugin read source no longer exists",
      );
    store.expectRevision(row.revision, current.revision);
    store.expectRevision(
      row.epoch,
      store.fieldEpoch({
        scope,
        entityId: row.id,
        ...(resourceKind ? { resourceKind } : {}),
      }),
    );
  }
  for (const row of characters) validate(row, "character");
  for (const row of chats) validate(row, "chat");
  for (const row of resources) validate(row, "resource", row.kind);
  for (const collection of collectionSets) {
    const actual = store.db
      .prepare("SELECT id FROM resources WHERE kind=?")
      .all(collection.kind);
    if (
      actual.length !== collection.ids.size ||
      actual.some((row) => !collection.ids.has(row.id))
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Plugin source collection enumeration changed",
      );
  }
  if (globals) {
    const actualIds = store.db
      .prepare("SELECT id FROM resources WHERE kind='global-variable'")
      .all()
      .map((row) => row.id);
    const capturedIds = new Set(globals.ids);
    if (
      actualIds.length !== capturedIds.size ||
      actualIds.some((id) => !capturedIds.has(id))
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Plugin global-variable enumeration changed",
      );
    for (const row of globals.rows)
      validate(row, "resource", "global-variable");
  }
  if (gardenCatalog) pluginCatalog.validate(store, gardenCatalog);
  if (currentScope) pluginCatalog.validateCurrentScope(store, currentScope);
  return true;
}

module.exports = { validatePluginReadDependencies };
