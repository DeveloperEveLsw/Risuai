"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");

const pluginPath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(pluginPath)
    ? false
    : "Fetch the pinned public WygLore fixture before compatibility validation",
  timeout: 15000,
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function barrier(promise, signal) {
  signal?.throwIfAborted();
  const aborted = deferred();
  const onAbort = () => aborted.reject(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([promise, aborted.promise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
async function fixture(t) {
  let now = Date.now();
  const store = new EntityStore(":memory:", { now: () => now });
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const tasks = [];
  t.after(async () => {
    for (const task of tasks) {
      task.controller.abort(new Error("Synthetic fixture cleanup"));
      task.providerGate?.resolve();
    }
    await Promise.allSettled(tasks.map((task) => task.promise));
    for (const task of tasks) await task.coordinator.release();
    store.close();
  });
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      aiModel: "reverse_proxy",
      pluginIds: ["wyglore"],
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: false,
      mainPrompt: "Help the gardener.",
      maxContext: 8000,
      maxResponse: 200,
      requestRetrys: 0,
    },
  });
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      enabled: true,
      script: fs.readFileSync(pluginPath, "utf8"),
      realArg: {},
    },
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "garden",
    definition: {
      type: "character",
      name: "Green",
      desc: "Green tends blue flowers.",
      firstMessage: "Welcome to the garden.",
      globalLore: [],
      triggerscript: [],
    },
    chat: {
      chatId: "a",
      metadata: { name: "Synthetic garden A", localLore: [] },
    },
  });
  store.applyCommand("other-chat", {
    type: "create-chat",
    characterId: "garden",
    chatId: "b",
    metadata: { name: "Synthetic garden B", localLore: [] },
  });
  const plugin = store.getResource("plugin", "wyglore"),
    namespace = {
      pluginId: plugin.id,
      bundleSha: WYGLORE_RELEASE.sha256,
      pluginEpoch: plugin.entityEpoch,
    };
  const initial = store.claimPluginStorage({
    namespace,
    writerId: "settings",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease: initial,
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
  store.releasePluginStorage(initial);
  function start(
    id,
    chatId,
    { providerGate, providerFailure = false, acquireTimeoutMs } = {},
  ) {
    store.enqueueJob(id, {
      type: "send",
      chatId,
      input: `Synthetic turn for ${chatId}. Tell me about blue flowers.`,
      messageId: id + ":input",
    });
    const claimed = store.claimJob("worker:" + id);
    assert.equal(claimed.job.id, id);
    const controller = new AbortController(),
      providerStarted = deferred(),
      busy = deferred();
    const task = {
      id,
      claimed,
      controller,
      providerGate,
      providerStarted,
      busy,
      requests: [],
      claimAttempts: 0,
      coordinator: undefined,
      promise: undefined,
    };
    const transport = {
      call: async (method, ...args) => {
        if (method === "claimPluginStorage") task.claimAttempts++;
        try {
          return store[method](...args);
        } catch (error) {
          if (
            method === "claimPluginStorage" &&
            error.code === "PLUGIN_STORAGE_BUSY"
          )
            busy.resolve();
          throw error;
        }
      },
    };
    const providerFetch = async (url, init) => {
      assert.equal(
        String(url),
        "https://synthetic.invalid/v1/chat/completions",
      );
      const body = JSON.parse(init.body);
      assert.equal(body.model, "synthetic-model");
      task.requests.push(body);
      providerStarted.resolve();
      if (providerGate) await barrier(providerGate.promise, controller.signal);
      if (providerFailure)
        return Response.json(
          { error: { message: "Synthetic provider failure" } },
          { status: 503 },
        );
      return Response.json({
        choices: [
          { message: { content: `Synthetic blue flowers for ${chatId}.` } },
        ],
      });
    };
    task.coordinator = createNativePluginCoordinator({
      store: transport,
      job: claimed.job,
      snapshot: claimed.snapshot,
      signal: controller.signal,
      fetch: providerFetch,
      acquireTimeoutMs,
      alertSelect: async () => {
        throw Error("Unexpected synthetic interaction");
      },
    });
    task.promise = native
      .executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        signal: controller.signal,
        providerFetch,
        fetch: async (path) =>
          new Response(
            fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
          ),
        openPluginRuntime: task.coordinator.open,
        preparePluginSnapshot: task.coordinator.prepareSnapshot,
      })
      .catch(async (error) => {
        await task.coordinator.release();
        throw error;
      });
    // Tests intentionally inspect a peer/barrier before awaiting this task.
    task.promise.catch(() => {});
    tasks.push(task);
    return task;
  }
  function finish(task, outcome) {
    return store.finishJob(
      task.claimed.job.id,
      task.claimed.job.owner,
      task.claimed.job.fence,
      { state: "completed", ...outcome },
    );
  }
  return {
    store,
    namespace,
    start,
    finish,
    time: (value) => {
      now = value;
    },
  };
}

