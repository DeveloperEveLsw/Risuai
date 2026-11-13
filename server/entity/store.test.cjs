"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const { EntityStoreClient } = require("./client.cjs");

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-entity-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStore(file, options);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* Some durability tests deliberately close the first connection. */
    }
    rmSync(directory, { recursive: true, force: true });
  });
  seed(store);
  return { store, file };
}

function seed(store) {
  store.applyCommand("character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic", unknownExtension: { retained: true } },
  });
  store.applyCommand("chat-a", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "A", note: "fixture" },
  });
  store.applyCommand("chat-b", {
    type: "create-chat",
    characterId: "c",
    chatId: "b",
    metadata: { name: "B" },
  });
}

const message = (data) => ({ role: "char", data });
const hasCode = (code) => (error) => error.code === code;

test("bootstrap contains summaries, chat data is separate, and message pagination preserves identity", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 12; i++) {
    store.applyCommand(`append-${i}`, {
      type: "append-message",
      chatId: "a",
      messageId: `m-${i}`,
      message: { ...message("text".repeat(1000)), extension: { index: i } },
    });
  }
  const initial = store.bootstrap();
  assert.equal(initial.characters[0].chatCount, 2);
  assert.equal(JSON.stringify(initial).includes("texttext"), false);
  assert.equal(JSON.stringify(initial).includes("unknownExtension"), false);
  const latest = store.snapshot("a", { limit: 5 });
  assert.deepEqual(
    latest.messages.map((m) => m.position),
    [7, 8, 9, 10, 11],
  );
  assert.equal(latest.messages[0].message.chatId, "m-7");
  assert.equal(latest.messages[0].message.extension.index, 7);
  assert.equal(latest.character.definition.unknownExtension.retained, true);
  assert.equal(latest.hasEarlier, true);
  const earlier = store.snapshot("a", { limit: 10, before: 7 });
  assert.deepEqual(
    earlier.messages.map((m) => m.position),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(earlier.hasEarlier, false);
  assert.equal(store.snapshot("b").messages.length, 0);
});

test("retry is durable and key ordering does not create a second command or event", (t) => {
  const { store, file } = fixture(t);
  const command = {
    type: "set-chat-variable",
    chatId: "a",
    key: "$toggle",
    value: true,
  };
  const result = store.applyCommand("retry-me", command);
  store.close();
  const reopened = new EntityStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.applyCommand("retry-me", {
      value: true,
      key: "$toggle",
      chatId: "a",
      type: "set-chat-variable",
    }),
    result,
  );
  assert.equal(reopened.cursor(), result.cursor);
  assert.throws(
    () => reopened.applyCommand("retry-me", { ...command, value: false }),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(reopened.snapshot("a").variables[0].value, true);
});

test("different chats retain independent changes and stale variable or message edits cannot overwrite", (t) => {
  const { store } = fixture(t);
  store.applyCommand("a-var", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$x",
    value: 1,
    expectedRevision: 0,
  });
  store.applyCommand("b-var", {
    type: "set-chat-variable",
    chatId: "b",
    key: "$x",
    value: 2,
    expectedRevision: 0,
  });
  assert.throws(
    () =>
      store.applyCommand("stale-var", {
        type: "set-chat-variable",
        chatId: "a",
        key: "$x",
        value: 3,
        expectedRevision: 0,
      }),
    hasCode("REVISION_CONFLICT"),
  );
  store.applyCommand("a-message", {
    type: "append-message",
    chatId: "a",
    messageId: "edit-me",
    message: message("initial"),
  });
  store.applyCommand("first-edit", {
    type: "edit-message",
    messageId: "edit-me",
    expectedRevision: 1,
    text: "new",
  });
  const cursor = store.cursor();
  assert.throws(
    () =>
      store.applyCommand("stale-edit", {
        type: "edit-message",
        messageId: "edit-me",
        expectedRevision: 1,
        text: "old",
      }),
    hasCode("REVISION_CONFLICT"),
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.snapshot("a").messages[0].message.data, "new");
  assert.equal(store.snapshot("a").variables[0].value, 1);
  assert.equal(store.snapshot("b").variables[0].value, 2);
});

