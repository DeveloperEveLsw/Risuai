"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const {
  projectCharacterOrder,
} = require("../../src/ts/runtime/characterNavigation.mjs");

const folder = {
  id: "f",
  name: "Synthetic folder",
  color: "blue",
  imgFile: "synthetic-image",
  data: ["b", "hidden", "unmapped"],
  unknown: { keep: true },
};
function fixture(t, file = ":memory:") {
  const f = { store: new EntityStore(file), n: 0 };
  t.after(() => f.store.close());
  f.command = (command) =>
    f.store.applyCommand("synthetic-collection-" + ++f.n, command);
  for (const id of ["a", "b", "c", "hidden"])
    f.command({
      type: "create-character",
      characterId: id,
      definition: {
        name: id,
        ...(id === "hidden" ? { trashTime: 123 } : {}),
        unknown: { keep: id },
      },
    });
  f.command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      characterOrder: [
        "unmapped-top",
        "a",
        folder,
        null,
        { id: "legacy-empty", data: [], unknown: true },
      ],
      unknown: { retained: true },
    },
  });
  f.header = () => f.store.bootstrap().characterNavigation;
  f.edit = (action, header = f.header()) => ({
    type: "change-character-navigation",
    expectedNavigationRevision: header.revision,
    expectedOrderRevision: header.order.revision,
    expectedSettingsEpoch: header.order.entityEpoch,
    action,
  });
  f.raw = () =>
    f.store.getResource("settings", "global").payload.characterOrder;
  return f;
}

test("stable moves preserve canonical hidden/unmapped members, unrelated folders and settings without reading character definitions", (t) => {
  const f = fixture(t),
    before = f.store.getCharacter("b"),
    cursor = f.store.cursor();
  const original = f.raw();
  assert.deepEqual(projectCharacterOrder(original, ["a", "b", "c"]), [
    "a",
    { ...folder, data: ["b"] },
    "c",
  ]);
  f.command(
    f.edit({
      type: "move",
      source: { kind: "character", id: "b" },
      destination: { folderId: null, before: { kind: "character", id: "a" } },
    }),
  );
  assert.deepEqual(f.raw(), [
    "unmapped-top",
    "b",
    "a",
    { ...folder, data: ["hidden", "unmapped"] },
    null,
    { id: "legacy-empty", data: [], unknown: true },
  ]);
  assert.deepEqual(f.store.getCharacter("b"), {
    ...before,
    cursor: f.store.cursor(),
  });
  assert.deepEqual(f.store.getResource("settings", "global").payload.unknown, {
    retained: true,
  });
  const events = f.store.changes(cursor).changes;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "fields");
  assert.ok(!JSON.stringify(events).includes('"keep":"b"'));
  assert.deepEqual(original[2], folder);
});

test("unlisted character grouping materializes only selected IDs and preserves imported metadata through moves and folder edits", (t) => {
  const f = fixture(t);
  f.command(
    f.edit({
      type: "group",
      sourceId: "c",
      target: { kind: "character", id: "a" },
      folder: { id: "new-f", name: "New Folder", color: "" },
    }),
  );
  assert.deepEqual(f.raw()[1].data, ["c", "a"]);
  f.command(
    f.edit({
      type: "group",
      sourceId: "b",
      target: { kind: "folder", id: "new-f" },
    }),
  );
  assert.deepEqual(f.raw()[1].data, ["c", "a", "b"]);
  f.command(
    f.edit({
      type: "edit-folder",
      folderId: "f",
      updates: {
        name: "Synthetic renamed",
        color: "red",
        imgFile: null,
        img: "",
      },
    }),
  );
  assert.deepEqual(f.raw()[2], {
    ...folder,
    data: ["hidden", "unmapped"],
    name: "Synthetic renamed",
    color: "red",
    imgFile: null,
    img: "",
  });
  f.command(
    f.edit({
      type: "move",
      source: { kind: "folder", id: "new-f" },
      destination: { folderId: null, before: null },
    }),
  );
  assert.equal(f.raw().at(-1).id, "new-f");
});

