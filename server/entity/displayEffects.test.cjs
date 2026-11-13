"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  store.initializeState({
    settings: { syntheticUnknown: { retained: true } },
    resources: [],
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", unknown: { retained: true } },
    chat: { chatId: "a", metadata: { name: "A" } },
  });
  store.applyCommand("chat-b", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "B" },
  });
  return store;
}
function command(store, options = {}) {
  const state = store.displayState("a");
  return {
    type: "apply-display-effects",
    chatId: "a",
    expectedChatEpoch: state.chatEpoch,
    expectedCharacterEpoch: state.characterEpoch,
    inputClock: state.inputClock,
    codeHash: "b".repeat(64),
    source: { kind: "view", contentHash: "a".repeat(64) },
    reads: [],
    edits: [
      {
        scope: "chat",
        chatId: "a",
        key: "$display",
        value: "Synthetic",
        expectedRevision: 0,
      },
    ],
    ...options,
  };
}
const values = (store) => store.snapshot("a").variables;
const receipts = (store) =>
  store.db.prepare("SELECT COUNT(*) AS count FROM display_effects").get().count;

test("display mutations and receipts commit atomically and transport-independent duplicate effects do not execute twice", (t) => {
  const store = fixture(t),
    cmd = command(store, {
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$counter",
          value: 1,
          expectedRevision: 0,
        },
        {
          scope: "chat",
          chatId: "a",
          key: "$__cache",
          value: '{"seen":true}',
          expectedRevision: 0,
        },
      ],
    });
  const before = store.displayState("a"),
    result = store.applyCommand("device-a", cmd),
    after = store.displayState("a");
  assert.equal(after.inputClock, before.inputClock);
  assert.deepEqual(after.applied, [result.displayKey]);
  assert.deepEqual(store.applyCommand("device-a", cmd), result);
  const cursor = store.cursor(),
    duplicate = store.applyCommand("device-b", cmd);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.matchesOriginalIntent, true);
  assert.equal(store.cursor(), cursor);
  assert.equal(receipts(store), 1);
  const different = store.applyCommand("rerender", {
    ...cmd,
    edits: [
      {
        scope: "chat",
        chatId: "a",
        key: "$counter",
        value: 2,
        expectedRevision: 1,
      },
    ],
  });
  assert.equal(different.deduplicated, true);
  assert.equal(different.matchesOriginalIntent, false);
  assert.equal(values(store).find((v) => v.key === "$counter").value, 1);
  const changes = store.changes(before.cursor).changes;
  assert.equal(changes.length, 3);
  assert.ok(
    changes.every(
      (event) => event.payload.displayEffectId === result.displayKey,
    ),
  );
});

test("external clocks isolate different chats, include shared configuration and exclude generation bookkeeping/progress", (t) => {
  const store = fixture(t),
    before = store.displayState("a").inputClock;
  store.applyCommand("other-chat", {
    type: "set-chat-variable",
    chatId: "b",
    key: "$other",
    value: "Synthetic",
    expectedRevision: 0,
  });
  assert.equal(store.displayState("a").inputClock, before);
  store.applyCommand("counter", { type: "record-import" });
  store.transaction(() => {
    store.event("character-activity", "c", null, 1, { lastInteraction: 1 });
    store.event("job-progress", "synthetic", "a", 1, { text: "Synthetic" });
  });
  assert.equal(store.displayState("a").inputClock, before);
  const [field] = store.readFields([
    { scope: "character", entityId: "c", key: "name" },
  ]).fields;
  store.applyCommand("definition", {
    type: "change-fields",
    edits: [
      {
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: "Changed synthetic",
      },
    ],
  });
  assert.ok(store.displayState("a").inputClock > before);
  const prior = store.displayState("a").inputClock;
  const [setting] = store.readFields([
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "language",
    },
  ]).fields;
  store.applyCommand("setting", {
    type: "change-fields",
    edits: [
      {
        ...setting,
        expectedRevision: setting.revision,
        expectedEpoch: setting.entityEpoch,
        value: "en",
      },
    ],
  });
  assert.ok(store.displayState("a").inputClock > prior);
});

