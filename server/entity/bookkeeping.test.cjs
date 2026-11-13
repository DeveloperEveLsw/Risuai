"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EntityStore } = require("./store.cjs");
const { DatabaseSync } = require("node:sqlite");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-bookkeeping-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* migration tests close the first handle */
    }
    rmSync(directory, { recursive: true, force: true });
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", extension: { retained: true } },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand("chat-" + chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
    });
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: { username: "Synthetic", statics: { messages: 5, imports: 2 } },
  });
  return { store, file };
}
function claim(store, chatId) {
  store.enqueueJob("job-" + chatId, {
    type: "send",
    chatId,
    input: "synthetic",
  });
  return store.claimJob("worker");
}
function finish(store, claimed, extra = {}) {
  return store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
    state: "completed",
    writeSet: {
      chatId: claimed.job.chatId,
      expectedRevision: claimed.job.startedRevision,
      ...extra,
    },
  });
}

test("a generated statistics delta cannot cross settings deletion/recreation and rolls back earlier writes", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b");
  const original = store.getResource("settings", "global");
  finish(store, a, {
    deleteResources: [
      { kind: "settings", id: "global", expectedRevision: original.revision },
    ],
  });
  store.applyCommand("recreated-settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: original.revision + 1,
    payload: { username: "Replacement", statics: { messages: 20, imports: 3 } },
  });
  const before = store.snapshot("b"),
    settings = store.getResource("settings", "global"),
    cursor = store.cursor();
  assert.ok(settings.entityEpoch > original.entityEpoch);
  assert.throws(
    () =>
      finish(store, b, {
        messages: [
          {
            id: "must-rollback",
            expectedRevision: 0,
            message: { role: "char", data: "Synthetic provisional reply" },
          },
        ],
        variables: [
          {
            key: "$must-rollback",
            expectedRevision: 0,
            value: "Synthetic provisional value",
          },
        ],
        statistics: [
          {
            settingsId: "global",
            expectedEpoch: original.entityEpoch,
            messagesDelta: 2,
          },
        ],
      }),
    { code: "REVISION_CONFLICT" },
  );
  const after = store.snapshot("b");
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.variables, before.variables);
  assert.deepEqual(
    store.getResource("settings", "global").statistics,
    settings.statistics,
  );
  assert.equal(store.cursor(), cursor);
});

for (const mode of ["generated", "explicit"])
  test(`${mode} activity cannot cross character deletion/recreation even when activity revisions match`, (t) => {
    const { store } = fixture(t);
    store.applyCommand("peer", {
      type: "create-character",
      characterId: "peer",
      definition: { name: "Synthetic peer", lastInteraction: 400 },
    });
    const source = store.getCharacter("peer"),
      job = claim(store, "a");
    store.applyCommand("delete-peer", {
      type: "delete-character",
      characterId: "peer",
      expectedRevision: source.revision,
      expectedEpoch: source.entityEpoch,
    });
    store.applyCommand("recreate-peer", {
      type: "create-character",
      characterId: "peer",
      definition: { name: "Replacement peer", lastInteraction: 25 },
    });
    const replacement = store.getCharacter("peer"),
      before = store.snapshot("a"),
      statistics = store.getResource("settings", "global").statistics,
      cursor = store.cursor();
    assert.equal(source.activity.revision, replacement.activity.revision);
    assert.ok(replacement.entityEpoch > source.entityEpoch);
    assert.throws(
      () =>
        finish(store, job, {
          messages: [
            {
              id: "must-rollback",
              expectedRevision: 0,
              message: { role: "char", data: "Synthetic provisional reply" },
            },
          ],
          variables: [
            {
              key: "$must-rollback",
              expectedRevision: 0,
              value: "Synthetic provisional value",
            },
          ],
          statistics: [
            { settingsId: "global", expectedEpoch: 0, messagesDelta: 1 },
          ],
          activities: [
            {
              characterId: "peer",
              expectedEpoch: source.entityEpoch,
              lastInteraction: 500,
              ...(mode === "explicit"
                ? { expectedRevision: source.activity.revision }
                : {}),
            },
          ],
        }),
      { code: "REVISION_CONFLICT" },
    );
    assert.deepEqual(store.getCharacter("peer").activity, replacement.activity);
    assert.deepEqual(
      store.getResource("settings", "global").statistics,
      statistics,
    );
    assert.deepEqual(store.snapshot("a").messages, before.messages);
    assert.deepEqual(store.snapshot("a").variables, before.variables);
    assert.equal(store.cursor(), cursor);
  });

