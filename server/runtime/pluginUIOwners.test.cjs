"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { parse } = require("node-html-parser");
const { createRuntimeService } = require("./service.cjs");
const {
  WYGLORE_RELEASE,
  getWygloreRelease,
  defaultWygloreFixturePath,
  readWygloreFixture,
} = require("../native/wygloreContract.cjs");

const artifact =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: existsSync(artifact)
    ? false
    : "Fetch the pinned public WygLore fixture before compatibility validation",
  timeout: 20000,
};

async function until(read, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (predicate(result)) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error("Synthetic plugin UI owner condition did not settle");
}

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function seedGenericSource(f, kind) {
  await f.runtime.store.call("enqueueJob", "synthetic-generic-source", {
    type: "send",
    chatId: "chat",
    input: "A safe synthetic input.",
    messageId: "synthetic-source-input",
  });
  const claimed = await f.runtime.store.call(
    "claimJob",
    "synthetic-fixture-worker",
  );
  assert.equal(claimed.job.id, "synthetic-generic-source");
  await f.runtime.store.call(
    "finishJob",
    claimed.job.id,
    "synthetic-fixture-worker",
    claimed.job.fence,
    kind === "retry"
      ? {
          state: "failed",
          result: {
            code: "SYNTHETIC_ERROR",
            message: "Synthetic failed invocation",
          },
        }
      : {
          state: "completed",
          messages: [
            {
              id: "synthetic-cached-reply",
              message: {
                role: "char",
                data: "The synthetic blue flowers are blooming.",
                generationInfo: {
                  generationId: "synthetic-cache",
                  model: "synthetic",
                },
              },
            },
          ],
          result: {
            rerolls: {
              "synthetic-cache": ["The synthetic blue flowers are blooming."],
            },
          },
        },
  );
}