test("invalid relationship and duplicate message roll back the command and journal", (t) => {
  const { store } = fixture(t);
  const cursor = store.cursor();
  assert.throws(() =>
    store.applyCommand("bad-chat", {
      type: "create-chat",
      characterId: "missing",
      chatId: "orphan",
      metadata: {},
    }),
  );
  assert.equal(store.cursor(), cursor);
  store.applyCommand("bad-chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "orphan",
    metadata: {},
  });
  store.applyCommand("m1", {
    type: "append-message",
    chatId: "a",
    messageId: "unique",
    message: message("first"),
  });
  const before = store.cursor();
  assert.throws(() =>
    store.applyCommand("m2", {
      type: "append-message",
      chatId: "b",
      messageId: "unique",
      message: message("second"),
    }),
  );
  assert.equal(store.cursor(), before);
  assert.equal(store.snapshot("b").messages.length, 0);
});

test("a snapshot cursor closes the snapshot/replay gap and expired history demands resync", (t) => {
  const { store } = fixture(t);
  const snapshot = store.snapshot("a");
  store.applyCommand("later", {
    type: "append-message",
    chatId: "a",
    messageId: "later",
    message: message("after snapshot"),
  });
  const replay = store.changes(snapshot.cursor, 1);
  assert.equal(replay.changes.length, 1);
  assert.equal(replay.changes[0].payload.message.data, "after snapshot");
  assert.equal(replay.cursor, replay.head);
  assert.equal(store.changes(replay.cursor).changes.length, 0);
  store.pruneChanges(replay.cursor);
  assert.throws(
    () => store.changes(snapshot.cursor),
    hasCode("RESYNC_REQUIRED"),
  );
  store.applyCommand("newer", {
    type: "set-chat-variable",
    chatId: "b",
    key: "new",
    value: false,
  });
  assert.equal(
    store.changes(replay.cursor).changes[0].sequence,
    replay.cursor + 1,
  );
});

test("same-chat jobs are ordered while another chat can run, and a later turn sees completed output", (t) => {
  const { store } = fixture(t);
  store.enqueueJob("a1", { type: "send", chatId: "a", input: "first" });
  store.enqueueJob("a2", { type: "send", chatId: "a", input: "second" });
  store.enqueueJob("b1", { type: "send", chatId: "b", input: "other" });
  const first = store.claimJob("worker-1");
  const other = store.claimJob("worker-2");
  assert.equal(first.job.id, "a1");
  assert.equal(other.job.id, "b1");
  assert.equal(store.claimJob("worker-3"), null);
  assert.throws(
    () =>
      store.applyCommand("during", {
        type: "set-chat-variable",
        chatId: "a",
        key: "x",
        value: true,
      }),
    hasCode("CHAT_BUSY"),
  );
  store.finishJob("a1", "worker-1", first.job.fence, {
    state: "completed",
    messages: [{ id: "reply-1", message: message("first completed") }],
    variables: [{ key: "turn", value: 1 }],
  });
  const second = store.claimJob("worker-3");
  assert.equal(second.job.id, "a2");
  assert.equal(second.snapshot.messages[0].message.data, "first completed");
  assert.equal(second.snapshot.variables[0].value, 1);
  assert.equal(store.getJob("b1").state, "running");
});

test("final messages, variables, job completion and journal either commit together or all roll back", (t) => {
  const { store } = fixture(t);
  store.enqueueJob("atomic", { type: "send", chatId: "a" });
  const claimed = store.claimJob("worker");
  const cursor = store.cursor();
  const bad = {
    state: "completed",
    messages: [
      { id: "duplicate", message: message("one") },
      { id: "duplicate", message: message("two") },
    ],
    variables: [{ key: "committed", value: true }],
  };
  assert.throws(() =>
    store.finishJob("atomic", "worker", claimed.job.fence, bad),
  );
  assert.equal(store.getJob("atomic").state, "running");
  assert.equal(store.snapshot("a").messages.length, 0);
  assert.equal(store.snapshot("a").variables.length, 0);
  assert.equal(store.cursor(), cursor);
  store.finishJob("atomic", "worker", claimed.job.fence, {
    state: "completed",
    messages: [{ id: "reply", message: message("done") }],
    variables: [{ key: "committed", value: true }],
  });
  assert.equal(store.getJob("atomic").state, "completed");
  assert.deepEqual(
    store.changes(cursor).changes.map((c) => c.type),
    ["message", "variable", "job"],
  );
});

