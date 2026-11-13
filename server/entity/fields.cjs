"use strict";
const { RuntimeError } = require("./errors.cjs");

const resourceKinds = new Set([
  "settings",
  "module",
  "preset",
  "persona",
  "plugin",
]);
const excluded = {
  character: new Set([
    "chaId",
    "type",
    "chats",
    "chatPage",
    "reloadKeys",
    "lastInteraction",
  ]),
  chat: new Set([
    "id",
    "message",
    "scriptstate",
    "GLGlobalVariables",
    "isStreaming",
    "activeStreamingDisplayOptimizationMode",
  ]),
  settings: new Set([
    "characters",
    "modules",
    "botPresets",
    "personas",
    "plugins",
    "globalChatVariables",
  ]),
};

function target(input, { id, object }, withKey = true, normalization = false) {
  object(input, "field target");
  if (!["character", "chat", "resource"].includes(input.scope))
    throw new RuntimeError("INVALID_COMMAND", "Unknown field scope");
  const value = {
    scope: input.scope,
    entityId: id(input.entityId, "entity ID"),
  };
  if (input.scope === "resource") {
    if (!resourceKinds.has(input.resourceKind))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "This resource has no editable object fields",
      );
    value.resourceKind = input.resourceKind;
  } else if (input.resourceKind !== undefined)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Only resource fields have a resource kind",
    );
  if (withKey) {
    value.key = id(input.key, "field key");
    if (
      excluded[value.resourceKind ?? value.scope]?.has(value.key) ||
      (value.scope === "resource" &&
        value.key === "id" &&
        !(normalization && !input.remove && input.value === value.entityId))
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Identity, collections and separately stored state require their own commands",
      );
  }
  return value;
}
function identity(value) {
  return JSON.stringify([
    value.scope,
    value.resourceKind ?? "",
    value.entityId,
    value.key,
  ]);
}
function epoch(store, value) {
  return store.deletedRevision(
    value.scope === "resource" ? "resource" : value.scope,
    value.resourceKind ?? "",
    value.entityId,
  );
}
function revisions(store, value) {
  return Object.fromEntries(
    store.db
      .prepare(
        "SELECT key, revision FROM entity_field_revisions WHERE scope=? AND kind=? AND entity_id=?",
      )
      .all(value.scope, value.resourceKind ?? "", value.entityId)
      .map((row) => [row.key, row.revision]),
  );
}
function payload(store, value) {
  let row;
  if (value.scope === "character")
    row = store.db
      .prepare(
        "SELECT definition AS payload, revision FROM characters WHERE id=?",
      )
      .get(value.entityId);
  else if (value.scope === "chat")
    row = store.db
      .prepare("SELECT metadata AS payload, revision FROM chats WHERE id=?")
      .get(value.entityId);
  else
    row = store.db
      .prepare("SELECT payload, revision FROM resources WHERE kind=? AND id=?")
      .get(value.resourceKind, value.entityId);
  if (!row) throw new RuntimeError("NOT_FOUND", "Field entity does not exist");
  const data = JSON.parse(row.payload);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Field entity must contain an object",
    );
  return { ...row, data };
}
function readField(store, value, cache = new Map()) {
  const groupKey = JSON.stringify([
    value.scope,
    value.resourceKind ?? "",
    value.entityId,
  ]);
  if (!cache.has(groupKey)) cache.set(groupKey, payload(store, value).data);
  const data = cache.get(groupKey);
  const exists = Object.hasOwn(data, value.key);
  return {
    ...value,
    exists,
    ...(exists ? { value: data[value.key] } : {}),
    revision:
      store.db
        .prepare(
          "SELECT revision FROM entity_field_revisions WHERE scope=? AND kind=? AND entity_id=? AND key=?",
        )
        .get(value.scope, value.resourceKind ?? "", value.entityId, value.key)
        ?.revision ?? 0,
    entityEpoch: epoch(store, value),
  };
}