test("same-folder insertion and removing a final actual member preserve order and prune only the emptied source folder", (t) => {
  const f = fixture(t);
  f.command(
    f.edit({
      type: "group",
      sourceId: "c",
      target: { kind: "character", id: "a" },
      folder: { id: "new", name: "Synthetic", color: "" },
    }),
  );
  f.command(
    f.edit({
      type: "move",
      source: { kind: "character", id: "c" },
      destination: { folderId: "new", before: null },
    }),
  );
  assert.deepEqual(f.raw()[1].data, ["a", "c"]);
  for (const id of ["c", "a"])
    f.command(
      f.edit({
        type: "move",
        source: { kind: "character", id },
        destination: { folderId: null, before: null },
      }),
    );
  assert.ok(!f.raw().some((value) => value?.id === "new"));
  assert.ok(f.raw().some((value) => value?.id === "legacy-empty"));
  assert.deepEqual(
    f.raw().find((value) => value?.id === "f"),
    folder,
  );
});

test("malformed anchors, nested folders, ambiguous memberships and unsafe edits leave canonical data, counter, journal and receipt untouched", (t) => {
  const f = fixture(t),
    before = f.raw(),
    cursor = f.store.cursor(),
    revision = f.header().revision;
  for (const action of [
    {
      type: "move",
      source: { kind: "folder", id: "f" },
      destination: { folderId: "f", before: null },
    },
    {
      type: "move",
      source: { kind: "character", id: "a" },
      destination: { folderId: null, before: { kind: "character", id: "b" } },
    },
    {
      type: "group",
      sourceId: "hidden",
      target: { kind: "character", id: "a" },
      folder: { id: "new", name: "x", color: "" },
    },
    { type: "edit-folder", folderId: "f", updates: { data: [] } },
    {
      type: "edit-folder",
      folderId: "f",
      updates: JSON.parse('{"__proto__":{}}'),
    },
  ]) {
    assert.throws(() => f.command(f.edit(action)), { code: "INVALID_COMMAND" });
    assert.deepEqual(f.raw(), before);
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.header().revision, revision);
    assert.equal(
      f.store.db
        .prepare("SELECT 1 FROM commands WHERE id=?")
        .get("synthetic-collection-" + f.n),
      undefined,
    );
  }
  const field = f.header().order;
  f.command({
    type: "change-fields",
    edits: [
      {
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: ["a", "a", ...before],
      },
    ],
  });
  assert.throws(
    () =>
      f.command(
        f.edit({
          type: "move",
          source: { kind: "character", id: "a" },
          destination: { folderId: null, before: null },
        }),
      ),
    { code: "INVALID_COMMAND" },
  );
});

test("stale collection/order/resource incarnation guards reject without erasing peer changes; unrelated names stay independent", (t) => {
  const f = fixture(t),
    stale = f.edit({
      type: "edit-folder",
      folderId: "f",
      updates: { name: "Old dialog" },
    });
  const name = f.store.readFields([
    { scope: "character", entityId: "a", key: "name" },
  ]).fields[0];
  f.command({
    type: "change-fields",
    edits: [
      {
        ...name,
        expectedRevision: name.revision,
        expectedEpoch: name.entityEpoch,
        value: "Synthetic name",
      },
    ],
  });
  f.command(stale);
  const old = f.edit({
    type: "edit-folder",
    folderId: "f",
    updates: { color: "purple" },
  });
  f.command(
    f.edit({ type: "edit-folder", folderId: "f", updates: { color: "red" } }),
  );
  assert.throws(() => f.command(old), { code: "REVISION_CONFLICT" });
  for (const action of ["create", "trash", "delete-recreate"]) {
    const capture = f.edit({
      type: "move",
      source: { kind: "character", id: "a" },
      destination: { folderId: null, before: null },
    });
    if (action === "create")
      f.command({
        type: "create-character",
        characterId: "peer",
        definition: { name: "Synthetic peer" },
      });
    if (action === "trash") {
      const field = f.store.readFields([
        { scope: "character", entityId: "b", key: "trashTime" },
      ]).fields[0];
      f.command({
        type: "change-fields",
        edits: [
          {
            ...field,
            expectedRevision: field.revision,
            expectedEpoch: field.entityEpoch,
            value: 1234,
          },
        ],
      });
    }
    if (action === "delete-recreate") {
      const row = f.store.getCharacter("a");
      f.command({
        type: "delete-character",
        characterId: "a",
        expectedRevision: row.revision,
        expectedEpoch: row.entityEpoch,
      });
      f.command({
        type: "create-character",
        characterId: "a",
        definition: { name: "Synthetic recreated" },
      });
    }
    assert.throws(() => f.command(capture), { code: "REVISION_CONFLICT" });
  }
});

