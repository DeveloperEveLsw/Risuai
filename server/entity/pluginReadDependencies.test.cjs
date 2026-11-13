"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const {
  createPluginReadDependencies,
} = require("../native/pluginReadDependencies.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  const command = (input) => store.applyCommand("synthetic-" + ++next, input);
  command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", desc: "Synthetic character source" },
  });
  for (const chatId of ["a", "b"])
    command({
      type: "create-chat",
      chatId,
      characterId: "c",
      metadata: { note: "Synthetic metadata" },
    });
  for (const [kind, resourceId, payload] of [
    [
      "settings",
      "global",
      { mainPrompt: "Synthetic main prompt", enabledModules: ["m"] },
    ],
    [
      "plugin",
      "p",
      {
        name: "Synthetic plugin",
        enabled: true,
        script: "/* synthetic */",
        realArg: { choice: "before" },
      },
    ],
    ["module", "m", { id: "m", name: "Synthetic module" }],
    ["persona", "person", { id: "person", name: "Synthetic persona" }],
    ["preset", "preset", { id: "preset", name: "Synthetic preset" }],
  ])
    command({
      type: "put-resource",
      kind,
      resourceId,
      expectedRevision: 0,
      payload,
    });
  function capture(
    fields = [
      "mainPrompt",
      "modules",
      "personas",
      "botPresets",
      "globalChatVariables",
    ],
  ) {
    const snapshot = store.executionSnapshot("a");
    // Global scalar snapshots historically omitted their tombstone epoch. Build
    // the same complete metadata facade required of the production snapshot.
    for (const row of snapshot.resources) {
      row.entityEpoch = store.fieldEpoch({
        scope: "resource",
        resourceKind: row.kind,
        entityId: row.id,
      });
    }
    const reads = createPluginReadDependencies(snapshot);
    reads.observeCharacter();
    reads.observeChat();
    reads.observePlugin("p");
    reads.observeDatabaseFields(fields);
    return reads.snapshot();
  }
  const options = { chatId: "a", pluginId: "p" };
  const validate = (reads, required = options) =>
    store.transaction(() =>
      validatePluginReadDependencies(store, reads, required),
    );
  function edit(target, value) {
    const field = store.readFields([target]).fields[0];
    return command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value,
        },
      ],
    });
  }
  const variable = (key, expectedRevision, value, remove = false) =>
    command({
      type: "change-variables",
      edits: [
        {
          scope: "global",
          key,
          expectedRevision,
          ...(remove ? { remove: true } : { value }),
        },
      ],
    });
  return { store, command, capture, validate, edit, variable, options };
}

test("plugin guards validate unchanged source metadata without reading bodies or opening transactions", (t) => {
  const f = fixture(t),
    reads = f.capture(),
    cursor = f.store.cursor();
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(
      sql,
      /\b(?:payload|definition|metadata|message|value)\b|\*/i,
    );
    return prepare(sql);
  };
  assert.equal(validatePluginReadDependencies(f.store, reads, f.options), true);
  f.store.db.prepare = prepare;
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.validate(reads), true);
});

test("same-incarnation character, chat metadata, plugin arguments and source resource edits reject a stale graph", (t) => {
  for (const target of [
    { scope: "character", entityId: "c", key: "desc" },
    { scope: "chat", entityId: "a", key: "note" },
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "mainPrompt",
    },
    { scope: "resource", resourceKind: "module", entityId: "m", key: "name" },
    {
      scope: "resource",
      resourceKind: "persona",
      entityId: "person",
      key: "name",
    },
    {
      scope: "resource",
      resourceKind: "preset",
      entityId: "preset",
      key: "name",
    },
    {
      scope: "resource",
      resourceKind: "plugin",
      entityId: "p",
      key: "realArg",
    },
  ]) {
    const f = fixture(t),
      reads = f.capture();
    f.edit(
      target,
      target.key === "realArg"
        ? { choice: "after" }
        : "Synthetic changed source",
    );
    const cursor = f.store.cursor();
    assert.throws(() => f.validate(reads), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.validate(f.capture()), true);
  }
});

test("global-variable broad clones guard values and absent-key enumeration including deletion and recreation", (t) => {
  for (const change of ["value", "add", "remove", "recreate"]) {
    const f = fixture(t);
    f.variable("toggle", 0, "before");
    const reads = f.capture();
    if (change === "value") f.variable("toggle", 1, "after");
    else if (change === "add") f.variable("new-toggle", 0, false);
    else {
      f.variable("toggle", 1, undefined, true);
      if (change === "recreate") f.variable("toggle", 2, "before");
    }
    const cursor = f.store.cursor();
    assert.throws(() => f.validate(reads), { code: "REVISION_CONFLICT" });
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.validate(f.capture()), true);
    if (change === "recreate")
      assert.equal(f.capture().globalVariables.rows[0].epoch, 2);
  }
  const f = fixture(t),
    empty = f.capture();
  f.variable("absent-at-capture", 0, true);
  assert.throws(() => f.validate(empty), { code: "REVISION_CONFLICT" });
});