test("expired workers cannot heartbeat or save and an interrupted provider job is not rerun", (t) => {
  let now = 1000;
  const { store } = fixture(t, { now: () => now });
  store.enqueueJob("expired", { type: "send", chatId: "a" });
  store.enqueueJob("next", { type: "send", chatId: "a" });
  const first = store.claimJob("old", 50);
  now += 51;
  assert.throws(
    () => store.heartbeat(first.job.id, "old", first.job.fence),
    hasCode("STALE_WORKER"),
  );
  assert.throws(
    () =>
      store.finishJob(first.job.id, "old", first.job.fence, {
        state: "completed",
      }),
    hasCode("STALE_WORKER"),
  );
  assert.equal(store.claimJob("new").job.id, "next");
  assert.equal(store.getJob("expired").state, "interrupted");
  assert.equal(
    store.enqueueJob("expired", { type: "send", chatId: "a" }).state,
    "interrupted",
  );
});

test("queued cancellation is durable; running cancellation needs worker acknowledgement", (t) => {
  const { store } = fixture(t);
  store.enqueueJob("queued-cancel", { type: "send", chatId: "a" });
  assert.equal(store.requestCancel("queued-cancel").state, "cancelled");
  assert.equal(store.claimJob("worker"), null);
  store.enqueueJob("running-cancel", { type: "send", chatId: "a" });
  const claimed = store.claimJob("worker");
  const requested = store.requestCancel("running-cancel");
  assert.equal(requested.state, "running");
  assert.equal(requested.cancelRequested, true);
  assert.throws(
    () =>
      store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
        state: "completed",
      }),
    hasCode("CANCEL_REQUESTED"),
  );
  store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
    state: "cancelled",
  });
  assert.equal(store.getJob("running-cancel").state, "cancelled");
});

test("resource revisions and unknown extension fields survive independent updates", (t) => {
  const { store } = fixture(t);
  const module = {
    id: "module",
    regex: [],
    unknownExtension: { a: [1, true] },
  };
  store.applyCommand("module", {
    type: "put-resource",
    kind: "module",
    resourceId: "module",
    expectedRevision: 0,
    payload: module,
  });
  store.applyCommand("preset", {
    type: "put-resource",
    kind: "preset",
    resourceId: "preset",
    expectedRevision: 0,
    payload: { temperature: 70 },
  });
  assert.deepEqual(store.getResource("module", "module").payload, module);
  assert.throws(
    () =>
      store.applyCommand("stale-resource", {
        type: "put-resource",
        kind: "module",
        resourceId: "module",
        expectedRevision: 0,
        payload: {},
      }),
    hasCode("REVISION_CONFLICT"),
  );
  assert.equal(store.getResource("preset", "preset").revision, 1);
});

test("real database workers share durable commands and concurrent appends without duplicate positions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-workers-"));
  const file = join(directory, "worker.sqlite");
  const first = new EntityStoreClient(file);
  const second = new EntityStoreClient(file);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    rmSync(directory, { recursive: true, force: true });
  });
  await first.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Worker fixture" },
  });
  await first.call("applyCommand", "chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: {},
  });
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? first : second).call("applyCommand", `append-${i}`, {
        type: "append-message",
        chatId: "a",
        messageId: `m-${i}`,
        message: message(`synthetic ${i}`),
      }),
    ),
  );
  assert.equal(new Set(results.map((r) => r.position)).size, 30);
  const command = { type: "send", chatId: "a", input: "durable request" };
  const jobs = await Promise.all([
    first.call("enqueueJob", "same-request", command),
    second.call("enqueueJob", "same-request", command),
  ]);
  assert.equal(jobs[0].id, jobs[1].id);
  const snapshot = await second.call("snapshot", "a");
  assert.equal(snapshot.messages.length, 30);
  const contenders = await Promise.all([
    first.call("claimJob", "one"),
    second.call("claimJob", "two"),
  ]);
  assert.equal(contenders.filter(Boolean).length, 1);
});

test("durable queued jobs survive closing every client and are claimable on a new process connection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-disconnect-"));
  const file = join(directory, "worker.sqlite");
  const client = new EntityStoreClient(file);
  await client.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Disconnect fixture" },
  });
  await client.call("applyCommand", "chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: {},
  });
  await client.call("enqueueJob", "accepted", {
    type: "send",
    chatId: "a",
    input: "fixture",
  });
  await client.close();
  const resumed = new EntityStoreClient(file);
  t.after(async () => {
    await resumed.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = await resumed.call("claimJob", "resumed");
  assert.equal(job.job.id, "accepted");
  await assert.rejects(() => client.call("bootstrap"), hasCode("STORE_CLOSED"));
});

