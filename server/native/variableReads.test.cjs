"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStoreClient } = require("../entity/client.cjs");
const { NativeScheduler } = require("./scheduler.cjs");

async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error("Synthetic native variable-read timeout");
}
async function fixture(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), "risu-native-variable-reads-"));
  const file = join(root, "state.sqlite");
  const store = new EntityStoreClient(file);
  let scheduler;
  t.after(async () => {
    await scheduler?.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      defaultVariables: "source=captured-default",
      triggerscript: [
        {
          effect: [
            {
              type: "triggerlua",
              code: `
onButtonClick = async(function(id, data)
  local source = ${scenario.read}(id, 'source')
  alertInput(id, 'Synthetic read completed'):await()
  setChatVar(id, 'derived', source)
  addChat(id, 'char', 'derived:' .. source)
  return source
end)`,
            },
          ],
        },
      ],
    },
  });
  for (const chatId of ["a", "b"])
    await store.call("applyCommand", "chat-" + chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: { name: chatId, localLore: [] },
    });
  if (scenario.seed.length)
    await store.call("applyCommand", "seed", {
      type: "change-variables",
      edits: scenario.seed,
    });
  scheduler = new NativeScheduler({ store, file, pollMs: 20 });
  await store.call("enqueueJob", "read-job", {
    type: "button",
    chatId: "a",
    data: "read",
  });
  const interaction = await until(async () => {
    const page = await store.call("listInteractions");
    if (page.items[0]) return page.items[0];
    const job = await store.call("getJob", "read-job");
    if (["failed", "interrupted", "cancelled"].includes(job?.state))
      throw new Error(
        "Job failed before the controlled peer edit: " +
          JSON.stringify(job.result),
      );
  });
  const peer = new EntityStoreClient(file);
  await peer.ready;
  try {
    await peer.call("applyCommand", "peer-edit", {
      type: "change-variables",
      edits: scenario.edit,
    });
    await peer.call("applyCommand", "answer", {
      type: "answer-interaction",
      interactionId: interaction.id,
      expectedRevision: 1,
      answer: "resume",
    });
  } finally {
    await peer.close();
  }
  const job = await until(
    () => store.call("getJob", "read-job"),
    (value) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(value.state),
  );
  return { store, job, snapshot: await store.call("snapshot", "a") };
}
const ordinary = (key, revision, value) => ({
  scope: "chat",
  chatId: "a",
  key,
  expectedRevision: revision,
  value,
});
const local = (key, revision, value) => ({
  scope: "chat-global",
  chatId: "a",
  key,
  expectedRevision: revision,
  value,
});
const global = (key, revision, value) => ({
  scope: "global",
  key,
  expectedRevision: revision,
  value,
});
const scenarios = [
  {
    name: "ordinary variable read changed by a peer",
    read: "getChatVar",
    seed: [ordinary("$source", 0, "before")],
    edit: [ordinary("$source", 1, "after")],
    conflict: true,
  },
  {
    name: "shared global read changed by a peer",
    read: "getGlobalVar",
    seed: [global("source", 0, "before")],
    edit: [global("source", 1, "after")],
    conflict: true,
  },
  {
    name: "absent local pin becomes present after global fallback",
    read: "getGlobalVar",
    seed: [global("source", 0, "before")],
    edit: [local("source", 0, "new-pin")],
    conflict: true,
  },
  {
    name: "empty local pin becomes truthy after global fallback",
    read: "getGlobalVar",
    seed: [global("source", 0, "before"), local("source", 0, "")],
    edit: [local("source", 1, "new-pin")],
    conflict: true,
  },
  {
    name: "missing ordinary value becomes present after default fallback",
    read: "getChatVar",
    seed: [],
    edit: [ordinary("$source", 0, "new-value")],
    conflict: true,
  },
  {
    name: "truthy local pin ignores an unread global edit",
    read: "getGlobalVar",
    seed: [global("source", 0, "before"), local("source", 0, "pinned")],
    edit: [global("source", 1, "after")],
    value: "pinned",
    conflict: false,
  },
  {
    name: "unrelated key edits still merge",
    read: "getGlobalVar",
    seed: [global("source", 0, "before")],
    edit: [global("other", 0, "unrelated"), ordinary("$other", 0, "unrelated")],
    value: "before",
    conflict: false,
  },
];
for (const scenario of scenarios)
  test("actual native Lua: " + scenario.name, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, scenario);
    console.log(
      "variable-read-observation:",
      JSON.stringify({
        scenario: scenario.name,
        state: f.job.state,
        code: f.job.result.code,
        messages: f.snapshot.messages.length,
        derived: f.snapshot.variables.find((v) => v.key === "$derived")?.value,
      }),
    );
    assert.equal(f.job.state, scenario.conflict ? "failed" : "completed");
    if (scenario.conflict) {
      assert.equal(f.job.result.code, "REVISION_CONFLICT");
      assert.ok(f.job.result.uncommitted.writeSet.variableReads.length);
      assert.equal(f.snapshot.messages.length, 0);
      assert.equal(
        f.snapshot.variables.some((v) => v.key === "$derived"),
        false,
      );
      assert.equal(
        f.job.result.uncommitted.result.value,
        scenario.seed.length ? "before" : "captured-default",
      );
    } else {
      assert.equal(
        f.snapshot.messages[0].message.data,
        "derived:" + scenario.value,
      );
      assert.equal(
        f.snapshot.variables.find((v) => v.key === "$derived").value,
        scenario.value,
      );
    }
    for (const edit of scenario.edit) {
      const result = (
        await f.store.call("readVariables", [
          {
            scope: edit.scope,
            ...(edit.chatId ? { chatId: edit.chatId } : {}),
            key: edit.key,
          },
        ])
      ).variables[0];
      assert.equal(result.value, edit.value);
    }
    assert.equal((await f.store.call("snapshot", "b")).messages.length, 0);
  });