/** Also called by whole-entity legacy/native writes, so they cannot bypass field CAS. */
function record(store, value, before, after, json, force = [], seed = false) {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
    ...force,
  ]);
  const forced = new Set(force);

  const changed = [];
  for (const key of keys) {
    const was = Object.hasOwn(before ?? {}, key),
      now = Object.hasOwn(after ?? {}, key);
    if (
      !forced.has(key) &&
      was === now &&
      (!was || json(before[key]) === json(after[key]))
    )
      continue;
    changed.push(key);
  }
  bumpFields(store, value, changed, seed);
}
function bumpFields(store, value, keys, seed = false) {
  const statement = store.db
    .prepare(`INSERT INTO entity_field_revisions(scope, kind, entity_id, key, revision) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(scope, kind, entity_id, key) DO ${seed ? "NOTHING" : "UPDATE SET revision=revision+1"}`);
  for (const key of keys)
    statement.run(value.scope, value.resourceKind ?? "", value.entityId, key);
}
function migrate(store, json) {
  for (const row of store.db
    .prepare("SELECT id, definition FROM characters")
    .all())
    record(
      store,
      { scope: "character", entityId: row.id },
      {},
      JSON.parse(row.definition),
      json,
      [],
      true,
    );
  for (const row of store.db.prepare("SELECT id, metadata FROM chats").all())
    record(
      store,
      { scope: "chat", entityId: row.id },
      {},
      JSON.parse(row.metadata),
      json,
      [],
      true,
    );
  for (const row of store.db
    .prepare("SELECT kind, id, payload FROM resources")
    .all())
    if (resourceKinds.has(row.kind))
      record(
        store,
        { scope: "resource", resourceKind: row.kind, entityId: row.id },
        {},
        JSON.parse(row.payload),
        json,
        [],
        true,
      );
}