test("server job execution reads the complete history while browser snapshots remain paginated", (t) => {
  const { store } = fixture(t);
  store.transaction(() => {
    for (let i = 0; i < 1005; i++)
      store.appendMessage("a", `history-${i}`, message(`turn ${i}`));
  });
  store.enqueueJob("full-context", { type: "send", chatId: "a" });
  const claimed = store.claimJob("worker");
  assert.equal(claimed.snapshot.messages.length, 1005);
  assert.equal(claimed.snapshot.messages[0].message.data, "turn 0");
  assert.equal(claimed.snapshot.messages.at(-1).message.data, "turn 1004");
  assert.equal(claimed.snapshot.hasEarlier, false);
  const browser = store.snapshot("a", { limit: 10000 });
  assert.equal(browser.messages.length, 1000);
  assert.equal(browser.hasEarlier, true);
});

test("job settings, modules and presets are captured with their revisions in the claim transaction", (t) => {
  const { store } = fixture(t);
  for (const kind of ["settings", "module", "preset"]) {
    store.applyCommand(`resource-${kind}`, {
      type: "put-resource",
      kind,
      resourceId: "fixture",
      expectedRevision: 0,
      payload: { name: `${kind} original`, extension: { retained: true } },
    });
  }
  store.enqueueJob("pinned", { type: "send", chatId: "a" });
  const claimed = store.claimJob("worker");
  store.applyCommand("later-settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "fixture",
    expectedRevision: 1,
    payload: { name: "later settings" },
  });
  const settings = claimed.snapshot.resources.find(
    (r) => r.kind === "settings",
  );
  assert.equal(settings.revision, 1);
  assert.equal(settings.payload.name, "settings original");
  assert.equal(store.getResource("settings", "fixture").revision, 2);
  assert.equal(claimed.snapshot.resources.length, 3);
});

test("non-JSON command values are rejected before their hash can collide with a different payload", (t) => {
  const { store } = fixture(t);
  const cursor = store.cursor();
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    [, 1],
  ]) {
    assert.throws(
      () =>
        store.applyCommand("invalid-json", {
          type: "create-character",
          characterId: "invalid",
          definition: { value },
        }),
      hasCode("INVALID_COMMAND"),
    );
    assert.equal(store.cursor(), cursor);
  }
  store.applyCommand("invalid-json", {
    type: "create-character",
    characterId: "valid",
    definition: { value: null },
  });
  store.enqueueJob("job-command", { type: "send", chatId: "a" });
  assert.throws(
    () => store.applyCommand("job-command", { type: "send", chatId: "a" }),
    hasCode("INVALID_COMMAND"),
  );
  assert.equal(store.getJob("job-command").state, "queued");
});

test("simultaneous close calls share one shutdown and reject new work while it is closing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-close-"));
  const client = new EntityStoreClient(join(directory, "state.sqlite"));
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.ready;
  const first = client.close();
  const second = client.close();
  assert.equal(first, second);
  await assert.rejects(() => client.call("bootstrap"), hasCode("STORE_CLOSED"));
  await Promise.all([first, second]);
  await assert.rejects(() => client.call("bootstrap"), hasCode("STORE_CLOSED"));
  assert.equal(client.failure, null);
});

