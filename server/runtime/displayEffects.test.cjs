"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createRuntimeService } = require("./service.cjs");
test("real HTTP/database-worker display admission deduplicates two devices, replays changes and survives restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "risu-http-display-")),
    file = join(directory, "synthetic.sqlite");
  let runtime = await createRuntimeService({ file });
  t.after(async () => {
    await runtime.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  await runtime.store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic HTTP display" },
    chat: { chatId: "a", metadata: { name: "Synthetic" } },
  });
  const serverId = (await runtime.store.call("bootstrap")).serverId;
  const api = async (path, body) => {
    const response = await fetch(runtime.url + "/api/runtime" + path, {
      headers: {
        "risu-runtime-id": serverId,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const before = await api("/chats/a/display");
  assert.equal(before.status, 200);
  const s = before.body,
    command = {
      type: "apply-display-effects",
      chatId: "a",
      expectedChatEpoch: s.chatEpoch,
      expectedCharacterEpoch: s.characterEpoch,
      inputClock: s.inputClock,
      codeHash: "a".repeat(64),
      source: { kind: "view", contentHash: "b".repeat(64) },
      reads: [
        { scope: "chat", chatId: "a", key: "$choice", expectedRevision: 0 },
      ],
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$choice",
          value: "Synthetic selected",
          expectedRevision: 0,
        },
      ],
    };
  const pair = await Promise.all(
    ["device-a", "device-b"].map((requestId) =>
      api("/commands", { requestId, command }),
    ),
  );
  assert.ok(pair.every((result) => result.status === 200));
  assert.equal(pair.filter((result) => result.body.deduplicated).length, 1);
  assert.equal(pair[0].body.displayKey, pair[1].body.displayKey);
  const snapshot = await api("/chats/a");
  assert.equal(snapshot.body.variables[0].value, "Synthetic selected");
  assert.equal(snapshot.body.variables[0].revision, 1);
  const changes = await api("/changes?after=" + s.cursor);
  assert.equal(changes.body.changes.length, 2);
  assert.ok(
    changes.body.changes.every(
      (event) => event.payload.displayEffectId === pair[0].body.displayKey,
    ),
  );
  const clock = await api("/chats/a/display");
  assert.equal(clock.body.inputClock, s.inputClock);
  assert.deepEqual(clock.body.applied, [pair[0].body.displayKey]);
  const bad = await api("/commands", {
    requestId: "stale-input",
    command: {
      ...command,
      codeHash: "c".repeat(64),
      inputClock: s.inputClock - 1,
    },
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, "DISPLAY_INPUT_CHANGED");
  const invalid = await api("/chats/a/display?limit=0");
  assert.equal(invalid.status, 400);
  await runtime.close();
  runtime = await createRuntimeService({ file });
  const retry = await api("/commands", { requestId: "after-restart", command });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal((await api("/chats/a")).body.variables[0].revision, 1);
  assert.equal((await api("/chats/a/display")).body.inputClock, s.inputClock);
});
