"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");

const settings = (key) => ({
  scope: "resource",
  resourceKind: "settings",
  entityId: "global",
  key,
});
const character = (key) => ({ scope: "character", entityId: "c", key });
const chat = (key) => ({ scope: "chat", entityId: "a", key });
const code = (expected) => (error) => error.code === expected;

function checked(f, target) {
  const field = f.store.readFields([target]).fields[0];
  return {
    ...target,
    expectedRevision: field.revision,
    expectedEpoch: field.entityEpoch,
  };
}
function groupImageFixture(t) {
  const f = fixture(t);
  f.change([f.edit(character("image"), "assets/synthetic-source.png")]);
  f.store.applyCommand("create-group", {
    type: "create-character",
    characterId: "g",
    definition: {
      type: "group",
      name: "Authored group",
      characters: ["c"],
      image: "assets/before.png",
      extra: { keep: true },
    },
  });
  const target = { scope: "character", entityId: "g", key: "image" };
  const membership = { ...target, key: "characters" };
  const command = () => ({
    type: "change-fields",
    edits: [f.edit(target, "assets/synthetic-composite.png")],
    checks: [checked(f, membership), checked(f, character("image"))],
  });
  return { ...f, target, membership, command };
}

test("derived group image checks fence source reads without rewriting sources or loading their bodies", (t) => {
  const f = groupImageFixture(t),
    command = f.command();
  // Unrelated source edits do not invalidate a captured image.
  f.change([f.edit(character("nickname"), "Authored later name")]);
  const sourceBefore = f.store.getCharacter("c");
  const cursor = f.store.cursor(),
    prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (/SELECT definition AS payload, revision FROM characters/.test(sql))
      return new Proxy(statement, {
        get(target, key) {
          if (key === "get")
            return (...args) => {
              assert.notEqual(
                args[0],
                "c",
                "read checks must not load unrelated source definitions",
              );
              return target.get(...args);
            };
          const member = Reflect.get(target, key);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    return statement;
  };
  const receipt = f.store.applyCommand("composite", command);
  f.store.db.prepare = prepare;
  const sourceAfter = f.store.getCharacter("c");
  assert.deepEqual(
    { ...sourceAfter, cursor: sourceBefore.cursor },
    sourceBefore,
  );
  assert.deepEqual(
    receipt.fields.map((v) => [v.entityId, v.key]),
    [["g", "image"]],
  );
  assert.deepEqual(
    f.store
      .changes(cursor)
      .changes.flatMap((v) => v.payload.fields.map((field) => field.entityId)),
    ["g"],
  );
  assert.deepEqual(f.store.getCharacter("g").definition.extra, { keep: true });
  // A committed retry returns the original receipt even after source changes.
  f.change([f.edit(character("image"), "assets/later.png")]);
  const after = f.store.cursor();
  assert.deepEqual(f.store.applyCommand("composite", command), receipt);
  assert.equal(f.store.cursor(), after);
  assert.throws(
    () => f.store.applyCommand("composite", { ...command, checks: [] }),
    code("IDEMPOTENCY_CONFLICT"),
  );
});

for (const kind of [
  "image-change",
  "image-ABA",
  "membership-change",
  "delete-recreate",
])
  test(`derived image rejects ${kind} atomically before writing its target`, (t) => {
    const f = groupImageFixture(t),
      command = f.command();
    if (kind === "image-change" || kind === "image-ABA") {
      f.change([f.edit(character("image"), "assets/changed.png")]);
      if (kind === "image-ABA")
        f.change([f.edit(character("image"), "assets/synthetic-source.png")]);
    } else if (kind === "membership-change") {
      f.change([f.edit(f.membership, [])]);
    } else {
      command.checks = command.checks.filter((check) => check.entityId === "c");
      f.store.applyCommand("delete-source", {
        type: "delete-character",
        characterId: "c",
        expectedRevision: f.store.getCharacter("c").revision,
        expectedEpoch: f.store.getCharacter("c").entityEpoch,
      });
      f.store.applyCommand("recreate-source", {
        type: "create-character",
        characterId: "c",
        definition: {
          name: "New authored incarnation",
          image: "assets/synthetic-source.png",
        },
      });
    }
    const before = f.store.getCharacter("g"),
      cursor = f.store.cursor();
    assert.throws(
      () => f.store.applyCommand("rejected-composite", command),
      code("REVISION_CONFLICT"),
    );
    assert.deepEqual(f.store.getCharacter("g"), before);
    assert.equal(f.store.cursor(), cursor);
    assert.equal(
      f.store.db
        .prepare("SELECT id FROM commands WHERE id='rejected-composite'")
        .get(),
      undefined,
    );
  });

test("read checks validate absent fields, missing owners, scopes, duplicate targets and bounded metadata", (t) => {
  const f = groupImageFixture(t),
    absent = checked(f, character("missingOptional"));
  const first = f.command();
  first.checks.push(absent);
  f.store.applyCommand("absent-source-check", first);
  const before = f.store.getCharacter("g"),
    cursor = f.store.cursor();
  const invalid = [
    null,
    {},
    Array(129).fill(absent),
    [absent, absent],
    [{ ...absent, value: "forbidden write" }],
    [{ ...absent, remove: false }],
    [{ ...absent, expectedRevision: -1 }],
    [{ ...absent, expectedEpoch: 0.5 }],
    [{ ...absent, scope: "unknown" }],
    [{ ...absent, key: "chaId" }],
  ];
  for (const [index, checks] of invalid.entries())
    assert.throws(
      () =>
        f.store.applyCommand("invalid-checks-" + index, {
          ...f.command(),
          checks,
        }),
      code("INVALID_COMMAND"),
    );
  assert.throws(
    () =>
      f.store.applyCommand("missing-check", {
        ...f.command(),
        checks: [{ ...absent, entityId: "never-created" }],
      }),
    code("NOT_FOUND"),
  );
  assert.deepEqual(f.store.getCharacter("g"), before);
  assert.equal(f.store.cursor(), cursor);
  const captured = f.command();
  captured.checks.push(absent);
  f.change([f.edit(character("missingOptional"), "now present")]);
  assert.throws(
    () => f.store.applyCommand("created-optional-check", captured),
    code("REVISION_CONFLICT"),
  );
});

test("derived writes check chat/settings dependencies and remain fenced across a second WAL connection and reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-derived-field-checks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic.sqlite"),
    f = fixture(t, file);
  let peer = new EntityStore(file);
  t.after(() => {
    try {
      peer.close();
    } catch {}
  });
  const command = {
    type: "change-fields",
    edits: [f.edit(character("image"), "assets/captured.png")],
    checks: [checked(f, chat("note")), checked(f, settings("temperature"))],
  };
  const note = peer.readFields([chat("note")]).fields[0];
  peer.applyCommand("peer-note", {
    type: "change-fields",
    edits: [
      {
        ...chat("note"),
        expectedRevision: note.revision,
        expectedEpoch: note.entityEpoch,
        value: "Peer changed captured source",
      },
    ],
  });
  assert.throws(
    () => f.store.applyCommand("old-derived", command),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.getCharacter("c").definition.image, undefined);
  const fresh = {
    ...command,
    checks: [checked(f, chat("note")), checked(f, settings("temperature"))],
  };
  const receipt = f.store.applyCommand("fresh-derived", fresh);
  const settingsField = peer.readFields([settings("temperature")]).fields[0];
  peer.applyCommand("peer-settings", {
    type: "change-fields",
    edits: [
      {
        ...settings("temperature"),
        expectedRevision: settingsField.revision,
        expectedEpoch: settingsField.entityEpoch,
        value: 42,
      },
    ],
  });
  assert.throws(
    () =>
      f.store.applyCommand("stale-settings-derived", {
        ...fresh,
        edits: [f.edit(character("image"), "assets/new.png")],
      }),
    code("REVISION_CONFLICT"),
  );
  peer.close();
  peer = new EntityStore(file);
  const cursor = peer.cursor();
  assert.deepEqual(peer.applyCommand("fresh-derived", fresh), receipt);
  assert.equal(peer.cursor(), cursor);
});

