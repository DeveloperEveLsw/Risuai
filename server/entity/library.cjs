"use strict";
const { RuntimeError } = require("./errors.cjs");
const fields = require("./fields.cjs");
const selection = require("./librarySelection.cjs");
const kinds = new Set(["module", "preset", "persona", "plugin"]);

function apply(store, command, helpers) {
  const { id, object, json } = helpers;
  if (!kinds.has(command.kind))
    throw new RuntimeError("INVALID_COMMAND", "Unknown library kind");
  const kind = command.kind;
  const settings = store.getResource("settings", "global");
  if (!settings) throw new RuntimeError("NOT_FOUND", "Settings do not exist");
  const orderKey = kind + "Ids";
  const existingIds = store.db
    .prepare("SELECT id FROM resources WHERE kind=? ORDER BY rowid")
    .all(kind)
    .map((row) => row.id);
  const order = Array.isArray(settings.payload[orderKey])
    ? [...settings.payload[orderKey]]
    : existingIds;
  const changes = new Map();
  const selectedKey =
    kind === "preset"
      ? "botPresetsId"
      : kind === "persona"
        ? "selectedPersona"
        : null;
  const selectedId = selectedKey
    ? order[Number(settings.payload[selectedKey] ?? 0)]
    : null;
  let result;
  if (
    command.type === "activate-library-resource" ||
    command.type === "save-active-library" ||
    command.type === "set-persona-image"
  ) {
    id(command.resourceId, "resourceId");
    id(command.expectedActiveId, "expectedActiveId");
    if (
      command.saveCurrent !== undefined &&
      typeof command.saveCurrent !== "boolean"
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "saveCurrent must be a boolean",
      );
    const applied = selection.apply(store, command);
    if (command.type === "save-active-library") return applied;
    for (const [key, value] of applied.changes) changes.set(key, value);
    result = { id: applied.id, kind: applied.kind };
  } else if (command.type === "reorder-library") {
    const value = command.order;
    if (
      !Array.isArray(value) ||
      value.length !== order.length ||
      new Set(value).size !== order.length ||
      value.some((item) => !order.includes(item))
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Order must include every library ID exactly once",
      );
    const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: orderKey,
    };
    const header = fields.readField(store, target);
    store.expectRevision(command.expectedRevision, header.revision);
    store.expectRevision(command.expectedEpoch, header.entityEpoch);
    changes.set(orderKey, value);
    if (selectedKey && selectedId)
      changes.set(selectedKey, value.indexOf(selectedId));
    result = { kind, order: value };
  } else {
    const resourceId = id(command.resourceId, "resourceId");
    const row = store.getResource(kind, resourceId);
    const epoch = store.deletedRevision("resource", kind, resourceId);
    store.expectRevision(command.expectedRevision, row?.revision ?? epoch);
    store.expectRevision(command.expectedEpoch, epoch);
    if (command.type === "save-library-resource") {
      const payload = object(command.payload, "resource payload");
      if (payload.id !== resourceId)
        throw new RuntimeError(
          "IDENTITY_CONFLICT",
          "Library identity cannot change",
        );
      result = store.mutate({
        type: "put-resource",
        kind,
        resourceId,
        expectedRevision: command.expectedRevision,
        payload,
      });
      if (!order.includes(resourceId))
        changes.set(orderKey, [...order, resourceId]);
    } else if (command.type === "delete-library-resource") {
      if (!row) throw new RuntimeError("NOT_FOUND", "Resource does not exist");
      const remaining = order.filter((value) => value !== resourceId);
      if (selectedKey && remaining.length === 0)
        throw new RuntimeError(
          "LAST_RESOURCE",
          "Keep at least one preset/persona",
        );
      changes.set(orderKey, remaining);
      if (selectedKey) {
        const next = Math.max(0, remaining.indexOf(selectedId));
        changes.set(selectedKey, next);
        if (selectedId === resourceId)
          for (const [key, value] of selection.changes(
            settings.payload,
            selection.applyDefinition(
              kind,
              settings.payload,
              store.getResource(kind, remaining[next]),
            ),
          ))
            changes.set(key, value);
      }
      if (kind === "module" && Array.isArray(settings.payload.enabledModules))
        changes.set(
          "enabledModules",
          settings.payload.enabledModules.filter(
            (value) => value !== resourceId,
          ),
        );
      store.recordFields(
        { scope: "resource", resourceKind: kind, entityId: resourceId },
        row.payload,
        {},
      );
      store.db
        .prepare("DELETE FROM resources WHERE kind=? AND id=?")
        .run(kind, resourceId);
      const revision = row.revision + 1;
      store.rememberDeletion("resource", kind, resourceId, revision);
      store.event("resource", `${kind}:${resourceId}`, null, revision, {
        kind,
        id: resourceId,
        deleted: true,
      });
      result = { id: resourceId, revision, deleted: true };
    } else throw new RuntimeError("INVALID_COMMAND", "Unknown library action");
  }
  const targets = [...changes]
    .filter(([key, value]) =>
      value === undefined
        ? Object.hasOwn(settings.payload, key)
        : json(settings.payload[key] ?? null) !== json(value),
    )
    .map(([key]) => ({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key,
    }));
  if (targets.length) {
    const cache = new Map();
    const edits = targets
      .map((target) => fields.readField(store, target, cache))
      .map((field) => ({
        scope: field.scope,
        resourceKind: field.resourceKind,
        entityId: field.entityId,
        key: field.key,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        ...(changes.get(field.key) === undefined
          ? { remove: true }
          : { value: changes.get(field.key) }),
      }));
    fields.changeFields(store, { type: "change-fields", edits }, null, helpers);
  }
  return result;
}
module.exports = { apply };
