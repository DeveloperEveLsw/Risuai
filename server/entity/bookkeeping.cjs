"use strict";
const { RuntimeError } = require("./errors.cjs");

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RuntimeError(
      "INVALID_COMMAND",
      `${label} must be a nonnegative safe integer`,
    );
  return value;
}

function separateCharacter(definition) {
  const {
    reloadKeys: _reloadKeys,
    lastInteraction,
    ...persistent
  } = definition;
  return {
    definition: persistent,
    lastInteraction:
      lastInteraction === undefined
        ? undefined
        : count(lastInteraction, "lastInteraction"),
  };
}

function separateSettings(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new RuntimeError("INVALID_COMMAND", "Settings must be an object");
  if (payload.statics === undefined) return { payload };
  const statics = payload.statics;
  if (!statics || typeof statics !== "object" || Array.isArray(statics))
    throw new RuntimeError("INVALID_COMMAND", "Statistics must be an object");
  const { messages = 0, imports = 0, ...extra } = statics;
  const persistent = { ...payload };
  if (Object.keys(extra).length) persistent.statics = extra;
  else delete persistent.statics;
  return {
    payload: persistent,
    statistics: {
      messages: count(messages, "messages"),
      imports: count(imports, "imports"),
    },
  };
}

function getStatistics(store, settingsId) {
  const row = store.db
    .prepare("SELECT * FROM settings_statistics WHERE settings_id=?")
    .get(settingsId);
  return row
    ? {
        settingsId,
        messages: row.messages,
        imports: row.imports,
        revision: row.revision,
      }
    : null;
}

function getActivity(store, characterId) {
  const row = store.db
    .prepare("SELECT * FROM character_activity WHERE character_id=?")
    .get(characterId);
  return row
    ? { lastInteraction: row.last_interaction, revision: row.revision }
    : null;
}

function createStatistics(
  store,
  settingsId,
  statistics = { messages: 0, imports: 0 },
) {
  store.db
    .prepare(
      "INSERT INTO settings_statistics(settings_id, messages, imports, revision) VALUES (?, ?, ?, ?)",
    )
    .run(
      settingsId,
      statistics.messages,
      statistics.imports,
      store.deletedRevision("statistics", "settings", settingsId) + 1,
    );
}

function createActivity(store, characterId, lastInteraction) {
  if (lastInteraction === undefined) return;
  store.db
    .prepare(
      "INSERT INTO character_activity(character_id, last_interaction) VALUES (?, ?)",
    )
    .run(characterId, lastInteraction);
}

function migrateBookkeeping(store, json) {
  for (const row of store.db
    .prepare("SELECT id, definition FROM characters")
    .all()) {
    const separated = separateCharacter(JSON.parse(row.definition));
    createActivity(store, row.id, separated.lastInteraction);
    store.db
      .prepare("UPDATE characters SET definition=? WHERE id=?")
      .run(json(separated.definition), row.id);
  }
  for (const row of store.db
    .prepare("SELECT id, payload FROM resources WHERE kind='settings'")
    .all()) {
    const separated = separateSettings(JSON.parse(row.payload));
    createStatistics(store, row.id, separated.statistics);
    store.db
      .prepare("UPDATE resources SET payload=? WHERE kind='settings' AND id=?")
      .run(json(separated.payload), row.id);
  }
}

/** Apply commutative generated effects or an explicit version-checked replacement. */
function applyBookkeeping(store, writes, id) {
  const seenStatistics = new Set(),
    seenActivity = new Set();
  for (const change of writes.statistics ?? []) {
    if (
      !change ||
      typeof change !== "object" ||
      Array.isArray(change) ||
      Object.keys(change).some(
        (key) =>
          ![
            "settingsId",
            "expectedEpoch",
            "messagesDelta",
            "expectedRevision",
            "messages",
            "imports",
          ].includes(key),
      )
    )
      throw new RuntimeError("INVALID_COMMAND", "Invalid statistics change");
    const settingsId = id(change.settingsId, "settings ID");
    if (seenStatistics.has(settingsId))
      throw new RuntimeError("INVALID_COMMAND", "Duplicate statistics change");
    seenStatistics.add(settingsId);
    const row = getStatistics(store, settingsId);
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Statistics settings do not exist");
    if (change.expectedEpoch !== undefined)
      store.expectRevision(
        change.expectedEpoch,
        store.fieldEpoch({
          scope: "resource",
          resourceKind: "settings",
          entityId: settingsId,
        }),
      );
    let messages, imports;
    if (change.messagesDelta !== undefined) {
      if (
        change.messages !== undefined ||
        change.imports !== undefined ||
        change.expectedRevision !== undefined
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Cannot combine a statistics delta and replacement",
        );
      const delta = count(change.messagesDelta, "messagesDelta");
      if (!delta)
        throw new RuntimeError(
          "INVALID_COMMAND",
          "A statistics delta must be positive",
        );
      messages = count(row.messages + delta, "messages");
      imports = row.imports;
    } else {
      store.expectRevision(change.expectedRevision, row.revision);
      messages = count(change.messages, "messages");
      imports = count(change.imports, "imports");
    }
    if (messages === row.messages && imports === row.imports) continue;
    store.db
      .prepare(
        "UPDATE settings_statistics SET messages=?, imports=?, revision=revision+1 WHERE settings_id=?",
      )
      .run(messages, imports, settingsId);
    store.event("statistics", settingsId, null, row.revision + 1, {
      settingsId,
      messages,
      imports,
    });
  }
  for (const change of writes.activities ?? []) {
    if (
      !change ||
      typeof change !== "object" ||
      Array.isArray(change) ||
      Object.keys(change).some(
        (key) =>
          ![
            "characterId",
            "lastInteraction",
            "expectedRevision",
            "expectedEpoch",
          ].includes(key),
      )
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid character activity change",
      );
    const characterId = id(change.characterId, "character ID");
    if (seenActivity.has(characterId))
      throw new RuntimeError("INVALID_COMMAND", "Duplicate activity change");
    seenActivity.add(characterId);
    if (
      !store.db.prepare("SELECT 1 FROM characters WHERE id=?").get(characterId)
    )
      throw new RuntimeError("NOT_FOUND", "Activity character does not exist");
    if (change.expectedEpoch !== undefined)
      store.expectRevision(
        change.expectedEpoch,
        store.fieldEpoch({ scope: "character", entityId: characterId }),
      );
    const row = getActivity(store, characterId);
    const next = count(change.lastInteraction, "lastInteraction");
    if (change.expectedRevision !== undefined)
      store.expectRevision(change.expectedRevision, row?.revision ?? 0);
    const lastInteraction =
      change.expectedRevision === undefined
        ? Math.max(row?.lastInteraction ?? 0, next)
        : next;
    if (row && lastInteraction === row.lastInteraction) continue;
    const revision = (row?.revision ?? 0) + 1;
    store.db
      .prepare(
        "INSERT INTO character_activity(character_id, last_interaction, revision) VALUES (?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET last_interaction=excluded.last_interaction, revision=excluded.revision",
      )
      .run(characterId, lastInteraction, revision);
    store.event("character-activity", characterId, null, revision, {
      characterId,
      lastInteraction,
    });
  }
}

module.exports = {
  separateCharacter,
  separateSettings,
  getStatistics,
  getActivity,
  createStatistics,
  createActivity,
  migrateBookkeeping,
  applyBookkeeping,
};