/** Atomic edits against per-field versions, with an incarnation fence across delete/recreate. */
function apply(store, inputs, validation, coalesce = false) {
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    inputs.length > (coalesce ? 4096 : 128)
  )
    throw new RuntimeError("INVALID_COMMAND", "Expected 1 to 128 field edits");
  const seen = new Set(),
    groups = new Map();
  for (const input of inputs) {
    const value = target(input, validation, true, coalesce),
      key = identity(value);
    if (seen.has(key))
      throw new RuntimeError("INVALID_COMMAND", "A field may appear only once");
    seen.add(key);
    validation.integer(input.expectedRevision, "field revision");
    validation.integer(input.expectedEpoch, "field entity epoch");
    if (input.remove !== undefined && typeof input.remove !== "boolean")
      throw new RuntimeError("INVALID_COMMAND", "remove must be a boolean");
    if (input.remove && Object.hasOwn(input, "value"))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "A removed field cannot include a value",
      );
    if (!input.remove) validation.json(input.value);
    if (
      value.resourceKind === "settings" &&
      value.key === "statics" &&
      !input.remove
    ) {
      validation.object(input.value, "statistics extras");
      if (
        Object.hasOwn(input.value, "messages") ||
        Object.hasOwn(input.value, "imports")
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Counters require their separate statistics command",
        );
    }
    store.expectRevision(input.expectedEpoch, epoch(store, value));
    const groupKey = JSON.stringify([
      value.scope,
      value.resourceKind ?? "",
      value.entityId,
    ]);
    let group = groups.get(groupKey);
    if (!group) {
      const { data } = payload(store, value);
      group = {
        value,
        before: data,
        after: { ...data },
        edits: [],
        versions: revisions(store, value),
      };
      groups.set(groupKey, group);
    }
    const currentRevision = Object.hasOwn(group.versions, value.key)
      ? group.versions[value.key]
      : 0;
    try {
      store.expectRevision(input.expectedRevision, currentRevision);
    } catch (error) {
      const same = input.remove
        ? !Object.hasOwn(group.before, value.key)
        : Object.hasOwn(group.before, value.key) &&
          validation.json(group.before[value.key]) ===
            validation.json(input.value);
      if (
        !coalesce ||
        error.code !== "REVISION_CONFLICT" ||
        input.expectedRevision > currentRevision ||
        !same
      )
        throw error;
      continue;
    }
    if (
      coalesce &&
      (input.remove
        ? !Object.hasOwn(group.before, value.key)
        : Object.hasOwn(group.before, value.key) &&
          validation.json(group.before[value.key]) ===
            validation.json(input.value))
    )
      continue;
    if (input.remove) delete group.after[value.key];
    else
      Object.defineProperty(group.after, value.key, {
        value: input.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    group.edits.push(value.key);
  }
  // Values already captured in this transaction serve both the journal and receipt.
  // Do not parse the whole entity again after writing a single field.
  const cache = new Map([...groups].map(([key, group]) => [key, group.after]));
  for (const { value, before, after, edits } of groups.values()) {
    if (!edits.length) continue;
    bumpFields(store, value, edits);
    if (value.scope === "chat")
      store.recordBookmarks(value.entityId, before, after);
    let revision, characterNavigationRevision, groupMembers;
    if (value.scope === "character") {
      store.db
        .prepare(
          "UPDATE characters SET definition=?, name=?, trash_time=?, revision=revision+1, updated_at=? WHERE id=?",
        )
        .run(
          validation.json(after),
          String(after.name ?? ""),
          Number.isSafeInteger(after.trashTime) ? after.trashTime : null,
          store.now(),
          value.entityId,
        );
      revision = store.db
        .prepare("SELECT revision FROM characters WHERE id=?")
        .get(value.entityId).revision;
      groupMembers = store.recordGroupMembers(value.entityId, before, after);
      const wasHidden =
        Number.isSafeInteger(before.trashTime) && before.trashTime !== 0;
      const nowHidden =
        Number.isSafeInteger(after.trashTime) && after.trashTime !== 0;
      if (wasHidden !== nowHidden)
        characterNavigationRevision = store.bumpCharacterNavigation();
    } else if (value.scope === "chat") {
      store.db
        .prepare("UPDATE chats SET metadata=?, name=? WHERE id=?")
        .run(validation.json(after), String(after.name ?? ""), value.entityId);
      revision = store.bumpChat(value.entityId, false);
    } else {
      const encoded = validation.json(after);
      store.db
        .prepare(
          "UPDATE resources SET payload=?, revision=revision+1 WHERE kind=? AND id=?",
        )
        .run(encoded, value.resourceKind, value.entityId);
      revision = store.db
        .prepare("SELECT revision FROM resources WHERE kind=? AND id=?")
        .get(value.resourceKind, value.entityId).revision;
      store.updateResourceCatalog(
        value.resourceKind,
        value.entityId,
        after,
        encoded,
        revision,
      );
    }
    store.event(
      "fields",
      value.scope === "resource"
        ? value.resourceKind + ":" + value.entityId
        : value.entityId,
      value.scope === "chat" ? value.entityId : null,
      revision,
      {
        ...(characterNavigationRevision !== undefined
          ? { characterNavigationRevision }
          : {}),
        fields: edits.map((key) => readField(store, { ...value, key }, cache)),
        ...(groupMembers?.length ? { groupMembers } : {}),
      },
    );
  }
  return {
    fields: inputs.map((input) =>
      readField(store, target(input, validation, true, coalesce), cache),
    ),
  };
}
/** Read dependencies fence derived browser output without writing source fields. */
function checkFields(store, inputs, validation) {
  if (inputs === undefined) return;
  if (!Array.isArray(inputs) || inputs.length > 128)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Expected at most 128 field checks",
    );
  const seen = new Set();
  for (const input of inputs) {
    const value = target(input, validation),
      key = identity(value);
    if (seen.has(key))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "A field check may appear only once",
      );
    seen.add(key);
    validation.integer(input.expectedRevision, "checked field revision");
    validation.integer(input.expectedEpoch, "checked entity epoch");
    if (Object.hasOwn(input, "value") || Object.hasOwn(input, "remove"))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Field checks cannot contain writes",
      );
    store.expectRevision(input.expectedEpoch, epoch(store, value));
    const exists =
      value.scope === "character"
        ? store.db
            .prepare("SELECT 1 FROM characters WHERE id=?")
            .get(value.entityId)
        : value.scope === "chat"
          ? store.db
              .prepare("SELECT 1 FROM chats WHERE id=?")
              .get(value.entityId)
          : store.db
              .prepare("SELECT 1 FROM resources WHERE kind=? AND id=?")
              .get(value.resourceKind, value.entityId);
    if (!exists)
      throw new RuntimeError(
        "NOT_FOUND",
        "Checked field entity does not exist",
      );
    const revision =
      store.db
        .prepare(
          "SELECT revision FROM entity_field_revisions WHERE scope=? AND kind=? AND entity_id=? AND key=?",
        )
        .get(value.scope, value.resourceKind ?? "", value.entityId, value.key)
        ?.revision ?? 0;
    store.expectRevision(input.expectedRevision, revision);
  }
}
function changeFields(store, command, requestId, validation) {
  if (command.after !== undefined) {
    if (
      !Array.isArray(command.after) ||
      command.after.length > 128 ||
      new Set(command.after).size !== command.after.length
    )
      throw new RuntimeError("INVALID_COMMAND", "Invalid field predecessors");
    for (const previous of command.after) {
      validation.id(previous, "predecessor request ID");
      if (previous === requestId)
        throw new RuntimeError(
          "INVALID_COMMAND",
          "A field change cannot depend on itself",
        );
      const row = store.db
        .prepare("SELECT payload, result FROM commands WHERE id=?")
        .get(previous);
      if (!row?.result)
        throw new RuntimeError(
          "DEPENDENCY_PENDING",
          "A preceding field change has not committed",
          { requestId: previous },
        );
      if (JSON.parse(row.payload).type !== "change-fields")
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Field predecessors must be field commands",
        );
    }
  }
  require("./groupImages.cjs").check(store, command.groupImageSources);
  checkFields(store, command.checks, validation);
  return apply(store, command.edits, validation);
}
module.exports = {
  target,
  identity,
  epoch,
  revisions,
  readField,
  record,
  migrate,
  apply,
  changeFields,
};
