"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { request } = require("node:http");
const { existsSync, readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("./service.cjs");
const {
  createNativePluginCoordinator,
} = require("../native/nativePluginRuntime.cjs");

const HOLO_SHA =
  "d7ce51b5edbf46940b2c3526bba0ed933ca8f548733c3035a12466c0f474bcf3";
const WYG_SHA =
  "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9";
const artifacts = {
  holocall: join(
    __dirname,
    "../../.local-runtime/public-plugins/creditail-holocall-bridge/1.3.0/creditail_holocall_bridge.js",
  ),
  wyglore: join(
    __dirname,
    "../../.local-runtime/public-plugins/wyglore-leaf/3.2.0/WygLoreLeaf-latest.js",
  ),
};
const actual = {
  timeout: 30000,
  skip: Object.values(artifacts).every(existsSync)
    ? false
    : "Fetch the exact pinned public HoloCall 1.3.0 and WygLore 3.2.0 fixtures",
};
const clickData = "ct_start~go~situation";
const lua = `
onButtonClick = async(function(id, data)
  if rawget(_G, "previousGarden") ~= nil then error("Another job's Lua state leaked") end
  previousGarden = data
  sleep(id, 50):await()
  local count = (tonumber(getChatVar(id, "count")) or 0) + 1
  setChatVar(id, "count", tostring(count))
  setChatVar(id, "choice", data)
  addChat(id, "char", "Garden choice " .. data .. " #" .. tostring(count))
  return data
end)`;

const variable = (snapshot, key) =>
  snapshot.variables.find((row) => row.key === "$" + key)?.value;

async function until(read, predicate, label) {
  const deadline = Date.now() + 20000;
  do {
    const result = await read();
    if (predicate(result)) return result;
    await delay(10);
  } while (Date.now() < deadline);
  throw Error("Synthetic HoloCall button did not finish: " + label);
}

function pluginPayload(id) {
  const script = readFileSync(artifacts[id], "utf8");
  assert.equal(
    createHash("sha256").update(script).digest("hex"),
    id === "holocall" ? HOLO_SHA : WYG_SHA,
  );
  return {
    id,
    name: id === "holocall" ? "creditail_holocall_bridge" : "◆ WygLore Leaf",
    version: "3.0",
    enabled: true,
    script,
    realArg: {},
  };
}

async function seed(call, { withWyglore = false, changeHolo } = {}) {
  let sequence = 0;
  const command = (value) => call("applyCommand", "seed-" + ++sequence, value);
  const initial = await call("getResource", "settings", "global");
  const ids = withWyglore ? ["wyglore", "holocall"] : ["holocall"];
  await command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: initial.revision,
    payload: {
      ...initial.payload,
      pluginIds: ids,
      enabledModules: ["garden-module"],
      mainPrompt: "Help the synthetic gardener.",
    },
  });
  const namespaces = [];
  for (const id of ids) {
    const payload = pluginPayload(id);
    if (id === "holocall") changeHolo?.(payload);
    await command({
      type: "put-resource",
      kind: "plugin",
      resourceId: id,
      expectedRevision: 0,
      payload,
    });
    const row = await call("getResource", "plugin", id);
    const namespace = {
      pluginId: id,
      bundleSha: createHash("sha256").update(payload.script).digest("hex"),
      pluginEpoch: row.entityEpoch,
    };
    const lease = await call("claimPluginStorage", {
      namespace,
      writerId: "synthetic-settings",
      authority: { kind: "browser" },
    });
    await call("commitPluginStorage", {
      lease,
      expectedRevision: 0,
      commitId: "synthetic-seed",
      writes: [
        { key: "synthetic-preserved-setting", value: { color: "blue" } },
      ],
    });
    await call("releasePluginStorage", lease);
    namespaces.push(namespace);
  }
  await command({
    type: "put-resource",
    kind: "module",
    resourceId: "garden-module",
    expectedRevision: 0,
    payload: {
      id: "garden-module",
      name: "Synthetic garden buttons",
      trigger: [
        {
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: `function onButtonClick(id, data) setChatVar(id, "module", tostring((tonumber(getChatVar(id, "module")) or 0) + 1)) return data end`,
            },
          ],
        },
      ],
    },
  });
  for (const [characterId, chatId] of [
    ["garden", "a"],
    ["garden-two", "b"],
  ])
    await command({
      type: "create-character",
      characterId,
      definition: {
        type: "character",
        name: "Synthetic " + characterId,
        desc: "A safe synthetic gardener.",
        firstMessage: "Welcome to the garden.",
        globalLore: [],
        triggerscript: [
          { conditions: [], effect: [{ type: "triggerlua", code: lua }] },
          {
            type: "manual",
            comment: "set-garden-mode",
            conditions: [],
            effect: [
              { type: "setvar", var: "manual", operator: "=", value: "done" },
            ],
          },
        ],
      },
      chat: { chatId, metadata: { name: "Synthetic garden", localLore: [] } },
    });
  const preserved = async () => ({
    plugins: await Promise.all(
      ids.map((id) => call("getResource", "plugin", id)),
    ),
    storage: await Promise.all(
      namespaces.map((namespace) => call("readAllPluginStorage", namespace)),
    ),
  });
  return { ids, namespaces, preserved };
}