test("ordinary field receipts and journal events contain only changed values despite large unrelated entities", (t) => {
  const f = fixture(t);
  const bulk = "Synthetic unrelated field marker ".repeat(32768);
  f.change([
    f.edit(character("syntheticBulk"), bulk),
    f.edit(chat("syntheticBulk"), bulk),
    f.edit(settings("syntheticBulk"), bulk),
  ]);
  const cursor = f.store.cursor();
  const prepare = f.store.db.prepare.bind(f.store.db);
  const reads = [];
  f.store.db.prepare = (sql) => {
    if (
      /SELECT (?:(?:definition|metadata) AS payload|payload), revision FROM (characters|chats|resources)/.test(
        sql,
      )
    )
      reads.push(sql);
    return prepare(sql);
  };
  const targets = [
    character("supaMemory"),
    chat("note"),
    settings("jailbreakToggle"),
  ];
  const edits = targets.map((target, i) =>
    f.edit(target, i === 1 ? "Synthetic selected note" : true),
  );
  reads.length = 0;
  const receipt = f.change(edits);
  f.store.db.prepare = prepare;
  const changes = f.store.changes(cursor).changes;
  assert.equal(
    reads.length,
    3,
    "each entity body is read once, not again for its receipt",
  );
  assert.equal(changes.length, 3);
  assert.ok(changes.every((change) => change.type === "fields"));
  assert.deepEqual(
    changes.map((change) => change.payload.fields[0].key),
    targets.map((target) => target.key),
  );
  assert.deepEqual(
    changes.map((change) => change.payload.fields[0].revision),
    [2, 2, 2],
  );
  assert.deepEqual(
    changes.map((change) => change.payload.fields[0].entityEpoch),
    [0, 0, 0],
  );
  assert.ok(JSON.stringify(changes).length < 3000);
  assert.ok(JSON.stringify(receipt).length < 3000);
  assert.ok(
    !JSON.stringify(changes).includes("Synthetic unrelated field marker"),
  );
  assert.equal(f.store.snapshot("a").chat.metadata.syntheticBulk, bulk);
  assert.equal(
    f.store.getResource("settings", "global").payload.syntheticBulk,
    bulk,
  );
  assert.equal(f.store.getCharacter("c").definition.syntheticBulk, bulk);
});
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: {
      name: "Synthetic",
      desc: "Synthetic definition",
      supaMemory: false,
      extra: { retained: true },
    },
  });
  store.applyCommand("chat", {
    type: "create-chat",
    chatId: "a",
    characterId: "c",
    metadata: {
      name: "Synthetic",
      note: "before",
      useLocallySetGlobalVariables: false,
      GLGlobalVariables: { keep: "kept" },
    },
  });
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      temperature: 80,
      jailbreakToggle: false,
      extra: { retained: true },
      statics: { messages: 5, imports: 2 },
    },
  });
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: { role: "char", data: "Synthetic unrequested archive marker" },
  });
  let next = 0;
  const edit = (target, value) => {
    const current = store.readFields([target]).fields[0];
    return {
      ...target,
      expectedRevision: current.revision,
      expectedEpoch: current.entityEpoch,
      value,
    };
  };
  const change = (edits) =>
    store.applyCommand("edit-" + ++next, { type: "change-fields", edits });
  const claim = () => {
    store.enqueueJob("job", { type: "button", chatId: "a" });
    return store.claimJob("engine");
  };
  const finish = (claimed, writes) =>
    store.finishJob("job", "engine", claimed.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claimed.snapshot.chat.revision,
        expectedContentRevision: claimed.snapshot.chat.contentRevision,
        ...writes,
      },
    });
  return { store, edit, change, claim, finish };
}

