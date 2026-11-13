"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
function fixture(t) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.initializeState({
    settings: {
      presetIds: ["a", "b"],
      personaIds: ["p", "q"],
      botPresetsId: 0,
      selectedPersona: 0,
      temperature: 71,
      maxContext: 4096,
      NAIsettings: {},
      username: "Current persona",
      userIcon: "",
      personaPrompt: "Synthetic current description",
      userNote: "Current note",
      unknown: { retained: true },
    },
    resources: [
      {
        kind: "preset",
        id: "a",
        payload: {
          id: "a",
          name: "A",
          temperature: 20,
          unknown: { retained: "A" },
        },
      },
      {
        kind: "preset",
        id: "b",
        payload: {
          id: "b",
          name: "B",
          temperature: 42,
          promptTemplate: [
            { type: "plain", role: "assistant", text: "Synthetic" },
          ],
          unknown: { retained: "B" },
        },
      },
      {
        kind: "persona",
        id: "p",
        payload: {
          id: "p",
          name: "P",
          icon: "",
          personaPrompt: "Synthetic P",
          note: "P note",
          unknown: true,
        },
      },
      {
        kind: "persona",
        id: "q",
        payload: {
          id: "q",
          name: "Q",
          icon: "",
          personaPrompt: "Synthetic Q",
          note: "Q note",
          largePortrait: true,
        },
      },
    ],
  });
  let next = 0;
  const command = (value) =>
    store.applyCommand("selection-fixture-" + ++next, value);
  const settings = () => store.getResource("settings", "global").payload;
  const activation = (kind, id, extra = {}) => {
    const key = kind === "preset" ? "botPresetsId" : "selectedPersona",
      guard = store.readFields([
        {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        },
      ]).fields[0],
      row = store.getResource(kind, id);
    return {
      type: "activate-library-resource",
      kind,
      resourceId: id,
      expectedRevision: row.revision,
      expectedEpoch: row.entityEpoch,
      expectedActiveId: settings()[kind + "Ids"][settings()[key]],
      expectedSelectionRevision: guard.revision,
      expectedSelectionEpoch: guard.entityEpoch,
      ...extra,
    };
  };
  return { store, command, settings, activation };
}
test("preset activation saves canonical current settings and applies original target semantics atomically", (t) => {
  const { store, command, settings, activation } = fixture(t);
  command(activation("preset", "b"));
  assert.equal(settings().temperature, 42);
  assert.equal(settings().botPresetsId, 1);
  assert.equal(store.getResource("preset", "a").payload.temperature, 71);
  assert.deepEqual(store.getResource("preset", "a").payload.unknown, {
    retained: "A",
  });
  assert.deepEqual(store.getResource("preset", "b").payload.unknown, {
    retained: "B",
  });
  assert.equal(settings().promptTemplate[0].role, "bot");
  assert.deepEqual(settings().unknown, { retained: true });
  assert.equal(
    store.listLibrary("preset").items.find((item) => item.id === "a").revision,
    2,
  );
});
test("persona activation captures live edits, applies target values and leaves definitions private to their identity", (t) => {
  const { store, command, settings, activation } = fixture(t);
  command(activation("persona", "q"));
  assert.equal(settings().username, "Q");
  assert.equal(settings().personaPrompt, "Synthetic Q");
  assert.equal(settings().selectedPersona, 1);
  assert.deepEqual(store.getResource("persona", "p").payload, {
    id: "p",
    name: "Current persona",
    icon: "",
    personaPrompt: "Synthetic current description",
    note: "Current note",
    unknown: true,
  });
  assert.equal(store.getResource("persona", "q").payload.largePortrait, true);
});
test("stale selection rolls back effects while selection of a revised definition uses canonical current data", (t) => {
  const { store, command, settings, activation } = fixture(t);
  const stale = activation("preset", "a"),
    before = activation("persona", "q");
  command(activation("preset", "b"));
  const cursor = store.cursor(),
    current = structuredClone(settings());
  assert.throws(() => command(stale), { code: "REVISION_CONFLICT" });
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(settings(), current);
  command({
    type: "save-library-resource",
    kind: "persona",
    resourceId: "q",
    expectedRevision: 1,
    expectedEpoch: 0,
    payload: {
      id: "q",
      name: "Changed",
      icon: "",
      personaPrompt: "Synthetic changed",
    },
  });
  command(before);
  assert.equal(settings().username, "Changed");
  assert.equal(settings().personaPrompt, "Synthetic changed");
  assert.equal(Object.hasOwn(settings(), "userNote"), false);
});
test("activation rejects future versions and deleted/recreated target incarnations without canonical effects", (t) => {
  const { store, command, settings, activation } = fixture(t);
  const invalid = activation("persona", "q");
  const cursor = store.cursor(),
    before = structuredClone(settings());
  for (const override of [
    { resourceId: {} },
    { expectedActiveId: "" },
    { saveCurrent: "false" },
    { expectedRevision: -1 },
  ])
    assert.throws(() => command({ ...invalid, ...override }), {
      code: "INVALID_COMMAND",
    });
  assert.throws(() => command({ ...invalid, expectedRevision: 99 }), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(settings(), before);
  command({
    type: "delete-library-resource",
    kind: "persona",
    resourceId: "q",
    expectedRevision: 1,
    expectedEpoch: 0,
  });
  const revision = store.deletedRevision("resource", "persona", "q");
  command({
    type: "save-library-resource",
    kind: "persona",
    resourceId: "q",
    expectedRevision: revision,
    expectedEpoch: revision,
    payload: {
      id: "q",
      name: "Recreated",
      icon: "",
      personaPrompt: "Synthetic recreated",
      note: "",
    },
  });
  const recreatedCursor = store.cursor();
  assert.throws(() => command(invalid), { code: "REVISION_CONFLICT" });
  assert.equal(store.cursor(), recreatedCursor);
  assert.deepEqual(settings(), before);
  assert.equal(store.getResource("persona", "p").revision, 1);
  command(activation("persona", "q"));
  assert.equal(settings().username, "Recreated");
});
test("save-active captures the selected identity and rejects omitted guards or a different target", (t) => {
  const { store, command, activation } = fixture(t);
  command(activation("persona", "p", { type: "save-active-library" }));
  assert.equal(
    store.getResource("persona", "p").payload.name,
    "Current persona",
  );
  assert.throws(
    () => command(activation("persona", "q", { type: "save-active-library" })),
    { code: "SELECTION_CONFLICT" },
  );
  const invalid = activation("preset", "a");
  delete invalid.expectedSelectionRevision;
  assert.throws(() => command(invalid), { code: "INVALID_COMMAND" });
});
test("deleting a selected definition applies the remaining preset/persona in the same transaction", (t) => {
  const { store, command, settings } = fixture(t);
  command({
    type: "delete-library-resource",
    kind: "persona",
    resourceId: "p",
    expectedRevision: 1,
    expectedEpoch: 0,
  });
  assert.equal(settings().username, "Q");
  assert.equal(settings().personaPrompt, "Synthetic Q");
  assert.deepEqual(settings().personaIds, ["q"]);
  command({
    type: "delete-library-resource",
    kind: "preset",
    resourceId: "a",
    expectedRevision: 1,
    expectedEpoch: 0,
  });
  assert.equal(settings().temperature, 42);
  assert.deepEqual(settings().presetIds, ["b"]);
  assert.equal(settings().botPresetsId, 0);
  assert.throws(
    () =>
      command({
        type: "delete-library-resource",
        kind: "preset",
        resourceId: "b",
        expectedRevision: 1,
        expectedEpoch: 0,
      }),
    { code: "LAST_RESOURCE" },
  );
});
test("persona image attachment requires a durable asset and guards the original selection and icon versions", (t) => {
  const { store, command, settings, activation } = fixture(t);
  const digest = "b".repeat(64),
    asset = store.registerAsset({
      id: digest + ".png",
      digest,
      extension: "png",
      mime: "image/png",
      byteLength: 73,
    });
  const image = (id) => {
    const icon = store.readFields([
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "userIcon",
      },
    ]).fields[0];
    return activation("persona", id, {
      type: "set-persona-image",
      path: asset.path,
      expectedIconRevision: icon.revision,
      expectedIconEpoch: icon.entityEpoch,
    });
  };
  const original = image("p");
  command(original);
  assert.equal(settings().userIcon, asset.path);
  assert.equal(store.getResource("persona", "p").payload.icon, asset.path);
  assert.equal(store.getResource("persona", "p").payload.id, "p");
  assert.equal(store.getResource("persona", "p").payload.unknown, true);
  const cursor = store.cursor();
  assert.throws(() => command(original), { code: "REVISION_CONFLICT" });
  assert.equal(store.cursor(), cursor);
  const late = image("p");
  command(activation("persona", "q"));
  const changedCursor = store.cursor();
  assert.throws(() => command(late), { code: "REVISION_CONFLICT" });
  assert.equal(store.cursor(), changedCursor);
  assert.equal(settings().userIcon, "");
  assert.throws(() => command(image("p")), { code: "SELECTION_CONFLICT" });
  assert.throws(
    () =>
      command({
        ...image("q"),
        path: "assets/runtime/" + "c".repeat(64) + ".png",
      }),
    { code: "NOT_FOUND" },
  );
  assert.equal(store.cursor(), changedCursor);
});
