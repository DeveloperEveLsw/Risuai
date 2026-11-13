"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createButtonProcessPool } = require("./buttonProcessPool.cjs");

async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label);
    await delay(10);
  }
}
async function fixture(t, code) {
  const directory = mkdtempSync(join(tmpdir(), "risu-button-reserve-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStoreClient(file);
  const pools = [];
  const workers = [];
  t.after(async () => {
    for (const pool of pools) await pool.close();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "garden",
    definition: {
      type: "character",
      name: "Synthetic Garden",
      triggerscript: [
        {
          effect: [
            {
              type: "triggerlua",
              code:
                code ??
                `
function onButtonClick(id, data)
  if rawget(_G, 'previousPrivateValue') ~= nil then error('private state leaked') end
  previousPrivateValue = data
  setChatVar(id, 'choice', data)
  return data
end`,
            },
          ],
        },
      ],
    },
  });
  for (const chatId of ["a", "b"])
    await store.call("applyCommand", "chat-" + chatId, {
      type: "create-chat",
      chatId,
      characterId: "garden",
      metadata: { name: "Synthetic " + chatId, localLore: [] },
    });
  return {
    file,
    store,
    pool(options) {
      const pool = createButtonProcessPool(options);
      pools.push(pool);
      return pool;
    },
    async run(pool, chatId, input) {
      const id = "job-" + chatId;
      await store.call("enqueueJob", id, {
        type: "button",
        chatId,
        data: input,
      });
      const claimed = await store.call(
        "claimJob",
        "synthetic-supervisor",
        30000,
        { includeSnapshot: false },
      );
      const worker = pool.create(claimed, { file });
      workers.push(worker);
      const executing = new Promise((resolve) =>
        worker.on("message", (message) => {
          if (message.executing) resolve();
        }),
      );
      const done = new Promise((resolve, reject) => {
        worker.on("message", (message) => {
          if (message.completed) resolve(message.completed);
          if (message.error) reject(new Error(message.error.message));
        });
        worker.on("error", reject);
        worker.once("exit", (code) => {
          if (code) reject(new Error("Native button exited " + code));
        });
      });
      const exited = once(worker, "exit");
      return { worker, claimed, done, executing, exited };
    },
  };
}
function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    connected: true,
    exitCode: null,
    signalCode: null,
    messages: [],
    killed: false,
  });
  child.send = (message, callback) => {
    child.messages.push(message);
    callback?.();
  };
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    child.connected = false;
    child.signalCode = "SIGKILL";
    setImmediate(() => child.emit("exit", null, "SIGKILL"));
    return true;
  };
  return child;
}

test("prepared public WASM factory is a one-use constructor and probe globals do not survive", async () => {
  const prewarm = require("./buttonPrewarm.cjs");
  assert.equal(prewarm.takeFactory(), undefined);
  await prewarm.prepare();
  const Factory = prewarm.takeFactory();
  assert.equal(prewarm.takeFactory(), undefined);
  const factory = new Factory();
  assert.throws(() => new Factory(), /cannot be reused/);
  const engine = await factory.createEngine({ injectObjects: true });
  try {
    assert.equal(
      engine.doStringSync("return previousPrivateValue == nil"),
      true,
    );
  } finally {
    engine.global.close();
  }
  await assert.rejects(prewarm.prepare(), /already consumed/);
});

test(
  "each prepared process executes exactly one button and a successor cannot inherit another chat's private globals",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const spawned = [];
    const pool = f.pool({
      spawn: (...args) => {
        const child = fork(...args);
        spawned.push(child);
        return child;
      },
    });
    await until(() => pool.status().ready === 1, "first public preparation");
    const first = await f.run(pool, "a", "synthetic-private-a");
    assert.equal(first.worker.buttonPrewarmed, true);
    assert.ok(first.worker.dispatchedAt <= Date.now());
    const firstResult = await first.done;
    assert.equal(
      firstResult.state,
      "completed",
      JSON.stringify(firstResult.result),
    );
    assert.equal((await first.exited)[0], 0);
    await until(
      () => pool.status().ready === 1,
      "successor public preparation",
    );
    const second = await f.run(pool, "b", "synthetic-private-b");
    assert.equal(second.worker.buttonPrewarmed, true);
    assert.notEqual(first.worker.pid, second.worker.pid);
    const secondResult = await second.done;
    assert.equal(
      secondResult.state,
      "completed",
      JSON.stringify(secondResult.result),
    );
    assert.equal((await second.exited)[0], 0);
    assert.equal(
      (await f.store.call("snapshot", "a")).variables.find(
        (row) => row.key === "$choice",
      ).value,
      "synthetic-private-a",
    );
    assert.equal(
      (await f.store.call("snapshot", "b")).variables.find(
        (row) => row.key === "$choice",
      ).value,
      "synthetic-private-b",
    );
    await pool.close();
    await until(
      () =>
        spawned.every(
          (child) => child.exitCode != null || child.signalCode != null,
        ),
      "no reserved child after close",
    );
    assert.deepEqual(pool.status(), {
      reserve: 1,
      ready: 0,
      warming: 0,
      closed: true,
    });
    assert.throws(() => pool.create(first.claimed, { file: f.file }), /closed/);
  },
);

test(
  "an already claimed button never waits for a warming reserve and the reserve receives no private job data",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const child = fakeChild();
    const pool = f.pool({ spawn: () => child });
    assert.deepEqual(pool.status(), {
      reserve: 1,
      ready: 0,
      warming: 1,
      closed: false,
    });
    const running = await f.run(pool, "a", "synthetic-private-a");
    assert.equal(running.worker.buttonPrewarmed, false);
    assert.equal((await running.done).state, "completed");
    assert.equal((await running.exited)[0], 0);
    assert.equal(child.messages.length, 1);
    assert.deepEqual(Object.keys(child.messages[0]).sort(), [
      "bundlePath",
      "token",
      "type",
    ]);
    assert.equal(
      JSON.stringify(child.messages).includes("synthetic-private-a"),
      false,
    );
    assert.equal(JSON.stringify(child.messages).includes(f.file), false);
  },
);

