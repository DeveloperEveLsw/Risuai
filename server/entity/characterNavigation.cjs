"use strict";
const { RuntimeError } = require("./errors.cjs");
const fields = require("./fields.cjs");
const {
  applyCharacterNavigation,
  CharacterNavigationError,
  removeCharacterOrderReferences,
} = require("../../src/ts/runtime/characterNavigation.mjs");
const counterKey = "character-navigation";
function revision(store) {
  return (
    store.db
      .prepare("SELECT value FROM runtime_meta WHERE key=?")
      .get(counterKey)?.value ?? 0
  );
}
function bump(store) {
  const current = revision(store);
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Character navigation counter is exhausted",
    );
  store.db
    .prepare(
      "INSERT INTO runtime_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(counterKey, current + 1);
  return current + 1;
}
const target = {
  scope: "resource",
  resourceKind: "settings",
  entityId: "global",
  key: "characterOrder",
};
function header(store) {
  const row = store.db
    .prepare(
      "SELECT json_type(payload,'$.characterOrder') AS type, payload -> '$.characterOrder' AS value FROM resources WHERE kind='settings' AND id='global'",
    )
    .get();
  const field = row
    ? {
        ...target,
        exists: row.type !== null,
        ...(row.type !== null ? { value: JSON.parse(row.value) } : {}),
        revision:
          store.db
            .prepare(
              "SELECT revision FROM entity_field_revisions WHERE scope='resource' AND kind='settings' AND entity_id='global' AND key='characterOrder'",
            )
            .get()?.revision ?? 0,
        entityEpoch: fields.epoch(store, target),
      }
    : null;
  return { revision: revision(store), cursor: store.cursor(), order: field };
}
function apply(store, command, validation) {
  const current = header(store);
  if (!current.order)
    throw new RuntimeError("NOT_FOUND", "Global settings do not exist");
  validation.integer(
    command.expectedNavigationRevision,
    "character navigation revision",
  );
  store.expectRevision(command.expectedNavigationRevision, current.revision);
  store.expectRevision(command.expectedOrderRevision, current.order.revision);
  store.expectRevision(
    command.expectedSettingsEpoch,
    current.order.entityEpoch,
  );
  const visible = store.db
    .prepare(
      "SELECT id FROM characters WHERE (trash_time IS NULL OR trash_time=0) AND id NOT IN ('§temp§','§playground§') ORDER BY rowid",
    )
    .all()
    .map((row) => row.id);
  let value;
  try {
    value = applyCharacterNavigation(
      current.order.exists ? current.order.value : [],
      command.action,
      visible,
    );
  } catch (error) {
    if (!(error instanceof CharacterNavigationError)) throw error;
    throw new RuntimeError("INVALID_COMMAND", error.message);
  }
  const result = store.applyFields([
    {
      ...target,
      expectedRevision: current.order.revision,
      expectedEpoch: current.order.entityEpoch,
      value,
    },
  ]);
  return { navigationRevision: current.revision, fields: result.fields };
}
function removeCharacter(store, characterId) {
  const current = header(store);
  if (!current.order?.exists || !Array.isArray(current.order.value)) return;
  const value = removeCharacterOrderReferences(
    current.order.value,
    characterId,
  );
  store.applyFields([
    {
      ...target,
      expectedRevision: current.order.revision,
      expectedEpoch: current.order.entityEpoch,
      value,
    },
  ]);
}
module.exports = { revision, bump, header, apply, removeCharacter };