test("stale external inputs and read dependencies reject before any display effect, receipt or request persists", (t) => {
  const store = fixture(t),
    stale = command(store);
  store.applyCommand("external", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$input",
    value: "changed",
    expectedRevision: 0,
  });
  let cursor = store.cursor();
  assert.throws(() => store.applyCommand("stale-input", stale), {
    code: "DISPLAY_INPUT_CHANGED",
  });
  assert.equal(receipts(store), 0);
  assert.equal(store.cursor(), cursor);
  const reader = command(store, {
    source: { kind: "view", contentHash: "c".repeat(64) },
    reads: [
      { scope: "chat", chatId: "a", key: "$dependency", expectedRevision: 0 },
    ],
  });
  store.applyCommand(
    "writer",
    command(store, {
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$dependency",
          value: "new",
          expectedRevision: 0,
        },
      ],
    }),
  );
  cursor = store.cursor();
  assert.throws(() => store.applyCommand("stale-read", reader), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(receipts(store), 1);
  assert.equal(store.cursor(), cursor);
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM commands WHERE id IN ('stale-input','stale-read')",
      )
      .get().count,
    0,
  );
});

test("a late multi-key write conflict rolls back earlier writes and restores the event origin", (t) => {
  const store = fixture(t);
  store.applyCommand(
    "prior",
    command(store, {
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$existing",
          value: "Original",
          expectedRevision: 0,
        },
      ],
    }),
  );
  const cursor = store.cursor(),
    clock = store.displayState("a").inputClock;
  assert.throws(
    () =>
      store.applyCommand(
        "bad",
        command(store, {
          codeHash: "c".repeat(64),
          edits: [
            {
              scope: "chat",
              chatId: "a",
              key: "$partial",
              value: "Must not persist",
              expectedRevision: 0,
            },
            {
              scope: "chat",
              chatId: "a",
              key: "$existing",
              value: "Overwrite",
              expectedRevision: 0,
            },
          ],
        }),
      ),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(
    values(store).some((v) => v.key === "$partial"),
    false,
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(receipts(store), 1);
  assert.equal(store.displayEffect, undefined);
  store.applyCommand("external", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$external",
    value: "Synthetic",
    expectedRevision: 0,
  });
  assert.ok(store.displayState("a").inputClock > clock);
});

test("display admission validates bounded shapes, own-chat writes and global/local reads even for an existing occurrence", (t) => {
  const store = fixture(t),
    valid = command(store);
  store.applyCommand("first", valid);
  const cursor = store.cursor(),
    before = values(store);
  const invalid = [
    { reads: [{ scope: "chat", chatId: "b", key: "$x", expectedRevision: 0 }] },
    {
      edits: [{ scope: "global", key: "x", value: "bad", expectedRevision: 0 }],
    },
    { edits: [valid.edits[0], valid.edits[0]] },
    {
      reads: [{ scope: "chat", chatId: "a", key: "$x", expectedRevision: -1 }],
    },
    { source: { ...valid.source, nonce: "bypass" } },
    { codeHash: "bad" },
    { edits: [{ ...valid.edits[0], value: "x".repeat(256 * 1024) }] },
    { edits: [{ ...valid.edits[0], remove: true }] },
    {
      reads: Array.from({ length: 129 }, (_, i) => ({
        scope: "global",
        key: "key" + i,
        expectedRevision: 0,
      })),
    },
  ];
  invalid.forEach((overrides, i) =>
    assert.throws(
      () => store.applyCommand("invalid-" + i, { ...valid, ...overrides }),
      { code: "INVALID_COMMAND" },
    ),
  );
  assert.deepEqual(values(store), before);
  assert.equal(store.cursor(), cursor);
  assert.equal(receipts(store), 1);
  const global = command(store, {
    codeHash: "d".repeat(64),
    reads: [
      { scope: "global", key: "absent", expectedRevision: 0 },
      { scope: "chat-global", chatId: "a", key: "absent", expectedRevision: 0 },
    ],
    edits: [],
  });
  assert.equal(store.applyCommand("valid-reads", global).deduplicated, false);
});

test("canonical source identity and entity incarnations fence edits, other chats and deletion/recreation", (t) => {
  const store = fixture(t);
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: { role: "char", data: "Synthetic" },
  });
  store.applyCommand("foreign-message", {
    type: "append-message",
    chatId: "b",
    messageId: "other",
    message: { role: "char", data: "Synthetic" },
  });
  const base = command(store, {
    source: {
      kind: "message",
      messageId: "m",
      expectedRevision: 1,
      contentHash: "e".repeat(64),
    },
  });
  assert.throws(
    () =>
      store.applyCommand("wrong-chat", {
        ...base,
        source: { ...base.source, messageId: "other" },
      }),
    { code: "NOT_FOUND" },
  );
  assert.throws(
    () =>
      store.applyCommand("wrong-revision", {
        ...base,
        source: { ...base.source, expectedRevision: 2 },
      }),
    { code: "REVISION_CONFLICT" },
  );
  store.applyCommand("effect", base);
  const deleting = store.snapshot("a").chat;
  store.applyCommand("delete", {
    type: "delete-chat",
    chatId: "a",
    expectedRevision: deleting.revision,
    expectedEpoch: deleting.entityEpoch,
  });
  store.applyCommand("recreate", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "New" },
  });
  assert.throws(() => store.applyCommand("aba", base), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(receipts(store), 0);
  assert.equal(values(store).length, 0);
});

