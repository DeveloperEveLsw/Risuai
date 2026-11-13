"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { createLocalTrial, TRIAL_PASSWORD } = require("./localTrial.cjs");
const { createLocalTrialProvider } = require("./localTrialProvider.cjs");

async function until(read, predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < end);
  throw Error("Local trial condition timed out: " + JSON.stringify(value));
}
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "risu-local-trial-test-")),
    ui = join(parent, "ui");
  await mkdir(ui);
  await writeFile(
    join(ui, "index.html"),
    "<!doctype html><title>Authored backend fixture</title>",
  );
  const fixture = { parent, staticDirectory: ui, port: 0, trials: [] };
  t.after(async () => {
    for (const trial of fixture.trials) await trial.close();
    await rm(parent, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  return fixture;
}

test("local trial provider stays loopback, bounds input, reports counters and supports real SSE/JSON completion", async (t) => {
  const provider = await createLocalTrialProvider({ delayMs: 20 });
  t.after(() => provider.close());
  const post = (body) =>
    fetch(provider.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const response = await post(JSON.stringify({ messages: [], stream: true })),
    streamed = await response.text();
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(streamed, /연습 응답 1/);
  assert.match(streamed, /완료했습니다/);
  assert.match(streamed, /data: \[DONE\]/);
  const json = await (await post(JSON.stringify({ messages: [] }))).json();
  assert.match(json.choices[0].message.content, /연습 응답 2/);
  assert.equal((await post("null")).status, 400);
  assert.equal(
    (await post(JSON.stringify({ messages: ["S".repeat(1024 * 1024)] })))
      .status,
    413,
  );
  assert.equal((await fetch(provider.url + "/unrecognized")).status, 404);
  const stats = await (await fetch(provider.url + "/health")).json();
  assert.equal(stats.accepted, 2);
  assert.equal(stats.completed, 2);
  assert.equal(stats.active, 0);
  await assert.rejects(
    createLocalTrialProvider({ delayMs: 30001 }),
    /INVALID_TRIAL_DELAY/,
  );
});

test(
  "fresh local trial authenticates, uses its selected native bundle for original output Lua and independent jobs, and retains its data on close",
  { timeout: 60000 },
  async (t) => {
    const options = await fixture(t);
    const original = JSON.stringify(
      pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href,
    );
    const bundlePath = join(options.parent, "isolated-bundle.mjs");
    // Forward to the unchanged original engine; an inert result witness detects
    // a worker accidentally loading the shared bundle instead of the selected one.
    await writeFile(
      bundlePath,
      `export {createInitialRuntimeState} from ${original};
import {executeExtensionJob as executeOriginal} from ${original};
export async function executeExtensionJob(...args) {
  const output = await executeOriginal(...args);
  output.result.isolatedBundleWitness = true;
  return output;
}\n`,
    );
    let trial;
    t.after(() => trial?.close());
    trial = await createLocalTrial({ ...options, bundlePath, delayMs: 2000 });
    options.trials.push(trial);
    const login = await fetch(trial.url + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: TRIAL_PASSWORD }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const api = async (path, body) => {
      const response = await fetch(trial.url + "/api/runtime" + path, {
        headers: {
          cookie,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const bootstrap = (await api("/bootstrap")).body;
    assert.equal(bootstrap.characters[0].id, "local-trial-character");
    assert.equal(
      (await fetch(trial.url + "/api/runtime/bootstrap")).status,
      401,
    );
    const command = (id) => ({
      requestId: "local-trial-send-" + id,
      command: {
        type: "send",
        chatId: "local-trial-" + id,
        input: "안전한 합성 입력",
        messageId: "local-trial-input-" + id,
      },
    });
    const a = await api("/jobs", command("a"));
    assert.equal(a.status, 202);
    const b = await api("/jobs", command("b"));
    assert.equal(b.status, 202);
    const repeated = await api("/jobs", command("a"));
    assert.equal(repeated.body.job.id, a.body.job.id);
    for (const id of ["a", "b"]) {
      const jobs = await until(
        () => trial.runtime.store.call("listJobs", "local-trial-" + id),
        (rows) => rows[0]?.state === "completed" || rows[0]?.state === "failed",
      );
      assert.equal(jobs[0].state, "completed", JSON.stringify(jobs[0].error));
      assert.equal(
        (await trial.runtime.store.call("getJob", jobs[0].id)).result
          .isolatedBundleWitness,
        true,
      );
      const snapshot = await trial.runtime.store.call(
        "snapshot",
        "local-trial-" + id,
      );
      assert.equal(
        snapshot.messages.filter((row) => row.id === "local-trial-input-" + id)
          .length,
        1,
      );
      assert.ok(
        snapshot.messages.some(
          (row) =>
            row.message.role === "char" &&
            row.message.data.includes("완료했습니다"),
        ),
      );
      assert.equal(
        snapshot.variables.find((row) => row.key === "$last_reply").value,
        "완료",
      );
    }
    const stats = await (await fetch(trial.providerUrl + "/health")).json();
    assert.equal(stats.accepted, 2);
    assert.equal(stats.completed, 2);
    assert.equal(stats.maxActive, 2);
    const directory = trial.directory,
      pid = trial.providerPid;
    await trial.close();
    await trial.close();
    trial = null;
    const manifest = JSON.parse(
      await readFile(join(directory, "trial.json"), "utf8"),
    );
    assert.equal(manifest.syntheticOnly, true);
    assert.equal(manifest.bundlePath, bundlePath);
    assert.ok((await readFile(join(directory, "entity.sqlite"))).length > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === "ESRCH",
    );
  },
);

test(
  "CLI can stop during its isolated build without leaving a build process or changing shared artifacts",
  { timeout: 30000 },
  async (t) => {
    const options = await fixture(t);
    const sharedBundle = await readFile(
      join(__dirname, "../native/dist/extensionJob.mjs"),
    );
    const child = fork(join(__dirname, "localTrial.cjs"), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        RISU_LOCAL_TRIAL_PARENT: options.parent,
        RISU_LOCAL_TRIAL_PORT: "0",
      },
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGKILL");
        await done;
      }
    });
    const [building] = await once(child, "message");
    assert.equal(building.building, true);
    assert.ok(building.directory.startsWith(options.parent + "/trial-"));
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await done;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.throws(
      () => process.kill(building.pid, 0),
      (error) => error.code === "ESRCH",
    );
    assert.deepEqual(
      await readFile(join(__dirname, "../native/dist/extensionJob.mjs")),
      sharedBundle,
    );
  },
);

test(
  "an occupied trial port is preserved and each invocation uses a new directory",
  { timeout: 30000 },
  async (t) => {
    const options = await fixture(t),
      blocker = createServer((_req, res) =>
        res.end("Authored existing listener"),
      );
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          blocker.close(resolve);
          blocker.closeAllConnections();
        }),
    );
    await assert.rejects(
      createLocalTrial({
        ...options,
        port: blocker.address().port,
        delayMs: 0,
      }),
      (error) => error.code === "EADDRINUSE",
    );
    assert.equal(
      await (await fetch("http://127.0.0.1:" + blocker.address().port)).text(),
      "Authored existing listener",
    );
    const first = await createLocalTrial({ ...options, delayMs: 0 });
    options.trials.push(first);
    await first.close();
    const second = await createLocalTrial({ ...options, delayMs: 0 });
    options.trials.push(second);
    t.after(() => second.close());
    assert.notEqual(first.directory, second.directory);
    assert.notEqual(first.file, second.file);
    await assert.rejects(
      createLocalTrial({ ...options, port: -1 }),
      /INVALID_TRIAL_OPTIONS/,
    );
  },
);

test(
  "CLI SIGTERM closes its own UI and provider and preserves the fresh synthetic database",
  { timeout: 30000 },
  async (t) => {
    const options = await fixture(t),
      child = fork(
        join(__dirname, "localTrial.cjs"),
        ["--built-ui", options.staticDirectory],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            RISU_LOCAL_TRIAL_PARENT: options.parent,
            RISU_LOCAL_TRIAL_PORT: "0",
            RISU_LOCAL_TRIAL_DELAY_MS: "20",
          },
        },
      );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGKILL");
        await done;
      }
    });
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(([code]) => {
        throw Error("CLI failed before ready: " + code);
      }),
    ]);
    assert.equal(ready.ready, true);
    assert.equal(
      (await (await fetch(ready.url + "/_health")).json()).ready,
      true,
    );
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await done;
    assert.equal(code, 0);
    assert.equal(signal, null);
    await assert.rejects(fetch(ready.url + "/_health"));
    await assert.rejects(fetch(ready.providerUrl + "/health"));
    assert.throws(
      () => process.kill(ready.providerPid, 0),
      (error) => error.code === "ESRCH",
    );
    assert.ok(
      (await readFile(join(ready.directory, "entity.sqlite"))).length > 0,
    );
  },
);