test("independent chat commits add counters and merge activity without invalidating shared definitions", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b"),
    cursor = store.cursor();
  finish(store, a, {
    statistics: [{ settingsId: "global", expectedEpoch: 0, messagesDelta: 1 }],
    activities: [{ characterId: "c", expectedEpoch: 0, lastInteraction: 400 }],
  });
  finish(store, b, {
    statistics: [{ settingsId: "global", expectedEpoch: 0, messagesDelta: 1 }],
    activities: [{ characterId: "c", expectedEpoch: 0, lastInteraction: 200 }],
  });
  assert.equal(store.getResource("settings", "global").revision, 1);
  assert.deepEqual(store.getResource("settings", "global").payload.statics, {
    messages: 7,
    imports: 2,
  });
  assert.equal(store.snapshot("a").character.revision, 1);
  assert.deepEqual(store.snapshot("a").character.activity, {
    lastInteraction: 400,
    revision: 1,
  });
  assert.equal(
    store.snapshot("a").character.definition.lastInteraction,
    undefined,
  );
  assert.equal(store.bootstrap().characters[0].lastInteraction, 400);
  assert.equal(
    store.changes(cursor).changes.filter((e) => e.type === "statistics").length,
    2,
  );
  assert.equal(
    store.changes(cursor).changes.filter((e) => e.type === "character-activity")
      .length,
    1,
  );
  assert.throws(
    () =>
      finish(store, a, {
        statistics: [{ settingsId: "global", messagesDelta: 1 }],
      }),
    { code: "STALE_WORKER" },
  );
  assert.equal(
    store.getResource("settings", "global").payload.statics.messages,
    7,
  );
});

test("explicit counter replacements use statistics revisions and a conflict rolls back messages", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b");
  finish(store, a, {
    statistics: [{ settingsId: "global", messagesDelta: 1 }],
  });
  const cursor = store.cursor();
  assert.throws(
    () =>
      finish(store, b, {
        messages: [
          {
            id: "reply-b",
            expectedRevision: 0,
            message: { role: "char", data: "synthetic" },
          },
        ],
        statistics: [
          {
            settingsId: "global",
            messages: 0,
            imports: 2,
            expectedRevision: 1,
          },
        ],
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(store.snapshot("b").messages.length, 0);
  assert.equal(store.cursor(), cursor);
  assert.equal(store.getJob("job-b").state, "running");
  finish(store, b, {
    statistics: [
      { settingsId: "global", messages: 0, imports: 2, expectedRevision: 2 },
    ],
  });
  assert.equal(
    store.getResource("settings", "global").payload.statics.messages,
    0,
  );
});

test("ordinary settings edits preserve counters copied from a stale device", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a");
  finish(store, a, {
    statistics: [{ settingsId: "global", messagesDelta: 1 }],
  });
  store.applyCommand("edit", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 1,
    payload: {
      username: "New",
      statics: { messages: 0, imports: 0, extension: "preserved" },
    },
  });
  const saved = store.getResource("settings", "global");
  assert.equal(saved.payload.username, "New");
  assert.deepEqual(saved.payload.statics, {
    messages: 6,
    imports: 2,
    extension: "preserved",
  });
  assert.equal(saved.statistics.revision, 2);
});

test("explicit activity edits require their own revision and can intentionally move the timestamp backwards", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b");
  finish(store, a, {
    activities: [{ characterId: "c", lastInteraction: 400 }],
  });
  assert.throws(
    () =>
      finish(store, b, {
        activities: [
          { characterId: "c", lastInteraction: 100, expectedRevision: 0 },
        ],
      }),
    { code: "REVISION_CONFLICT" },
  );
  finish(store, b, {
    activities: [
      { characterId: "c", lastInteraction: 100, expectedRevision: 1 },
    ],
  });
  assert.equal(store.snapshot("b").character.activity.lastInteraction, 100);
});