test("durable duplicate admission is immutable and navigation counter survives pruning and reopening SQLite", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-character-navigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic.sqlite"),
    f = fixture(t, file);
  const action = f.edit({
    type: "edit-folder",
    folderId: "f",
    updates: { color: "green" },
  });
  const result = f.store.applyCommand("synthetic-immutable", action),
    cursor = f.store.cursor(),
    revision = f.header().revision;
  f.store.pruneChanges(cursor);
  f.store.close();
  f.store = new EntityStore(file);
  assert.deepEqual(f.store.applyCommand("synthetic-immutable", action), result);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.header().revision, revision);
  assert.throws(
    () =>
      f.store.applyCommand("synthetic-immutable", {
        ...action,
        action: { ...action.action, updates: { color: "red" } },
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("native whole-definition and field write sets change the same visibility counter and roll it back with failed persistence", (t) => {
  const f = fixture(t);
  f.command({
    type: "create-chat",
    characterId: "a",
    chatId: "synthetic-chat",
    metadata: { name: "Synthetic" },
  });
  for (const modern of [false, true]) {
    const jobId = "synthetic-native-" + modern;
    f.store.enqueueJob(jobId, { type: "send", chatId: "synthetic-chat" });
    const claim = f.store.claimJob("synthetic-worker"),
      before = f.header(),
      row = f.store.getCharacter("a");
    const writes = {
      chatId: "synthetic-chat",
      expectedRevision: claim.job.startedRevision,
      ...(modern
        ? { expectedContentRevision: claim.job.startedContentRevision }
        : {}),
      characters: [
        {
          id: "a",
          ...(modern
            ? {
                expectedEpoch: row.entityEpoch,
                fields: [
                  {
                    key: "trashTime",
                    expectedRevision: row.fieldRevisions.trashTime ?? 0,
                    value: 0,
                  },
                ],
              }
            : {
                expectedRevision: row.revision,
                definition: { ...row.definition, trashTime: 321 },
              }),
        },
      ],
    };
    assert.throws(
      () =>
        f.store.finishJob(jobId, "synthetic-worker", claim.job.fence, {
          state: "completed",
          writeSet: {
            ...writes,
            resources: [
              {
                kind: "settings",
                id: "global",
                expectedRevision: -1,
                payload: {},
              },
            ],
          },
        }),
      { code: "INVALID_COMMAND" },
    );
    assert.deepEqual(f.header(), before);
    assert.deepEqual(f.store.getCharacter("a"), row);
    f.store.finishJob(jobId, "synthetic-worker", claim.job.fence, {
      state: "completed",
      writeSet: writes,
    });
    assert.equal(f.header().revision, before.revision + 1);
    const event = f.store
      .changes(before.cursor)
      .changes.find((change) =>
        modern ? change.type === "fields" : change.type === "character",
      );
    assert.equal(
      event.payload.characterNavigationRevision,
      f.header().revision,
    );
  }
});

test("semantic moves scan identities, not 133 unopened definition bodies, and retain every unmentioned member", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 133; i++)
    f.command({
      type: "create-character",
      characterId: "synthetic-large-" + i,
      definition: {
        name: "Synthetic",
        desc: "Synthetic definition. ".repeat(8192),
      },
    });
  const capture = f.edit({
    type: "move",
    source: { kind: "character", id: "c" },
    destination: { folderId: "f", before: { kind: "character", id: "b" } },
  });
  const statements = [],
    prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    statements.push(sql);
    return prepare(sql);
  };
  try {
    f.command(capture);
  } finally {
    delete f.store.db.prepare;
  }
  assert.ok(
    !statements.some(
      (sql) => /definition/i.test(sql) && /characters/i.test(sql),
    ),
    statements.join("\n"),
  );
  const ids = f.store.bootstrap().characters.map((row) => row.id);
  assert.equal(ids.length, 137);
  assert.equal(
    projectCharacterOrder(
      f.raw(),
      ids.filter((id) => id !== "hidden"),
    ).flatMap((value) => (typeof value === "string" ? value : value.data))
      .length,
    136,
  );
  assert.deepEqual(f.raw().find((value) => value?.id === "f").data, [
    "c",
    "b",
    "hidden",
    "unmapped",
  ]);
});

