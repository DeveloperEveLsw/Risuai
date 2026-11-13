"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("../entity/store.cjs");
const { readCharacterSnapshot } = require("./readSnapshot.cjs");

test("lazy engine character reads pin definitions and guards on a read-only connection and release it on success or failure", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-lazy-character-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file);
  store.applyCommand("create", {
    type: "create-character",
    characterId: "synthetic",
    definition: { name: "Synthetic", desc: "before" },
  });
  const reader = new DatabaseSync(file, { readOnly: true });
  t.after(() => {
    reader.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const previous = readCharacterSnapshot(reader, "synthetic");
  assert.deepEqual(previous, store.getCharacter("synthetic"));
  const target = { scope: "character", entityId: "synthetic", key: "desc" };
  store.applyCommand("edit", {
    type: "change-fields",
    edits: [
      {
        ...target,
        expectedRevision: previous.fieldRevisions.desc,
        expectedEpoch: previous.entityEpoch,
        value: "after",
      },
    ],
  });
  const current = readCharacterSnapshot(reader, "synthetic");
  assert.equal(previous.definition.desc, "before");
  assert.equal(current.definition.desc, "after");
  assert.deepEqual(current, store.getCharacter("synthetic"));
  assert.ok(current.fieldRevisions.desc > previous.fieldRevisions.desc);
  assert.equal(readCharacterSnapshot(reader, "missing"), null);
  assert.throws(() => readCharacterSnapshot(reader, ""), {
    code: "INVALID_COMMAND",
  });
  assert.deepEqual(readCharacterSnapshot(reader, "synthetic"), current);
});