test("independent fields merge across entity revisions; ABA and deletion/recreation retain per-field guards", (t) => {
  const f = fixture(t);
  const a = f.edit(settings("temperature"), 65),
    b = f.edit(settings("jailbreakToggle"), true);
  f.change([a]);
  f.change([b]);
  assert.equal(
    f.store.getResource("settings", "global").payload.temperature,
    65,
  );
  assert.equal(
    f.store.getResource("settings", "global").payload.jailbreakToggle,
    true,
  );
  f.change([f.edit(settings("temperature"), 80)]);
  assert.throws(() => f.change([a]), code("REVISION_CONFLICT"));
  const original = f.edit(chat("note"), "new");
  f.change(
    [{ ...original, remove: true, value: undefined }].map(
      ({ value, ...rest }) => rest,
    ),
  );
  const absent = f.store.readFields([chat("note")]).fields[0];
  assert.equal(absent.revision, 2);
  assert.equal(absent.exists, false);
  f.change([
    {
      ...chat("note"),
      expectedRevision: 2,
      expectedEpoch: 0,
      value: "recreated",
    },
  ]);
  assert.throws(() => f.change([original]), code("REVISION_CONFLICT"));
  assert.equal(f.store.snapshot("a").chat.metadata.note, "recreated");
});

test("multi-entity changes, admission and journal roll back together on a stale field", (t) => {
  const f = fixture(t);
  const stale = f.edit(character("supaMemory"), true);
  f.change([{ ...stale, value: false }]);
  const cursor = f.store.cursor(),
    versions = f.store.fieldRevisions({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
    });
  assert.throws(
    () =>
      f.store.applyCommand("rejected", {
        type: "change-fields",
        edits: [f.edit(settings("temperature"), 1), stale],
      }),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.store.getResource("settings", "global").payload.temperature,
    80,
  );
  assert.deepEqual(
    f.store.fieldRevisions({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
    }),
    versions,
  );
  assert.equal(
    f.store.db.prepare("SELECT id FROM commands WHERE id='rejected'").get(),
    undefined,
  );
});

