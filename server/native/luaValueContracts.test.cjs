"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Worker } = require("node:worker_threads");
const { EntityStoreClient } = require("../entity/client.cjs");

async function fixture(
  t,
  code,
  {
    moduleCode,
    command = "send",
    streaming = false,
    streamingMode = "off",
  } = {},
) {
  const requests = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (streaming) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "reply marker" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: "reply marker" } }] }),
      );
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "risu-lua-value-contract-"));
  const file = join(root, "state.sqlite"),
    store = new EntityStoreClient(file);
  t.after(async () => {
    await store.close();
    await new Promise((resolve) => {
      provider.close(resolve);
      provider.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  });
  await store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic Lua contract",
      desc: "Synthetic definition",
      firstMessage: "Synthetic greeting",
      triggerscript: [
        {
          type: "output",
          conditions: [],
          effect: [{ type: "triggerlua", code }],
        },
      ],
    },
  });
  await store.call("applyCommand", "chat", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: { name: "Synthetic", localLore: [] },
  });
  await store.call("applyCommand", "seed-message", {
    type: "append-message",
    chatId: "a",
    messageId: "seed",
    message: { role: "char", data: "history marker" },
  });
  await store.call("applyCommand", "settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: streaming,
      streamingDisplayOptimizationMode: streamingMode,
      mainPrompt: "Synthetic system",
      maxContext: 8000,
      maxResponse: 200,
      enabledModules: moduleCode ? ["module"] : [],
    },
  });
  if (moduleCode)
    await store.call("applyCommand", "module", {
      type: "put-resource",
      kind: "module",
      resourceId: "module",
      expectedRevision: 0,
      payload: {
        id: "module",
        name: "Synthetic module",
        trigger: [
          {
            type: "output",
            conditions: [],
            effect: [{ type: "triggerlua", code: moduleCode }],
          },
        ],
      },
    });
  const baseline = await store.call("snapshot", "a");
  await store.call("enqueueJob", "job", {
    type: command,
    chatId: "a",
    ...(command === "send"
      ? { input: "input marker", messageId: "input" }
      : { data: "button marker" }),
  });
  const claimed = await store.call("claimJob", "worker");
  const worker = new Worker(join(__dirname, "extensionWorker.cjs"), {
    workerData: { file, claimed },
  });
  t.after(() => worker.terminate());
  const job = await new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.completed) resolve(message.completed);
      if (message.error) reject(new Error(message.error.message));
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code) reject(new Error(`Synthetic worker exited: ${code}`));
    });
  });
  return {
    store,
    job,
    requests,
    baseline,
    snapshot: await store.call("snapshot", "a"),
  };
}

test(
  "actual native Lua preserves string edit input/output and table request/chat/state contracts",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `
listenEdit('editInput', function(id, text, meta)
  assert(type(text) == 'string' and type(meta) == 'table')
  local chat = getChat(id, 0)
  assert(type(chat) == 'table' and type(chat.data) == 'string')
  assert(type(getFullChat(id)) == 'table' and type(getRecentChats(id, 1)) == 'table')
  setState(id, 'shape', { value = chat.data:gsub('marker', 'checked') })
  local state = getState(id, 'shape')
  assert(type(state) == 'table' and type(state.value) == 'string')
  setChatVar(id, 'history', state.value)
  return text:gsub('marker', 'checked')
end)
listenEdit('editRequest', function(id, messages, meta)
  assert(type(messages) == 'table' and type(messages[1]) == 'table')
  assert(type(messages[1].content) == 'string')
  for _, message in ipairs(messages) do
    message.content = message.content:gsub('checked', 'requested')
  end
  setChatVar(id, 'requestShape', type(messages))
  return messages
end)
listenEdit('editOutput', function(id, text, meta)
  assert(type(text) == 'string' and type(meta) == 'table')
  assert(type(getUserLastMessage(id)) == 'string')
  assert(type(getCharacterLastMessage(id)) == 'string')
  setChatVar(id, 'outputShape', type(text))
  return text:gsub('marker', 'checked')
end)`,
    );
    assert.equal(f.job.state, "completed", JSON.stringify(f.job.result));
    assert.equal(f.requests.length, 1);
    assert.ok(
      f.requests[0].messages.some((row) => row.content === "input requested"),
    );
    assert.equal(f.snapshot.messages.at(-2).message.data, "input checked");
    assert.equal(f.snapshot.messages.at(-1).message.data, "reply checked");
    const variables = Object.fromEntries(
      f.snapshot.variables.map((row) => [row.key, row.value]),
    );
    assert.equal(variables.$history, "history checked");
    assert.equal(variables.$requestShape, "table");
    assert.equal(variables.$outputShape, "string");
    assert.deepEqual(JSON.parse(variables.$__shape), {
      value: "history checked",
    });
  },
);