test(
  "two native jobs in different chats wait for one plugin writer and publish separate atomic chat/graph commits",
  actual,
  async (t) => {
    const f = await fixture(t),
      gate = deferred(),
      first = f.start("first", "a", { providerGate: gate });
    await first.providerStarted.promise;
    const second = f.start("second", "b");
    await second.busy.promise;
    assert.equal(second.requests.length, 0);
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(f.store.snapshot("b").messages.length, 0);
    gate.resolve();
    const firstOutcome = await first.promise;
    assert.ok(firstOutcome.pluginStorage.writes.length);
    assert.equal(firstOutcome.pluginStorage.expectedRevision, 1);
    f.finish(first, firstOutcome);
    await first.coordinator.release();
    const secondOutcome = await second.promise;
    assert.ok(second.claimAttempts >= 2);
    assert.equal(secondOutcome.pluginStorage.expectedRevision, 2);
    assert.ok(
      secondOutcome.pluginStorage.lease.fence >
        firstOutcome.pluginStorage.lease.fence,
    );
    f.finish(second, secondOutcome);
    await second.coordinator.release();
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 3);
    assert.deepEqual(
      f.store.snapshot("a").messages.map((row) => row.message.role),
      ["user", "char"],
    );
    assert.deepEqual(
      f.store.snapshot("b").messages.map((row) => row.message.role),
      ["user", "char"],
    );
    assert.equal(
      f.store.snapshot("a").messages.at(-1).message.data,
      "Synthetic blue flowers for a.",
    );
    assert.equal(
      f.store.snapshot("b").messages.at(-1).message.data,
      "Synthetic blue flowers for b.",
    );
  },
);
test(
  "aborting a waiting chat does not steal/release its peer lease or submit any staged memory",
  actual,
  async (t) => {
    const f = await fixture(t),
      gate = deferred(),
      first = f.start("first", "a", { providerGate: gate });
    await first.providerStarted.promise;
    const waiting = f.start("waiting", "b");
    await waiting.busy.promise;
    f.store.requestCancel(waiting.id);
    waiting.controller.abort(new Error("Synthetic waiting cancellation"));
    await assert.rejects(waiting.promise);
    assert.equal(waiting.requests.length, 0);
    f.store.finishJob(
      waiting.id,
      waiting.claimed.job.owner,
      waiting.claimed.job.fence,
      { state: "cancelled", result: { code: "SYNTHETIC_CANCEL" } },
    );
    const owner = f.store.db
      .prepare("SELECT writer_id FROM plugin_storage_namespaces")
      .get();
    assert.equal(owner.writer_id, "native-plugin:first");
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
    assert.equal(f.store.snapshot("b").messages.length, 0);
    gate.resolve();
    const outcome = await first.promise;
    f.finish(first, outcome);
    await first.coordinator.release();
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 2);
  },
);
test(
  "a busy plugin writer reaches its explicit acquisition budget without executing another provider",
  actual,
  async (t) => {
    const f = await fixture(t),
      gate = deferred(),
      first = f.start("first", "a", { providerGate: gate });
    await first.providerStarted.promise;
    const waiting = f.start("budgeted", "b", { acquireTimeoutMs: 0 });
    await assert.rejects(waiting.promise, { code: "PLUGIN_STORAGE_BUSY" });
    assert.equal(waiting.requests.length, 0);
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
    f.store.finishJob(
      waiting.id,
      waiting.claimed.job.owner,
      waiting.claimed.job.fence,
      { state: "failed", result: { code: "PLUGIN_STORAGE_BUSY" } },
    );
    gate.resolve();
    const outcome = await first.promise;
    f.finish(first, outcome);
    await first.coordinator.release();
  },
);
test(
  "expired native ownership lets another chat claim the plugin while the old result cannot write or release its successor",
  actual,
  async (t) => {
    const f = await fixture(t),
      firstGate = deferred(),
      secondGate = deferred(),
      first = f.start("expired", "a", { providerGate: firstGate });
    await first.providerStarted.promise;
    f.time(first.claimed.job.leaseUntil + 1);
    const second = f.start("successor", "b", { providerGate: secondGate });
    await second.providerStarted.promise;
    assert.equal(f.store.getJob(first.id).state, "interrupted");
    assert.equal(
      f.store.db
        .prepare("SELECT writer_id FROM plugin_storage_namespaces")
        .get().writer_id,
      "native-plugin:successor",
    );
    firstGate.resolve();
    const old = await first.promise;
    assert.throws(() => f.finish(first, old), { code: "STALE_WORKER" });
    await first.coordinator.release();
    assert.equal(
      f.store.db
        .prepare("SELECT writer_id FROM plugin_storage_namespaces")
        .get().writer_id,
      "native-plugin:successor",
    );
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 1);
    secondGate.resolve();
    const next = await second.promise;
    f.finish(second, next);
    await second.coordinator.release();
    assert.equal(f.store.readAllPluginStorage(f.namespace).revision, 2);
    assert.equal(f.store.snapshot("b").messages.length, 2);
  },
);
test(
  "a failed native provider discards original plugin staged memory instead of publishing a boot checkpoint",
  actual,
  async (t) => {
    const f = await fixture(t),
      before = f.store.readAllPluginStorage(f.namespace),
      failed = f.start("failed", "a", { providerFailure: true });
    await assert.rejects(failed.promise);
    assert.equal(failed.requests.length, 1);
    f.store.finishJob(
      failed.id,
      failed.claimed.job.owner,
      failed.claimed.job.fence,
      { state: "failed", result: { code: "SYNTHETIC_PROVIDER_FAILURE" } },
    );
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM plugin_storage_commits")
        .get().count,
      1,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT lease_token FROM plugin_storage_namespaces")
        .get().lease_token,
      null,
    );
  },
);
test(
  "cancellation after complete native output rolls back both graph and chat without a plugin receipt",
  actual,
  async (t) => {
    const f = await fixture(t),
      before = f.store.readAllPluginStorage(f.namespace),
      task = f.start("cancelled", "a"),
      outcome = await task.promise;
    assert.ok(outcome.pluginStorage.writes.length);
    f.store.requestCancel(task.id);
    assert.throws(() => f.finish(task, outcome), { code: "CANCEL_REQUESTED" });
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM plugin_storage_commits")
        .get().count,
      1,
    );
    f.store.finishJob(task.id, task.claimed.job.owner, task.claimed.job.fence, {
      state: "cancelled",
      result: { code: "CANCEL_REQUESTED" },
    });
    await task.coordinator.release();
  },
);
test(
  "cancelling during native generation stops the request and leaves graph/chat unchanged",
  actual,
  async (t) => {
    const f = await fixture(t),
      before = f.store.readAllPluginStorage(f.namespace),
      gate = deferred(),
      task = f.start("mid-flight", "a", { providerGate: gate });
    await task.providerStarted.promise;
    f.store.requestCancel(task.id);
    task.controller.abort(new Error("Synthetic in-flight cancellation"));
    await assert.rejects(task.promise);
    f.store.finishJob(task.id, task.claimed.job.owner, task.claimed.job.fence, {
      state: "cancelled",
      result: { code: "SYNTHETIC_CANCEL" },
    });
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.store.snapshot("a").messages.length, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT lease_token FROM plugin_storage_namespaces")
        .get().lease_token,
      null,
    );
  },
);