test("a job atomically commits message edits, deletions, order, metadata, variables and shared definitions", (t) => {
  const { store } = fixture(t);
  for (const [messageId, data] of [
    ["old", "before"],
    ["remove", "gone"],
  ])
    store.applyCommand(messageId, {
      type: "append-message",
      chatId: "a",
      messageId,
      message: { ...message(data), extension: { kept: true } },
    });
  store.applyCommand("variable", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$remove",
    value: "old",
  });
  store.applyCommand("module", {
    type: "put-resource",
    kind: "module",
    resourceId: "mod",
    expectedRevision: 0,
    payload: { name: "before" },
  });
  store.enqueueJob("tracked", { type: "button", chatId: "a" });
  const { job, snapshot } = store.claimJob("worker");
  const writes = {
    chatId: "a",
    expectedRevision: snapshot.chat.revision,
    metadata: { ...snapshot.chat.metadata, note: "updated" },
    characters: [
      {
        id: "c",
        expectedRevision: 1,
        definition: { ...snapshot.character.definition, name: "Updated" },
      },
    ],
    messages: [
      {
        id: "old",
        expectedRevision: 1,
        message: { ...snapshot.messages[0].message, data: "edited" },
      },
      { id: "new", expectedRevision: 0, message: message("added") },
    ],
    deleteMessages: [{ id: "remove", expectedRevision: 1 }],
    messageOrder: ["new", "old"],
    variables: [{ key: "$new", value: "yes", expectedRevision: 0 }],
    deleteVariables: [{ key: "$remove", expectedRevision: 1 }],
    resources: [
      {
        kind: "module",
        id: "mod",
        expectedRevision: 1,
        payload: { name: "after" },
      },
    ],
  };
  const cursor = store.cursor();
  store.finishJob(job.id, "worker", job.fence, {
    state: "completed",
    writeSet: writes,
    result: { action: "fixture" },
  });
  const final = store.snapshot("a");
  assert.deepEqual(
    final.messages.map((m) => m.id),
    ["new", "old"],
  );
  assert.equal(final.messages[1].message.data, "edited");
  assert.equal(final.messages[1].message.extension.kept, true);
  assert.equal(final.chat.metadata.note, "updated");
  assert.equal(final.character.definition.unknownExtension.retained, true);
  assert.deepEqual(
    final.variables.map((v) => v.key),
    ["$new"],
  );
  assert.equal(final.deletedVariables[0].revision, 2);
  assert.equal(store.getResource("module", "mod").payload.name, "after");
  assert.equal(store.snapshot("b").messages.length, 0);
  const events = store.changes(cursor).changes;
  assert.equal(events.at(-1).type, "job");
  assert.equal(events.at(-1).payload.state, "completed");
  assert.ok(events.some((e) => e.type === "message-order"));
});

test("a shared-resource conflict rolls back every earlier job write and preserves the generated result separately", (t) => {
  const { store } = fixture(t);
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: message("before"),
  });
  store.applyCommand("global", {
    type: "put-resource",
    kind: "global-variable",
    resourceId: "x",
    expectedRevision: 0,
    payload: "before",
  });
  store.enqueueJob("conflicting", { type: "send", chatId: "a" });
  const { job, snapshot } = store.claimJob("worker");
  store.applyCommand("outside-change", {
    type: "put-resource",
    kind: "global-variable",
    resourceId: "x",
    expectedRevision: 1,
    payload: "outside",
  });
  const cursor = store.cursor();
  assert.throws(
    () =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: {
          chatId: "a",
          expectedRevision: snapshot.chat.revision,
          messages: [
            { id: "m", expectedRevision: 1, message: message("generated") },
          ],
          variables: [{ key: "$x", value: "generated", expectedRevision: 0 }],
          resources: [
            {
              kind: "global-variable",
              id: "x",
              expectedRevision: 1,
              payload: "generated",
            },
          ],
        },
      }),
    hasCode("REVISION_CONFLICT"),
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.getJob(job.id).state, "running");
  assert.equal(store.snapshot("a").messages[0].message.data, "before");
  assert.equal(store.snapshot("a").variables.length, 0);
  store.finishJob(job.id, "worker", job.fence, {
    state: "failed",
    result: { conflict: true, uncommittedOutput: "generated" },
  });
  assert.equal(store.getJob(job.id).result.uncommittedOutput, "generated");
  assert.equal(store.getResource("global-variable", "x").payload, "outside");
});