test("settings recreation rejects an old folder capture even when the imported order is identical", (t) => {
  const f = fixture(t),
    stale = f.edit({
      type: "edit-folder",
      folderId: "f",
      updates: { name: "Old incarnation" },
    });
  const settings = f.store.getResource("settings", "global");
  f.command({
    type: "create-chat",
    characterId: "a",
    chatId: "synthetic-delete-settings",
    metadata: { name: "Synthetic" },
  });
  f.store.enqueueJob("synthetic-delete-settings-job", {
    type: "send",
    chatId: "synthetic-delete-settings",
  });
  const claim = f.store.claimJob("synthetic-worker");
  f.store.finishJob(claim.job.id, "synthetic-worker", claim.job.fence, {
    state: "completed",
    writeSet: {
      chatId: claim.job.chatId,
      expectedRevision: claim.job.startedRevision,
      deleteResources: [
        { kind: "settings", id: "global", expectedRevision: settings.revision },
      ],
    },
  });
  assert.equal(f.header().order, null);
  f.command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision + 1,
    payload: settings.payload,
  });
  assert.ok(f.header().order.entityEpoch > stale.expectedSettingsEpoch);
  assert.throws(
    () =>
      f.command({ ...stale, expectedOrderRevision: f.header().order.revision }),
    { code: "REVISION_CONFLICT" },
  );
  assert.deepEqual(f.raw(), settings.payload.characterOrder);
});

test("bootstrap order values, field revisions and lifecycle counter share a real WAL snapshot", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-character-header-wal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic.sqlite"),
    f = fixture(t, file),
    peer = new EntityStore(file);
  t.after(() => peer.close());
  const expected = f.header(),
    prepare = f.store.db.prepare.bind(f.store.db);
  let injected = false;
  f.store.db.prepare = (sql) => {
    if (
      !injected &&
      sql.includes("SELECT json_type(payload,'$.characterOrder')")
    ) {
      injected = true;
      peer.applyCommand(
        "synthetic-wal-peer-move",
        f.edit(
          { type: "edit-folder", folderId: "f", updates: { color: "purple" } },
          expected,
        ),
      );
      peer.applyCommand("synthetic-wal-peer-new", {
        type: "create-character",
        characterId: "synthetic-new",
        definition: { name: "Synthetic new" },
      });
    }
    return prepare(sql);
  };
  let pinned;
  try {
    pinned = f.store.bootstrap();
  } finally {
    delete f.store.db.prepare;
  }
  assert.ok(injected);
  assert.deepEqual(pinned.characterNavigation, expected);
  assert.equal(pinned.characters.length, 4);
  const current = f.store.bootstrap();
  assert.equal(current.characters.length, 5);
  assert.equal(current.characterNavigation.revision, expected.revision + 1);
  assert.equal(current.characterNavigation.order.value[2].color, "purple");
});

test("permanent deletion clears only known order references atomically and a recreated ID does not inherit its old folder", (t) => {
  const f = fixture(t),
    field = f.header().order;
  const raw = [
    "a",
    { ...folder, data: ["a", "b", "hidden", "unmapped"] },
    {
      id: "emptied",
      name: "Synthetic",
      data: ["a"],
      color: "",
      imgFile: "synthetic-unreferenced",
      unknown: true,
    },
    { id: "unrelated-empty", data: [], unknown: true },
    null,
    "unmapped-top",
  ];
  f.command({
    type: "change-fields",
    edits: [
      {
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: raw,
      },
    ],
  });
  const row = f.store.getCharacter("a"),
    before = f.header(),
    remove = f.store.removeCharacterOrderReferences.bind(f.store);
  const deletion = {
    type: "delete-character",
    characterId: "a",
    expectedRevision: row.revision,
    expectedEpoch: row.entityEpoch,
  };
  f.store.removeCharacterOrderReferences = (id) => {
    remove(id);
    throw Error("Synthetic failure after relationship write");
  };
  assert.throws(() => f.command(deletion), /Synthetic failure/);
  delete f.store.removeCharacterOrderReferences;
  assert.deepEqual(f.header(), before);
  assert.deepEqual(f.store.getCharacter("a"), row);
  f.command(deletion);
  const expected = [
    { ...folder, data: ["b", "hidden", "unmapped"] },
    { id: "unrelated-empty", data: [], unknown: true },
    null,
    "unmapped-top",
  ];
  assert.deepEqual(f.raw(), expected);
  assert.deepEqual(
    f.store.changes(before.cursor).changes.map((value) => value.type),
    ["character", "fields"],
  );
  assert.equal(f.header().revision, before.revision + 1);
  f.command({
    type: "create-character",
    characterId: "a",
    definition: { name: "Synthetic recreated" },
  });
  assert.deepEqual(f.raw(), expected);
  assert.ok(
    !projectCharacterOrder(f.raw(), ["a", "b", "c"])
      .find((value) => value?.id === "f")
      .data.includes("a"),
  );
});
