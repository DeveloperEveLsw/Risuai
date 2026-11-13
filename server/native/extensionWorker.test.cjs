"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Worker } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStoreClient } = require("../entity/client.cjs");

async function fixture(t, code) {
  const directory = mkdtempSync(join(tmpdir(), "risu-native-")),
    file = join(directory, "state.sqlite");
  const store = new EntityStoreClient(file);
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      unknownExtension: { retained: true },
      triggerscript: [{ effect: [{ type: "triggerlua", code }] }],
    },
  });
  for (const chatId of ["a", "b"])
    await store.call("applyCommand", `chat-${chatId}`, {
      type: "create-chat",
      chatId,
      characterId: "c",
      metadata: { name: chatId, localLore: [] },
    });
  return { store, file };
}
function start(t, file, claimed) {
  const worker = new Worker(join(__dirname, "extensionWorker.cjs"), {
    workerData: { file, claimed },
  });
  t.after(() => worker.terminate());
  let resolveExecuting, rejectExecuting, resolveDone, rejectDone;
  const executing = new Promise((resolve, reject) => {
    resolveExecuting = resolve;
    rejectExecuting = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  executing.catch(() => {});
  done.catch(() => {});
  worker.on("message", (message) => {
    if (message.executing) resolveExecuting();
    if (message.completed) resolveDone(message.completed);
    if (message.error) {
      const error = new Error(message.error.message);
      rejectExecuting(error);
      rejectDone(error);
    }
  });
  worker.on("error", (error) => {
    rejectExecuting(error);
    rejectDone(error);
  });
  worker.on("exit", (code) => {
    if (code) {
      const error = new Error(`Engine worker exited (${code})`);
      rejectExecuting(error);
      rejectDone(error);
    }
  });
  return { worker, executing, done };
}

test("a real native Lua job commits after the admitting client closes and retains message/variable identity", async (t) => {
  const { store, file } = await fixture(
    t,
    `
function onButtonClick(id, data)
  setChatVar(id, 'choice', data)
  setState(id, 'selection', { value = data })
  addChat(id, 'char', 'button:' .. data)
  return data
end`,
  );
  await store.call("enqueueJob", "button", {
    type: "button",
    chatId: "a",
    data: "one",
  });
  const claimed = await store.call("claimJob", "engine");
  const run = start(t, file, claimed);
  await run.executing;
  await store.close();
  const finished = await run.done;
  assert.equal(finished.state, "completed");
  assert.equal(finished.result.value, "one");
  const observer = new EntityStoreClient(file);
  t.after(() => observer.close());
  const saved = await observer.call("snapshot", "a");
  assert.equal(saved.messages[0].message.data, "button:one");
  assert.equal(saved.messages[0].message.chatId, saved.messages[0].id);
  assert.equal(saved.variables.find((v) => v.key === "$choice").value, "one");
  assert.deepEqual(
    JSON.parse(saved.variables.find((v) => v.key === "$__selection").value),
    { value: "one" },
  );
  assert.equal((await observer.call("snapshot", "b")).messages.length, 0);
  assert.equal((await observer.call("getJob", "button")).state, "completed");
  await observer.close();
});

test("CPU work in the engine leaves the separate database worker available before the script finishes", async (t) => {
  const { store, file } = await fixture(
    t,
    `
function onButtonClick(id, data)
  local started = os.clock()
  while os.clock() - started < 0.8 do end
  setChatVar(id, 'choice', data)
  return data
end`,
  );
  await store.call("enqueueJob", "heavy", {
    type: "button",
    chatId: "a",
    data: "heavy",
  });
  const claimed = await store.call("claimJob", "engine");
  const run = start(t, file, claimed);
  await run.executing;
  await store.call("applyCommand", "other-chat-toggle", {
    type: "set-chat-variable",
    chatId: "b",
    key: "$choice",
    value: "immediate",
    expectedRevision: 0,
  });
  assert.equal((await store.call("getJob", "heavy")).state, "running");
  assert.equal(
    (await store.call("snapshot", "b")).variables[0].value,
    "immediate",
  );
  assert.equal((await run.done).state, "completed");
});

test(
  "a cancellation during native execution commits no partial Lua state",
  { timeout: 10000 },
  async (t) => {
    const { store, file } = await fixture(
      t,
      `
function onButtonClick(id, data)
  setChatVar(id, 'choice', 'temporary')
  local started = os.clock()
  while os.clock() - started < 0.8 do end
  addChat(id, 'char', 'must not save')
end`,
    );
    await store.call("enqueueJob", "cancel", {
      type: "button",
      chatId: "a",
      data: "cancel",
    });
    const claimed = await store.call("claimJob", "engine");
    const run = start(t, file, claimed);
    await run.executing;
    await store.call("requestCancel", "cancel");
    assert.equal((await run.done).state, "cancelled");
    const saved = await store.call("snapshot", "a");
    assert.equal(saved.variables.length, 0);
    assert.equal(saved.messages.length, 0);
  },
);

test(
  "an unawaited interactive capability fails the native job without saving earlier Lua effects",
  { timeout: 10000 },
  async (t) => {
    const { store, file } = await fixture(
      t,
      `
function onButtonClick(id, data)
  setChatVar(id, 'choice', 'temporary')
  alertInput(id, 'synthetic interaction')
  return data
end`,
    );
    await store.call("enqueueJob", "capability", {
      type: "button",
      chatId: "a",
      data: "failure",
    });
    const run = start(t, file, await store.call("claimJob", "engine"));
    const saved = await run.done;
    assert.equal(saved.state, "failed");
    assert.match(saved.result.message, /must be awaited/);
    assert.equal((await store.call("snapshot", "a")).variables.length, 0);
    assert.equal(await store.call("claimJob", "engine"), null);
  },
);

test("native Lua normal and error alerts persist in order without waiting for a browser", async (t) => {
  const { store, file } = await fixture(
    t,
    `
function onButtonClick(id, data)
  alertNormal(id, 'first <b>synthetic</b>')
  alertError(id, 'second')
  setChatVar(id, 'choice', 'completed')
end`,
  );
  await store.call("enqueueJob", "notices", {
    type: "button",
    chatId: "a",
    data: "synthetic",
  });
  const run = start(t, file, await store.call("claimJob", "engine"));
  assert.equal((await run.done).state, "completed");
  const list = await store.call("listNotices");
  assert.equal(list.count, 2);
  assert.deepEqual(
    list.items.map((n) => n.position),
    [1, 2],
  );
  assert.equal(
    (await store.call("readNotice", list.items[0].id)).notice.message,
    "first <b>synthetic</b>",
  );
  assert.equal(
    (await store.call("readNotice", list.items[1].id)).notice.message,
    "second",
  );
  assert.equal(
    (await store.call("snapshot", "a")).variables.find(
      (v) => v.key === "$choice",
    ).value,
    "completed",
  );
});

test("a setup validation error caught with pcall completes, preserves the form and allows confirmation after selection", async (t) => {
  const { store, file } = await fixture(
    t,
    `
function setupConfirm(id)
  if getChatVar(id, 'selected') ~= 'yes' then
    pcall(alertError, id, '아직 안 고른 것: 부서')
    return
  end
  setChatVar(id, 'form_open', '0')
end
function onButtonClick(id, data)
  if data == 'select' then
    setChatVar(id, 'selected', 'yes')
    return
  end
  setupConfirm(id)
end`,
  );
  async function press(jobId, data) {
    await store.call("enqueueJob", jobId, {
      type: "button",
      chatId: "a",
      data,
    });
    return start(t, file, await store.call("claimJob", "engine")).done;
  }
  assert.equal(
    (await press("missing-selection", "setupConfirm")).state,
    "completed",
  );
  const list = await store.call("listNotices");
  assert.equal(list.count, 1);
  assert.equal(
    (await store.call("readNotice", list.items[0].id)).notice.message,
    "아직 안 고른 것: 부서",
  );
  assert.equal((await store.call("snapshot", "a")).variables.length, 0);
  assert.equal((await store.call("snapshot", "a")).messages.length, 0);
  assert.equal((await press("selection", "select")).state, "completed");
  assert.equal((await press("confirm", "setupConfirm")).state, "completed");
  const saved = await store.call("snapshot", "a");
  assert.equal(saved.variables.find((v) => v.key === "$form_open").value, "0");
  assert.equal(saved.variables.find((v) => v.key === "$selected").value, "yes");
  assert.equal((await store.call("listNotices")).count, 1);
});

test("an emitted alert survives a later Lua failure while canonical script effects roll back", async (t) => {
  const { store, file } = await fixture(
    t,
    `
function onButtonClick(id, data)
  setChatVar(id, 'choice', 'temporary')
  alertNormal(id, 'before failure')
  error('synthetic failure after notice')
end`,
  );
  await store.call("enqueueJob", "notice-failure", {
    type: "button",
    chatId: "a",
    data: "synthetic",
  });
  const run = start(t, file, await store.call("claimJob", "engine"));
  assert.equal((await run.done).state, "failed");
  assert.equal((await store.call("listNotices")).count, 1);
  assert.equal((await store.call("snapshot", "a")).variables.length, 0);
});

for (const api of ["alertNormal", "alertError"])
  test(`${api} flood caught inside Lua still fails the job and saves no partial canonical effects`, async (t) => {
    const { store, file } = await fixture(
      t,
      `
function onButtonClick(id, data)
  setChatVar(id, 'choice', 'temporary')
  for i=1,129 do pcall(function() ${api}(id, '') end) end
end`,
    );
    await store.call("enqueueJob", "notice-flood", {
      type: "button",
      chatId: "a",
      data: "synthetic",
    });
    const run = start(t, file, await store.call("claimJob", "engine"));
    const result = await run.done;
    assert.equal(result.state, "failed");
    assert.match(result.result.message, /Notification delivery failed/);
    assert.equal((await store.call("listNotices")).count, 128);
    assert.equal((await store.call("snapshot", "a")).variables.length, 0);
  });

for (const api of ["alertNormal", "alertError"])
  test(`${api} database notification failure blocks the native job final save`, async (t) => {
    const { store, file } = await fixture(
      t,
      `
function onButtonClick(id, data)
  pcall(${api}, id, 'must persist')
  setChatVar(id, 'choice', 'must not commit')
end`,
    );
    const hook = new DatabaseSync(file);
    hook.exec(
      "CREATE TRIGGER synthetic_notice_failure BEFORE INSERT ON job_notices BEGIN SELECT RAISE(ABORT, 'synthetic notice storage failure'); END;",
    );
    hook.close();
    await store.call("enqueueJob", "notice-storage-failure", {
      type: "button",
      chatId: "a",
      data: "synthetic",
    });
    const run = start(t, file, await store.call("claimJob", "engine"));
    const saved = await run.done;
    assert.equal(saved.state, "failed");
    assert.match(saved.result.message, /synthetic notice storage failure/);
    assert.equal((await store.call("snapshot", "a")).variables.length, 0);
    assert.equal((await store.call("listNotices")).count, 0);
  });

test(
  "a committed notification survives an actual native worker kill and database reopen without canonical effects",
  { timeout: 10000 },
  async (t) => {
    const { store, file } = await fixture(
      t,
      `
onButtonClick = async(function(id, data)
  alertNormal(id, 'before worker kill')
  sleep(id, 60000):await()
  setChatVar(id, 'choice', 'must not commit')
end)`,
    );
    await store.call("enqueueJob", "notice-kill", {
      type: "button",
      chatId: "a",
      data: "synthetic",
    });
    const claimed = await store.call("claimJob", "engine");
    const run = start(t, file, claimed);
    await run.executing;
    let list;
    const until = Date.now() + 5000;
    do {
      list = await store.call("listNotices");
      if (list.count) break;
      await delay(20);
    } while (Date.now() < until);
    assert.equal(list.count, 1);
    assert.equal(
      (await store.call("getJobStatus", claimed.job.id)).state,
      "running",
    );
    await run.worker.terminate();
    await store.call(
      "interruptJob",
      claimed.job.id,
      claimed.job.owner,
      claimed.job.fence,
      "synthetic worker kill",
    );
    const reopened = new EntityStoreClient(file);
    try {
      assert.equal(
        (await reopened.call("getJobStatus", claimed.job.id)).state,
        "interrupted",
      );
      assert.equal(
        (await reopened.call("readNotice", list.items[0].id)).notice.message,
        "before worker kill",
      );
      assert.equal((await reopened.call("snapshot", "a")).variables.length, 0);
    } finally {
      await reopened.close();
    }
  },
);

test(
  "two independent native jobs fence a shared character edit and retain the losing result without repeating it",
  { timeout: 10000 },
  async (t) => {
    const { store, file } = await fixture(
      t,
      `
local calls = 0
function onButtonClick(id, data)
  calls = calls + 1
  setChatVar(id, 'choice', data .. ':' .. calls)
  setDescription(id, 'description:' .. data)
  return data .. ':' .. calls
end`,
    );
    await store.call("enqueueJob", "job-a", {
      type: "button",
      chatId: "a",
      data: "a",
    });
    await store.call("enqueueJob", "job-b", {
      type: "button",
      chatId: "b",
      data: "b",
    });
    const a = await store.call("claimJob", "engine-a"),
      b = await store.call("claimJob", "engine-b");
    const runs = [start(t, file, a), start(t, file, b)];
    const results = await Promise.all(runs.map((run) => run.done));
    assert.deepEqual(results.map((job) => job.state).sort(), [
      "completed",
      "failed",
    ]);
    const winner = results.find((job) => job.state === "completed"),
      loser = results.find((job) => job.state === "failed");
    assert.equal(loser.result.code, "REVISION_CONFLICT");
    assert.equal(loser.result.uncommitted.result.value, `${loser.chatId}:1`);
    assert.equal(
      (await store.call("snapshot", loser.chatId)).variables.length,
      0,
    );
    assert.equal(
      (await store.call("snapshot", winner.chatId)).variables[0].value,
      `${winner.chatId}:1`,
    );
    assert.equal(await store.call("claimJob", "engine"), null);
  },
);