test("deleted or recreated chat/character and mismatched incarnation cannot publish a captured graph", (t) => {
  const f = fixture(t),
    reads = f.capture();
  const wrongEpoch = structuredClone(reads);
  wrongEpoch.characters[0].epoch += 1;
  assert.throws(() => f.validate(wrongEpoch), { code: "REVISION_CONFLICT" });
  f.command({
    type: "delete-character",
    characterId: "c",
    expectedRevision: f.store.characterView("c").revision,
    expectedEpoch: 0,
  });
  assert.throws(() => f.validate(reads), { code: "NOT_FOUND" });
  f.command({
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic recreated" },
  });
  f.command({ type: "create-chat", characterId: "c", chatId: "a" });
  assert.throws(() => f.validate(reads), { code: "REVISION_CONFLICT" });
  assert.equal(f.validate(f.capture()), true);
});

test("raw resource collections reject added members even when settings and existing rows are unchanged", (t) => {
  for (const [kind, field] of [
    ["module", "modules"],
    ["persona", "personas"],
    ["preset", "botPresets"],
    ["plugin", "plugins"],
  ]) {
    const f = fixture(t),
      reads = f.capture([field]);
    f.command({
      type: "put-resource",
      kind,
      resourceId: "new-member",
      expectedRevision: 0,
      payload: { id: "new-member", name: "Synthetic added member" },
    });
    assert.throws(() => f.validate(reads), { code: "REVISION_CONFLICT" });
    assert.equal(f.validate(f.capture([field])), true);
  }
});

test("malformed, duplicate, oversized and incomplete admitted closures fail before any writes", (t) => {
  const f = fixture(t),
    good = f.capture(),
    cursor = f.store.cursor();
  const empty = { version: 1, characters: [], chats: [], resources: [] };
  const bad = [
    undefined,
    null,
    [],
    {},
    { ...good, version: 0 },
    { ...good, version: "1" },
    { ...good, prompt: "Private data must not be admitted" },
    { ...good, characters: null },
    { ...good, chats: Array(1) },
    { ...good, characters: [{ ...good.characters[0], payload: {} }] },
    { ...good, chats: [{ ...good.chats[0], revision: -1 }] },
    { ...good, chats: [{ ...good.chats[0], epoch: 0.1 }] },
    {
      ...good,
      resources: [{ kind: "global-variable", id: "x", revision: 0, epoch: 0 }],
    },
    { ...good, resources: [{ ...good.resources[0], id: "" }] },
    { ...good, resources: [{ ...good.resources[0], id: "x".repeat(257) }] },
    { ...good, resources: [good.resources[0], good.resources[0]] },
    { ...good, characters: Array(4097).fill(good.characters[0]) },
    { ...good, globalVariables: { ids: ["x"], rows: [] } },
    { ...good, globalVariables: { ids: ["x", "x"], rows: [] } },
    { ...good, globalVariables: undefined },
    { ...good, collectionSets: undefined },
    { ...good, collectionSets: Array(1) },
    { ...good, collectionSets: [{ kind: "settings", ids: [] }] },
    { ...good, collectionSets: [{ kind: "module", ids: [] }] },
    { ...good, collectionSets: [{ kind: "module", ids: ["m", "m"] }] },
    {
      ...good,
      collectionSets: [
        { kind: "module", ids: ["m"] },
        { kind: "module", ids: ["m"] },
      ],
    },
    empty,
    { ...good, characters: [] },
    { ...good, chats: [] },
    {
      ...good,
      resources: good.resources.filter((row) => row.kind !== "plugin"),
    },
    {
      ...good,
      resources: good.resources.filter((row) => row.kind !== "settings"),
    },
  ];
  for (const reads of bad) {
    assert.throws(() => f.validate(reads), {
      code: "PLUGIN_READ_DEPENDENCY_INVALID",
    });
    assert.equal(f.store.cursor(), cursor);
  }
  assert.equal(
    f.validate(empty, {}),
    true,
    "General validator can validate an explicitly empty closure; admitted job policy cannot",
  );
  const missing = structuredClone(good);
  missing.resources.push({
    kind: "module",
    id: "missing",
    revision: 0,
    epoch: 0,
  });
  missing.collectionSets
    .find((row) => row.kind === "module")
    .ids.push("missing");
  assert.throws(() => f.validate(missing), { code: "NOT_FOUND" });
  assert.equal(f.store.cursor(), cursor);
});

test("unconsumed chat and module edits remain compatible, settings are deliberately guarded conservatively", (t) => {
  const f = fixture(t),
    reads = f.capture(["mainPrompt"]);
  f.edit(
    { scope: "chat", entityId: "b", key: "note" },
    "Synthetic other chat note",
  );
  f.edit(
    { scope: "resource", resourceKind: "module", entityId: "m", key: "name" },
    "Synthetic unconsumed module",
  );
  assert.equal(f.validate(reads), true);
  f.edit(
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "username",
    },
    "Synthetic settings edit",
  );
  assert.throws(() => f.validate(reads), { code: "REVISION_CONFLICT" });
});