for (const [
  name,
  event,
  expression,
  calls,
  streaming,
  streamingMode = "off",
] of [
  ["chat object in input", "editInput", "getChat(id, 0)", 0],
  ["request array", "editRequest", "text", 0],
  ["state object in output", "editOutput", "getState(id, 'shape')", 1],
  [
    "state object in streamed output",
    "editOutput",
    "getState(id, 'shape')",
    1,
    true,
  ],
  [
    "state object after streamed EOF",
    "editOutput",
    "getState(id, 'shape')",
    1,
    true,
    "strong",
  ],
])
  test(
    "actual native Lua rejects gsub on " +
      name +
      " without partial persistence",
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(
        t,
        `
listenEdit('${event}', function(id, text, meta)
  setChatVar(id, 'partial', 'must not save')
  setState(id, 'shape', { value = 'synthetic' })
  local value = ${expression}
  return value:gsub('marker', 'checked')
end)`,
        { streaming, streamingMode },
      );
      assert.equal(f.job.state, "failed");
      assert.equal(f.job.result.code, "ENGINE_ERROR");
      assert.match(
        f.job.result.message,
        /Lua execution failed:.*attempt to call a nil value \(method 'gsub'\)/s,
      );
      assert.deepEqual(f.snapshot.messages, f.baseline.messages);
      assert.deepEqual(f.snapshot.variables, f.baseline.variables);
      assert.equal(f.requests.length, calls);
      if (event === "editOutput") {
        const preview = await f.store.call("previewJobResult", f.job.id);
        assert.equal(preview.canRecover, false);
        assert.equal(
          preview.providerOutputs[0].complete,
          !streaming || streamingMode === "strong",
        );
        assert.equal(
          preview.providerOutputs[0].type,
          streaming ? "streaming" : "success",
        );
        assert.equal(
          preview.providerOutputs[0].candidates[0].data,
          "reply marker",
        );
      }
      const compact = await f.store.call("getJobStatus", f.job.id);
      assert.equal(JSON.stringify(compact).includes("reply marker"), false);
      console.log(
        "lua-value-observation:",
        JSON.stringify({
          name,
          state: f.job.state,
          code: f.job.result.code,
          providerCalls: f.requests.length,
          partialWrites: false,
        }),
      );
    },
  );

test(
  "a later module Lua type error rejects earlier character effects before provider execution",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `
listenEdit('editInput', function(id, text)
  setChatVar(id, 'characterEffect', 'must not save')
  return text:gsub('marker', 'checked')
end)`,
      {
        moduleCode: `
listenEdit('editInput', function(id, text)
  return getChat(id, 0):gsub('marker', 'checked')
end)`,
      },
    );
    assert.equal(f.job.state, "failed");
    assert.match(f.job.result.message, /method 'gsub'/);
    assert.deepEqual(f.snapshot.messages, f.baseline.messages);
    assert.deepEqual(f.snapshot.variables, f.baseline.variables);
    assert.equal(f.requests.length, 0);
  },
);

test(
  "a native button gsub failure saves neither earlier Lua variables nor messages",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `
function onButtonClick(id, data)
  setChatVar(id, 'partial', 'must not save')
  addChat(id, 'char', 'must not save')
  return getChat(id, 0):gsub('marker', 'checked')
end`,
      { command: "button" },
    );
    assert.equal(f.job.state, "failed");
    assert.equal(f.job.result.code, "ENGINE_ERROR");
    assert.match(f.job.result.message, /method 'gsub'/);
    assert.deepEqual(f.snapshot.messages, f.baseline.messages);
    assert.deepEqual(f.snapshot.variables, f.baseline.variables);
    assert.equal(f.requests.length, 0);
  },
);
