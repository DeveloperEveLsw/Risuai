"use strict";
const { RuntimeError } = require("./errors.cjs");
const {
  createPresetRuntime,
} = require("../../src/ts/storage/presetRuntime.ts");
const {
  createPromptTemplateRuntime,
} = require("../../src/ts/storage/promptTemplateRuntime.ts");
const fields = require("./fields.cjs");
const { LLMFormat } = require("../../src/ts/model/types.ts");
const { assetId } = require("./assets.cjs");
const selectedKey = (kind) =>
  kind === "preset" ? "botPresetsId" : "selectedPersona";
const clean = (value) => JSON.parse(JSON.stringify(value));
function capture(kind, settings, row) {
  if (kind === "persona")
    return clean({
      ...row.payload,
      name: settings.username,
      icon: settings.userIcon,
      personaPrompt: settings.personaPrompt,
      note: settings.userNote,
      id: row.id,
    });
  const db = {
    ...structuredClone(settings),
    botPresets: [structuredClone(row.payload)],
    botPresetsId: 0,
  };
  createPresetRuntime({
    readResourceValue: (value) => value,
    DBState: { db },
    safeStructuredClone: structuredClone,
    ...createPromptTemplateRuntime({ safeStructuredClone: structuredClone }),
    LLMFormat,
  }).saveCurrentPreset();
  return clean({ ...row.payload, ...db.botPresets[0], id: row.id });
}
function applyDefinition(kind, settings, row) {
  const db = structuredClone(settings);
  if (kind === "preset") db.NAIsettings ??= {};
  if (kind === "persona")
    Object.assign(db, {
      username: row.payload.name,
      userIcon: row.payload.icon,
      personaPrompt: row.payload.personaPrompt,
      userNote: row.payload.note,
    });
  else
    createPresetRuntime({
      readResourceValue: (value) => value,
      DBState: { db },
      safeStructuredClone: structuredClone,
      ...createPromptTemplateRuntime({ safeStructuredClone: structuredClone }),
      LLMFormat,
    }).setPreset(db, structuredClone(row.payload));
  return db;
}
function changes(before, after) {
  return new Map(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      )
      .map((key) => [key, after[key]]),
  );
}
function apply(store, command) {
  const kind = command.kind;
  if (!["preset", "persona"].includes(kind))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Only presets/personas have activation state",
    );
  const settings = store.getResource("settings", "global");
  if (!settings) throw new RuntimeError("NOT_FOUND", "Settings do not exist");
  const order = settings.payload[kind + "Ids"];
  if (!Array.isArray(order))
    throw new RuntimeError("INVALID_COMMAND", "Library membership is missing");
  const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: selectedKey(kind),
    },
    guard = fields.readField(store, target);
  store.expectRevision(command.expectedSelectionRevision, guard.revision);
  store.expectRevision(command.expectedSelectionEpoch, guard.entityEpoch);
  const activeId = order[Number(settings.payload[target.key] ?? 0)];
  if (activeId !== command.expectedActiveId)
    throw new RuntimeError(
      "SELECTION_CONFLICT",
      "The active library item changed",
    );
  const row = store.getResource(kind, command.resourceId);
  if (!row || !order.includes(command.resourceId))
    throw new RuntimeError("NOT_FOUND", "Library item does not exist");
  // Selection/capture is an intent over canonical current data, rather than a stale body replacement.
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0
  )
    throw new RuntimeError("INVALID_COMMAND", "Invalid observed revision");
  if (command.expectedRevision > row.revision)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Observed resource revision is from the future",
    );
  store.expectRevision(command.expectedEpoch, row.entityEpoch);
  if (command.type === "set-persona-image") {
    if (kind !== "persona" || command.resourceId !== activeId)
      throw new RuntimeError(
        "SELECTION_CONFLICT",
        "Only the selected persona image can change",
      );
    store.expectRevision(command.expectedRevision, row.revision);
    const icon = fields.readField(store, { ...target, key: "userIcon" });
    store.expectRevision(command.expectedIconRevision, icon.revision);
    store.expectRevision(command.expectedIconEpoch, icon.entityEpoch);
    const asset = store.getAsset(assetId(command.path));
    if (!asset)
      throw new RuntimeError(
        "NOT_FOUND",
        "Upload the shared asset before attaching it",
      );
    store.mutate({
      type: "put-resource",
      kind,
      resourceId: activeId,
      expectedRevision: row.revision,
      payload: { ...row.payload, icon: asset.path },
    });
    return { id: activeId, kind, changes: new Map([["userIcon", asset.path]]) };
  }
  if (command.type === "save-active-library") {
    if (command.resourceId !== activeId)
      throw new RuntimeError(
        "SELECTION_CONFLICT",
        "Only the active item can capture current settings",
      );
    return store.mutate({
      type: "put-resource",
      kind,
      resourceId: activeId,
      expectedRevision: row.revision,
      payload: capture(kind, settings.payload, row),
    });
  }
  if (command.saveCurrent !== false && activeId) {
    const current = store.getResource(kind, activeId);
    if (!current)
      throw new RuntimeError("NOT_FOUND", "Active library item is missing");
    store.mutate({
      type: "put-resource",
      kind,
      resourceId: activeId,
      expectedRevision: current.revision,
      payload: capture(kind, settings.payload, current),
    });
  }
  const applied = applyDefinition(
    kind,
    settings.payload,
    store.getResource(kind, command.resourceId),
  );
  applied[target.key] = order.indexOf(command.resourceId);
  const delta = changes(settings.payload, applied);
  return { id: command.resourceId, kind, changes: delta };
}
module.exports = { apply, capture, applyDefinition, changes };
