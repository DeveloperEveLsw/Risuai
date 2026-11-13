"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const { EntityStore } = require("../entity/store.cjs");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const { createNativeProcessWorker } = require("./processWorker.cjs");
const { getWygloreRelease } = require("./wygloreContract.cjs");

const holoPath = join(
  __dirname,
  "../../.local-runtime/public-plugins/creditail-holocall-bridge/1.3.0/creditail_holocall_bridge.js",
);
const actual = {
  skip: fs.existsSync(holoPath)
    ? false
    : "Preserve the original reviewed HoloCall fixture",
  timeout: 30000,
};
let serial = 0;

async function fixture(t, { wygVersion, file = ":memory:" } = {}) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(file);
  t.after(() => store.close());
  store.initializeState(native.createInitialRuntimeState());
  const requests = [];
  let beforeResponse;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    await beforeResponse?.();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const command = (value) => store.applyCommand("setup-" + ++serial, value);
  const holo = {
    id: "holo",
    name: "creditail_holocall_bridge",
    version: "3.0",
    versionOfPlugin: "1.3.0",
    enabled: true,
    script: fs.readFileSync(holoPath, "utf8"),
    realArg: { synthetic: "must remain unchanged" },
  };
  command({
    type: "put-resource",
    kind: "plugin",
    resourceId: holo.id,
    expectedRevision: 0,
    payload: holo,
  });
  let namespace;
  if (wygVersion) {
    const script = fs.readFileSync(
      join(
        __dirname,
        `../../.local-runtime/public-plugins/wyglore-leaf/${wygVersion}/WygLoreLeaf-latest.js`,
      ),
      "utf8",
    );
    command({
      type: "put-resource",
      kind: "plugin",
      resourceId: "wyg",
      expectedRevision: 0,
      payload: {
        id: "wyg",
        name: "◆ WygLore Leaf",
        version: "3.0",
        enabled: true,
        script,
        realArg: {},
      },
    });
    namespace = {
      pluginId: "wyg",
      bundleSha: getWygloreRelease(script).sha256,
      pluginEpoch: 0,
    };
    const lease = store.claimPluginStorage({
      namespace,
      writerId: "synthetic-settings",
      authority: { kind: "browser" },
    });
    store.commitPluginStorage({
      lease,
      expectedRevision: 0,
      commitId: "settings",
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
    store.releasePluginStorage(lease);
  }
  const settings = store.getResource("settings", "global");
  command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      pluginIds: namespace ? ["holo", "wyg"] : ["holo"],
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: url,
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: false,
      mainPrompt: "Synthetic garden",
      maxContext: 8000,
      maxResponse: 200,
    },
  });
  command({
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Green",
      desc: "Green tends flowers.",
      firstMessage: "Welcome to the synthetic garden.",
      globalLore: [],
      customscript: [
        {
          in: "marker",
          out: "changed-input",
          type: "editinput",
          comment: "input",
        },
        {
          in: "raw-output",
          out: "processed-output",
          type: "editoutput",
          comment: "output",
        },
      ],
      triggerscript: [
        {
          type: "output",
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: "listenEdit('editOutput', function(id, text, meta) setChatVar(id, 'outputDone', 'yes') return text .. ':lua' end)",
            },
          ],
        },
      ],
    },
    chat: { chatId: "a", metadata: { name: "Synthetic", localLore: [] } },
  });
  const originalPlugin = store.getResource("plugin", "holo");
  const providerFetch = (target, init) => {
    assert.equal(
      String(target),
      url,
      "Synthetic tests must never contact an external provider",
    );
    return fetch(target, init);
  };
  function enqueue(type = "send", id = "run") {
    let command = {
      type,
      chatId: "a",
      input: "marker",
      messageId: id + ":input",
    };
    if (type !== "send") {
      store.applyCommand(id + ":seed-user", {
        type: "append-message",
        chatId: "a",
        messageId: "seed-user",
        message: {
          role: "user",
          data: "Previous synthetic input",
          chatId: "seed-user",
        },
      });
      store.applyCommand(id + ":seed-answer", {
        type: "append-message",
        chatId: "a",
        messageId: "seed-answer",
        message: {
          role: "char",
          data: "Existing answer. ",
          chatId: "seed-answer",
        },
      });
      const last = store.snapshot("a").messages.at(-1);
      command = {
        type,
        chatId: "a",
        messageId: last.id,
        expectedRevision: last.revision,
      };
    }
    store.enqueueJob(id, command);
    return store.claimJob("synthetic-worker");
  }
  async function execute(claimed, intercept) {
    const coordinator = createNativePluginCoordinator({
      store: {
        call: async (method, ...args) => {
          await intercept?.(method);
          return store[method](...args);
        },
      },
      job: claimed.job,
      snapshot: claimed.snapshot,
      fetch: providerFetch,
      alertSelect: async () => {
        throw Error("Unexpected synthetic interaction");
      },
    });
    try {
      const result = await native.executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        providerFetch,
        fetch: async (path) =>
          new Response(
            fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
          ),
        preparePluginSnapshot: coordinator.prepareSnapshot,
        openPluginRuntime: coordinator.open,
      });
      return { claimed, result, coordinator };
    } catch (error) {
      await coordinator.release();
      throw error;
    }
  }
  function finish(outcome) {
    return store.finishJob(
      outcome.claimed.job.id,
      outcome.claimed.job.owner,
      outcome.claimed.job.fence,
      { state: "completed", ...outcome.result },
    );
  }
  return {
    native,
    store,
    requests,
    namespace,
    command,
    originalPlugin,
    enqueue,
    execute,
    finish,
    beforeResponse: (callback) => {
      beforeResponse = callback;
    },
  };
}