test("causal predecessors protect a child whose revision could match another device; request retries are immutable", (t) => {
  const f = fixture(t),
    intent = f.edit(settings("jailbreakToggle"), true);
  const command = { type: "change-fields", edits: [intent], after: [] };
  const saved = f.store.applyCommand("remote", command);
  assert.deepEqual(f.store.applyCommand("remote", command), saved);
  assert.throws(
    () =>
      f.store.applyCommand("remote", {
        ...command,
        edits: [{ ...intent, value: false }],
      }),
    code("IDEMPOTENCY_CONFLICT"),
  );
  assert.throws(
    () =>
      f.store.applyCommand("child", {
        type: "change-fields",
        after: ["uncommitted-parent"],
        edits: [{ ...intent, expectedRevision: 2, value: false }],
      }),
    code("DEPENDENCY_PENDING"),
  );
  assert.equal(
    f.store.getResource("settings", "global").payload.jailbreakToggle,
    true,
  );
  f.store.applyCommand("child", {
    type: "change-fields",
    after: ["remote"],
    edits: [{ ...intent, expectedRevision: 2, value: false }],
  });
  assert.equal(
    f.store.readFields([settings("jailbreakToggle")]).fields[0].revision,
    3,
  );
});

test("field reads omit archive and counters; protected fields and malformed edits cannot bypass entity boundaries", (t) => {
  const f = fixture(t),
    read = f.store.readFields([
      settings("temperature"),
      character("supaMemory"),
      chat("note"),
    ]);
  assert.equal(read.fields.length, 3);
  assert.equal(JSON.stringify(read).includes("archive marker"), false);
  assert.equal(read.fields[0].revision, 1);
  for (const target of [
    character("chaId"),
    character("chats"),
    chat("message"),
    chat("GLGlobalVariables"),
    settings("characters"),
  ])
    assert.throws(
      () =>
        f.change([
          { ...target, expectedRevision: 0, expectedEpoch: 0, value: {} },
        ]),
      code("INVALID_COMMAND"),
    );
  assert.throws(
    () => f.change([f.edit(settings("statics"), { messages: 100 })]),
    code("INVALID_COMMAND"),
  );
  assert.equal(
    f.store.getResource("settings", "global").payload.statics.messages,
    5,
  );
  assert.throws(
    () =>
      f.change([{ ...f.edit(settings("temperature"), 1), expectedEpoch: 1 }]),
    code("REVISION_CONFLICT"),
  );
  assert.throws(
    () =>
      f.change([
        f.edit(settings("temperature"), 1),
        f.edit(settings("temperature"), 2),
      ]),
    code("INVALID_COMMAND"),
  );
  const own = {
    ...settings("__proto__"),
    expectedRevision: 0,
    expectedEpoch: 0,
    value: { marker: "own" },
  };
  f.change([own]);
  const value = f.store.getResource("settings", "global").payload;
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.deepEqual(value.__proto__, { marker: "own" });
  assert.equal({}.marker, undefined);
  f.change([
    {
      ...settings("constructor"),
      expectedRevision: 0,
      expectedEpoch: 0,
      value: "own",
    },
  ]);
  assert.equal(
    f.store.readFields([settings("constructor")]).fields[0].revision,
    1,
  );
});