test("clocks, receipts and duplicate protection survive journal pruning and reopening SQLite", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-display-")),
    file = join(directory, "state.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = fixture(t, file);
  const cmd = command(store),
    result = store.applyCommand("first", cmd),
    clock = store.displayState("a").inputClock;
  store.pruneChanges(store.cursor());
  assert.equal(store.displayState("a").inputClock, clock);
  store.close();
  store = new EntityStore(file);
  t.after(() => store.close());
  const duplicate = store.applyCommand("after-restart", cmd);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.displayKey, result.displayKey);
  assert.equal(values(store)[0].revision, 1);
  assert.deepEqual(store.displayState("a").applied, [result.displayKey]);
});

test("display receipt pages are bounded, cursor-ordered and limited to the current external input", (t) => {
  const store = fixture(t);
  for (let i = 0; i < 4; i++)
    store.applyCommand(
      "effect-" + i,
      command(store, { codeHash: String(i).repeat(64), edits: [] }),
    );
  const first = store.displayState("a", { limit: 2 }),
    second = store.displayState("a", { limit: 2, after: first.next });
  assert.equal(first.applied.length, 2);
  assert.equal(second.applied.length, 2);
  assert.equal(second.next, null);
  assert.deepEqual([...first.applied, ...second.applied].sort(), [
    ...first.applied,
    ...second.applied,
  ]);
  store.applyCommand("external", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$new",
    value: "input",
    expectedRevision: 0,
  });
  assert.deepEqual(store.displayState("a").applied, []);
  assert.equal(receipts(store), 4);
  assert.throws(() => store.displayState("a", { after: "invalid" }), {
    code: "INVALID_COMMAND",
  });
});

test("schema-eleven migration retains original entities, identity, assets, active jobs and journal while initializing the display boundary", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-display-migrate-")),
    file = join(directory, "state.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = fixture(t, file);
  store.enqueueJob("queued", {
    type: "button",
    chatId: "a",
    data: "Synthetic",
  });
  store.registerAsset({
    id: "a".repeat(64) + ".wav",
    digest: "a".repeat(64),
    extension: "wav",
    mime: "audio/wav",
    byteLength: 44,
  });
  const before = {
    bootstrap: store.bootstrap(),
    snapshot: store.snapshot("a"),
    job: store.getJob("queued"),
    asset: store.getAsset("a".repeat(64) + ".wav"),
  };
  store.db.exec(
    "DROP TABLE display_effects; DROP TABLE display_input_clocks; PRAGMA user_version=11;",
  );
  store.close();
  store = new EntityStore(file);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(store.bootstrap(), before.bootstrap);
  assert.deepEqual(store.snapshot("a"), before.snapshot);
  assert.deepEqual(store.getJob("queued"), before.job);
  assert.deepEqual(store.getAsset("a".repeat(64) + ".wav"), before.asset);
  assert.equal(store.displayState("a").inputClock, before.bootstrap.cursor);
  assert.deepEqual(store.displayState("a").applied, []);
});

test("supplied logical keys are checked before deduplication and every derived journal event carries its input clock", (t) => {
  const store = fixture(t),
    cmd = command(store);
  assert.throws(
    () =>
      store.applyCommand("wrong-key", { ...cmd, displayKey: "0".repeat(64) }),
    (error) => error.code === "INVALID_COMMAND",
  );
  assert.equal(receipts(store), 0);
  assert.equal(values(store).length, 0);
  const result = store.applyCommand("correct-key-first", cmd);
  const key = result.displayKey;
  assert.throws(
    () =>
      store.applyCommand("wrong-key-existing", {
        ...cmd,
        displayKey: "0".repeat(64),
      }),
    (error) => error.code === "INVALID_COMMAND",
  );
  const duplicate = store.applyCommand("correct-key-second", {
    ...cmd,
    displayKey: key,
  });
  assert.equal(duplicate.deduplicated, true);
  const events = store
    .changes(0)
    .changes.filter((event) => event.payload.displayEffectId === key);
  assert.ok(events.length >= 2);
  assert.ok(
    events.every((event) => event.payload.displayInputClock === cmd.inputClock),
  );
  assert.equal(store.displayEffect, undefined);
  assert.equal(store.displayInputClock, undefined);
});