test("deleting and recreating variables, resources and messages never resets their revisions", (t) => {
  const { store } = fixture(t);
  store.applyCommand("variable", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$x",
    value: "first",
    expectedRevision: 0,
  });
  store.applyCommand("resource", {
    type: "put-resource",
    kind: "module",
    resourceId: "x",
    payload: { name: "first" },
    expectedRevision: 0,
  });
  store.applyCommand("message", {
    type: "append-message",
    chatId: "a",
    messageId: "x",
    message: message("first"),
  });
  store.enqueueJob("delete", { type: "button", chatId: "a" });
  let claim = store.claimJob("worker");
  store.finishJob(claim.job.id, "worker", claim.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: claim.snapshot.chat.revision,
      deleteMessages: [{ id: "x", expectedRevision: 1 }],
      deleteVariables: [{ key: "$x", expectedRevision: 1 }],
      deleteResources: [{ kind: "module", id: "x", expectedRevision: 1 }],
    },
  });
  assert.equal(store.getResource("module", "x"), null);
  assert.equal(
    store.bootstrap().resources.find((r) => r.id === "x").revision,
    2,
  );
  store.enqueueJob("restore", { type: "button", chatId: "a" });
  claim = store.claimJob("worker");
  assert.equal(claim.snapshot.deletedResources[0].revision, 2);
  store.finishJob(claim.job.id, "worker", claim.job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: claim.snapshot.chat.revision,
      messages: [
        { id: "x", expectedRevision: 2, message: message("restored") },
      ],
      variables: [{ key: "$x", expectedRevision: 2, value: "restored" }],
      resources: [
        {
          kind: "module",
          id: "x",
          expectedRevision: 2,
          payload: { name: "restored" },
        },
      ],
    },
  });
  assert.equal(store.snapshot("a").messages[0].revision, 3);
  assert.equal(store.snapshot("a").variables[0].revision, 3);
  assert.equal(store.getResource("module", "x").revision, 3);
  assert.throws(
    () =>
      store.applyCommand("stale-var", {
        type: "set-chat-variable",
        chatId: "a",
        key: "$x",
        expectedRevision: 1,
        value: "stale",
      }),
    hasCode("REVISION_CONFLICT"),
  );
  assert.throws(
    () =>
      store.applyCommand("stale-msg", {
        type: "edit-message",
        messageId: "x",
        expectedRevision: 1,
        text: "stale",
      }),
    hasCode("REVISION_CONFLICT"),
  );
  assert.throws(
    () =>
      store.applyCommand("stale-resource", {
        type: "put-resource",
        kind: "module",
        resourceId: "x",
        expectedRevision: 1,
        payload: { name: "stale" },
      }),
    hasCode("REVISION_CONFLICT"),
  );
});

test("an invalid job write cannot edit another chat or silently submit an unknown field", (t) => {
  const { store } = fixture(t);
  store.applyCommand("foreign", {
    type: "append-message",
    chatId: "b",
    messageId: "foreign",
    message: message("private to B"),
  });
  store.enqueueJob("bounded", { type: "button", chatId: "a" });
  const { job, snapshot } = store.claimJob("worker");
  const cursor = store.cursor();
  assert.throws(
    () =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: {
          chatId: "a",
          expectedRevision: snapshot.chat.revision,
          messages: [
            {
              id: "foreign",
              expectedRevision: 1,
              message: message("wrong target"),
            },
          ],
        },
      }),
    hasCode("INVALID_COMMAND"),
  );
  assert.throws(
    () =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: {
          chatId: "a",
          expectedRevision: snapshot.chat.revision,
          untrackedState: {},
        },
      }),
    hasCode("INVALID_COMMAND"),
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.snapshot("b").messages[0].message.data, "private to B");
});

test("an out-of-band chat edit cannot prevent reporting an uncommitted result or cancellation", (t) => {
  const { store } = fixture(t);
  for (const [chatId, terminal] of [
    ["a", "failed"],
    ["b", "cancelled"],
  ]) {
    store.enqueueJob(`conflict-${chatId}`, { type: "send", chatId });
    const { job } = store.claimJob("worker");
    // Ordinary chat commands remain locked during a job. Maintenance/migration writes
    // or a future independently admitted operation can still invalidate its snapshot.
    store.transaction(() => store.setVariable(chatId, "$choice", "outside", 0));
    assert.throws(
      () =>
        store.finishJob(job.id, "worker", job.fence, {
          state: "completed",
          messages: [{ id: `result-${chatId}`, message: message("generated") }],
        }),
      hasCode("REVISION_CONFLICT"),
    );
    const done = store.finishJob(job.id, "worker", job.fence, {
      state: terminal,
      result: { uncommittedOutput: "generated", conflict: true },
    });
    assert.equal(done.job.state, terminal);
    assert.equal(done.job.result.uncommittedOutput, "generated");
    assert.equal(store.snapshot(chatId).messages.length, 0);
    assert.equal(store.snapshot(chatId).variables[0].value, "outside");
    assert.equal(store.claimJob("worker"), null);
  }
});

test("schema version one migrates without changing previously stored data", (t) => {
  const { store, file } = fixture(t);
  store.applyCommand("v1-data", {
    type: "set-chat-variable",
    chatId: "a",
    key: "$x",
    value: "retained",
  });
  store.db.exec("DROP TABLE entity_tombstones; PRAGMA user_version=1;");
  store.close();
  const migrated = new EntityStore(file);
  t.after(() => migrated.close());
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    22,
  );
  assert.equal(migrated.snapshot("a").variables[0].value, "retained");
  assert.equal(
    migrated.snapshot("a").character.definition.unknownExtension.retained,
    true,
  );
});