test("whole resource writes update changed field guards; a recreated entity fences even an originally absent key", (t) => {
  const f = fixture(t),
    pending = f.edit(settings("brandNew"), "old intent");
  const row = f.store.getResource("settings", "global");
  f.store.applyCommand("whole", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: row.revision,
    payload: { ...row.payload, temperature: 55 },
  });
  assert.equal(
    f.store.readFields([settings("temperature")]).fields[0].revision,
    2,
  );
  assert.equal(
    f.store.readFields([settings("jailbreakToggle")]).fields[0].revision,
    1,
  );
  const claimed = f.claim();
  f.finish(claimed, {
    deleteResources: [{ kind: "settings", id: "global", expectedRevision: 2 }],
  });
  f.store.applyCommand("recreate", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 3,
    payload: { temperature: 90, jailbreakToggle: true },
  });
  assert.throws(() => f.change([pending]), code("REVISION_CONFLICT"));
  assert.equal(
    f.store.readFields([settings("temperature")]).fields[0].revision,
    4,
  );
  assert.equal(
    f.store.readFields([settings("brandNew")]).fields[0].entityEpoch,
    3,
  );
});

test("native field writes merge unrelated configuration, metadata and character edits; overlapping fields roll back everything", (t) => {
  const f = fixture(t),
    claimed = f.claim();
  f.change([
    f.edit(settings("jailbreakToggle"), true),
    f.edit(character("supaMemory"), true),
    f.edit(chat("useLocallySetGlobalVariables"), true),
  ]);
  assert.equal(
    f.store.snapshot("a").chat.contentRevision,
    claimed.job.startedContentRevision,
  );
  f.finish(claimed, {
    metadataFields: [{ key: "note", expectedRevision: 1, value: "engine" }],
    metadataEpoch: 0,
    characters: [
      {
        id: "c",
        fields: [
          {
            key: "desc",
            expectedRevision: 1,
            value: "Synthetic engine definition",
          },
        ],
        expectedEpoch: 0,
      },
    ],
    resources: [
      {
        kind: "settings",
        id: "global",
        fields: [{ key: "temperature", expectedRevision: 1, value: 65 }],
        expectedEpoch: 0,
      },
    ],
    messages: [
      {
        id: "reply",
        expectedRevision: 0,
        message: { role: "char", data: "computed" },
      },
    ],
  });
  const saved = f.store.snapshot("a");
  assert.equal(saved.chat.metadata.useLocallySetGlobalVariables, true);
  assert.equal(saved.chat.metadata.note, "engine");
  assert.equal(saved.character.definition.supaMemory, true);
  assert.deepEqual(saved.character.definition.extra, { retained: true });
  assert.equal(
    f.store.getResource("settings", "global").payload.jailbreakToggle,
    true,
  );
  f.store.enqueueJob("second", { type: "button", chatId: "a" });
  const second = f.store.claimJob("engine");
  const stale = f.edit(character("desc"), "engine overlap");
  f.change([{ ...stale, value: "user" }]);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.finishJob("second", "engine", second.job.fence, {
        state: "completed",
        writeSet: {
          chatId: "a",
          expectedRevision: second.snapshot.chat.revision,
          expectedContentRevision: second.snapshot.chat.contentRevision,
          metadataFields: [
            { key: "note", expectedRevision: 2, value: "must roll back" },
          ],
          metadataEpoch: 0,
          characters: [
            {
              id: "c",
              fields: [
                {
                  key: "desc",
                  expectedRevision: stale.expectedRevision,
                  value: stale.value,
                },
              ],
              expectedEpoch: 0,
            },
          ],
        },
      }),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.snapshot("a").chat.metadata.note, "engine");
  assert.equal(f.store.snapshot("a").character.definition.desc, "user");
});