for (const wygVersion of [undefined, "3.1.6", "3.2.0"])
  for (const type of ["send", "continue", "reroll"])
    test(
      `compiled ${type} preserves HoloCall with ${wygVersion ? "full WygLore " + wygVersion : "no memory plugin"}`,
      actual,
      async (t) => {
        const f = await fixture(t, { wygVersion });
        const outcome = await f.execute(f.enqueue(type));
        try {
          assert.equal(f.requests.length, 1);
          assert.equal(
            f.store.snapshot("a").messages.length,
            type === "send" ? 0 : 2,
            "No output commits before the final guarded transaction",
          );
          if (wygVersion) {
            assert.ok(outcome.result.pluginStorage);
            assert.equal(outcome.result.pluginAdmission, undefined);
            assert.match(
              f.requests[0].messages
                .map((message) => message.content)
                .join("\n"),
              /WygLore Leaf — canonical layer/,
            );
            assert.ok(
              outcome.result.pluginStorage.reads.resources.some(
                (row) => row.kind === "plugin" && row.id === "holo",
              ),
            );
            assert.deepEqual(
              outcome.result.pluginStorage.reads.collectionSets.find(
                (row) => row.kind === "plugin",
              ).ids,
              ["holo", "wyg"],
            );
          } else {
            assert.equal(
              outcome.result.pluginAdmission.kind,
              "browser-generation-v1",
            );
            assert.equal(outcome.result.pluginStorage, undefined);
          }
          f.finish(outcome);
          const snapshot = f.store.snapshot("a");
          assert.match(
            snapshot.messages.at(-1).message.data,
            /processed-output:lua/,
          );
          assert.equal(
            snapshot.variables.find((row) => row.key === "$outputDone").value,
            "yes",
          );
          if (type === "send")
            assert.equal(snapshot.messages[0].message.data, "changed-input");
          assert.deepEqual(
            f.store.getResource("plugin", "holo"),
            f.originalPlugin,
          );
          assert.equal(
            f.store.db
              .prepare(
                "SELECT COUNT(*) AS n FROM plugin_storage_namespaces WHERE plugin_id='holo'",
              )
              .get().n,
            0,
          );
        } finally {
          await outcome.coordinator.release();
        }
      },
    );

for (const wygVersion of [undefined, "3.2.0"])
  test(
    `concurrent HoloCall source edits reject compiled output ${wygVersion ? "and the WygLore graph" : "and explicit recovery"}`,
    actual,
    async (t) => {
      const f = await fixture(t, { wygVersion });
      const outcome = await f.execute(f.enqueue());
      try {
        const graph = f.namespace && f.store.readAllPluginStorage(f.namespace);
        f.command({
          type: "put-resource",
          kind: "plugin",
          resourceId: "holo",
          expectedRevision: f.originalPlugin.revision,
          payload: {
            ...f.originalPlugin.payload,
            script: f.originalPlugin.payload.script + "\n",
          },
        });
        assert.throws(() => f.finish(outcome));
        assert.equal(f.store.snapshot("a").messages.length, 0);
        if (graph)
          assert.deepEqual(f.store.readAllPluginStorage(f.namespace), graph);
        f.store.finishJob(
          outcome.claimed.job.id,
          outcome.claimed.job.owner,
          outcome.claimed.job.fence,
          {
            state: "failed",
            result: { code: "REVISION_CONFLICT", uncommitted: outcome.result },
          },
        );
        assert.equal(
          f.store.previewJobResult(outcome.claimed.job.id).canRecover,
          false,
        );
        assert.equal(f.requests.length, 1);
      } finally {
        await outcome.coordinator.release();
      }
    },
  );

