"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Worker } = require("node:worker_threads");
const { generateKeyPairSync } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createNativeProcessWorker } = require("./processWorker.cjs");
const { NativeScheduler } = require("./scheduler.cjs");

async function fixture(t, response, overrides = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body) });
    await response(res, requests.at(-1), req);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const directory = mkdtempSync(join(tmpdir(), "risu-generation-")),
    file = join(directory, "state.sqlite"),
    store = new EntityStoreClient(file);
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
      desc: "Synthetic definition {{getvar::choice}}",
      firstMessage: "Synthetic greeting",
      customscript: [
        {
          comment: "input",
          in: "marker",
          out: "changed-input",
          type: "editinput",
        },
        {
          comment: "output",
          in: "raw-output",
          out: "processed-output",
          type: "editoutput",
        },
      ],
      globalLore: [
        {
          key: "changed-input",
          content: "Synthetic activated lore",
          insertorder: 100,
          mode: "normal",
          alwaysActive: false,
          secondkey: "",
          selective: false,
        },
      ],
      triggerscript: [
        {
          type: "output",
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'outputDone', 'yes')
  return text .. ':lua'
end)
`,
            },
          ],
        },
      ],
      ...overrides.character,
    },
  });
  await store.call("applyCommand", "chat", {
    type: "create-chat",
    chatId: "a",
    characterId: "c",
    metadata: { name: "Synthetic", localLore: [], ...overrides.chat },
  });
  await store.call("applyCommand", "settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: false,
      streamingDisplayOptimizationMode: "balanced",
      mainPrompt: "Synthetic system {{char}}",
      jailbreak: "",
      maxContext: 8000,
      maxResponse: 200,
      ...overrides.settings,
    },
  });
  return { store, file, requests };
}
function start(t, file, claimed, isolatedProcess = false) {
  const worker = isolatedProcess
      ? createNativeProcessWorker({ file, claimed, diagnostics: true })
      : new Worker(join(__dirname, "extensionWorker.cjs"), {
          workerData: { file, claimed, diagnostics: true },
        }),
    progress = [];
  t.after(() => worker.terminate());
  const done = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.progress) progress.push(message.progress);
      if (message.completed) resolve(message.completed);
      if (message.error) reject(new Error(message.error.message));
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code) reject(new Error(`Worker exit ${code}`));
    });
  });
  return { done, progress, worker };
}

for (const streaming of [false, true]) {
  test(
    `native Vertex dispatch ${streaming ? "streams" : "returns"} through the server transport and saves upstream regex/Lua output`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(
        t,
        async (res) => {
          const item = (text) => ({
            candidates: [{ content: { parts: [{ text }] } }],
          });
          if (streaming) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: " + JSON.stringify(item("raw-")) + "\n\n");
            await new Promise((resolve) => setTimeout(resolve, 150));
            res.end("data: " + JSON.stringify(item("output")) + "\n\n");
          } else {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(item("raw-output")));
          }
        },
        {
          settings: {
            customAPIFormat: 6,
            useStreaming: streaming,
            google: {
              projectId: "synthetic-project",
              accessToken: "synthetic-key",
            },
            vertexAccessToken: "synthetic-token",
            vertexAccessTokenExpires: Date.now() + 60000,
          },
        },
      );
      await f.store.call("enqueueJob", "vertex", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "vertex-input",
      });
      const run = start(
        t,
        f.file,
        await f.store.call("claimJob", "vertex-worker"),
      );
      const result = await run.done;
      assert.equal(result.state, "completed", JSON.stringify(result.result));
      const snapshot = await f.store.call("snapshot", "a");
      assert.equal(snapshot.messages[0].message.data, "changed-input");
      assert.equal(snapshot.messages[1].message.data, "processed-output:lua");
      assert.equal(result.result.providerCalls, 1);
      assert.equal(f.requests.length, 1);
      assert.ok(Array.isArray(f.requests[0].body.contents));
      assert.match(f.requests[0].path, /models\/synthetic-model:/);
      assert.equal(
        snapshot.variables.find((v) => v.key === "$outputDone").value,
        "yes",
      );
      if (streaming) {
        const shown = run.progress
          .filter((e) => e.type === "messages")
          .flatMap((e) => e.messages)
          .filter((m) => m.role === "char");
        assert.ok(shown.length);
        assert.ok(shown.every((m) => m.chatId === snapshot.messages[1].id));
      }
    },
  );
}

test(
  "Vertex stream error events fail without committing a partial chat or replaying generation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"candidates":[{"content":{"parts":[{"text":"raw-"}]}}]}\n\n',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        res.end(
          'data: {"error":{"message":"Synthetic interrupted Vertex response"}}\n\n',
        );
      },
      {
        settings: {
          customAPIFormat: 6,
          useStreaming: true,
          google: {
            projectId: "synthetic-project",
            accessToken: "synthetic-key",
          },
          vertexAccessToken: "synthetic-token",
          vertexAccessTokenExpires: Date.now() + 60000,
        },
      },
    );
    await f.store.call("enqueueJob", "vertex-error", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "vertex-error-input",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "vertex-worker"),
    );
    const result = await run.done;
    assert.equal(result.state, "failed");
    assert.match(
      result.result.message,
      /Google stream failed: Synthetic interrupted Vertex response/,
    );
    const snapshot = await f.store.call("snapshot", "a");
    assert.equal(snapshot.messages.length, 0);
    assert.equal(
      snapshot.variables.find((v) => v.key === "$outputDone"),
      undefined,
    );
    assert.equal(f.requests.length, 1);
  },
);

test(
  "actual native generation delivers both trigger and Lua output alerts without requiring a browser",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) =>
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        ),
      {
        character: {
          triggerscript: [
            {
              type: "start",
              conditions: [],
              effect: [
                {
                  type: "v2ShowAlert",
                  valueType: "value",
                  value: "before provider",
                },
              ],
            },
            {
              type: "output",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `
listenEdit('editOutput', function(id, text, meta)
  alertNormal(id, 'after provider')
  setChatVar(id, 'notified', 'yes')
  return text .. ':notified'
end)`,
                },
              ],
            },
          ],
        },
      },
    );
    await f.store.call("enqueueJob", "notified-generation", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "notified-input",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "engine"),
      true,
    );
    const saved = await run.done;
    assert.equal(saved.state, "completed", JSON.stringify(saved.result));
    assert.equal(f.requests.length, 1);
    const list = await f.store.call("listNotices");
    const messages = await Promise.all(
      list.items.map(
        async (n) => (await f.store.call("readNotice", n.id)).notice.message,
      ),
    );
    assert.deepEqual(messages, ["before provider", "after provider"]);
    const snapshot = await f.store.call("snapshot", "a");
    assert.equal(
      snapshot.messages.at(-1).message.data,
      "processed-output:notified",
    );
    assert.equal(
      snapshot.variables.find((v) => v.key === "$notified").value,
      "yes",
    );
  },
);

test(
  "isolated native processes generate repeatedly and concurrently with the actual Gemma tokenizer and ONNX dependency",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) =>
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        ),
      { settings: { customTokenizer: "gemma" } },
    );
    await f.store.call("applyCommand", "gemma-chat-b", {
      type: "create-chat",
      characterId: "c",
      chatId: "b",
      metadata: { name: "Synthetic B", localLore: [] },
    });
    for (let round = 0; round < 2; round++) {
      for (const chatId of ["a", "b"])
        await f.store.call("enqueueJob", `gemma-${round}-${chatId}`, {
          type: "send",
          chatId,
          input: "marker",
        });
      const runs = [];
      for (let i = 0; i < 2; i++) {
        const claimed = await f.store.call(
          "claimJob",
          "gemma-process-" + round + "-" + i,
        );
        const run = start(t, f.file, claimed, true);
        assert.ok(run.worker.pid);
        assert.notEqual(run.worker.pid, process.pid);
        runs.push(run);
      }
      const result = await Promise.all(runs.map((run) => run.done));
      assert.ok(
        result.every((job) => job.state === "completed"),
        JSON.stringify(result.map((job) => job.result)),
      );
      assert.ok(result.every((job) => job.result.providerCalls === 1));
    }
    assert.equal(f.requests.length, 4);
    for (const chatId of ["a", "b"]) {
      const snap = await f.store.call("snapshot", chatId);
      assert.equal(snap.messages.length, 4);
      assert.ok(
        snap.messages
          .filter((m) => m.message.role === "char")
          .every((m) => m.message.data === "processed-output:lua"),
      );
    }
  },
);

test(
  "isolated process cancellation aborts the provider and durably preserves cancellation without partial messages",
  { timeout: 15000 },
  async (t) => {
    let ready;
    const reached = new Promise((resolve) => {
      ready = resolve;
    });
    const f = await fixture(t, async (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      ready();
      await new Promise((resolve) => res.on("close", resolve));
    });
    await f.store.call("enqueueJob", "process-cancel", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "process-worker"),
      true,
    );
    await reached;
    await f.store.call("requestCancel", "process-cancel");
    run.worker.postMessage({ type: "cancel", jobId: "process-cancel" });
    const result = await run.done;
    assert.equal(result.state, "cancelled", JSON.stringify(result.result));
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "the default scheduler fences a killed native process and never automatically replays its provider request",
  { timeout: 15000 },
  async (t) => {
    let ready;
    const reached = new Promise((resolve) => {
      ready = resolve;
    });
    const f = await fixture(t, async (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      ready();
      await new Promise((resolve) => res.on("close", resolve));
    });
    await f.store.call("enqueueJob", "process-kill", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const scheduler = new NativeScheduler({
      store: f.store,
      file: f.file,
      pollMs: 20,
    });
    t.after(() => scheduler.close());
    await reached;
    const entry = scheduler.running.get("process-kill");
    assert.ok(entry.worker.pid);
    await entry.worker.terminate();
    await entry.done;
    const result = await f.store.call("getJob", "process-kill");
    assert.equal(result.state, "interrupted");
    await scheduler.pump();
    assert.equal(f.requests.length, 1);
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
    await scheduler.close();
  },
);

test(
  "the real composed native job refreshes Vertex OAuth and commits token fields with generated messages",
  { timeout: 15000 },
  async (t) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const f = await fixture(
      t,
      () => {
        throw new Error("Unexpected synthetic HTTP call");
      },
      {
        settings: {
          customAPIFormat: 6,
          vertexClientEmail: "synthetic@test.gserviceaccount.com",
          vertexPrivateKey: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
          vertexAccessTokenExpires: 0,
        },
      },
    );
    await f.store.call("enqueueJob", "vertex-refresh", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "oauth-input",
    });
    const claimed = await f.store.call("claimJob", "oauth-worker");
    const { executeExtensionJob } = await import(
      pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
    );
    const calls = [];
    const execution = await executeExtensionJob(claimed, {
      appVer: "2026.8.250",
      fetch: async (path) =>
        new Response(
          await readFile(join(__dirname, "../../public", path.slice(1))),
        ),
      providerFetch: async (url, init) => {
        calls.push(new URL(url).hostname);
        if (new URL(url).hostname === "oauth2.googleapis.com")
          return Response.json({ access_token: "synthetic-refreshed-token" });
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer synthetic-refreshed-token",
        );
        return Response.json({
          candidates: [{ content: { parts: [{ text: "raw-output" }] } }],
        });
      },
    });
    assert.equal(execution.result.providerCalls, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "oauth2.googleapis.com");
    await f.store.call(
      "finishJob",
      claimed.job.id,
      claimed.job.owner,
      claimed.job.fence,
      { state: "completed", ...execution },
    );
    const snapshot = await f.store.call("snapshot", "a");
    assert.equal(snapshot.messages.at(-1).message.data, "processed-output:lua");
    const settings = (await f.store.call("getResource", "settings", "global"))
      .payload;
    assert.equal(settings.vertexAccessToken, "synthetic-refreshed-token");
    assert.ok(settings.vertexAccessTokenExpires > Date.now());
    assert.equal(
      settings.vertexClientEmail,
      "synthetic@test.gserviceaccount.com",
    );
    assert.equal(f.requests.length, 0);
  },
);

test(
  "cancelling a native Vertex stream preserves durable job cancellation and does not save partial messages",
  { timeout: 15000 },
  async (t) => {
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const f = await fixture(
      t,
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: "Synthetic partial" }] } },
              ],
            }) +
            "\n\n",
        );
        ready();
        await new Promise((resolve) => res.on("close", resolve));
      },
      {
        settings: {
          customAPIFormat: 6,
          useStreaming: true,
          vertexAccessToken: "synthetic-token",
          vertexAccessTokenExpires: Date.now() + 60000,
        },
      },
    );
    await f.store.call("enqueueJob", "vertex-cancel", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "vertex-worker"),
    );
    await started;
    await f.store.call("requestCancel", "vertex-cancel");
    run.worker.postMessage({ type: "cancel", jobId: "vertex-cancel" });
    const result = await run.done;
    assert.equal(result.state, "cancelled", JSON.stringify(result.result));
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "durable message flags feed the actual original native prompt filter: true skips one, allBefore excludes its boundary and greeting, false restores",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "Synthetic reply" } }],
          }),
        );
      },
      { character: { customscript: [], triggerscript: [], globalLore: [] } },
    );
    for (let i = 0; i < 4; i++)
      await f.store.call("applyCommand", "flag-message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "fm" + i,
        message: {
          role: i % 2 === 0 ? "user" : "char",
          data: "Synthetic saved flag marker " + i,
        },
      });
    let commandId = 0;
    const set = async (id, disabled) => {
      const snap = await f.store.call("snapshot", "a");
      await f.store.call("applyCommand", "native-flag-" + ++commandId, {
        type: "set-message-disabled",
        chatId: "a",
        messageId: id,
        expectedRevision: snap.messages.find((m) => m.id === id).revision,
        expectedChatEpoch: snap.chat.entityEpoch,
        disabled,
      });
    };
    const generate = async () => {
      const id = "flag-generate-" + ++commandId;
      await f.store.call("enqueueJob", id, {
        type: "send",
        chatId: "a",
        input: "Synthetic new flag input",
        messageId: "flag-input-" + commandId,
      });
      const run = start(
        t,
        f.file,
        await f.store.call("claimJob", "flag-engine-" + commandId),
      );
      const result = await run.done;
      assert.equal(result.state, "completed", JSON.stringify(result.result));
      return JSON.stringify(f.requests.at(-1).body.messages);
    };
    await set("fm1", true);
    let prompt = await generate();
    assert.doesNotMatch(prompt, /Synthetic saved flag marker 1/);
    assert.match(prompt, /Synthetic saved flag marker 0/);
    assert.match(prompt, /Synthetic greeting/);
    await set("fm2", "allBefore");
    prompt = await generate();
    for (let i = 0; i < 3; i++)
      assert.doesNotMatch(
        prompt,
        new RegExp("Synthetic saved flag marker " + i),
      );
    assert.doesNotMatch(prompt, /Synthetic greeting/);
    assert.match(prompt, /Synthetic saved flag marker 3/);
    await set("fm1", false);
    await set("fm2", false);
    prompt = await generate();
    for (let i = 0; i < 4; i++)
      assert.match(prompt, new RegExp("Synthetic saved flag marker " + i));
    assert.match(prompt, /Synthetic greeting/);
    assert.equal(f.requests.length, 3);
  },
);

test(
  "actual native generation uses upstream input, CBS, lorebook, HTTP provider, output regex and Lua before its atomic commit",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
      );
    });
    await f.store.call("enqueueJob", "generate", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "input-id",
    });
    const run = start(t, f.file, await f.store.call("claimJob", "engine"));
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.model, "synthetic-model");
    const prompt = JSON.stringify(f.requests[0].body.messages);
    assert.match(prompt, /changed-input/);
    assert.match(prompt, /Synthetic activated lore/);
    assert.doesNotMatch(prompt, /\{\{char\}\}/);
    const snapshot = await f.store.call("snapshot", "a");
    assert.equal(snapshot.messages[0].id, "input-id");
    assert.equal(snapshot.messages[0].message.data, "changed-input");
    assert.equal(snapshot.messages[1].message.data, "processed-output:lua");
    assert.equal(
      snapshot.variables.find((v) => v.key === "$outputDone").value,
      "yes",
    );
    assert.equal(result.result.providerCalls, 1);
  },
);

test(
  "a disabled installed plugin does not block real native provider execution",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
      );
    });
    await f.store.call("applyCommand", "disabled-plugin", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "disabled",
      expectedRevision: 0,
      payload: {
        name: "Synthetic disabled",
        version: "3.0",
        enabled: false,
        script: 'throw new Error("Disabled code must never run")',
      },
    });
    await f.store.call("enqueueJob", "disabled-generate", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "disabled-input",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "disabled-engine"),
    );
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(f.requests.length, 1);
  },
);
test(
  "an unreviewed enabled plugin fails before a provider call or message commit",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async () => {
      throw Error("Provider must not be called");
    });
    await f.store.call("applyCommand", "active-plugin", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "active",
      expectedRevision: 0,
      payload: {
        name: "Synthetic active",
        version: "3.0",
        enabled: true,
        script: "Synthetic unreviewed code",
      },
    });
    await f.store.call("enqueueJob", "blocked-generate", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "blocked-input",
    });
    const run = start(
      t,
      f.file,
      await f.store.call("claimJob", "blocked-engine"),
    );
    const result = await run.done;
    assert.equal(result.state, "failed");
    assert.match(result.result.message, /complete server plugin host/);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
  },
);
test(
  "two real generation workers for the same character in different chats finish without bookkeeping conflicts",
  { timeout: 15000 },
  async (t) => {
    let arrived = 0,
      release;
    const bothRequests = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      t,
      async (res) => {
        if (++arrived === 2) release();
        await bothRequests;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
      { settings: { statics: { messages: 5, imports: 2 } } },
    );
    await f.store.call("applyCommand", "chat-b", {
      type: "create-chat",
      chatId: "b",
      characterId: "c",
      metadata: { name: "Synthetic B", localLore: [] },
    });
    const initial = await f.store.call("snapshot", "a");
    const settings = await f.store.call("getResource", "settings", "global");
    for (const chatId of ["a", "b"])
      await f.store.call("enqueueJob", "generate-" + chatId, {
        type: "send",
        chatId,
        input: "marker",
        messageId: "input-" + chatId,
      });
    const a = await f.store.call("claimJob", "engine-a"),
      b = await f.store.call("claimJob", "engine-b");
    assert.equal(a.snapshot.character.revision, b.snapshot.character.revision);
    const workers = [start(t, f.file, a), start(t, f.file, b)];
    const results = await Promise.all(workers.map((worker) => worker.done));
    assert.deepEqual(
      results.map((result) => result.state),
      ["completed", "completed"],
      JSON.stringify(
        results.map((result) => ({
          state: result.state,
          code: result.result.code,
          message: result.result.message,
        })),
      ),
    );
    assert.equal(f.requests.length, 2);
    for (const chatId of ["a", "b"]) {
      const saved = await f.store.call("snapshot", chatId);
      assert.equal(saved.messages[0].id, "input-" + chatId);
      assert.equal(saved.messages[1].message.data, "processed-output:lua");
      assert.ok(saved.character.revision <= initial.character.revision + 1);
      assert.ok(saved.character.activity.lastInteraction > 0);
      assert.equal(saved.character.definition.reloadKeys, undefined);
      assert.equal(saved.character.definition.lastInteraction, undefined);
      assert.equal(
        saved.variables.find((row) => row.key === "$outputDone").value,
        "yes",
      );
    }
    const finalSettings = await f.store.call(
      "getResource",
      "settings",
      "global",
    );
    // The first use may materialize upstream's lazy defaults once. It must not
    // produce a second conflicting replacement from the concurrent job.
    assert.ok(finalSettings.revision <= settings.revision + 1);
    assert.deepEqual(finalSettings.payload.statics, {
      messages: 7,
      imports: 2,
    });
    const normalizedCharacter = (await f.store.call("snapshot", "a")).character;
    for (const chatId of ["a", "b"])
      await f.store.call("enqueueJob", "again-" + chatId, {
        type: "send",
        chatId,
        input: "marker",
        messageId: "next-" + chatId,
      });
    const nextClaims = [
      await f.store.call("claimJob", "engine-a"),
      await f.store.call("claimJob", "engine-b"),
    ];
    const nextResults = await Promise.all(
      nextClaims.map((claimed) => start(t, f.file, claimed).done),
    );
    assert.deepEqual(
      nextResults.map((result) => result.state),
      ["completed", "completed"],
    );
    assert.equal(
      (await f.store.call("snapshot", "a")).character.revision,
      normalizedCharacter.revision,
    );
    const nextSettings = await f.store.call(
      "getResource",
      "settings",
      "global",
    );
    assert.equal(nextSettings.revision, finalSettings.revision);
    assert.equal(nextSettings.payload.statics.messages, 9);
    assert.equal(f.requests.length, 4);
  },
);

test(
  "a streaming provider generation finishes after the admitting client closes with stable progress and final message IDs",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: "raw-" } }],
            }) +
            "\n\n",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: "output" },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      },
      { settings: { useStreaming: true } },
    );
    await f.store.call("enqueueJob", "stream", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "input-id",
    });
    const run = start(t, f.file, await f.store.call("claimJob", "engine"));
    await f.store.close();
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const observer = new EntityStoreClient(f.file);
    t.after(() => observer.close());
    const snapshot = await observer.call("snapshot", "a");
    assert.equal(snapshot.messages[1].message.data, "processed-output:lua");
    const displayed = run.progress
      .filter((e) => e.type === "messages")
      .flatMap((e) => e.messages)
      .filter((m) => m.role === "char");
    assert.ok(displayed.length >= 1);
    assert.ok(displayed.every((m) => m.chatId === snapshot.messages[1].id));
    assert.equal(f.requests.length, 1);
  },
);

test(
  "uncertain provider transport failure never repeats the request or commits provisional effects",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res, _request, req) => {
        req.socket.destroy();
      },
      { settings: { requestRetrys: 4 } },
    );
    await f.store.call("enqueueJob", "uncertain", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "engine"),
    ).done;
    assert.equal(result.state, "failed");
    assert.match(result.result.message, /uncertain/);
    assert.equal(f.requests.length, 1);
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
    assert.equal(await f.store.call("claimJob", "engine"), null);
  },
);

test(
  "a native Claude tokenizer performs real token counts while generating through the same provider pipeline",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
      { settings: { customTokenizer: "claude" } },
    );
    await f.store.call("enqueueJob", "claude-tokenizer", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "engine"),
    ).done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const output = (await f.store.call("snapshot", "a")).messages.at(
      -1,
    ).message;
    assert.equal(output.data, "processed-output:lua");
    assert.ok(Number.isInteger(output.generationInfo.inputTokens));
    assert.ok(output.generationInfo.inputTokens > 0);
  },
);

test(
  "a stored cancellation aborts an active provider read without saving provisional state",
  { timeout: 15000 },
  async (t) => {
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    const f = await fixture(t, async (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      requested();
      await new Promise((resolve) => res.on("close", resolve));
    });
    await f.store.call("enqueueJob", "cancel-generation", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const run = start(t, f.file, await f.store.call("claimJob", "engine"));
    await started;
    await f.store.call("requestCancel", "cancel-generation");
    run.worker.postMessage({ type: "cancel", jobId: "cancel-generation" });
    const result = await run.done;
    assert.equal(result.state, "cancelled", JSON.stringify(result.result));
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "a final shared-settings conflict retains already computed output and never repeats its provider request",
  { timeout: 15000 },
  async (t) => {
    let requested, release;
    const started = new Promise((resolve) => {
        requested = resolve;
      }),
      hold = new Promise((resolve) => {
        release = resolve;
      });
    const f = await fixture(t, async (res) => {
      requested();
      await hold;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
      );
    });
    await f.store.call("enqueueJob", "conflict-generation", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const run = start(t, f.file, await f.store.call("claimJob", "engine"));
    await started;
    const old = await f.store.call("getResource", "settings", "global");
    await f.store.call("applyCommand", "change-settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: old.revision,
      payload: { ...old.payload, temperature: 65 },
    });
    release();
    const result = await run.done;
    assert.equal(result.state, "failed");
    assert.equal(result.result.code, "REVISION_CONFLICT");
    assert.ok(
      result.result.uncommitted.writeSet.messages.some(
        (m) => m.message.data === "processed-output:lua",
      ),
    );
    assert.equal(f.requests.length, 1);
    assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
  },
);

test(
  "the original Responses API handler performs a native HTTP generation and output processing",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "raw-output" }],
              },
            ],
          }),
        );
      },
      { settings: { customAPIFormat: 18 } },
    );
    await f.store.call("enqueueJob", "responses", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "engine"),
    ).done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.ok(Array.isArray(f.requests[0].body.input));
    assert.equal(
      (await f.store.call("snapshot", "a")).messages.at(-1).message.data,
      "processed-output:lua",
    );
    assert.equal(f.requests.length, 1);
  },
);

test(
  "native generation retains output when a peer changes variables read by CBS/Lua, without a second provider call",
  { timeout: 20000 },
  async (t) => {
    let release, reached;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const providerStarted = new Promise((resolve) => {
      reached = resolve;
    });
    t.after(() => release());
    const f = await fixture(
      t,
      async (res) => {
        reached();
        await gate;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
      {
        chat: {
          useLocallySetGlobalVariables: true,
          GLGlobalVariables: { toggle_local: "before" },
        },
        character: {
          triggerscript: [
            {
              type: "output",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'outputDone', 'yes')
  return text .. ':' .. getChatVar(id, 'choice') .. ':' .. getGlobalVar(id, 'globalRead') .. ':' .. getGlobalVar(id, 'toggle_local')
end)
`,
                },
              ],
            },
          ],
        },
      },
    );
    await f.store.call("applyCommand", "before", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$choice",
          expectedRevision: 0,
          value: "before",
        },
        {
          scope: "global",
          key: "globalRead",
          expectedRevision: 0,
          value: "before-global",
        },
      ],
    });
    await f.store.call("enqueueJob", "generation", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "input",
    });
    const claimed = await f.store.call("claimJob", "worker", 30000, {
      includeSnapshot: false,
    });
    const running = start(t, f.file, claimed);
    await providerStarted;
    const result = await f.store.call("applyCommand", "during", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$choice",
          expectedRevision: 1,
          value: "after",
        },
        {
          scope: "chat-global",
          chatId: "a",
          key: "toggle_local",
          expectedRevision: 1,
          value: "after",
        },
        {
          scope: "global",
          key: "globalRead",
          expectedRevision: 1,
          value: "after-global",
        },
      ],
    });
    assert.equal(result.variables.length, 3);
    assert.equal((await f.store.call("getJob", "generation")).state, "running");
    assert.equal(
      (await f.store.call("snapshot", "a")).chat.contentRevision,
      claimed.job.startedContentRevision,
    );
    release();
    const job = await running.done;
    assert.equal(job.state, "failed", JSON.stringify(job.result));
    assert.equal(job.result.code, "REVISION_CONFLICT");
    const saved = await f.store.call("snapshot", "a");
    assert.equal(
      job.result.uncommitted.writeSet.messages.at(-1).message.data,
      "processed-output:before:before-global:before",
    );
    assert.equal(saved.messages.length, 0);
    assert.equal(
      saved.variables.find((row) => row.key === "$choice").value,
      "after",
    );
    assert.equal(
      saved.variables.some((row) => row.key === "$outputDone"),
      false,
    );
    assert.deepEqual(saved.chat.metadata.GLGlobalVariables, {
      toggle_local: "after",
    });
    assert.equal(
      (await f.store.call("getResource", "global-variable", "globalRead"))
        .payload,
      "after-global",
    );
    assert.equal(f.requests.length, 1);
    assert.match(
      JSON.stringify(f.requests[0].body),
      /Synthetic definition before/,
    );
  },
);

