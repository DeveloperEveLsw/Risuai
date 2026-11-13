"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { request } = require("node:http");
const { existsSync, readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");
const { getWygloreRelease } = require("../native/wygloreContract.cjs");
const { PHASES } = require("../native/buttonTimings.cjs");

const artifact = join(
  __dirname,
  "../../.local-runtime/public-plugins/wyglore-leaf/3.2.0/WygLoreLeaf-latest.js",
);
const actual = {
  timeout: 30000,
  skip: existsSync(artifact)
    ? false
    : "Fetch the pinned public WygLore 3.2.0 fixture",
};
const lua = `
onButtonClick = async(function(id, data)
  if rawget(_G, "previousChatPrivate") ~= nil then error("Previous job globals leaked") end
  previousChatPrivate = data
  sleep(id, 75):await()
  local count = (tonumber(getChatVar(id, "count")) or 0) + 1
  setChatVar(id, "count", tostring(count))
  setChatVar(id, "choice", data)
  addChat(id, "char", "Selected " .. data .. " #" .. tostring(count))
  return data
end)`;

async function until(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error("Synthetic button condition did not finish: " + label);
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-button-http-"));
  const file = join(directory, "state.sqlite");
  const errors = [];
  const runtime = await createRuntimeService({
    file,
    initialize: true,
    scheduler: {
      reviewedPlugins: true,
      pollMs: 15,
      progressIntervalMs: 15,
      onError: (error) => errors.push(error),
    },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const serverId = (await runtime.store.call("bootstrap")).serverId;
  function client() {
    return (path, data, extraHeaders = {}) =>
      new Promise((resolve, reject) => {
        const body = data === undefined ? null : JSON.stringify(data);
        const outgoing = request(
          runtime.url + "/api/runtime" + path,
          {
            agent: false,
            method: body === null ? "GET" : "POST",
            headers: {
              "risu-runtime-id": serverId,
              ...(body === null
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
              ...extraHeaders,
            },
          },
          (response) => {
            let encoded = "";
            response.setEncoding("utf8");
            response.on("data", (part) => {
              encoded += part;
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                const result = JSON.parse(encoded);
                assert.ok(response.statusCode < 400, JSON.stringify(result));
                resolve(result);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      });
  }
  const left = client();
  const right = client();
  const command = (requestId, value) =>
    left("/commands", { requestId, command: value });
  const settings = await runtime.store.call(
    "getResource",
    "settings",
    "global",
  );
  await command("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      pluginIds: ["wyglore"],
      enabledModules: ["button-module"],
      mainPrompt: "Help the synthetic gardener.",
    },
  });
  const script = readFileSync(artifact, "utf8");
  await command("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: "◆ WygLore Leaf",
      version: "3.0",
      enabled: true,
      script,
      realArg: {},
    },
  });
  await command("module", {
    type: "put-resource",
    kind: "module",
    resourceId: "button-module",
    expectedRevision: 0,
    payload: {
      id: "button-module",
      name: "Synthetic button module",
      trigger: [
        {
          effect: [
            {
              type: "triggerlua",
              code: `function onButtonClick(id, data) setChatVar(id, "module", tostring((tonumber(getChatVar(id, "module")) or 0) + 1)) return data end`,
            },
          ],
          conditions: [],
        },
      ],
    },
  });
  for (const [characterId, chatId] of [
    ["garden", "a"],
    ["garden-two", "b"],
  ])
    await command("character-" + characterId, {
      type: "create-character",
      characterId,
      definition: {
        type: "character",
        name: "Synthetic " + characterId,
        desc: "A safe synthetic gardener.",
        firstMessage: "Welcome to the garden.",
        globalLore: [],
        triggerscript: [
          { effect: [{ type: "triggerlua", code: lua }], conditions: [] },
          {
            type: "manual",
            comment: "set-mode",
            conditions: [],
            effect: [
              { type: "setvar", var: "manual", operator: "=", value: "done" },
            ],
          },
        ],
      },
      chat: {
        chatId,
        metadata: { name: "Synthetic " + chatId, localLore: [] },
      },
    });
  await command("ui-chat", {
    type: "create-chat",
    characterId: "garden",
    chatId: "ui",
    metadata: { name: "Synthetic settings garden", localLore: [] },
  });
  const namespace = {
    pluginId: "wyglore",
    bundleSha: getWygloreRelease(script).sha256,
    pluginEpoch: (await runtime.store.call("getResource", "plugin", "wyglore"))
      .entityEpoch,
  };
  const lease = await runtime.store.call("claimPluginStorage", {
    namespace,
    writerId: "synthetic-settings",
    authority: { kind: "browser" },
  });
  await runtime.store.call("commitPluginStorage", {
    lease,
    expectedRevision: 0,
    commitId: "synthetic-settings",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          speedMode: "fast",
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  await runtime.store.call("releasePluginStorage", lease);
  const graph = () => runtime.store.call("readAllPluginStorage", namespace);
  const accepted = (requestId, chatId = "a", data = "blue", api = left) =>
    api("/jobs", { requestId, command: { type: "button", chatId, data } });
  const completed = (id) =>
    until(
      () => runtime.store.call("getJob", id),
      (job) =>
        ["completed", "failed", "interrupted", "cancelled"].includes(job.state),
      id,
    ).then((job) => {
      assert.equal(job.state, "completed", JSON.stringify(job.result));
      return job;
    });
  async function loseAcknowledgement(requestId, data) {
    const body = JSON.stringify({
      requestId,
      command: { type: "button", chatId: "a", data },
    });
    await new Promise((resolve, reject) => {
      let acceptedResponse = false;
      const outgoing = request(
        runtime.url + "/api/runtime/jobs",
        {
          agent: false,
          method: "POST",
          headers: {
            "risu-runtime-id": serverId,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          acceptedResponse = true;
          response.destroy();
          outgoing.destroy();
          resolve();
        },
      );
      outgoing.on("error", (error) => {
        if (!acceptedResponse) reject(error);
      });
      outgoing.end(body);
    });
  }
  return {
    runtime,
    left,
    right,
    command,
    graph,
    accepted,
    completed,
    loseAcknowledgement,
    errors,
  };
}

const variable = (snapshot, key) =>
  snapshot.variables.find((row) => row.key === "$" + key)?.value;

test(
  "a real open WygLore UI owner keeps its global storage lease while an original Lua button completes",
  actual,
  async (t) => {
    const f = await fixture(t);
    const owner = await f.left("/plugin-ui", {
      pluginId: "wyglore",
      chatId: "ui",
      expectedChatEpoch: 0,
    });
    const entry = f.runtime.pluginOwners.sessions.get(owner.sessionId);
    const child = entry.child;
    const lease = structuredClone(entry.lease);
    const graph = await f.graph();
    await f.accepted("held-ui-button");
    await f.completed("held-ui-button");
    assert.equal(f.runtime.pluginOwners.sessions.get(owner.sessionId), entry);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(entry.lease.token, lease.token);
    assert.equal(entry.lease.fence, lease.fence);
    assert.equal(entry.lease.writerId, lease.writerId);
    assert.deepEqual(await f.graph(), graph);
    const ui = await f.left("/plugin-ui/" + owner.sessionId, undefined, {
      "risu-plugin-owner": owner.ownerToken,
    });
    assert.ok(ui.html);
    const state = await f.left("/chats/a");
    assert.equal(variable(state, "count"), "1");
    assert.equal(variable(state, "module"), "1");
    assert.equal(state.messages.length, 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "accepted repeated clicks survive lost acknowledgement and all HTTP clients closing, and two devices converge without replay",
  actual,
  async (t) => {
    const f = await fixture(t);
    const graph = await f.graph();
    await f.loseAcknowledgement("one", "private-one");
    const retried = await f.accepted("one", "a", "private-one", f.right);
    assert.equal(retried.job.id, "one");
    await f.accepted("two", "a", "private-two");
    await f.accepted("three", "a", "private-three", f.right);
    // No live browser connection or event stream owns these durable jobs.
    f.runtime.server.closeAllConnections();
    await Promise.all(["one", "two", "three"].map(f.completed));
    const [left, right] = await Promise.all([
      f.left("/chats/a"),
      f.right("/chats/a"),
    ]);
    assert.deepEqual(left, right);
    assert.equal(variable(left, "count"), "3");
    assert.equal(variable(left, "module"), "3");
    assert.equal(variable(left, "choice"), "private-three");
    assert.deepEqual(
      left.messages.map((row) => row.message.data),
      [
        "Selected private-one #1",
        "Selected private-two #2",
        "Selected private-three #3",
      ],
    );
    assert.equal((await f.runtime.store.call("listJobs", "a", 50)).length, 3);
    assert.deepEqual(await f.graph(), graph);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "different characters keep original Lua globals isolated while enabled module buttons and named manual triggers remain compatible",
  actual,
  async (t) => {
    const f = await fixture(t);
    await Promise.all([
      f.accepted("left-one", "a", "private-left"),
      f.accepted("right-one", "b", "private-right", f.right),
    ]);
    await Promise.all([f.completed("left-one"), f.completed("right-one")]);
    await f.accepted("left-two", "a", "private-left-next");
    await f.completed("left-two");
    await f.left("/jobs", {
      requestId: "manual",
      command: { type: "button", chatId: "b", manualName: "set-mode" },
    });
    await f.completed("manual");
    const [left, right] = await Promise.all([
      f.left("/chats/a"),
      f.right("/chats/b"),
    ]);
    assert.equal(variable(left, "count"), "2");
    assert.equal(variable(right, "count"), "1");
    assert.equal(variable(left, "module"), "2");
    assert.equal(variable(right, "module"), "1");
    assert.equal(variable(left, "choice"), "private-left-next");
    assert.equal(variable(right, "choice"), "private-right");
    assert.equal(variable(left, "manual"), undefined);
    assert.equal(variable(right, "manual"), "done");
    assert.equal(left.messages.length, 2);
    assert.equal(right.messages.length, 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "durable button phase timings cover startup through precommit and contain no script or private input values",
  actual,
  async (t) => {
    const f = await fixture(t);
    await until(
      () => f.runtime.scheduler.buttonPool.status(),
      (state) => state.ready === 1,
      "one-shot reserve ready",
    );
    await f.accepted("timed", "a", "private-timing-canary");
    const job = await f.completed("timed");
    const timings = job.progress.buttonTimings;
    assert.ok(timings);
    for (const phase of ["startup", "context", "lua", "precommit"])
      assert.ok(Object.hasOwn(timings, phase), phase);
    for (const [phase, duration] of Object.entries(timings)) {
      assert.ok(PHASES.includes(phase));
      assert.equal(typeof duration, "number");
      assert.ok(
        Number.isFinite(duration) && duration >= 0 && duration <= 3600000,
      );
    }
    const encoded = JSON.stringify(timings);
    assert.ok(!encoded.includes("private-timing-canary"));
    assert.ok(!encoded.includes("previousChatPrivate"));
    assert.ok(!encoded.includes("Synthetic"));
    assert.ok(!encoded.includes("http"));
    assert.deepEqual(f.errors, []);
  },
);