test(
  "a complete compiled HoloCall-only send can be recovered without repeating its provider",
  actual,
  async (t) => {
    const f = await fixture(t);
    const outcome = await f.execute(f.enqueue());
    try {
      f.store.finishJob(
        outcome.claimed.job.id,
        outcome.claimed.job.owner,
        outcome.claimed.job.fence,
        {
          state: "failed",
          result: { code: "DATABASE_ERROR", uncommitted: outcome.result },
        },
      );
      assert.equal(
        f.store.previewJobResult(outcome.claimed.job.id).canRecover,
        true,
      );
      f.command({
        type: "recover-job-result",
        jobId: outcome.claimed.job.id,
        chatId: "a",
        expectedChatEpoch: outcome.claimed.job.chatEpoch,
        expectedContentRevision: outcome.claimed.job.startedContentRevision,
      });
      assert.equal(f.store.snapshot("a").messages.length, 2);
      assert.match(
        f.store.snapshot("a").messages.at(-1).message.data,
        /processed-output:lua/,
      );
      assert.equal(f.requests.length, 1);
    } finally {
      await outcome.coordinator.release();
    }
  },
);

for (const change of ["alter", "unknown"])
  test(
    `the final post-lease snapshot rejects a newly ${change} plugin before provider execution`,
    actual,
    async (t) => {
      const f = await fixture(t, { wygVersion: "3.2.0" });
      const claimed = f.enqueue();
      await assert.rejects(
        () =>
          f.execute(claimed, (method) => {
            if (method !== "readPluginJobSnapshot") return;
            if (change === "alter")
              f.command({
                type: "put-resource",
                kind: "plugin",
                resourceId: "holo",
                expectedRevision: f.originalPlugin.revision,
                payload: {
                  ...f.originalPlugin.payload,
                  script: f.originalPlugin.payload.script + "\n",
                },
              });
            else
              f.command({
                type: "put-resource",
                kind: "plugin",
                resourceId: "unknown",
                expectedRevision: 0,
                payload: {
                  id: "unknown",
                  name: "unknown",
                  enabled: true,
                  script: "unknown",
                },
              });
          }),
        { code: "PLUGIN_UNSUPPORTED" },
      );
      assert.equal(f.requests.length, 0);
      assert.equal(f.store.snapshot("a").messages.length, 0);
    },
  );

test(
  "a durable reviewed HoloCall send completes in a fresh server process without any browser tab",
  actual,
  async (t) => {
    const directory = fs.mkdtempSync(
      join(tmpdir(), "risu-holocall-generation-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "state.sqlite");
    const f = await fixture(t, { file });
    const claimed = f.enqueue();
    let providerStarted;
    const started = new Promise((resolve) => {
      providerStarted = resolve;
    });
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    f.beforeResponse(async () => {
      providerStarted();
      await hold;
    });
    const child = createNativeProcessWorker({
      file,
      claimed,
      reviewedPlugins: true,
      diagnostics: true,
    });
    t.after(() => child.terminate());
    const done = new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message.completed) resolve(message.completed);
        if (message.error) reject(new Error(message.error.message));
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code) reject(new Error("Synthetic worker stopped: " + code));
      });
    });
    await started;
    // No browser context or HTTP observer owns this accepted durable job.
    assert.equal(f.store.getJob(claimed.job.id).state, "running");
    release();
    const job = await done;
    assert.equal(job.state, "completed", JSON.stringify(job.result));
    const clients = [new EntityStoreClient(file), new EntityStoreClient(file)];
    try {
      const [first, second] = await Promise.all(
        clients.map((client) => client.call("snapshot", "a")),
      );
      assert.deepEqual(first, second);
      assert.equal(first.messages.length, 2);
      assert.match(first.messages.at(-1).message.data, /processed-output:lua/);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.store.getResource("plugin", "holo"), f.originalPlugin);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  },
);
