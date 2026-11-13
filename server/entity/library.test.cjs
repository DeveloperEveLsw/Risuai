"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let next = 0;
  store.initializeState({
    settings: {
      moduleIds: [],
      presetIds: [],
      personaIds: [],
      pluginIds: [],
      enabledModules: [],
      selectedPersona: 0,
      botPresetsId: 0,
      unknown: { retained: true },
    },
    resources: [],
  });
  const command = (value) =>
    store.applyCommand("synthetic-library-" + ++next, value);
  const save = (kind, id, payload = {}, revision = 0, epoch = 0) =>
    command({
      type: "save-library-resource",
      kind,
      resourceId: id,
      expectedRevision: revision,
      expectedEpoch: epoch,
      payload: { ...payload, id },
    });
  const remove = (kind, id) =>
    command({
      type: "delete-library-resource",
      kind,
      resourceId: id,
      expectedRevision: store.getResource(kind, id).revision,
      expectedEpoch: store.deletedRevision("resource", kind, id),
    });
  const settings = () => store.getResource("settings", "global").payload;
  return { store, command, save, remove, settings };
}
test("independent library creates compose membership, preserve unknown data and replay one receipt", (t) => {
  const { store, save, settings } = fixture(t);
  save("module", "a", { name: "Synthetic", unknown: { value: 1 } });
  save("module", "b", { name: "Synthetic B" });
  assert.deepEqual(settings().moduleIds, ["a", "b"]);
  assert.deepEqual(settings().unknown, { retained: true });
  const input = {
    type: "save-library-resource",
    kind: "module",
    resourceId: "a",
    expectedRevision: 1,
    expectedEpoch: 0,
    payload: { id: "a", name: "Edited", unknown: { value: 1 } },
  };
  const receipt = store.applyCommand("immutable-update", input),
    cursor = store.cursor();
  assert.deepEqual(store.applyCommand("immutable-update", input), receipt);
  assert.equal(store.cursor(), cursor);
  assert.equal(store.getResource("module", "a").payload.name, "Edited");
  assert.deepEqual(settings().moduleIds, ["a", "b"]);
  assert.throws(() => save("module", "a", { name: "Old draft" }, 1), {
    code: "REVISION_CONFLICT",
  });
});
test("resource deletion atomically updates membership/enabled modules and incarnation guards reject obsolete drafts", (t) => {
  const { store, save, remove, settings, command } = fixture(t);
  save("module", "a");
  save("module", "b");
  const field = store.readFields([
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "enabledModules",
    },
  ]).fields[0];
  command({
    type: "change-fields",
    edits: [
      {
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: ["a", "b"],
      },
    ],
  });
  const removed = remove("module", "a");
  assert.deepEqual(settings().moduleIds, ["b"]);
  assert.deepEqual(settings().enabledModules, ["b"]);
  assert.equal(store.getResource("module", "a"), null);
  assert.equal(
    store.deletedRevision("resource", "module", "a"),
    removed.revision,
  );
  save(
    "module",
    "a",
    { name: "New incarnation" },
    removed.revision,
    removed.revision,
  );
  assert.throws(
    () => save("module", "a", { name: "Obsolete" }, removed.revision + 1, 0),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(
    store.getResource("module", "a").payload.name,
    "New incarnation",
  );
  assert.deepEqual(settings().moduleIds, ["b", "a"]);
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
test("preset/persona order changes preserve stable selection, enforce a permutation/CAS and retain the last entry", (t) => {
  const { store, save, remove, settings, command } = fixture(t);
  for (const kind of ["preset", "persona"]) {
    save(kind, kind + "-a");
    save(kind, kind + "-b");
    const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: kind + "Ids",
    };
    const field = store.readFields([target]).fields[0];
    const input = {
      type: "reorder-library",
      kind,
      order: [kind + "-b", kind + "-a"],
      expectedRevision: field.revision,
      expectedEpoch: field.entityEpoch,
    };
    command(input);
    assert.deepEqual(settings()[kind + "Ids"], input.order);
    assert.equal(
      settings()[kind === "preset" ? "botPresetsId" : "selectedPersona"],
      1,
    );
    assert.throws(
      () => command({ ...input, order: [kind + "-a", kind + "-b"] }),
      { code: "REVISION_CONFLICT" },
    );
    const before = store.cursor();
    assert.throws(
      () => command({ ...input, order: [kind + "-a", kind + "-a"] }),
      { code: "INVALID_COMMAND" },
    );
    assert.equal(store.cursor(), before);
    remove(kind, kind + "-b");
    assert.equal(
      settings()[kind === "preset" ? "botPresetsId" : "selectedPersona"],
      0,
    );
    const cursor = store.cursor();
    assert.throws(() => remove(kind, kind + "-a"), { code: "LAST_RESOURCE" });
    assert.equal(store.cursor(), cursor);
    assert.ok(store.getResource(kind, kind + "-a"));
  }
});
test("invalid library identities/guards leave no resource, membership or receipt", (t) => {
  const { store, command, settings } = fixture(t),
    before = store.cursor();
  assert.throws(
    () =>
      command({
        type: "save-library-resource",
        kind: "module",
        resourceId: "a",
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: { id: "b" },
      }),
    { code: "IDENTITY_CONFLICT" },
  );
  assert.throws(
    () =>
      command({
        type: "save-library-resource",
        kind: "module",
        resourceId: "a",
        expectedRevision: 0,
        payload: { id: "a" },
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.throws(
    () =>
      command({
        type: "save-library-resource",
        kind: "settings",
        resourceId: "a",
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: { id: "a" },
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(store.cursor(), before);
  assert.deepEqual(settings().moduleIds, []);
  assert.equal(store.getResource("module", "a"), null);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM commands").get().n,
    0,
  );
});