async function httpFixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "risu-holocall-http-"));
  const errors = [];
  const runtime = await createRuntimeService({
    file: join(directory, "state.sqlite"),
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
  const seeded = await seed(runtime.store.call.bind(runtime.store), options);
  const serverId = (await runtime.store.call("bootstrap")).serverId;
  function client() {
    return (path, data, loseAcknowledgement = false) =>
      new Promise((resolve, reject) => {
        const body = data === undefined ? null : JSON.stringify(data);
        let acceptedResponse = false;
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
            },
          },
          (response) => {
            acceptedResponse = true;
            if (loseAcknowledgement) {
              response.destroy();
              outgoing.destroy();
              resolve();
              return;
            }
            let encoded = "";
            response.setEncoding("utf8");
            response.on("data", (part) => (encoded += part));
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
        outgoing.on("error", (error) => {
          if (!loseAcknowledgement || !acceptedResponse) reject(error);
        });
        outgoing.end(body);
      });
  }
  const left = client();
  const right = client();
  const button = (requestId, chatId = "a", api = left, loseAck = false) =>
    api(
      "/jobs",
      { requestId, command: { type: "button", chatId, data: clickData } },
      loseAck,
    );
  const terminal = (id) =>
    until(
      () => runtime.store.call("getJob", id),
      (job) =>
        ["completed", "failed", "interrupted", "cancelled"].includes(job.state),
      id,
    );
  return { runtime, errors, ...seeded, left, right, button, terminal };
}

// These are the original durable character-button jobs. Preserving HoloCall's
// enabled installation/source does not boot its browser composer/provider
// bridge, change client plugin startup, or add a host for its own send actions.
for (const withWyglore of [false, true])
  test(
    `exact HoloCall ${withWyglore ? "with WygLore 3.2.0" : "alone"} preserves installation/storage while durable original buttons survive lost acknowledgement, tab exit and two devices`,
    actual,
    async (t) => {
      const f = await httpFixture(t, { withWyglore });
      const before = await f.preserved();
      await f.button("one", "a", f.left, true);
      const retried = await f.button("one", "a", f.right);
      assert.equal(retried.job.id, "one");
      await f.button("two");
      await f.button("three", "a", f.right);
      await f.button("other-character", "b", f.right);
      f.runtime.server.closeAllConnections();
      for (const id of ["one", "two", "three", "other-character"])
        assert.equal((await f.terminal(id)).state, "completed");
      await f.left("/jobs", {
        requestId: "manual",
        command: { type: "button", chatId: "a", manualName: "set-garden-mode" },
      });
      assert.equal((await f.terminal("manual")).state, "completed");
      const [left, right, other] = await Promise.all([
        f.left("/chats/a"),
        f.right("/chats/a"),
        f.right("/chats/b"),
      ]);
      assert.deepEqual(left, right);
      assert.equal(variable(left, "count"), "3");
      assert.equal(variable(left, "module"), "3");
      assert.equal(variable(left, "choice"), clickData);
      assert.equal(variable(left, "manual"), "done");
      assert.deepEqual(
        left.messages.map((row) => row.message.data),
        [1, 2, 3].map((count) => `Garden choice ${clickData} #${count}`),
      );
      assert.equal(variable(other, "count"), "1");
      assert.equal(variable(other, "module"), "1");
      assert.equal(variable(other, "manual"), undefined);
      assert.equal((await f.runtime.store.call("listJobs", "a", 50)).length, 4);
      assert.deepEqual(await f.preserved(), before);
      assert.deepEqual(f.errors, []);
    },
  );

