"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStoreClient } = require("../entity/client.cjs");
const { NativeScheduler } = require("./scheduler.cjs");
const { DatabaseSync } = require("node:sqlite");
async function until(read, predicate = (value) => !!value) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error("Synthetic interaction wait timed out");
}
async function fixture(t, code, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "risu-native-interactions-")),
    file = join(root, "state.sqlite");
  const store = new EntityStoreClient(file);
  let scheduler;
  t.after(async () => {
    await scheduler?.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.call("applyCommand", "c", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      triggerscript: [{ effect: [{ type: "triggerlua", code }] }],
    },
  });
  for (const id of ["a", "b", "c", "d"])
    await store.call("applyCommand", "chat-" + id, {
      type: "create-chat",
      chatId: id,
      characterId: "c",
      metadata: { name: id, localLore: [] },
    });
  scheduler = new NativeScheduler({
    store,
    file,
    pollMs: 20,
    concurrency: 1,
    interactionCapacity: 2,
    ...options,
  });
  let admitted;
  return {
    store,
    file,
    scheduler,
    start: (id, chatId = "a", data = "ask") => {
      admitted = id;
      return store.call("enqueueJob", id, { type: "button", chatId, data });
    },
    pending: async () =>
      until(async () => {
        const page = await store.call("listInteractions");
        if (page.items[0])
          return (await store.call("readInteraction", page.items[0].id))
            .interaction;
        const job = await store.call("getJob", admitted);
        if (["failed", "cancelled", "interrupted"].includes(job?.state))
          throw new Error(
            "Native job ended before interaction: " +
              JSON.stringify(job.result),
          );
      }),
    answer: (id, value) =>
      store.call("applyCommand", "answer-" + id, {
        type: "answer-interaction",
        interactionId: id,
        expectedRevision: 1,
        answer: value,
      }),
    terminal: (id) =>
      until(
        () => store.call("getJob", id),
        (j) =>
          ["completed", "failed", "cancelled", "interrupted"].includes(j.state),
      ),
  };
}
test(
  "original awaited Lua input/select/confirm returns strings and booleans and commits one final state while a live VM survives observer close",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick = async(function(id, data)
    local name=alertInput(id, 'Synthetic input'):await()
    local choice=alertSelect(id, {'alpha','beta'}):await()
    local accepted=alertConfirm(id, 'Synthetic confirmation'):await()
    setChatVar(id,'input',name)
    setChatVar(id,'choice',choice)
    setChatVar(id,'confirmed',tostring(accepted))
    return name .. ':' .. choice .. ':' .. tostring(accepted)
  end)`,
    );
    await f.start("three-prompts");
    const input = await f.pending();
    assert.equal(input.kind, "input");
    const observer = new EntityStoreClient(f.file);
    await observer.ready;
    await observer.close();
    assert.equal((await f.store.call("snapshot", "a")).variables.length, 0);
    await f.answer(input.id, "한글");
    const select = await f.pending();
    assert.equal(select.kind, "select");
    assert.deepEqual(select.descriptor.options, ["alpha", "beta"]);
    await f.answer(select.id, "1");
    const confirm = await f.pending();
    assert.equal(confirm.kind, "confirm");
    await f.answer(confirm.id, false);
    const done = await f.terminal("three-prompts");
    assert.equal(done.state, "completed");
    assert.equal(done.result.value, "한글:1:false");
    const saved = await f.store.call("snapshot", "a");
    assert.equal(
      saved.variables.find((v) => v.key === "$confirmed").value,
      "false",
    );
    assert.equal((await f.store.call("listInteractions")).count, 0);
  },
);
test(
  "two waiting VMs release a single execution slot for another chat; resumes honor the CPU bound and same-chat order",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick = async(function(id, data)
    if data=='fast' then return 'fast' end
    if data=='busy' then
      local started=os.clock()
      while os.clock()-started<1.2 do end
      return 'busy'
    end
    local value=alertInput(id, 'Synthetic ' .. data):await()
    return value
  end)`,
    );
    await f.start("waiting-a", "a", "a");
    await until(
      () => f.store.call("listInteractions"),
      (p) => p.count === 1,
    );
    await f.start("same-a-next", "a", "fast");
    await f.start("waiting-b", "b", "b");
    await until(
      () => f.store.call("listInteractions"),
      (p) => p.count === 2,
    );
    await f.start("fast-c", "c", "fast");
    assert.equal((await f.terminal("fast-c")).state, "completed");
    assert.equal((await f.store.call("getJob", "same-a-next")).state, "queued");
    assert.equal(f.scheduler.running.size <= 3, true);
    const pending = (await f.store.call("listInteractions")).items;
    await f.start("busy-d", "d", "busy");
    await until(() => f.scheduler.running.get("busy-d")?.executing);
    await Promise.all(pending.map((p) => f.answer(p.id, "shared")));
    await until(() =>
      pending.every((p) => f.scheduler.running.get(p.jobId)?.resumeRequested),
    );
    assert.equal(
      [...f.scheduler.running.values()].filter((entry) => !entry.waiting)
        .length,
      1,
    );
    assert.equal((await f.terminal("busy-d")).result.value, "busy");
    assert.equal((await f.terminal("waiting-a")).result.value, "shared");
    assert.equal((await f.terminal("waiting-b")).result.value, "shared");
    assert.equal((await f.terminal("same-a-next")).result.value, "fast");
  },
);
test(
  "cancellation of an awaited original Lua call closes its prompt and commits no partial chat variables",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick = async(function(id, data)
    setChatVar(id,'must-not-save','before input')
    local value=alertInput(id, 'Synthetic cancellation'):await()
    return value
  end)`,
    );
    await f.start("cancelled");
    const pending = await f.pending();
    await f.store.call("requestCancel", "cancelled");
    f.scheduler.cancel("cancelled");
    assert.equal((await f.terminal("cancelled")).state, "cancelled");
    assert.equal(
      (await f.store.call("readInteraction", pending.id)).interaction.state,
      "closed",
    );
    assert.equal((await f.store.call("snapshot", "a")).variables.length, 0);
    await assert.rejects(f.answer(pending.id, "late"), {
      code: "INTERACTION_CLOSED",
    });
  },
);
test(
  "waiting process capacity is bounded and an answer can resume an existing VM even when new admission is full",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick=async(function(id,data)
    if data=='fast' then return 'fast' end
    return alertInput(id,'Synthetic capacity'):await()
  end)`,
      { interactionCapacity: 1 },
    );
    await f.start("wait-a", "a");
    await until(
      () => f.store.call("listInteractions"),
      (p) => p.count === 1,
    );
    await f.start("wait-b", "b");
    await until(
      () => f.store.call("listInteractions"),
      (p) => p.count === 2,
    );
    await until(() =>
      [...f.scheduler.running.values()].every((entry) => entry.waiting),
    );
    await f.start("queued-c", "c", "fast");
    await f.scheduler.pump();
    assert.equal(f.scheduler.running.size, 2);
    assert.equal((await f.store.call("getJob", "queued-c")).state, "queued");
    const first = (await f.store.call("listInteractions")).items[0];
    await f.answer(first.id, "resume");
    assert.equal((await f.terminal(first.jobId)).result.value, "resume");
    assert.equal((await f.terminal("queued-c")).result.value, "fast");
  },
);
test(
  "an actual interaction INSERT failure rejects awaited Lua and rolls back its earlier canonical changes",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick=async(function(id,data)
    setChatVar(id,'must-not-save','before failing publication')
    return alertInput(id,'Synthetic DB failure'):await()
  end)`,
    );
    const inject = new DatabaseSync(f.file);
    inject.exec(
      "CREATE TRIGGER synthetic_interaction_failure BEFORE INSERT ON job_interactions BEGIN SELECT RAISE(ABORT,'Synthetic interaction publication failure'); END;",
    );
    inject.close();
    await f.start("failed-publication");
    const done = await f.terminal("failed-publication");
    assert.equal(done.state, "failed");
    assert.match(
      done.result.message,
      /Synthetic interaction publication failure/,
    );
    assert.equal((await f.store.call("snapshot", "a")).variables.length, 0);
    assert.equal((await f.store.call("listInteractions")).count, 0);
  },
);
test(
  "actual waiting process loss closes the durable prompt without reconstructing Lua or saving its earlier effects",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `onButtonClick = async(function(id, data)
    setChatVar(id,'must-not-save','before input')
    return alertInput(id, 'Synthetic worker loss'):await()
  end)`,
    );
    await f.start("killed");
    const pending = await f.pending();
    await f.scheduler.running.get("killed").worker.terminate();
    assert.equal((await f.terminal("killed")).state, "interrupted");
    const reopened = new EntityStoreClient(f.file);
    try {
      assert.equal(
        (await reopened.call("readInteraction", pending.id)).interaction.state,
        "closed",
      );
      assert.equal((await reopened.call("listInteractions")).count, 0);
      assert.equal((await reopened.call("snapshot", "a")).variables.length, 0);
      assert.equal((await reopened.call("listJobs", "a")).length, 1);
    } finally {
      await reopened.close();
    }
  },
);
test(
  "unawaited interactive Lua explicitly fails rather than saving partial state or a recoverable incomplete result",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `function onButtonClick(id, data)
    setChatVar(id,'must-not-save','before input')
    alertInput(id,'Synthetic unawaited')
    return 'incomplete'
  end`,
    );
    await f.start("unawaited");
    const done = await f.terminal("unawaited");
    assert.equal(done.state, "failed");
    assert.match(done.result.message, /await|Interactive/);
    assert.equal(done.result.uncommitted, undefined);
    assert.equal((await f.store.call("snapshot", "a")).variables.length, 0);
    assert.equal((await f.store.call("listInteractions")).count, 0);
  },
);
