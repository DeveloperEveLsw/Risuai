"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, request } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
  readWygloreFixture,
} = require("../native/wygloreContract.cjs");

const artifact =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  timeout: 30000,
  skip: existsSync(artifact)
    ? false
    : "Fetch the pinned public WygLore fixture before compatibility validation",
};

async function until(read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw Error(
    "Synthetic WygLore service condition did not settle: " +
      JSON.stringify(
        last && typeof last === "object"
          ? { state: last.state, progress: last.progress, result: last.result }
          : last,
      ),
  );
}
function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function delta(text) {
  return (
    "data: " +
    JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) +
    "\n\n"
  );
}

async function fixture(t, options = {}) {
  const requests = [],
    errors = [];
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      let encoded = "";
      for await (const part of req) encoded += part;
      const body = JSON.parse(encoded);
      assert.equal(body.model, "synthetic-model");
      requests.push(body);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta("The blue "));
      }
      if (requests.length === 1) await options.firstProviderBarrier?.promise;
      if (body.stream) res.end(delta("flowers bloom.") + "data: [DONE]\n\n");
      else {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "The blue flowers bloom." } }],
          }),
        );
      }
    } catch (error) {
      errors.push(error);
      if (!res.destroyed) {
        res.statusCode = 500;
        res.end("Synthetic provider fixture failed");
      }
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "risu-wyglore-service-")),
    file = join(directory, "state.sqlite");
  const f = { requests, errors, file, processIds: [] };
  t.after(async () => {
    options.firstProviderBarrier?.release();
    await f.runtime?.close();
    await new Promise((resolve) => {
      provider.close(resolve);
      provider.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  });
  f.restart = async () => {
    await f.runtime?.close();
    f.runtime = await createRuntimeService({
      file,
      initialize: true,
      eventsPollMs: 20,
      scheduler: {
        ...(options.reviewedPlugins === undefined
          ? {}
          : { reviewedPlugins: options.reviewedPlugins }),
        concurrency: 1,
        pollMs: 20,
        progressIntervalMs: 25,
        onError: (error) => errors.push(error),
      },
    });
    const factory = f.runtime.scheduler.workerFactory;
    f.runtime.scheduler.workerFactory = (claimed) => {
      const worker = factory(claimed);
      f.processIds.push(worker.pid);
      return worker;
    };
  };
  await f.restart();
  f.api = async (path, data) => {
    const response = await fetch(
      f.runtime.url + "/api/runtime" + path,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const command = (requestId, command) =>
    f.api("/commands", { requestId, command });
  const previous = await f.runtime.store.call(
    "getResource",
    "settings",
    "global",
  );
  await command("synthetic-settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: previous.revision,
    payload: {
      ...previous.payload,
      aiModel: "reverse_proxy",
      pluginIds: ["wyglore"],
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: !!options.streaming,
      streamingDisplayOptimizationMode: "balanced",
      maxContext: 8000,
      maxResponse: 200,
      mainPrompt: "Help the synthetic gardener.",
      jailbreak: "",
    },
  });
  await command("synthetic-plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      enabled: true,
      script: await readWygloreFixture(artifact),
      realArg: {},
    },
  });
  await command("synthetic-character", {
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
      chatId: "chat",
      metadata: { name: "Synthetic garden", localLore: [] },
    },
  });
  const plugin = await f.runtime.store.call("getResource", "plugin", "wyglore");
  f.namespace = {
    pluginId: "wyglore",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: plugin.entityEpoch,
  };
  const lease = await f.runtime.store.call("claimPluginStorage", {
    namespace: f.namespace,
    writerId: "synthetic-config",
    authority: { kind: "browser" },
  });
  await f.runtime.store.call("commitPluginStorage", {
    lease,
    expectedRevision: 0,
    commitId: "synthetic-config",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          canonicalIngestEnabled: true,
          speedMode: "fast",
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  await f.runtime.store.call("releasePluginStorage", lease);
  f.payload = (id) => ({
    requestId: id,
    command: {
      type: "send",
      chatId: "chat",
      input: "Green, tell me about the flowers.",
      messageId: "input:" + id,
    },
  });
  f.send = (id) => f.api("/jobs", f.payload(id));
  f.finished = (id) =>
    until(
      () => f.api("/jobs/" + id),
      (job) => !["queued", "running"].includes(job.state),
    );
  f.idle = () =>
    until(
      () => Promise.resolve(f.runtime.scheduler.running.size),
      (count) => count === 0,
    );
  f.graph = () => f.runtime.store.call("readAllPluginStorage", f.namespace);
  f.chat = () => f.runtime.store.call("snapshot", "chat");
  f.released = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (
        db
          .prepare(
            "SELECT lease_token IS NULL AS released FROM plugin_storage_namespaces WHERE plugin_id='wyglore'",
          )
          .get().released === 1
      );
    } finally {
      db.close();
    }
  };
  return f;
}

test(
  "default isolated service admission rejects the active original plugin before any provider request",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.send("default-disabled");
    const job = await f.finished("default-disabled");
    assert.equal(job.state, "failed");
    assert.match(
      job.result.message,
      /server plugin host is required|Server plugin execution capability/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal((await f.graph()).revision, 1);
    assert.equal((await f.chat()).messages.length, 0);
    await f.idle();
    assert.equal(f.released(), true);
    assert.deepEqual(f.errors, []);
  },
);