async function genericCommand(f, kind) {
  if (kind === "retry") {
    const preview = await f.runtime.store.call(
      "previewJobResult",
      "synthetic-generic-source",
    );
    assert.equal(preview.canRetry, true);
    return { type: "retry-job-result", ...preview.target };
  }
  const message = (await f.chat()).messages.find(
    (row) => row.id === "synthetic-cached-reply",
  );
  const choices = await f.runtime.store.call(
    "readReplyChoices",
    "chat",
    message.id,
    message.revision,
    0,
  );
  assert.equal(choices.count, 1);
  return { type: "move-reply-choice", ...choices.target, direction: "next" };
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "risu-plugin-ui-owners-")),
    file = join(directory, "state.sqlite"),
    requests = [];
  const provider = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "Unexpected synthetic UI provider request" }),
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const f = { file, directory, requests, errors: [] };
  t.after(async () => {
    await f.runtime?.close();
    await new Promise((resolve) => {
      provider.close(resolve);
      provider.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  });
  f.runtime = await createRuntimeService({
    file,
    initialize: true,
    scheduler: {
      reviewedPlugins: options.reviewedPlugins ?? true,
      // Tests enqueue directly to keep generation out of owner lifecycle checks.
      pollMs: 60000,
      onError: (error) => f.errors.push(error),
    },
  });
  f.serverId = (await f.runtime.store.call("bootstrap")).serverId;
  f.request = async (
    path,
    { data, method, ownerToken, serverId = f.serverId } = {},
  ) => {
    const response = await fetch(f.runtime.url + "/api/runtime" + path, {
      method: method ?? (data === undefined ? "GET" : "POST"),
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(serverId === null ? {} : { "risu-runtime-id": serverId }),
        ...(ownerToken === undefined
          ? {}
          : { "risu-plugin-owner": ownerToken }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, result: await response.json() };
  };
  f.expectError = async (path, request, code, status) => {
    const result = await f.request(path, request);
    assert.equal(
      result.result.error?.code,
      code,
      JSON.stringify(result.result),
    );
    if (status !== undefined) assert.equal(result.status, status);
    assert.ok(result.status >= 400);
    return result.result.error;
  };
  const command = (id, body) => f.runtime.store.call("applyCommand", id, body);
  const settings = await f.runtime.store.call(
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
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      requestRetrys: 0,
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-key",
      mainPrompt: "Help the synthetic gardener.",
    },
  });
  await command("plugin", {
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
  await command("character", {
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
  await command("chat-two", {
    type: "create-chat",
    characterId: "garden",
    chatId: "chat-two",
    metadata: { name: "Other synthetic garden", localLore: [] },
  });
  await command("other-character", {
    type: "create-character",
    characterId: "red-garden",
    definition: {
      type: "character",
      name: "Red",
      desc: "Red tends green leaves.",
      firstMessage: "Welcome to the other garden.",
      globalLore: [],
      triggerscript: [],
    },
    chat: {
      chatId: "red-chat",
      metadata: { name: "Other safe garden", localLore: [] },
    },
  });
  const plugin = await f.runtime.store.call("getResource", "plugin", "wyglore");
  f.namespace = {
    pluginId: "wyglore",
    bundleSha: getWygloreRelease(plugin.payload.script).sha256,
    pluginEpoch: plugin.entityEpoch,
  };
  const lease = await f.runtime.store.call("claimPluginStorage", {
    namespace: f.namespace,
    writerId: "synthetic-ui-settings",
    authority: { kind: "browser" },
  });
  await f.runtime.store.call("commitPluginStorage", {
    lease,
    expectedRevision: 0,
    commitId: "synthetic-ui-settings",
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
  f.openBody = { pluginId: "wyglore", chatId: "chat", expectedChatEpoch: 0 };
  f.graph = () => f.runtime.store.call("readAllPluginStorage", f.namespace);
  f.chat = () => f.runtime.store.call("snapshot", "chat");
  f.open = async (body = f.openBody) => {
    const result = await f.request("/plugin-ui", { data: body });
    assert.equal(result.status, 200, JSON.stringify(result.result));
    return result.result;
  };
  f.close = async (owner) => {
    const result = await f.request(`/plugin-ui/${owner.sessionId}/close`, {
      method: "POST",
      ownerToken: owner.ownerToken,
    });
    assert.equal(result.status, 200, JSON.stringify(result.result));
    assert.deepEqual(result.result, { closed: true, background: false });
  };
  return f;
}

function event(snapshot, node, type = "click", extra = {}) {
  assert.ok(node, "Original UI exposes the requested registered control");
  return {
    scope: snapshot.scope,
    revision: snapshot.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: node.getAttribute("data-risu-plugin-node"),
    type,
    ...extra,
  };
}

async function backupPanel(f, owner) {
  let view = owner.snapshot;
  for (const find of [
    (root) => root.querySelector('button[data-tab="dataRecovery"]'),
    (root) =>
      root
        .querySelectorAll("button")
        .find((node) => node.textContent.trim() === "백업 · 정리"),
  ]) {
    const response = await f.request(`/plugin-ui/${owner.sessionId}/event`, {
      ownerToken: owner.ownerToken,
      data: event(view, find(parse(view.html))),
    });
    assert.equal(response.status, 200, JSON.stringify(response.result));
    view = response.result.snapshot;
  }
  return view;
}

function backupButton(view, label) {
  return event(
    view,
    parse(view.html)
      .querySelectorAll("button")
      .find((node) => node.textContent.trim() === label),
  );
}

async function pendingEffect(f, owner, kind) {
  return until(async () => {
    const response = await f.request(`/plugin-ui/${owner.sessionId}`, {
      ownerToken: owner.ownerToken,
    });
    assert.equal(response.status, 200, JSON.stringify(response.result));
    return response.result.effects?.find((effect) => effect.kind === kind);
  }, Boolean);
}

function artifactURL(f, owner, effect) {
  return (
    f.runtime.url +
    `/api/runtime/plugin-ui/${owner.sessionId}/artifact/${effect.id}?eventId=${encodeURIComponent(effect.eventId)}`
  );
}

test(
  "original exports expose private artifacts only after their complete HTTP checkpoint and owner-scoped acknowledgement",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backupPanel(f, owner);
    const request = backupButton(view, "설정만 내보내기");
    const completed = await f.request(`/plugin-ui/${owner.sessionId}/event`, {
      ownerToken: owner.ownerToken,
      data: request,
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.result));
    const effect = completed.result.snapshot.effects.find(
      (item) => item.kind === "download",
    );
    assert.ok(effect);
    assert.equal(effect.eventId, request.eventId);
    const receipt = await f.runtime.store.call("readPluginUIEvent", {
      eventId: request.eventId,
      sessionId: owner.sessionId,
    });
    assert.equal(receipt.state, "completed");
    const headers = {
      "risu-runtime-id": f.serverId,
      "risu-plugin-owner": owner.ownerToken,
    };
    for (const replacement of [
      { "risu-plugin-owner": "forged" },
      { "risu-runtime-id": "foreign" },
    ]) {
      const response = await fetch(artifactURL(f, owner, effect), {
        headers: { ...headers, ...replacement },
      });
      assert.equal(
        response.status,
        replacement["risu-plugin-owner"] ? 403 : 409,
      );
    }
    const response = await fetch(artifactURL(f, owner, effect), { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, effect.bytes);
    assert.ok(JSON.parse(bytes.toString("utf8")));
    const repeated = await fetch(artifactURL(f, owner, effect), { headers });
    assert.equal(repeated.status, 200);
    assert.deepEqual(Buffer.from(await repeated.arrayBuffer()), bytes);
    const resolved = await f.request(`/plugin-ui/${owner.sessionId}/effect`, {
      ownerToken: owner.ownerToken,
      data: {
        effectId: effect.id,
        eventId: effect.eventId,
        kind: "download",
        received: true,
      },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.result));
    assert.deepEqual(resolved.result, {
      effectId: effect.id,
      eventId: effect.eventId,
      kind: "download",
      resolved: true,
    });
    const closed = await fetch(artifactURL(f, owner, effect), { headers });
    assert.equal(closed.status, 409);
    assert.deepEqual(f.requests, []);
    await f.close(owner);
  },
);

test(
  "an original pending file import rejects a forged owner and wrong event, accepts one scoped cancellation, and keeps canonical graph unchanged",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backupPanel(f, owner);
    const graph = await f.graph(),
      chat = await f.chat();
    const request = backupButton(view, "설정만 가져오기");
    const submitted = f.request(`/plugin-ui/${owner.sessionId}/event`, {
      ownerToken: owner.ownerToken,
      data: request,
    });
    const effect = await pendingEffect(f, owner, "file");
    assert.equal(effect.eventId, request.eventId);
    for (const invalid of [
      {
        ownerToken: "forged",
        data: {
          effectId: effect.id,
          eventId: request.eventId,
          kind: "file",
          file: null,
        },
        code: "FORBIDDEN",
      },
      {
        ownerToken: owner.ownerToken,
        data: {
          effectId: effect.id,
          eventId: "plugin-ui:" + randomUUID(),
          kind: "file",
          file: null,
        },
        code: "INVALID_PLUGIN_UI_EFFECT",
      },
    ]) {
      await f.expectError(
        `/plugin-ui/${owner.sessionId}/effect`,
        invalid,
        invalid.code,
      );
    }
    const answer = {
      effectId: effect.id,
      eventId: request.eventId,
      kind: "file",
      file: null,
    };
    const cancelled = await f.request(`/plugin-ui/${owner.sessionId}/effect`, {
      ownerToken: owner.ownerToken,
      data: answer,
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.result));
    const completed = await submitted;
    assert.equal(completed.status, 200, JSON.stringify(completed.result));
    assert.deepEqual(await f.graph(), graph);
    assert.deepEqual(await f.chat(), chat);
    const repeated = await f.request(`/plugin-ui/${owner.sessionId}/effect`, {
      ownerToken: owner.ownerToken,
      data: answer,
    });
    // The cancelled original realm is either detached or already reaped. Both
    // states reject a second response without entering the handler again.
    assert.ok(
      ["PLUGIN_UI_CLOSED", "FORBIDDEN"].includes(repeated.result.error?.code),
    );
    assert.equal(
      repeated.status,
      repeated.result.error.code === "FORBIDDEN" ? 403 : 409,
    );
    assert.deepEqual(await f.graph(), graph);
    assert.deepEqual(f.requests, []);
  },
);

for (const closeKind of ["close", "generation"])
  test(
    `pending original file selection is cancelled promptly when ${closeKind === "close" ? "the browser owner closes" : "a new generation is admitted"}`,
    actual,
    async (t) => {
      const f = await fixture(t),
        owner = await f.open(),
        view = await backupPanel(f, owner);
      const graph = await f.graph();
      const submitted = f.request(`/plugin-ui/${owner.sessionId}/event`, {
        ownerToken: owner.ownerToken,
        data: backupButton(view, "전체 가져오기 (뜰 포함)"),
      });

      await pendingEffect(f, owner, "file");
      const started = Date.now();
      if (closeKind === "close") {
        const closed = await f.request(`/plugin-ui/${owner.sessionId}/close`, {
          ownerToken: owner.ownerToken,
          method: "POST",
        });
        assert.equal(closed.status, 200);
        assert.deepEqual(closed.result, { closed: true, background: true });
      } else {
        f.runtime.scheduler.kick = () => {};
        const accepted = await f.request("/jobs", {
          data: {
            requestId: "after-file-selection",
            command: {
              type: "send",
              chatId: "red-chat",
              input: "Red, hello.",
              messageId: "after-file-input",
            },
          },
        });
        assert.equal(accepted.status, 202, JSON.stringify(accepted.result));
        assert.equal(accepted.result.job.state, "queued");
      }
      const completed = await submitted;
      assert.equal(completed.status, 200, JSON.stringify(completed.result));
      await until(
        () => f.runtime.pluginOwners.sessions.size,
        (size) => size === 0,
      );
      assert.ok(
        Date.now() - started < 4000,
        "waiting for a detached picker cannot stall the global writer",
      );
      assert.deepEqual(await f.graph(), graph);
      assert.deepEqual(f.requests, []);
    },
  );

test(
  "closing after HTTP admission but before the original picker starts cancels future file interaction without retaining a detached writer",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backupPanel(f, owner);
    const entry = f.runtime.pluginOwners.sessions.get(owner.sessionId),
      originalSend = entry.child.send;
    const entered = barrier(),
      graph = await f.graph();
    let held, cancellationId;
    entry.child.send = function (...args) {
      if (args[0]?.type === "dispatch" && !held) {
        held = args;
        entered.release();
        return true;
      }
      if (args[0]?.type === "cancelEffects") cancellationId = args[0].requestId;
      return originalSend.apply(this, args);
    };
    const submitted = f.request(`/plugin-ui/${owner.sessionId}/event`, {
      ownerToken: owner.ownerToken,
      data: backupButton(view, "설정만 가져오기"),
    });
    try {
      await entered.promise;
      assert.ok(entry.running.size > 0);
      const closed = await f.request(`/plugin-ui/${owner.sessionId}/close`, {
        ownerToken: owner.ownerToken,
        method: "POST",
      });
      assert.equal(closed.status, 200);
      assert.deepEqual(closed.result, { closed: true, background: true });
      await until(
        () => cancellationId && !entry.pending.has(cancellationId),
        Boolean,
      );
      entry.child.send = originalSend;
      originalSend.apply(entry.child, held);
      held = undefined;
      const completed = await submitted;
      assert.equal(completed.status, 200, JSON.stringify(completed.result));
      assert.equal(completed.result.snapshot.visible, false);
      assert.deepEqual(completed.result.snapshot.effects, []);
      await until(
        () => f.runtime.pluginOwners.sessions.size,
        (size) => size === 0,
      );
      assert.deepEqual(await f.graph(), graph);
      assert.deepEqual(f.requests, []);
    } finally {
      entry.child.send = originalSend;
      if (held && entry.child.connected) originalSend.apply(entry.child, held);
    }
  },
);

test(
  "default disabled capability rejects the pinned original before creating a child or calling any provider",
  actual,
  async (t) => {
    const f = await fixture(t, { reviewedPlugins: false });
    const capability = await f.request("/plugins/wyglore/capability");
    assert.deepEqual(capability.result, {
      supported: false,
      enabled: false,
      release: getWygloreRelease(await readWygloreFixture(artifact)).version,
      serverId: f.serverId,
    });
    await f.expectError(
      "/plugin-ui",
      { data: f.openBody },
      "PLUGIN_UNSUPPORTED",
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.equal((await f.graph()).revision, 1);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "capability requires enabled exact reviewed bytes and exposes no source or graph",
  actual,
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.request("/plugins/wyglore/capability")).result.supported,
      true,
    );
    const plugin = await f.runtime.store.call(
      "getResource",
      "plugin",
      "wyglore",
    );
    await f.runtime.store.call("applyCommand", "different-bytes", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: plugin.revision,
      payload: {
        ...plugin.payload,
        script: plugin.payload.script + "\n// Synthetic altered release",
      },
    });
    const capability = (await f.request("/plugins/wyglore/capability")).result;
    assert.equal(capability.supported, false);
    assert.deepEqual(Object.keys(capability).sort(), [
      "enabled",
      "release",
      "serverId",
      "supported",
    ]);
    await f.expectError(
      "/plugin-ui",
      { data: f.openBody },
      "PLUGIN_UNSUPPORTED",
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "opening rejects foreign database identity and raw file/writeSet/source overrides before spawning a child",
  actual,
  async (t) => {
    const f = await fixture(t);
    for (const serverId of [null, "foreign-synthetic-database"])
      await f.expectError(
        "/plugin-ui",
        { data: f.openBody, serverId },
        "SERVER_CHANGED",
        409,
      );
    for (const extra of [
      { file: join(f.directory, "other.sqlite") },
      { writeSet: { chatId: "chat", messages: [] } },
      { pluginStorage: { writes: [{ key: "wl.web.v1", value: "forged" }] } },
      { script: "throw new Error('synthetic')" },
      { providerFetch: "synthetic" },
      { sessionId: "forged-session" },
    ])
      await f.expectError(
        "/plugin-ui",
        { data: { ...f.openBody, ...extra } },
        "INVALID_COMMAND",
        400,
      );
    for (const epoch of [-1, 0.5, "0", null])
      await f.expectError(
        "/plugin-ui",
        { data: { ...f.openBody, expectedChatEpoch: epoch } },
        "INVALID_COMMAND",
        400,
      );
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.equal((await f.graph()).revision, 1);
    assert.equal(existsSync(join(f.directory, "other.sqlite")), false);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "unknown or forged owner tokens cannot read, dispatch or close another owner",
  actual,
  async (t) => {
    const f = await fixture(t),
      id = randomUUID();
    for (const ownerToken of [undefined, "forged-token", randomUUID()]) {
      await f.expectError(`/plugin-ui/${id}`, { ownerToken }, "FORBIDDEN", 403);
      await f.expectError(
        `/plugin-ui/${id}/event`,
        { ownerToken, data: { eventId: "forged" } },
        "FORBIDDEN",
        403,
      );
      await f.expectError(
        `/plugin-ui/${id}/close`,
        { ownerToken, method: "POST" },
        "FORBIDDEN",
        403,
      );
    }
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.equal((await f.graph()).revision, 1);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "child startup rejects a missing chat or stale incarnation and leaves no orphan owner or graph writes",
  actual,
  async (t) => {
    const f = await fixture(t),
      graph = await f.graph();
    await f.expectError(
      "/plugin-ui",
      {
        data: { ...f.openBody, chatId: "absent-synthetic-chat" },
      },
      "NOT_FOUND",
      404,
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    await f.expectError(
      "/plugin-ui",
      {
        data: { ...f.openBody, expectedChatEpoch: 1 },
      },
      "REVISION_CONFLICT",
      409,
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.deepEqual(await f.graph(), graph);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "original UI runs in an isolated owner child; duplicate same-plugin devices stay busy and valid close releases the lease",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open();
    const entry = f.runtime.pluginOwners.sessions.get(owner.sessionId);
    assert.ok(entry.child.pid);
    assert.notEqual(entry.child.pid, process.pid);
    assert.ok(entry.lease?.token);
    assert.equal(JSON.stringify(owner).includes(entry.lease.token), false);
    assert.equal(owner.snapshot.scope.chatId, "chat");
    assert.equal(
      parse(owner.snapshot.html).querySelectorAll("button[data-tab]").length,
      7,
    );
    const graph = await f.graph();
    await f.expectError(
      "/plugin-ui",
      { data: { ...f.openBody, chatId: "chat-two" } },
      "PLUGIN_STORAGE_BUSY",
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 1);
    assert.deepEqual(await f.graph(), graph);
    await f.expectError(
      `/plugin-ui/${owner.sessionId}`,
      { ownerToken: randomUUID() },
      "FORBIDDEN",
      403,
    );
    const forgedToken = randomUUID();
    await f.expectError(
      `/plugin-ui/${owner.sessionId}/event`,
      {
        ownerToken: forgedToken,
        data: { eventId: "forged" },
      },
      "FORBIDDEN",
      403,
    );
    await f.expectError(
      `/plugin-ui/${owner.sessionId}/close`,
      {
        ownerToken: forgedToken,
        method: "POST",
      },
      "FORBIDDEN",
      403,
    );
    assert.equal(f.runtime.pluginOwners.sessions.size, 1);
    const snapshot = await f.request(`/plugin-ui/${owner.sessionId}`, {
      ownerToken: owner.ownerToken,
    });
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.result));
    assert.equal(snapshot.result.scope.sessionId, owner.sessionId);
    const child = entry.child;
    await f.close(owner);
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    const successor = await f.runtime.store.call("claimPluginStorage", {
      namespace: f.namespace,
      writerId: "synthetic-successor",
      authority: { kind: "browser" },
    });
    assert.ok(successor.fence > entry.lease.fence);
    await f.runtime.store.call("releasePluginStorage", successor);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "stale public event scope and raw mutation overrides fail before original callbacks or durable writes",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      graph = await f.graph(),
      chat = await f.chat();
    const snapshot = owner.snapshot,
      button = parse(snapshot.html).querySelector(
        'button[data-tab="settings"]',
      );
    const request = event(snapshot, button);
    await f.expectError(
      `/plugin-ui/${owner.sessionId}/event`,
      {
        ownerToken: owner.ownerToken,
        data: {
          ...request,
          scope: {
            ...request.scope,
            writerFence: request.scope.writerFence + 1,
          },
        },
      },
      "PLUGIN_UI_SCOPE_CHANGED",
    );
    for (const extra of [
      { file: join(f.directory, "forged-event.sqlite") },
      { writeSet: { chatId: "chat", messages: [] } },
      { pluginStorage: { writes: [{ key: "wl.web.v1", value: "forged" }] } },
      { source: "throw new Error('synthetic')" },
    ])
      await f.expectError(
        `/plugin-ui/${owner.sessionId}/event`,
        { ownerToken: owner.ownerToken, data: { ...request, ...extra } },
        "INVALID_PLUGIN_UI_EVENT",
      );
    await f.expectError(
      `/plugin-ui/${owner.sessionId}/event`,
      {
        ownerToken: owner.ownerToken,
        serverId: "foreign-database",
        data: request,
      },
      "SERVER_CHANGED",
      409,
    );
    assert.equal(
      await f.runtime.store.call("readPluginUIEvent", {
        sessionId: owner.sessionId,
        eventId: request.eventId,
      }),
      null,
    );
    assert.deepEqual(await f.graph(), graph);
    assert.deepEqual(await f.chat(), chat);
    assert.equal(existsSync(join(f.directory, "forged-event.sqlite")), false);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "manager yield stops the original UI child before a new generation can acquire its namespace",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      entry = f.runtime.pluginOwners.sessions.get(owner.sessionId);
    const child = entry.child,
      graph = await f.graph();
    f.runtime.scheduler.kick = () => {};
    const admitted = await f.request("/jobs", {
      data: {
        requestId: "synthetic-after-ui",
        command: {
          type: "send",
          chatId: "chat",
          input: "Green, hello.",
          messageId: "synthetic-input",
        },
      },
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.result));
    assert.equal(admitted.result.job.state, "queued");
    assert.equal(f.runtime.pluginOwners.sessions.size, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await f.expectError(
      `/plugin-ui/${owner.sessionId}`,
      { ownerToken: owner.ownerToken },
      "FORBIDDEN",
      403,
    );
    assert.deepEqual(await f.graph(), graph);
    const lease = await f.runtime.store.call("claimPluginStorage", {
      namespace: f.namespace,
      writerId: "synthetic-after-yield",
      authority: { kind: "browser" },
    });
    assert.ok(lease.fence > entry.lease.fence);
    await f.runtime.store.call("releasePluginStorage", lease);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "idle orphan sweep terminates the original UI process and releases private writer ownership",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      entry = f.runtime.pluginOwners.sessions.get(owner.sessionId);
    f.runtime.pluginOwners.options.idleMs = 20;
    entry.usedAt = Date.now() - 100;
    await until(
      () => Promise.resolve(f.runtime.pluginOwners.sessions.size),
      (size) => size === 0,
    );
    assert.ok(entry.child.exitCode !== null || entry.child.signalCode !== null);
    const lease = await f.runtime.store.call("claimPluginStorage", {
      namespace: f.namespace,
      writerId: "synthetic-after-orphan",
      authority: { kind: "browser" },
    });
    assert.ok(lease.fence > entry.lease.fence);
    await f.runtime.store.call("releasePluginStorage", lease);
    assert.deepEqual(f.requests, []);
  },
);

test(
  "abrupt owner process loss releases the fenced lease and never admits calls through its old token",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      entry = f.runtime.pluginOwners.sessions.get(owner.sessionId),
      graph = await f.graph();
    entry.child.kill("SIGKILL");
    try {
      await until(
        () => Promise.resolve(f.runtime.pluginOwners.sessions.size),
        (size) => size === 0,
      );
    } catch (error) {
      // Keep a broken exit waiter from hanging unrelated test teardown. The
      // assertion still fails, and only this test-owned dead entry is removed.
      f.runtime.pluginOwners.sessions.delete(owner.sessionId);
      if (entry.lease)
        await f.runtime.store.call("releasePluginStorage", entry.lease);
      throw error;
    }
    await f.expectError(
      `/plugin-ui/${owner.sessionId}/event`,
      {
        ownerToken: owner.ownerToken,
        data: { eventId: "forged" },
      },
      "FORBIDDEN",
      403,
    );
    assert.deepEqual(await f.graph(), graph);
    const lease = await f.runtime.store.call("claimPluginStorage", {
      namespace: f.namespace,
      writerId: "synthetic-after-process-loss",
      authority: { kind: "browser" },
    });
    assert.ok(lease.fence > entry.lease.fence);
    await f.runtime.store.call("releasePluginStorage", lease);
    assert.deepEqual(f.requests, []);
  },
);

for (const drain of ["close", "generation", "command-retry", "command-choice"])
  test(
    `accepted original dispatch survives polling loss and idle sweep; ${drain} drains it before terminating its child`,
    actual,
    async (t) => {
      const f = await fixture(t);
      const kind = drain === "command-retry" ? "retry" : "choice";
      if (drain.startsWith("command-")) await seedGenericSource(f, kind);
      const owner = await f.open(),
        entry = f.runtime.pluginOwners.sessions.get(owner.sessionId),
        graph = await f.graph(),
        request = event(
          owner.snapshot,
          parse(owner.snapshot.html).querySelector(
            'button[data-tab="settings"]',
          ),
        ),
        command = drain.startsWith("command-")
          ? await genericCommand(f, kind)
          : null;
      f.runtime.scheduler.kick = () => {};
      let resumed = false,
        dispatch,
        drained;
      entry.child.kill("SIGSTOP");
      try {
        dispatch = f.request(`/plugin-ui/${owner.sessionId}/event`, {
          data: request,
          ownerToken: owner.ownerToken,
        });
        // Observe the promise immediately while inspecting the independent
        // owner process so an early transport failure cannot go unhandled.
        void dispatch.catch(() => {});
        await until(
          () => Promise.resolve(entry.pending.size),
          (size) => size === 1,
          500,
        );
        f.runtime.pluginOwners.options.idleMs = 20;
        // No snapshot polling or other owner heartbeat is sent during this gap.
        await delay(1200);
        assert.equal(
          f.runtime.pluginOwners.sessions.get(owner.sessionId),
          entry,
        );
        assert.equal(entry.child.exitCode, null);
        assert.equal(entry.child.signalCode, null);
        assert.deepEqual(await f.graph(), graph);
        let didDrain = false;
        drained = (
          drain === "close"
            ? f.request(`/plugin-ui/${owner.sessionId}/close`, {
                method: "POST",
                ownerToken: owner.ownerToken,
              })
            : drain.startsWith("command-")
              ? f.request("/commands", {
                  data: { requestId: "synthetic-drained-command", command },
                })
              : f.request("/jobs", {
                  data: {
                    requestId: "synthetic-drained-generation",
                    command: {
                      type: "send",
                      chatId: "chat",
                      input: "Green, hello.",
                      messageId: "synthetic-drained-input",
                    },
                  },
                })
        ).then((value) => {
          didDrain = true;
          return value;
        });
        void drained.catch(() => {});
        await delay(30);
        if (drain === "close") {
          const acknowledged = await Promise.race([
            drained,
            delay(300).then(() => {
              throw new Error("Pagehide close did not detach promptly");
            }),
          ]);
          assert.equal(
            acknowledged.status,
            200,
            JSON.stringify(acknowledged.result),
          );
          assert.deepEqual(acknowledged.result, {
            closed: true,
            background: true,
          });
          assert.equal(
            f.runtime.pluginOwners.sessions.get(owner.sessionId),
            entry,
          );
          assert.equal(entry.child.signalCode, null);
        } else {
          assert.equal(
            didDrain,
            false,
            "New generation must wait for the accepted original action",
          );
          if (drain === "generation")
            assert.equal(
              await f.runtime.store.call(
                "getJob",
                "synthetic-drained-generation",
              ),
              null,
            );
          else {
            assert.equal(
              (await f.runtime.store.call("listJobs", "chat", 50)).filter(
                (job) => ["queued", "running"].includes(job.state),
              ).length,
              0,
            );
          }
        }
        entry.child.kill("SIGCONT");
        resumed = true;
        const completed = await dispatch;
        assert.equal(completed.status, 200, JSON.stringify(completed.result));
        assert.equal(completed.result.eventId, request.eventId);
        const receipt = await f.runtime.store.call("readPluginUIEvent", {
          eventId: request.eventId,
          sessionId: owner.sessionId,
        });
        assert.equal(receipt.state, "completed");
        assert.equal(receipt.appliedRevision, completed.result.appliedRevision);
        const afterDrain = await drained;
        assert.equal(
          afterDrain.status,
          drain === "generation" ? 202 : 200,
          JSON.stringify(afterDrain.result),
        );
        if (drain === "close")
          assert.deepEqual(afterDrain.result, {
            closed: true,
            background: true,
          });
        else if (drain === "generation")
          assert.equal(afterDrain.result.job.state, "queued");
        else {
          const childId =
            kind === "retry"
              ? afterDrain.result.disposition.resultJobId
              : afterDrain.result.jobId;
          if (kind === "retry")
            assert.equal(afterDrain.result.disposition.action, "retry");
          else assert.equal(afterDrain.result.kind, "generation");
          assert.equal(
            (await f.runtime.store.call("getJob", childId)).state,
            "queued",
          );
        }
        await until(
          () => Promise.resolve(f.runtime.pluginOwners.sessions.size),
          (size) => size === 0,
        );
        assert.equal(f.runtime.pluginOwners.sessions.size, 0);
        assert.ok(
          entry.child.exitCode !== null || entry.child.signalCode !== null,
        );
        assert.deepEqual(f.requests, []);
      } finally {
        // A failed assertion must never leave a stopped test-owned process.
        if (
          !resumed &&
          entry.child.exitCode === null &&
          entry.child.signalCode === null
        )
          entry.child.kill("SIGCONT");
        await Promise.allSettled([dispatch, drained].filter(Boolean));
      }
    },
  );

for (const state of ["queued", "running"])
  test(
    `a ${state} generation in another character blocks UI capture before any shared writer is claimed`,
    actual,
    async (t) => {
      const f = await fixture(t),
        graph = await f.graph();
      await f.runtime.store.call("enqueueJob", "other-garden-generation", {
        type: "send",
        chatId: "red-chat",
        input: "Red, hello.",
        messageId: "other-garden-input",
      });
      let claimed;
      if (state === "running")
        claimed = await f.runtime.store.call(
          "claimJob",
          "synthetic-active-worker",
        );
      await f.expectError("/plugin-ui", { data: f.openBody }, "CHAT_BUSY", 409);
      assert.equal(f.runtime.pluginOwners.sessions.size, 0);
      assert.deepEqual(await f.graph(), graph);
      await f.runtime.store.call("requestCancel", "other-garden-generation");
      if (claimed)
        await f.runtime.store.call(
          "finishJob",
          claimed.job.id,
          "synthetic-active-worker",
          claimed.job.fence,
          { state: "cancelled", result: {} },
        );
      const captured = await f.runtime.store.call("capturePluginUI", "chat");
      assert.equal(captured.scope.chatId, "chat");
      assert.deepEqual(f.requests, []);
    },
  );

test(
  "dedicated UI claim rejects generation admitted after capture and preserves the generic lease contract",
  actual,
  async (t) => {
    const f = await fixture(t),
      graph = await f.graph();
    const captured = await f.runtime.store.call("capturePluginUI", "chat");
    assert.equal(captured.scope.chatId, "chat");
    await f.runtime.store.call("enqueueJob", "capture-claim-gap", {
      type: "send",
      chatId: "red-chat",
      input: "Red, hello.",
      messageId: "capture-claim-input",
    });
    const input = {
      namespace: f.namespace,
      writerId: "synthetic-gap-ui",
      authority: { kind: "browser" },
    };
    await assert.rejects(f.runtime.store.call("claimPluginUIStorage", input), {
      code: "CHAT_BUSY",
    });
    assert.deepEqual(await f.graph(), graph);
    const generic = await f.runtime.store.call("claimPluginStorage", {
      ...input,
      writerId: "synthetic-existing-api",
    });
    await f.runtime.store.call("releasePluginStorage", generic);
    await f.runtime.store.call("requestCancel", "capture-claim-gap");
    const uiLease = await f.runtime.store.call("claimPluginUIStorage", input);
    assert.equal(uiLease.writerId, input.writerId);
    await f.runtime.store.call("releasePluginStorage", uiLease);
    assert.deepEqual(f.requests, []);
  },
);

for (const duringCapability of [false, true])
  test(
    `generation barrier covers awaited database admission and ${duringCapability ? "an already-pending capability check" : "a new UI opening"}`,
    actual,
    async (t) => {
      const f = await fixture(t),
        entered = barrier(),
        release = barrier(),
        capabilityEntered = barrier(),
        capabilityRelease = barrier(),
        originalCall = f.runtime.store.call,
        graph = await f.graph();
      f.runtime.scheduler.kick = () => {};
      let capabilityHeld = false,
        opening,
        admission;
      f.runtime.store.call = async function (method, ...args) {
        if (
          duringCapability &&
          !capabilityHeld &&
          method === "getResource" &&
          args[0] === "plugin" &&
          args[1] === "wyglore"
        ) {
          capabilityHeld = true;
          capabilityEntered.release();
          await capabilityRelease.promise;
        }
        if (
          method === "enqueueJob" &&
          args[0] === "synthetic-admission-barrier"
        ) {
          entered.release();
          await release.promise;
        }
        return originalCall.call(this, method, ...args);
      };
      try {
        if (duringCapability) {
          opening = f.request("/plugin-ui", { data: f.openBody });
          void opening.catch(() => {});
          await capabilityEntered.promise;
        }
        admission = f.request("/jobs", {
          data: {
            requestId: "synthetic-admission-barrier",
            command: {
              type: "send",
              chatId: "red-chat",
              input: "Red, hello.",
              messageId: "barrier-input",
            },
          },
        });
        void admission.catch(() => {});
        await entered.promise;
        assert.equal(
          await f.runtime.store.call("getJob", "synthetic-admission-barrier"),
          null,
        );
        if (duringCapability) capabilityRelease.release();
        else opening = f.request("/plugin-ui", { data: f.openBody });
        const blocked = await opening;
        assert.equal(
          blocked.result.error?.code,
          "PLUGIN_UI_CLOSED",
          JSON.stringify(blocked.result),
        );
        assert.equal(f.runtime.pluginOwners.sessions.size, 0);
        assert.deepEqual(await f.graph(), graph);
        release.release();
        const accepted = await admission;
        assert.equal(accepted.status, 202, JSON.stringify(accepted.result));
        assert.equal(accepted.result.job.state, "queued");
        await f.expectError(
          "/plugin-ui",
          { data: f.openBody },
          "CHAT_BUSY",
          409,
        );
        assert.deepEqual(f.requests, []);
      } finally {
        release.release();
        capabilityRelease.release();
        await Promise.allSettled([opening, admission].filter(Boolean));
        f.runtime.store.call = originalCall;
      }
    },
  );