test("version two migration preserves counters, activity, unknown fields and semantic revisions", (t) => {
  const { store, file } = fixture(t);
  store.db.exec(
    "DROP TABLE settings_statistics; DROP TABLE character_activity; PRAGMA user_version=2;",
  );
  store.db.prepare("UPDATE characters SET definition=? WHERE id='c'").run(
    JSON.stringify({
      name: "Synthetic",
      chaId: "c",
      lastInteraction: 123,
      reloadKeys: 9,
      extension: { retained: true },
    }),
  );
  store.db
    .prepare(
      "UPDATE resources SET payload=? WHERE kind='settings' AND id='global'",
    )
    .run(
      JSON.stringify({
        username: "Synthetic",
        statics: { messages: 7, imports: 3, extension: "preserved" },
      }),
    );
  store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  const character = migrated.snapshot("a").character;
  assert.deepEqual(character.activity, { lastInteraction: 123, revision: 1 });
  assert.equal(character.revision, 1);
  assert.equal(character.definition.reloadKeys, undefined);
  assert.equal(character.definition.lastInteraction, undefined);
  assert.equal(character.definition.extension.retained, true);
  const settings = migrated.getResource("settings", "global");
  assert.equal(settings.revision, 1);
  assert.deepEqual(settings.payload.statics, {
    messages: 7,
    imports: 3,
    extension: "preserved",
  });
  assert.deepEqual(
    JSON.parse(
      migrated.db
        .prepare("SELECT payload FROM resources WHERE id='global'")
        .get().payload,
    ).statics,
    { extension: "preserved" },
  );
});

test("counter overflow rejects the whole final transaction", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a");
  store.db
    .prepare(
      "UPDATE settings_statistics SET messages=? WHERE settings_id='global'",
    )
    .run(Number.MAX_SAFE_INTEGER);
  const cursor = store.cursor();
  assert.throws(
    () =>
      finish(store, a, {
        statistics: [{ settingsId: "global", messagesDelta: 1 }],
        activities: [{ characterId: "c", lastInteraction: 10 }],
      }),
    { code: "INVALID_COMMAND" },
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.snapshot("a").character.activity, null);
});

test("identical shared normalization is reused while future revisions remain invalid", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b");
  const shared = {
    characters: [
      {
        id: "c",
        expectedRevision: 1,
        definition: {
          name: "Normalized",
          chaId: "c",
          extension: { retained: true },
        },
      },
    ],
    resources: [
      {
        kind: "settings",
        id: "global",
        expectedRevision: 1,
        payload: { username: "Normalized" },
      },
    ],
    statistics: [{ settingsId: "global", messagesDelta: 1 }],
  };
  finish(store, a, shared);
  finish(store, b, shared);
  assert.equal(store.snapshot("a").character.revision, 2);
  assert.equal(store.getResource("settings", "global").revision, 2);
  assert.equal(
    store.getResource("settings", "global").payload.statics.messages,
    7,
  );
  store.enqueueJob("future", { type: "button", chatId: "a" });
  const future = store.claimJob("worker");
  assert.throws(
    () =>
      finish(store, future, {
        characters: [{ ...shared.characters[0], expectedRevision: 99 }],
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () =>
      finish(store, future, {
        resources: [{ ...shared.resources[0], expectedRevision: 99 }],
      }),
    { code: "REVISION_CONFLICT" },
  );
});

test("deleting and recreating settings cannot revive an older statistics revision", (t) => {
  const { store } = fixture(t),
    a = claim(store, "a"),
    b = claim(store, "b");
  finish(store, a, {
    deleteResources: [{ kind: "settings", id: "global", expectedRevision: 1 }],
  });
  store.applyCommand("recreate", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 2,
    payload: { username: "New", statics: { messages: 20, imports: 3 } },
  });
  assert.equal(store.getResource("settings", "global").statistics.revision, 3);
  assert.throws(
    () =>
      finish(store, b, {
        statistics: [
          {
            settingsId: "global",
            messages: 0,
            imports: 0,
            expectedRevision: 1,
          },
        ],
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(
    store.getResource("settings", "global").payload.statics.messages,
    20,
  );
});

test("an invalid legacy counter rolls back the entire schema migration and retains the original data", (t) => {
  const { store, file } = fixture(t);
  store.db.exec(
    "DROP TABLE settings_statistics; DROP TABLE character_activity; PRAGMA user_version=2;",
  );
  const original = JSON.stringify({
    name: "Synthetic",
    lastInteraction: 123,
    reloadKeys: 9,
  });
  store.db
    .prepare("UPDATE characters SET definition=? WHERE id='c'")
    .run(original);
  store.db
    .prepare("UPDATE resources SET payload=? WHERE id='global'")
    .run(JSON.stringify({ statics: { messages: -1, imports: 0 } }));
  store.close();
  assert.throws(() => new EntityStore(file), { code: "INVALID_COMMAND" });
  const observer = new DatabaseSync(file);
  try {
    assert.equal(observer.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      observer.prepare("SELECT definition FROM characters WHERE id='c'").get()
        .definition,
      original,
    );
    assert.equal(
      observer
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('settings_statistics', 'character_activity')",
        )
        .get().n,
      0,
    );
  } finally {
    observer.close();
  }
});