test(
  "native output overlapping a concurrently confirmed variable retains its computed result and makes no second provider call",
  { timeout: 20000 },
  async (t) => {
    let release, reached;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const providerStarted = new Promise((resolve) => {
      reached = resolve;
    });
    t.after(() => release());
    const f = await fixture(t, async (res) => {
      reached();
      await gate;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
      );
    });
    await f.store.call("enqueueJob", "overlap", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "input",
    });
    const running = start(
      t,
      f.file,
      await f.store.call("claimJob", "worker", 30000, {
        includeSnapshot: false,
      }),
    );
    await providerStarted;
    await f.store.call("applyCommand", "user-choice", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$outputDone",
          expectedRevision: 0,
          value: "user",
        },
      ],
    });
    assert.equal((await f.store.call("getJob", "overlap")).state, "running");
    release();
    const job = await running.done;
    assert.equal(job.state, "failed");
    assert.equal(job.result.code, "REVISION_CONFLICT");
    assert.ok(
      job.result.uncommitted.writeSet.messages.some(
        (row) => row.message.data === "processed-output:lua",
      ),
    );
    const saved = await f.store.call("snapshot", "a");
    assert.equal(
      saved.variables.find((row) => row.key === "$outputDone").value,
      "user",
    );
    assert.equal(saved.messages.length, 0);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "native generation keeps pinned CBS settings and character reads while field commands confirm and final defaults merge",
  { timeout: 20000 },
  async (t) => {
    let release, reached;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (reached = resolve));
    t.after(() => release());
    const f = await fixture(
      t,
      async (res) => {
        reached();
        await gate;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
      {
        settings: { jailbreakToggle: false },
        character: {
          supaMemory: false,
          triggerscript: [
            {
              type: "output",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'outputDone', 'yes')
  return text .. ':' .. cbs('{{char}}:{{jbtoggled}}')
end)
`,
                },
              ],
            },
          ],
        },
        chat: { note: "before", useLocallySetGlobalVariables: false },
      },
    );
    await f.store.call("enqueueJob", "field-generation", {
      type: "send",
      chatId: "a",
      input: "marker",
    });
    const claimed = await f.store.call("claimJob", "worker", 30000, {
      includeSnapshot: false,
    });
    const running = start(t, f.file, claimed);
    await started;
    const targets = [
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "jailbreakToggle",
      },
      { scope: "character", entityId: "c", key: "name" },
      { scope: "character", entityId: "c", key: "supaMemory" },
      { scope: "chat", entityId: "a", key: "note" },
      { scope: "chat", entityId: "a", key: "useLocallySetGlobalVariables" },
    ];
    const values = [
      true,
      "Synthetic device name",
      true,
      "Synthetic device note",
      true,
    ];
    const before = await f.store.call("readFields", targets);
    await f.store.call("applyCommand", "during-fields", {
      type: "change-fields",
      edits: before.fields.map((field, i) => ({
        ...targets[i],
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: values[i],
      })),
    });
    assert.equal(
      (await f.store.call("getJob", "field-generation")).state,
      "running",
    );
    assert.deepEqual(
      (await f.store.call("readFields", targets)).fields.map(
        (field) => field.value,
      ),
      values,
    );
    release();
    const job = await running.done;
    assert.equal(job.state, "completed", JSON.stringify(job.result));
    const saved = await f.store.call("snapshot", "a");
    assert.equal(
      saved.messages.at(-1).message.data,
      "processed-output:Synthetic:0",
    );
    assert.equal(saved.character.definition.name, "Synthetic device name");
    assert.equal(saved.character.definition.supaMemory, true);
    assert.equal(saved.chat.metadata.note, "Synthetic device note");
    assert.equal(saved.chat.metadata.useLocallySetGlobalVariables, true);
    assert.equal(
      (await f.store.call("getResource", "settings", "global")).payload
        .jailbreakToggle,
      true,
    );
    assert.equal(f.requests.length, 1);
    assert.match(JSON.stringify(f.requests[0].body), /Synthetic definition/);
  },
);

for (const scenario of [
  "trigger-condition",
  "trigger-lua",
  "trigger-equality",
  "trigger-direct-equality",
  "trigger-local-control",
  "trigger-absent",
  "toggle-metadata",
  "unread-toggle-control",
])
  test(
    "native raw variable read: " + scenario,
    { timeout: 20000 },
    async (t) => {
      let release, reached;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        reached = resolve;
      });
      t.after(() => release());
      const toggle = scenario.includes("toggle"),
        unrelated = scenario === "unread-toggle-control",
        localControl = scenario === "trigger-local-control",
        absent = scenario === "trigger-absent";
      const f = await fixture(
        t,
        async (res) => {
          reached();
          await gate;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        },
        {
          character: {
            desc: "Synthetic plain definition",
            defaultVariables: "rawOnly=before",
            triggerscript: toggle
              ? []
              : scenario === "trigger-direct-equality" || localControl
                ? [
                    {
                      type: "output",
                      conditions: [],
                      effect: localControl
                        ? [
                            {
                              type: "v2DeclareLocalVar",
                              indent: 0,
                              var: "rawOnly",
                              valueType: "value",
                              value: "local-before",
                            },
                            {
                              type: "v2SetVar",
                              indent: 0,
                              var: "derived",
                              valueType: "var",
                              value: "rawOnly",
                              operator: "=",
                            },
                          ]
                        : [
                            {
                              type: "v2ToLowerCase",
                              sourceType: "value",
                              source: "BEFORE",
                              outputVar: "rawOnly",
                            },
                          ],
                    },
                  ]
                : scenario === "trigger-equality"
                  ? [
                      {
                        type: "output",
                        conditions: [],
                        effect: [
                          {
                            type: "setvar",
                            var: "rawOnly",
                            operator: "=",
                            value: "before",
                          },
                        ],
                      },
                    ]
                  : scenario !== "trigger-lua"
                    ? [
                        {
                          type: "output",
                          conditions: [
                            {
                              type: "var",
                              var: "rawOnly",
                              operator: "=",
                              value: "before",
                            },
                          ],
                          effect: [
                            {
                              type: "setvar",
                              var: "derived",
                              operator: "=",
                              value: "condition-accepted",
                            },
                          ],
                        },
                      ]
                    : [
                        {
                          type: "output",
                          conditions: [],
                          effect: [
                            {
                              type: "triggerlua",
                              code: `
listenEdit('editOutput', function(id, text, meta)
  local source = getChatVar(id, 'rawOnly')
  setChatVar(id, 'derived', source)
  return text .. ':' .. source
end)`,
                            },
                          ],
                        },
                      ],
          },
          settings: toggle
            ? {
                promptInfoInsideChat: true,
                customPromptTemplateToggle: "rawToggle=Synthetic raw toggle",
              }
            : {},
        },
      );
      const target = toggle
        ? { scope: "global", key: "toggle_rawToggle" }
        : { scope: "chat", chatId: "a", key: "$rawOnly" };
      if (!absent)
        await f.store.call("applyCommand", "raw-before", {
          type: "change-variables",
          edits: [
            { ...target, expectedRevision: 0, value: toggle ? "1" : "before" },
          ],
        });
      await f.store.call("enqueueJob", "raw-generation", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "input",
      });
      const claimed = await f.store.call("claimJob", "worker", 30000, {
        includeSnapshot: false,
      });
      const running = start(t, f.file, claimed);
      await started;
      const peerTarget = unrelated
        ? { scope: "global", key: "toggle_unread" }
        : target;
      await f.store.call("applyCommand", "raw-during", {
        type: "change-variables",
        edits: [
          {
            ...peerTarget,
            expectedRevision: unrelated || absent ? 0 : 1,
            value: toggle ? "0" : "after",
          },
        ],
      });
      release();
      const job = await running.done;
      const saved = await f.store.call("snapshot", "a");
      console.log(
        "raw-read-observation:",
        JSON.stringify({
          scenario,
          state: job.state,
          code: job.result.code,
          canonicalMessages: saved.messages.length,
          providerCalls: f.requests.length,
        }),
      );
      assert.equal(
        job.state,
        unrelated || localControl ? "completed" : "failed",
      );
      if (localControl) {
        assert.equal(
          saved.variables.find((row) => row.key === "$derived").value,
          "local-before",
        );
        assert.equal(saved.messages.length, 2);
      } else if (unrelated) {
        assert.deepEqual(
          saved.messages.at(-1).message.promptInfo.promptToggles,
          [{ key: "Synthetic raw toggle", value: "ON" }],
        );
      } else {
        assert.equal(job.result.code, "REVISION_CONFLICT");
        const read = job.result.uncommitted.writeSet.variableReads.find(
          (read) => read.scope === target.scope && read.key === target.key,
        );
        assert.deepEqual(read, {
          scope: target.scope,
          key: target.key,
          expectedRevision: absent ? 0 : 1,
          expectedExists: !absent,
        });
        assert.equal(saved.messages.length, 0);
        assert.equal(
          saved.variables.some((row) => row.key === "$derived"),
          false,
        );
        if (toggle)
          assert.deepEqual(
            job.result.uncommitted.writeSet.messages.at(-1).message.promptInfo
              .promptToggles,
            [{ key: "Synthetic raw toggle", value: "ON" }],
          );
      }
      assert.equal(
        (await f.store.call("readVariables", [peerTarget])).variables[0].value,
        toggle ? "0" : "after",
      );
      assert.equal(f.requests.length, 1);
    },
  );

for (const scenario of [
  "used-module-delete",
  "used-module-recreate",
  "used-persona-recreate",
  "same-module-edit",
  "unused-module-recreate",
  "used-preset-recreate",
  "same-preset-edit",
])
  test(
    "native resource lifetime: " + scenario,
    { timeout: 25000 },
    async (t) => {
      let release,
        reached,
        gateEnabled = false;
      const gate = new Promise((resolve) => {
          release = resolve;
        }),
        started = new Promise((resolve) => {
          reached = resolve;
        });
      t.after(() => release());
      const f = await fixture(
        t,
        async (res) => {
          if (gateEnabled) {
            reached();
            await gate;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        },
        {
          chat: { bindedPersona: "used-persona" },
          settings: {
            ...(scenario.includes("preset")
              ? {
                  presetChain: "Selected",
                  presetIds: ["used-preset", "other-preset"],
                  botPresetsId: 0,
                }
              : {}),
            enabledModules: ["used-module"],
            personaIds: ["used-persona", "other-persona"],
          },
        },
      );
      const modulePayload = {
        id: "used-module",
        name: "Synthetic module",
        regex: [
          {
            comment: "Synthetic module regex",
            in: "processed-output",
            out: "module-before-output",
            type: "editoutput",
          },
        ],
      };
      for (const [kind, resourceId, payload] of [
        ["module", "used-module", modulePayload],
        ["module", "unused-module", { id: "unused-module", name: "Unused" }],
        [
          "persona",
          "used-persona",
          {
            id: "used-persona",
            name: "Synthetic bound user",
            personaPrompt: "Synthetic bound persona",
          },
        ],
        ["persona", "other-persona", { id: "other-persona", name: "Other" }],
      ])
        await f.store.call("applyCommand", "seed-" + resourceId, {
          type: "put-resource",
          kind,
          resourceId,
          expectedRevision: 0,
          payload,
        });
      if (scenario.includes("preset"))
        for (const [resourceId, name] of [
          ["used-preset", "Selected"],
          ["other-preset", "Other"],
        ])
          await f.store.call("applyCommand", "seed-" + resourceId, {
            type: "put-resource",
            kind: "preset",
            resourceId,
            expectedRevision: 0,
            payload: {
              id: resourceId,
              name,
              mainPrompt: "Synthetic selected resource preset",
              unknownField: { keep: true },
            },
          });
      await f.store.call("enqueueJob", "resource-warm", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "warm-input",
      });
      assert.equal(
        (await start(t, f.file, await f.store.call("claimJob", "worker")).done)
          .state,
        "completed",
      );
      const baseline = await f.store.call("snapshot", "a");
      gateEnabled = true;
      await f.store.call("enqueueJob", "resource-second", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "second-input",
      });
      const running = start(
        t,
        f.file,
        await f.store.call("claimJob", "worker", 30000, {
          includeSnapshot: false,
        }),
      );
      await started;
      const persona = scenario === "used-persona-recreate",
        unused = scenario === "unused-module-recreate",
        ordinary =
          scenario === "same-module-edit" || scenario === "same-preset-edit",
        preset = scenario.includes("preset");
      const kind = persona ? "persona" : preset ? "preset" : "module",
        resourceId = preset
          ? "used-preset"
          : persona
            ? "used-persona"
            : unused
              ? "unused-module"
              : "used-module";
      const before = await f.store.call("getResource", kind, resourceId);
      if (ordinary) {
        await f.store.call("applyCommand", "peer-edit", {
          type: "save-library-resource",
          kind,
          resourceId,
          expectedRevision: before.revision,
          expectedEpoch: before.entityEpoch,
          payload: {
            ...before.payload,
            name: "Peer module",
            ...(preset
              ? { mainPrompt: "Peer preset prompt" }
              : {
                  regex: [
                    { ...modulePayload.regex[0], out: "module-peer-output" },
                  ],
                }),
          },
        });
      } else {
        await f.store.call("applyCommand", "peer-delete", {
          type: "delete-library-resource",
          kind,
          resourceId,
          expectedRevision: before.revision,
          expectedEpoch: before.entityEpoch,
        });
        if (scenario !== "used-module-delete")
          await f.store.call("applyCommand", "peer-recreate", {
            type: "put-resource",
            kind,
            resourceId,
            expectedRevision: before.revision + 1,
            payload: { ...before.payload, name: "Replacement" },
          });
      }
      const peer = await f.store.call("getResource", kind, resourceId);
      release();
      const job = await running.done;
      const saved = await f.store.call("snapshot", "a");
      console.log(
        "resource-lifetime-observation:",
        JSON.stringify({
          scenario,
          state: job.state,
          code: job.result.code,
          beforeMessages: baseline.messages.length,
          afterMessages: saved.messages.length,
          providerCalls: f.requests.length,
        }),
      );
      assert.equal(
        job.state,
        ordinary || unused ? "completed" : "failed",
        JSON.stringify(job.result),
      );
      if (ordinary || unused) {
        assert.equal(saved.messages.length, baseline.messages.length + 2);
        assert.equal(
          saved.messages.at(-1).message.data,
          "module-before-output:lua",
        );
      } else {
        assert.equal(
          job.result.code,
          scenario === "used-module-delete" ? "NOT_FOUND" : "REVISION_CONFLICT",
        );
        assert.deepEqual(saved.messages, baseline.messages);
        assert.ok(
          job.result.uncommitted.writeSet.resourceReads.some(
            (read) =>
              read.kind === kind &&
              read.id === resourceId &&
              read.expectedEpoch === before.entityEpoch,
          ),
        );
        assert.equal(
          saved.variables.find((row) => row.key === "$outputDone").value,
          "yes",
        );
        const preview = await f.store.call("previewJobResult", job.id);
        assert.equal(preview.canRecover, false);
        assert.equal(preview.blocked.code, job.result.code);
      }
      const currentResource = await f.store.call(
        "getResource",
        kind,
        resourceId,
      );
      if (preset && ordinary) {
        // Original capture may add a setting introduced by the earlier preset application.
        // Peer edits and imported metadata must still survive unchanged.
        assert.equal(currentResource.payload.name, peer.payload.name);
        assert.equal(currentResource.payload.mainPrompt, "Peer preset prompt");
        assert.deepEqual(
          currentResource.payload.unknownField,
          peer.payload.unknownField,
        );
        assert.equal(currentResource.entityEpoch, peer.entityEpoch);
      } else assert.deepEqual(currentResource, peer);
      assert.equal(f.requests.length, 2);
    },
  );

for (const scenario of [
  "selected-delete",
  "selected-recreate",
  "selected-output-recreate",
  "selected-override-recreate",
  "selected-edit",
  "unused-recreate",
])
  test(
    "native trigger persona lifetime: " + scenario,
    { timeout: 25000 },
    async (t) => {
      let release,
        reached,
        held = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        reached = resolve;
      });
      t.after(() => release());
      const f = await fixture(
        t,
        async (res) => {
          if (held) {
            reached();
            await gate;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        },
        {
          chat: { bindedPersona: "bound-persona" },
          settings: {
            selectedPersona: 1,
            personaPrompt:
              scenario === "selected-override-recreate"
                ? "Synthetic settings override"
                : "",
            personaIds: ["bound-persona", "selected-persona", "unused-persona"],
          },
          character: {
            desc: "Synthetic bound user {{user}}",
            triggerscript: [
              {
                type:
                  scenario === "selected-output-recreate" ? "output" : "input",
                conditions: [],
                effect: [
                  { type: "v2GetPersonaDesc", indent: 0, outputVar: "derived" },
                ],
              },
            ],
          },
        },
      );
      for (const [resourceId, personaPrompt] of [
        ["bound-persona", "Synthetic bound prompt"],
        ["selected-persona", "Synthetic selected prompt"],
        ["unused-persona", "Synthetic unused prompt"],
      ])
        await f.store.call("applyCommand", "seed-" + resourceId, {
          type: "put-resource",
          kind: "persona",
          resourceId,
          expectedRevision: 0,
          payload: { id: resourceId, name: resourceId, personaPrompt },
        });
      await f.store.call("enqueueJob", "trigger-persona-warm", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "warm-input",
      });
      assert.equal(
        (await start(t, f.file, await f.store.call("claimJob", "worker")).done)
          .state,
        "completed",
      );
      const baseline = await f.store.call("snapshot", "a");
      const derived =
        scenario === "selected-override-recreate"
          ? "Synthetic settings override"
          : "Synthetic selected prompt";
      assert.equal(
        baseline.variables.find((row) => row.key === "$derived").value,
        derived,
      );
      const prompt = JSON.stringify(f.requests[0].body.messages);
      assert.ok(prompt.includes("Synthetic bound user bound-persona"), prompt);
      assert.equal(prompt.includes("Synthetic selected prompt"), false);
      held = true;
      await f.store.call("enqueueJob", "trigger-persona-second", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "second-input",
      });
      const claimed = await f.store.call("claimJob", "worker", 30000, {
        includeSnapshot: false,
      });
      const running = start(t, f.file, claimed);
      await started;
      const ordinary = scenario === "selected-edit",
        unused = scenario === "unused-recreate";
      const resourceId = unused ? "unused-persona" : "selected-persona";
      const before = await f.store.call("getResource", "persona", resourceId);
      if (ordinary)
        await f.store.call("applyCommand", "peer-edit", {
          type: "save-library-resource",
          kind: "persona",
          resourceId,
          expectedRevision: before.revision,
          expectedEpoch: before.entityEpoch,
          payload: {
            ...before.payload,
            personaPrompt: "Synthetic peer prompt",
          },
        });
      else {
        await f.store.call("applyCommand", "peer-delete", {
          type: "delete-library-resource",
          kind: "persona",
          resourceId,
          expectedRevision: before.revision,
          expectedEpoch: before.entityEpoch,
        });
        if (scenario !== "selected-delete")
          await f.store.call("applyCommand", "peer-recreate", {
            type: "put-resource",
            kind: "persona",
            resourceId,
            expectedRevision: before.revision + 1,
            payload: {
              ...before.payload,
              personaPrompt: "Synthetic replacement prompt",
            },
          });
      }
      const peer = await f.store.call("getResource", "persona", resourceId);
      release();
      const job = await running.done;
      const saved = await f.store.call("snapshot", "a");
      console.log(
        "trigger-persona-observation:",
        JSON.stringify({
          scenario,
          state: job.state,
          code: job.result.code,
          beforeMessages: baseline.messages.length,
          afterMessages: saved.messages.length,
          providerCalls: f.requests.length,
          derived: saved.variables.find((row) => row.key === "$derived").value,
        }),
      );
      assert.equal(
        job.state,
        ordinary || unused ? "completed" : "failed",
        JSON.stringify(job.result),
      );
      if (ordinary || unused) {
        assert.equal(saved.messages.length, baseline.messages.length + 2);
        assert.equal(
          saved.variables.find((row) => row.key === "$derived").value,
          derived,
        );
      } else {
        assert.equal(
          job.result.code,
          scenario === "selected-delete" ? "NOT_FOUND" : "REVISION_CONFLICT",
        );
        assert.deepEqual(saved.messages, baseline.messages);
        assert.deepEqual(saved.variables, baseline.variables);
        assert.ok(
          job.result.uncommitted.writeSet.resourceReads.some(
            (read) =>
              read.kind === "persona" &&
              read.id === resourceId &&
              read.expectedEpoch === before.entityEpoch,
          ),
        );
        const preview = await f.store.call("previewJobResult", job.id);
        assert.equal(preview.canRecover, false);
        assert.equal(preview.blocked.code, job.result.code);
        await assert.rejects(
          f.store.call("applyCommand", "recovery", {
            type: "recover-job-result",
            jobId: job.id,
            chatId: "a",
            expectedChatEpoch: claimed.job.chatEpoch,
            expectedContentRevision: claimed.job.startedContentRevision,
          }),
          { code: job.result.code },
        );
        assert.deepEqual(
          (await f.store.call("snapshot", "a")).messages,
          baseline.messages,
        );
      }
      assert.deepEqual(
        await f.store.call("getResource", "persona", resourceId),
        peer,
      );
      assert.equal(f.requests.length, 2);
    },
  );

test(
  "native preset chain captures active settings and executes the selected original preset",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
      {
        settings: {
          presetChain: "Target",
          presetIds: ["active", "target"],
          botPresetsId: 0,
        },
      },
    );
    for (const [resourceId, payload] of [
      [
        "active",
        { id: "active", name: "Active", mainPrompt: "Old saved prompt" },
      ],
      [
        "target",
        {
          id: "target",
          name: "Target",
          mainPrompt: "Synthetic selected preset prompt",
          unknownField: { keep: true },
        },
      ],
    ])
      await f.store.call("applyCommand", "preset-" + resourceId, {
        type: "put-resource",
        kind: "preset",
        resourceId,
        expectedRevision: 0,
        payload,
      });
    await f.store.call("enqueueJob", "preset-chain", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "preset-input",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "worker", 30000, {
        includeSnapshot: false,
      }),
    ).done;
    console.log(
      "preset-chain-observation:",
      JSON.stringify({
        state: result.state,
        code: result.result.code,
        providerCalls: f.requests.length,
      }),
    );
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(f.requests.length, 1);
    assert.match(
      JSON.stringify(f.requests[0].body),
      /Synthetic selected preset prompt/,
    );
    const settings = await f.store.call("getResource", "settings", "global");
    assert.equal(settings.payload.botPresetsId, 1);
    assert.equal(
      settings.payload.mainPrompt,
      "Synthetic selected preset prompt",
    );
    const active = await f.store.call("getResource", "preset", "active");
    assert.equal(active.payload.mainPrompt, "Synthetic system {{char}}");
    assert.deepEqual(
      (await f.store.call("getResource", "preset", "target")).payload
        .unknownField,
      { keep: true },
    );
  },
);

test(
  "native SupaMemory summarizes overflowing synthetic history through the actual memory model and persists summary metadata",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res, request) => {
        const memory = request.body.messages.some((message) =>
          String(message.content).includes("SYNTHETIC_SUMMARY"),
        );
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: memory
                    ? "Synthetic compressed summary"
                    : "raw-output",
                },
              },
            ],
          }),
        );
      },
      {
        character: { supaMemory: true },
        chat: { extension: { keep: true } },
        settings: {
          subModel: "reverse_proxy",
          supaModelType: "subModel",
          supaMemoryPrompt: "SYNTHETIC_SUMMARY",
          maxContext: 1500,
          maxResponse: 100,
          maxSupaChunkSize: 500,
        },
      },
    );
    for (let i = 0; i < 8; i++)
      await f.store.call("applyCommand", "history-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "history-" + i,
        message: {
          role: i % 2 ? "char" : "user",
          data: ("Synthetic history " + i + " ").repeat(100),
        },
      });
    await f.store.call("enqueueJob", "memory-generation", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "memory-input",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "memory-engine"),
    ).done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const memoryRequests = f.requests.filter((request) =>
      request.body.messages.some((message) =>
        String(message.content).includes("SYNTHETIC_SUMMARY"),
      ),
    );
    assert.ok(
      memoryRequests.length > 0,
      "The actual tokenizer/history must trigger memory summarization",
    );
    assert.equal(result.result.providerCalls, f.requests.length);
    assert.equal(f.requests.length, memoryRequests.length + 1);
    assert.ok(
      f.requests
        .at(-1)
        .body.messages.some((message) =>
          String(message.content).includes("Synthetic compressed summary"),
        ),
    );
    const saved = await f.store.call("snapshot", "a");
    assert.match(
      saved.chat.metadata.supaMemoryData,
      /Synthetic compressed summary/,
    );
    assert.equal(typeof saved.chat.metadata.lastMemory, "string");
    assert.deepEqual(saved.chat.metadata.extension, { keep: true });
    assert.equal(
      saved.messages.length,
      10,
      "Summarizing a prompt must preserve canonical history",
    );
    assert.equal(saved.messages.at(-1).message.data, "processed-output:lua");
  },
);

test(
  "an unavailable native local summarizer reports failure before canonical chat effects or provider calls",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => res.end("{}"), {
      character: { supaMemory: true },
      settings: {
        supaModelType: "distilbart",
        maxContext: 400,
        maxResponse: 100,
        maxSupaChunkSize: 100,
      },
    });
    for (let i = 0; i < 3; i++)
      await f.store.call("applyCommand", "local-history-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "local-history-" + i,
        message: { role: "user", data: "Synthetic long history ".repeat(200) },
      });
    const before = await f.store.call("snapshot", "a");
    await f.store.call("enqueueJob", "unsupported-local-memory", {
      type: "send",
      chatId: "a",
      input: "marker",
      messageId: "local-memory-input",
    });
    const result = await start(
      t,
      f.file,
      await f.store.call("claimJob", "local-memory-engine"),
    ).done;
    assert.equal(result.state, "failed");
    assert.match(JSON.stringify(result.result), /runSummarizer/);
    assert.equal(f.requests.length, 0);
    const after = await f.store.call("snapshot", "a");
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.chat.metadata.supaMemoryData, undefined);
  },
);

for (const streaming of [false, true])
  test(
    `registered Gemini 4 Argon ${streaming ? "streams" : "returns"} through Vertex and commits original output scripts atomically`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(
        t,
        async () => {
          throw Error("Only the synthetic Argon provider port may be used");
        },
        {
          settings: {
            aiModel: "gemini-4-argon-vertex",
            useStreaming: streaming,
            reasoningEffort: -1,
            google: {
              projectId: "synthetic-project",
              accessToken: "synthetic-key",
            },
            vertexRegion: "us-central1",
            vertexAccessToken: "synthetic-token",
            vertexAccessTokenExpires: Date.now() + 60000,
          },
        },
      );
      await f.store.call("enqueueJob", "argon", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "argon-input",
      });
      const claimed = await f.store.call("claimJob", "argon-worker");
      const { executeExtensionJob } = await import(
        pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
      );
      const calls = [],
        progress = [];
      const execution = await executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        fetch: async (path) =>
          new Response(
            await readFile(join(__dirname, "../../public", path.slice(1))),
          ),
        onProgress: (event) => progress.push(event),
        providerFetch: async (url, init) => {
          const parsed = new URL(url),
            body = JSON.parse(init.body);
          calls.push({ url: parsed, body });
          assert.equal(parsed.hostname, "aiplatform.googleapis.com");
          assert.match(
            parsed.pathname,
            /\/locations\/global\/publishers\/google\/models\/gemini-4-argon:/,
          );
          assert.equal(
            parsed.searchParams.get("alt"),
            streaming ? "sse" : null,
          );
          assert.equal(
            new Headers(init.headers).get("authorization"),
            "Bearer synthetic-token",
          );
          const config = body.generation_config ?? body.generationConfig;
          assert.match(config.thinkingConfig.thinkingLevel, /^low$/i);
          assert.equal(config.maxOutputTokens, 200);
          for (const key of [
            "thinkingBudget",
            "temperature",
            "topP",
            "topK",
            "frequencyPenalty",
            "presencePenalty",
            "candidateCount",
          ])
            assert.equal(config[key], undefined, key);
          assert.ok(
            body.contents.some((message) =>
              message.parts.some((part) =>
                part.text?.includes("changed-input"),
              ),
            ),
          );
          const item = (text) => ({
            modelVersion: "gemini-4-argon",
            candidates: [{ content: { parts: [{ text }] } }],
          });
          if (!streaming) return Response.json(item("raw-output"));
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  encoder.encode(
                    "data: " + JSON.stringify(item("raw-")) + "\n\n",
                  ),
                );
                await new Promise((resolve) => setTimeout(resolve, 25));
                controller.enqueue(
                  encoder.encode(
                    "data: " + JSON.stringify(item("output")) + "\n\n",
                  ),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(execution.result.providerCalls, 1);
      assert.equal((await f.store.call("snapshot", "a")).messages.length, 0);
      await f.store.call(
        "finishJob",
        claimed.job.id,
        claimed.job.owner,
        claimed.job.fence,
        { state: "completed", ...execution },
      );
      const snapshot = await f.store.call("snapshot", "a");
      assert.equal(snapshot.messages[0].message.data, "changed-input");
      assert.equal(snapshot.messages[1].message.data, "processed-output:lua");
      assert.equal(
        snapshot.variables.find((v) => v.key === "$outputDone").value,
        "yes",
      );
      if (streaming)
        assert.ok(progress.some((event) => event.type === "messages"));
      assert.equal(f.requests.length, 0);
    },
  );

for (const streaming of [false, true])
  test(
    `original ${streaming ? "streaming" : "nonstreaming"} multi-generation cache persists its own output stage and selection never repeats effects`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(
        t,
        async () => {
          throw Error(
            "The synthetic provider port must handle all generation requests",
          );
        },
        {
          settings: {
            aiModel: "gpt4o",
            genTime: 3,
            useStreaming: streaming,
            openAIKey: "synthetic-key",
          },
        },
      );
      await f.store.call("enqueueJob", "choices", {
        type: "send",
        chatId: "a",
        input: "marker",
        messageId: "input",
      });
      const claimed = await f.store.call("claimJob", "worker");
      const { executeExtensionJob } = await import(
        pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
      );
      let calls = 0;
      const execution = await executeExtensionJob(claimed, {
        appVer: "2026.8.250",
        fetch: async (path) =>
          new Response(
            await readFile(join(__dirname, "../../public", path.slice(1))),
          ),
        providerFetch: async (url, init) => {
          calls++;
          assert.equal(JSON.parse(init.body).n, 3);
          assert.equal(Boolean(JSON.parse(init.body).stream), streaming);
          const choices = [0, 1, 2].map((index) => ({
            index,
            message: { content: "raw-output-" + index },
            delta: { content: "raw-output-" + index },
          }));
          if (streaming)
            return new Response(
              "data: " + JSON.stringify({ choices }) + "\n\ndata: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          return Response.json({ choices });
        },
      });
      await f.store.call(
        "finishJob",
        claimed.job.id,
        claimed.job.owner,
        claimed.job.fence,
        { state: "completed", ...execution },
      );
      const before = await f.store.call("snapshot", "a"),
        row = before.messages.at(-1);
      assert.equal(calls, 1);
      assert.equal(f.requests.length, 0);
      const cached =
        execution.result.rerolls[row.message.generationInfo.generationId];
      assert.equal(cached.length, streaming ? 1 : 3);
      assert.deepEqual(
        cached,
        streaming
          ? ["raw-output-0"]
          : [
              "processed-output-0:lua",
              "processed-output-1:lua",
              "processed-output-2:lua",
            ],
      );
      assert.equal(row.message.data, "processed-output-0:lua");
      const characterBefore = await f.store.call("getCharacter", "c");
      const head = await f.store.call(
        "readReplyChoices",
        "a",
        row.id,
        row.revision,
        0,
      );
      assert.equal(head.count, streaming ? 1 : 3);
      const selected = await f.store.call("applyCommand", "select", {
        type: "move-reply-choice",
        ...head.target,
        direction: "next",
      });
      if (streaming) {
        // The original wrapToolStream emits only key0 even when n=3.
        assert.equal(selected.kind, "generation");
        await f.store.call("requestCancel", selected.jobId);
        const returned = await f.store.call(
          "readReplyChoices",
          "a",
          row.id,
          row.revision,
          0,
        );
        await f.store.call("applyCommand", "return", {
          type: "move-reply-choice",
          ...returned.target,
          direction: "previous",
        });
      } else assert.equal(selected.kind, "selected");
      const after = await f.store.call("snapshot", "a");
      assert.deepEqual(after.messages.at(-1).message, {
        ...row.message,
        data: cached[streaming ? 0 : 1],
      });
      assert.deepEqual(after.variables, before.variables);
      const characterAfter = await f.store.call("getCharacter", "c");
      assert.deepEqual(characterAfter.definition, characterBefore.definition);
      assert.deepEqual(characterAfter.activity, characterBefore.activity);
      assert.deepEqual(after.chat.metadata, before.chat.metadata);
      assert.equal(calls, 1);
    },
  );