test("legacy whole metadata remains guarded; identical native defaults coalesce without accepting future revisions", (t) => {
  const f = fixture(t),
    claimed = f.claim();
  f.change([f.edit(chat("note"), "user")]);
  assert.throws(
    () =>
      f.finish(claimed, {
        metadata: { ...claimed.snapshot.chat.metadata, note: "stale" },
      }),
    code("REVISION_CONFLICT"),
  );
  f.change([f.edit(settings("temperature"), 65)]);
  const cursor = f.store.cursor();
  f.store.transaction(() =>
    f.store.applyFields(
      [
        {
          ...settings("temperature"),
          expectedRevision: 1,
          expectedEpoch: 0,
          value: 65,
        },
      ],
      true,
    ),
  );
  assert.equal(f.store.cursor(), cursor);
  assert.throws(
    () =>
      f.store.transaction(() =>
        f.store.applyFields(
          [
            {
              ...settings("temperature"),
              expectedRevision: 3,
              expectedEpoch: 0,
              value: 65,
            },
          ],
          true,
        ),
      ),
    code("REVISION_CONFLICT"),
  );
  assert.equal(
    f.store.readFields([settings("temperature")]).fields[0].revision,
    2,
  );
});

test("schema-seven migration seeds field guards without changing identity, bodies, entity revisions, cursor or running progress", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-fields-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite"),
    f = fixture(t, file);
  const claimed = f.claim();
  f.store.writeJobProgress("job", "engine", claimed.job.fence, {
    stage: 2,
    messages: [{ data: "synthetic partial" }],
  });
  const snapshot = f.store.snapshot("a"),
    resource = f.store.getResource("settings", "global"),
    identity = f.store.bootstrap().serverId,
    cursor = f.store.cursor();
  f.store.db.exec(
    "DROP TABLE entity_field_revisions; ALTER TABLE jobs DROP COLUMN started_metadata_revision; PRAGMA user_version=7;",
  );
  f.store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  assert.equal(migrated.bootstrap().serverId, identity);
  assert.equal(migrated.cursor(), cursor);
  assert.deepEqual(migrated.snapshot("a"), snapshot);
  assert.deepEqual(migrated.getResource("settings", "global"), resource);
  assert.equal(
    migrated.getJob("job").progress.messages[0].data,
    "synthetic partial",
  );
  assert.equal(
    migrated.getJob("job").startedMetadataRevision,
    migrated.metadataRevision("a"),
  );
  assert.equal(
    migrated.readFields([settings("temperature")]).fields[0].revision,
    1,
  );
});