test(
  "failed preparation backs off and a claimed button completes through the fresh-process fallback",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let errors = 0,
      spawns = 0;
    const pool = f.pool({
      bundlePath: f.file + ".missing.mjs",
      backoffMs: 10000,
      onError: (diagnostic) => {
        assert.deepEqual(diagnostic, { code: "BUTTON_PREWARM_FAILED" });
        errors++;
      },
      spawn: (...args) => {
        spawns++;
        return fork(...args);
      },
    });
    await until(() => errors === 1, "failed public preparation diagnostic");
    assert.equal(spawns, 1);
    const running = await f.run(pool, "a", "synthetic-fallback");
    assert.equal(running.worker.buttonPrewarmed, false);
    assert.equal((await running.done).state, "completed");
    assert.equal((await running.exited)[0], 0);
    assert.equal(spawns, 1);
    await pool.close();
  },
);

test(
  "a cancelled prepared button commits no private changes and exits its single-use process",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `
function onButtonClick(id, data)
  setChatVar(id, 'choice', data)
  local started = os.clock()
  while os.clock() - started < 0.5 do end
  return data
end`,
    );
    const pool = f.pool();
    await until(
      () => pool.status().ready === 1,
      "public preparation before cancellation",
    );
    const running = await f.run(pool, "a", "must-not-commit");
    await running.executing;
    await f.store.call("requestCancel", running.claimed.job.id);
    running.worker.postMessage({
      type: "cancel",
      jobId: running.claimed.job.id,
    });
    assert.equal((await running.done).state, "cancelled");
    assert.equal((await running.exited)[0], 0);
    assert.equal((await f.store.call("snapshot", "a")).variables.length, 0);
  },
);

test(
  "unresponsive preparation is bounded, replaced after backoff and cleaned up on shutdown",
  { timeout: 5000 },
  async () => {
    const children = [];
    const pool = createButtonProcessPool({
      warmTimeoutMs: 50,
      backoffMs: 50,
      spawn: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });
    try {
      await until(
        () => children.length === 2,
        "bounded replacement after timeout",
      );
      assert.equal(children[0].killed, true);
      assert.equal(pool.status().warming, 1);
    } finally {
      await pool.close();
    }
    assert.equal(
      children.every((child) => child.killed),
      true,
    );
    assert.equal(pool.status().warming, 0);
  },
);

test(
  "a detached supervisor kills its public-only reserved process",
  { timeout: 15000 },
  async () => {
    const child = fork(join(__dirname, "buttonPrewarmProcess.cjs"), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    const exited = once(child, "exit");
    try {
      const ready = new Promise((resolve) =>
        child.on("message", (message) => {
          if (message.buttonReady === "synthetic-token") resolve();
        }),
      );
      child.send({ type: "prepare-button", token: "synthetic-token" });
      await ready;
      child.disconnect();
      assert.equal((await exited)[0], 1);
    } finally {
      if (child.exitCode == null && child.signalCode == null)
        child.kill("SIGKILL");
    }
  },
);

test("reserve size is bounded", () => {
  assert.throws(
    () => createButtonProcessPool({ reserve: 3 }),
    /between 0 and 2/,
  );
  assert.throws(
    () => createButtonProcessPool({ warmTimeoutMs: 0 }),
    /positive/,
  );
  const pool = createButtonProcessPool({ reserve: 0 });
  assert.deepEqual(pool.status(), {
    reserve: 0,
    ready: 0,
    warming: 0,
    closed: false,
  });
  return pool.close();
});

test(
  "broken preparation backs off exponentially, stops after three failures and retries only after another button",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const spawnTimes = [];
    const pool = f.pool({
      backoffMs: 10,
      spawn: () => {
        const child = fakeChild();
        const send = child.send;
        child.send = (message, callback) => {
          send(message, callback);
          queueMicrotask(() =>
            child.emit("message", { buttonWarmFailed: message.token }),
          );
        };
        spawnTimes.push(Date.now());
        return child;
      },
    });
    await until(
      () => spawnTimes.length === 3 && pool.status().warming === 0,
      "three preparation failures",
    );
    await delay(60);
    assert.equal(spawnTimes.length, 3);
    assert.ok(spawnTimes[1] - spawnTimes[0] >= 9);
    assert.ok(spawnTimes[2] - spawnTimes[1] >= 19);
    const running = await f.run(pool, "a", "synthetic-retry-trigger");
    assert.equal(running.worker.buttonPrewarmed, false);
    assert.equal((await running.done).state, "completed");
    assert.equal((await running.exited)[0], 0);
    await until(
      () => spawnTimes.length === 6 && pool.status().warming === 0,
      "later button restarts public preparation",
    );
    await delay(60);
    assert.equal(spawnTimes.length, 6);
  },
);

test("generation commands cannot consume a prepared process", async (t) => {
  const f = await fixture(t);
  const child = fakeChild();
  const pool = f.pool({ spawn: () => child });
  child.emit("message", { buttonReady: child.messages[0].token });
  assert.equal(pool.status().ready, 1);
  const claimed = {
    job: { id: "unclaimed-synthetic-generation", type: "send" },
    command: { type: "send" },
  };
  const worker = pool.create(claimed, { file: f.file });
  worker.on("error", () => {});
  assert.equal(worker.buttonPrewarmed, false);
  assert.equal(pool.status().ready, 1);
  assert.equal(child.messages.length, 1);
  await worker.terminate();
});