for (const streaming of [false, true])
  test(
    `isolated service original-plugin ${streaming ? "streaming" : "non-streaming"} injection commits atomically and survives a service/process restart`,
    actual,
    async (t) => {
      const firstProviderBarrier = barrier(),
        f = await fixture(t, {
          streaming,
          reviewedPlugins: true,
          firstProviderBarrier,
        });
      await f.send("first");
      await until(
        () => Promise.resolve(f.requests.length),
        (count) => count === 1,
      );
      const entry = f.runtime.scheduler.running.get("first");
      assert.ok(entry?.worker.pid);
      assert.notEqual(entry.worker.pid, process.pid);
      const firstPid = entry.worker.pid;
      assert.equal((await f.graph()).revision, 1);
      assert.equal(
        (await f.chat()).messages.length,
        0,
        "Streaming progress cannot become canonical before plugin checkpoint completion",
      );
      assert.match(
        f.requests[0].messages.map((message) => message.content).join("\n"),
        /WygLore Leaf — canonical layer/,
      );
      assert.match(
        f.requests[0].messages.map((message) => message.content).join("\n"),
        /Green tends blue flowers/,
      );
      if (streaming) {
        assert.equal(f.requests[0].stream, true);
        await until(
          () => f.api("/jobs/first"),
          (job) =>
            job.progress?.messages?.some(
              (message) =>
                message.role === "char" && message.data?.trim() === "The blue",
            ),
        );
      }
      firstProviderBarrier.release();
      const first = await f.finished("first");
      assert.equal(first.state, "completed", JSON.stringify(first.result));
      assert.equal(first.result.providerCalls, 1);
      await f.idle();
      assert.equal(
        f.released(),
        true,
        "The native process finally released its plugin writer lease",
      );
      const graph = await f.graph(),
        chat = await f.chat();
      assert.equal(graph.revision, 2);
      assert.equal(chat.messages.length, 2);
      assert.equal(
        chat.messages.at(-1).message.data,
        "The blue flowers bloom.",
      );
      const marker = chat.chat.metadata.localLore.find(
        (row) => row.key === "__wl_marker__",
      );
      assert.ok(
        marker,
        "The original plugin persisted its canonical ownership marker",
      );
      const firstMarker = JSON.parse(marker.content);
      assert.ok(firstMarker.unitCount > 0);
      await f.restart();
      assert.deepEqual(
        await f.graph(),
        graph,
        "Restart restored the exact persisted original-plugin graph",
      );
      assert.equal(f.released(), true);
      await f.send("second");
      const second = await f.finished("second");
      assert.equal(second.state, "completed", JSON.stringify(second.result));
      await f.idle();
      assert.equal(f.requests.length, 2);
      assert.match(
        f.requests[1].messages.map((message) => message.content).join("\n"),
        /WygLore Leaf — canonical layer/,
      );
      assert.match(
        f.requests[1].messages.map((message) => message.content).join("\n"),
        /Green tends blue flowers/,
      );
      const next = await f.chat();
      assert.equal(next.messages.length, 4);
      assert.equal((await f.graph()).revision, 3);
      assert.equal(
        JSON.parse(
          next.chat.metadata.localLore.find(
            (row) => row.key === "__wl_marker__",
          ).content,
        ).webKey,
        firstMarker.webKey,
      );
      assert.equal(f.released(), true);
      assert.equal(f.runtime.scheduler.running.size, 0);
      assert.deepEqual(f.processIds.slice(0, 1), [firstPid]);
      assert.equal(f.processIds.length, 2);
      assert.notEqual(
        f.processIds[1],
        firstPid,
        "Each job restarted the original plugin in a fresh isolated process",
      );
      assert.notEqual(f.processIds[1], process.pid);
      assert.deepEqual(f.errors, []);
    },
  );

test(
  "discarded HTTP acknowledgement and disconnected event tab leave the original-plugin job running for a second client",
  actual,
  async (t) => {
    const firstProviderBarrier = barrier(),
      f = await fixture(t, {
        streaming: true,
        reviewedPlugins: true,
        firstProviderBarrier,
      });
    const cursor = (await f.chat()).cursor;
    const tab = new AbortController();
    const feed = await fetch(
      f.runtime.url + "/api/runtime/events?after=" + cursor,
      { signal: tab.signal },
    );
    assert.equal(feed.status, 200);
    await new Promise((resolve, reject) => {
      const connection = request(
        f.runtime.url + "/api/runtime/jobs",
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          assert.equal(response.statusCode, 202);
          response.destroy();
          connection.destroy();
          resolve();
        },
      );
      connection.on("error", reject);
      connection.end(JSON.stringify(f.payload("tab-left")));
    });
    await until(
      () => Promise.resolve(f.requests.length),
      (count) => count === 1,
    );
    tab.abort();
    await feed.body.cancel().catch(() => {});
    const anotherClient = await f.api("/jobs/tab-left");
    assert.equal(anotherClient.state, "running");
    assert.equal(anotherClient.cancelRequested, false);
    assert.equal((await f.graph()).revision, 1);
    firstProviderBarrier.release();
    const completed = await f.finished("tab-left");
    assert.equal(
      completed.state,
      "completed",
      JSON.stringify(completed.result),
    );
    assert.equal(
      (await f.chat()).messages.at(-1).message.data,
      "The blue flowers bloom.",
    );
    assert.equal((await f.graph()).revision, 2);
    const retry = await f.api("/jobs", f.payload("tab-left"));
    assert.equal(retry.job.state, "completed");
    assert.equal(
      f.requests.length,
      1,
      "The other client's acknowledgement retry cannot replay a provider request",
    );
    await f.idle();
    assert.equal(f.released(), true);
    assert.deepEqual(f.errors, []);
  },
);