async function computedFixture(t) {
  const native = await import(
    pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.initializeState(native.createInitialRuntimeState());
  const seeded = await seed(async (method, ...args) => store[method](...args));
  store.enqueueJob("button", { type: "button", chatId: "a", data: clickData });
  const claimed = store.claimJob("synthetic-worker");
  const calls = [];
  let providerCalls = 0;
  const coordinator = createNativePluginCoordinator({
    store: {
      call: async (method, ...args) => {
        calls.push(method);
        return store[method](...args);
      },
    },
    job: claimed.job,
    snapshot: claimed.snapshot,
    fetch: async () => {
      providerCalls++;
      throw Error("No external plugin/provider call is allowed in this test");
    },
  });
  t.after(() => coordinator.release());
  const result = await native.executeExtensionJob(claimed, {
    appVer: "2026.8.250",
    preparePluginSnapshot: coordinator.prepareSnapshot,
    openPluginRuntime: coordinator.open,
    providerFetch: async () => {
      providerCalls++;
      throw Error("A button must not request a model");
    },
    fetch: async (path) => {
      assert.match(path, /^\/lua\/[a-zA-Z0-9_-]+\.lua$/);
      return new Response(
        readFileSync(join(__dirname, "../../public", path.slice(1))),
      );
    },
  });
  assert.ok(result.pluginAdmission);
  assert.equal(result.pluginStorage, undefined);
  assert.equal(providerCalls, 0);
  assert.ok(
    !calls.some((method) => /PluginStorage|PluginJobSnapshot/.test(method)),
  );
  const finish = (outcome) =>
    store.finishJob(
      claimed.job.id,
      claimed.job.owner,
      claimed.job.fence,
      outcome,
    );
  let sequence = 0;
  function edit(changes) {
    const row = store.getResource("plugin", "holocall");
    return store.applyCommand("edit-" + ++sequence, {
      type: "put-resource",
      kind: "plugin",
      resourceId: "holocall",
      expectedRevision: row.revision,
      payload: { ...row.payload, ...changes },
    });
  }
  return { store, claimed, result, seeded, finish, edit };
}

test(
  "an exact HoloCall button computes without a plugin VM/storage lease/provider and a complete unchanged failed result can be explicitly recovered",
  actual,
  async (t) => {
    const f = await computedFixture(t);
    const preserved = await f.seeded.preserved();
    assert.equal(f.store.snapshot("a").messages.length, 0);
    f.finish({
      state: "failed",
      result: { code: "DATABASE_ERROR", uncommitted: f.result },
    });
    assert.equal(f.store.previewJobResult("button").canRecover, true);
    f.store.applyCommand("recover", {
      type: "recover-job-result",
      jobId: "button",
      chatId: "a",
      expectedChatEpoch: f.claimed.job.chatEpoch,
      expectedContentRevision: f.claimed.job.startedContentRevision,
    });
    assert.equal(variable(f.store.snapshot("a"), "count"), "1");
    assert.equal(variable(f.store.snapshot("a"), "module"), "1");
    assert.deepEqual(await f.seeded.preserved(), preserved);
  },
);

for (const scenario of [
  "source",
  "configuration",
  "disable-reenable",
  "remove-reinstall",
  "plugin-collection",
])
  test(
    `a HoloCall ${scenario} change after real Lua computation blocks atomic commit and retained-result recovery`,
    actual,
    async (t) => {
      const f = await computedFixture(t);
      if (scenario === "source")
        f.edit({ script: "/* changed synthetic source */" });
      if (scenario === "configuration")
        f.edit({ realArg: { synthetic: "new value" } });
      if (scenario === "disable-reenable") {
        f.edit({ enabled: false });
        f.edit({ enabled: true });
      }
      if (scenario === "remove-reinstall") {
        const row = f.store.getResource("plugin", "holocall");
        f.store.applyCommand("remove", {
          type: "delete-library-resource",
          kind: "plugin",
          resourceId: "holocall",
          expectedRevision: row.revision,
          expectedEpoch: row.entityEpoch,
        });
        f.store.applyCommand("reinstall", {
          type: "put-resource",
          kind: "plugin",
          resourceId: "holocall",
          expectedRevision: f.store.deletedRevision(
            "resource",
            "plugin",
            "holocall",
          ),
          payload: row.payload,
        });
      }
      if (scenario === "plugin-collection")
        f.store.applyCommand("another-plugin", {
          type: "put-resource",
          kind: "plugin",
          resourceId: "new-inactive-plugin",
          expectedRevision: 0,
          payload: {
            id: "new-inactive-plugin",
            enabled: false,
            script: "synthetic",
          },
        });
      const state = f.store.snapshot("a");
      const cursor = f.store.cursor();
      assert.throws(() => f.finish({ state: "completed", ...f.result }), {
        code: "REVISION_CONFLICT",
      });
      assert.equal(f.store.cursor(), cursor);
      assert.deepEqual(f.store.snapshot("a"), state);
      assert.equal(f.store.getJob("button").state, "running");
      f.finish({
        state: "failed",
        result: { code: "REVISION_CONFLICT", uncommitted: f.result },
      });
      const retained = f.store.snapshot("a");
      // Recording the terminal job advances the global event cursor, while all
      // computed chat, module and message effects remain uncommitted.
      assert.deepEqual(retained, { ...state, cursor: retained.cursor });
      assert.equal(f.store.previewJobResult("button").canRecover, false);
      assert.throws(() =>
        f.store.applyCommand("recover", {
          type: "recover-job-result",
          jobId: "button",
          chatId: "a",
          expectedChatEpoch: f.claimed.job.chatEpoch,
          expectedContentRevision: f.claimed.job.startedContentRevision,
        }),
      );
      assert.deepEqual(f.store.snapshot("a"), retained);
    },
  );

for (const scenario of ["modified-artifact", "unreviewed-plugin"])
  test(
    `${scenario} remains rejected before original Lua effects while the plugin stays enabled`,
    actual,
    async (t) => {
      const f = await httpFixture(t, {
        changeHolo: (plugin) => {
          if (scenario === "modified-artifact") plugin.script += "\n";
          else {
            plugin.name = "Synthetic unreviewed plugin";
            plugin.script = "/* no engine compatibility review */";
          }
        },
      });
      const preserved = await f.preserved();
      await f.button("rejected");
      const job = await f.terminal("rejected");
      assert.equal(job.state, "failed");
      assert.equal(job.result.code, "PLUGIN_UNSUPPORTED");
      assert.equal(job.result.uncommitted, undefined);
      const state = await f.left("/chats/a");
      assert.equal(state.messages.length, 0);
      assert.equal(variable(state, "count"), undefined);
      assert.equal(variable(state, "module"), undefined);
      assert.deepEqual(await f.preserved(), preserved);
      assert.deepEqual(f.errors, []);
    },
  );
