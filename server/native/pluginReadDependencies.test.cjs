"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

function fixture() {
  return {
    character: {
      id: "character",
      revision: 7,
      entityEpoch: 2,
      definition: { desc: "PRIVATE CHARACTER DESCRIPTION" },
    },
    chat: {
      id: "chat",
      revision: 12,
      entityEpoch: 3,
      metadata: { note: "PRIVATE CHAT NOTE" },
    },
    resources: [
      {
        kind: "settings",
        id: "global",
        revision: 8,
        entityEpoch: 1,
        payload: {
          mainPrompt: "PRIVATE MAIN PROMPT",
          moduleIds: ["m"],
          personaIds: ["p"],
        },
      },
      {
        kind: "plugin",
        id: "plugin",
        revision: 9,
        entityEpoch: 4,
        payload: { realArg: { secret: "PRIVATE ARGUMENT" } },
      },
      {
        kind: "module",
        id: "m",
        revision: 6,
        entityEpoch: 5,
        payload: { lorebook: ["PRIVATE LORE"] },
      },
      {
        kind: "persona",
        id: "p",
        revision: 3,
        entityEpoch: 0,
        payload: { personaPrompt: "PRIVATE PERSONA" },
      },
      {
        kind: "global-variable",
        id: "toggle_z",
        revision: 4,
        entityEpoch: 1,
        payload: true,
      },
      {
        kind: "global-variable",
        id: "toggle_a",
        revision: 2,
        entityEpoch: 0,
        payload: "PRIVATE VARIABLE VALUE",
      },
    ],
  };
}

test("plugin raw source reads preserve revisions in addition to incarnation guards", () => {
  const reads = createPluginReadDependencies(fixture());
  reads.observeCharacter();
  reads.observeCharacter();
  reads.observeChat();
  reads.observeChat();
  reads.observePlugin("plugin");
  reads.observeDatabaseFields([
    "modules",
    "personas",
    "selectedPersona",
    "mainPrompt",
    "globalNote",
  ]);
  const result = reads.snapshot();
  assert.deepEqual(result.characters, [
    { id: "character", revision: 7, epoch: 2 },
  ]);
  assert.deepEqual(result.chats, [{ id: "chat", revision: 12, epoch: 3 }]);
  assert.deepEqual(result.resources, [
    { kind: "plugin", id: "plugin", revision: 9, epoch: 4 },
    { kind: "settings", id: "global", revision: 8, epoch: 1 },
    { kind: "module", id: "m", revision: 6, epoch: 5 },
    { kind: "persona", id: "p", revision: 3, epoch: 0 },
  ]);
  assert.deepEqual(result.collectionSets, [
    { kind: "module", ids: ["m"] },
    { kind: "persona", ids: ["p"] },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|payload|definition|metadata/,
  );
});

test("broad global variable reads guard both current values and absent-key enumeration", () => {
  const reads = createPluginReadDependencies(fixture());
  reads.observeDatabaseFields(["globalChatVariables"]);
  assert.deepEqual(reads.snapshot().globalVariables, {
    ids: ["toggle_a", "toggle_z"],
    rows: [
      { key: "toggle_a", revision: 2, epoch: 0 },
      { key: "toggle_z", revision: 4, epoch: 1 },
    ],
  });
  const empty = fixture();
  empty.resources = empty.resources.filter(
    (row) => row.kind !== "global-variable",
  );
  const emptyReads = createPluginReadDependencies(empty);
  emptyReads.observeDatabaseFields(["globalChatVariables"]);
  assert.deepEqual(emptyReads.snapshot().globalVariables, {
    ids: [],
    rows: [],
  });
});

test("returned dependencies cannot mutate admitted source revisions", () => {
  const reads = createPluginReadDependencies(fixture());
  reads.observeCharacter();
  reads.observeDatabaseFields(["globalChatVariables", "modules", "botPresets"]);
  const result = reads.snapshot();
  result.characters[0].revision = 999;
  result.globalVariables.ids.push("introduced");
  result.globalVariables.rows[0].revision = 999;
  result.collectionSets[0].ids.push("introduced");
  assert.equal(reads.snapshot().characters[0].revision, 7);
  assert.deepEqual(reads.snapshot().globalVariables.ids, [
    "toggle_a",
    "toggle_z",
  ]);
  assert.equal(reads.snapshot().globalVariables.rows[0].revision, 2);
  assert.deepEqual(reads.snapshot().collectionSets, [
    { kind: "module", ids: ["m"] },
    { kind: "preset", ids: [] },
  ]);
});

test("source metadata failures and unsupported cross-character reads are explicit", () => {
  const reads = createPluginReadDependencies(fixture());
  assert.throws(() => reads.observePlugin("absent"), {
    code: "PLUGIN_READ_DEPENDENCY_INVALID",
  });
  assert.throws(
    () => reads.observeDatabaseFields(["characters"]),
    /explicit snapshot capability/,
  );
  const absentSettings = fixture();
  absentSettings.resources = [];
  assert.throws(
    () =>
      createPluginReadDependencies(absentSettings).observeDatabaseFields([
        "mainPrompt",
      ]),
    /captured source row/,
  );
  const invalid = fixture();
  invalid.character.revision = -1;
  assert.throws(
    () => createPluginReadDependencies(invalid).observeCharacter(),
    /revision is invalid/,
  );
});
