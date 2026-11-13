"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");

async function fixture(t, experimental, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "risu-v3-generation-")),
    file = join(dir, "state.sqlite"),
    requests = [];
  const provider = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text),
      kind =
        req.url === "/embeddings"
          ? "embedding"
          : body.messages.some((x) =>
                String(x.content).includes("HYPAV3_SUMMARY"),
              )
            ? "memory"
            : "main";
    requests.push({ kind, body });
    if (options.respond)
      await options.respond(res, body, kind, requests.length);
    if (res.writableEnded || res.destroyed) return;
    res.setHeader("content-type", "application/json");
    if (kind === "embedding") {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      res.end(
        JSON.stringify({
          data: input.map((text) => ({
            embedding: String(text).includes("needle") ? [1, 0] : [0, 1],
          })),
        }),
      );
    } else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  kind === "memory"
                    ? "<Thoughts>Hidden</Thoughts>Synthetic compressed needle"
                    : "raw-output",
              },
            },
          ],
        }),
      );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const f = { requests, runtime: null };
  t.after(async () => {
    await f.runtime?.close();
    await new Promise((resolve) => {
      provider.close(resolve);
      provider.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });
  f.restart = async () => {
    await f.runtime?.close();
    f.runtime = await createRuntimeService({
      file,
      initialize: true,
      scheduler: { pollMs: 20, cancelGraceMs: 100 },
    });
  };
  await f.restart();
  f.api = async (path, data) => {
    const response = await fetch(
      f.runtime.url + "/api/runtime" + path,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "content-type": "application/json",
              connection: "close",
            },
            body: JSON.stringify(data),
          },
    );
    const result = await response.json();
    assert.ok(response.status < 300, JSON.stringify(result));
    return result;
  };
  f.command = (requestId, command) =>
    f.api("/commands", { requestId, command });
  await f.command("c", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      firstMessage: "Synthetic greeting",
      supaMemory: true,
      customscript: [
        {
          type: "editoutput",
          in: "raw-output",
          out: "processed-output",
          comment: "Synthetic",
        },
      ],
    },
  });
  await f.command("a", {
    type: "create-chat",
    characterId: "c",
    chatId: "a",
    metadata: {
      name: "Synthetic",
      localLore: [],
      extension: { keep: true },
      ...options.chat,
    },
  });
  const settings = await f.runtime.store.call(
    "getResource",
    "settings",
    "global",
  );
  await f.command("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      aiModel: "reverse_proxy",
      subModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: false,
      mainPrompt: "Synthetic system",
      jailbreak: "",
      maxContext: 1500,
      maxResponse: 100,
      supaModelType: "subModel",
      hypav2: false,
      hanuraiEnable: false,
      hypaV3: true,
      hypaModel: "custom",
      hypaCustomSettings: {
        url: `http://127.0.0.1:${provider.address().port}`,
        model: "synthetic-embedding",
      },
      hypaV3PresetId: 0,
      hypaV3Presets: [
        {
          name: "Synthetic",
          settings: {
            ...settings.payload.hypaV3Presets[0].settings,
            useExperimentalImpl: experimental,
            summarizationModel: "subModel",
            summarizationPrompt: "HYPAV3_SUMMARY",
            maxChatsPerSummary: 2,
            queryChatCount: 3,
            recentMemoryRatio: 1,
            similarMemoryRatio: 0,
            ...options.memory,
          },
        },
      ],
      ...options.settings,
    },
  });
  f.history = async (long = false) => {
    for (let i = 0; i < 8; i++)
      await f.command("history" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m" + i,
        message: {
          role: i % 2 ? "char" : "user",
          data: long
            ? ("Synthetic history " + i + " ").repeat(100)
            : i > 4
              ? "needle recent query"
              : "hay",
        },
      });
  };
  f.send = (id) =>
    f.api("/jobs", {
      requestId: id,
      command: {
        type: "send",
        chatId: "a",
        input: "needle input",
        messageId: id + "-input",
      },
    });
  f.finished = async (id) => {
    const end = Date.now() + 15000;
    do {
      const job = await f.api("/jobs/" + id);
      if (!["queued", "running"].includes(job.state)) return job;
      await delay(20);
    } while (Date.now() < end);
    throw Error("V3 synthetic generation did not finish");
  };
  return f;
}

for (const experimental of [false, true]) {
  const mode = experimental ? "experimental" : "default";
  test(
    `${mode} automatic V3 summarizes with real tokenization, finishes after the admission response closes and persists across restart`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, experimental, {
        respond: async (res, body, kind) => {
          if (kind === "memory") await delay(50);
        },
      });
      await f.history(true);
      await f.send("generate");
      const job = await f.finished("generate");
      assert.equal(job.state, "completed", JSON.stringify(job.result));
      const memory = f.requests.filter((x) => x.kind === "memory"),
        main = f.requests.filter((x) => x.kind === "main");
      assert.ok(memory.length > 0);
      assert.equal(main.length, 1);
      assert.ok(memory.every((x) => x.body.stream === false));
      assert.ok(
        main[0].body.messages.some((x) =>
          String(x.content).includes("Synthetic compressed needle"),
        ),
      );
      const before = await f.api("/chats/a");
      assert.equal(before.messages.length, 10);
      assert.equal(before.messages.at(-1).message.data, "processed-output");
      const data = before.chat.metadata.hypaV3Data;
      assert.ok(data.summaries.length > 0);
      assert.ok(data.summaries.every((x) => !x.text.includes("Thoughts")));
      assert.ok(
        data.summaries.flatMap((x) => x.chatMemos).some((x) => x === "m0"),
      );
      assert.deepEqual(before.chat.metadata.extension, { keep: true });
      const count = f.requests.length;
      await f.restart();
      const after = await f.api("/chats/a");
      assert.deepEqual(after.chat.metadata.hypaV3Data, data);
      assert.deepEqual(after.messages, before.messages);
      await f.send("generate");
      await delay(80);
      assert.equal(
        f.requests.length,
        count,
        "A duplicate admission must not run a second paid summary or generation",
      );
    },
  );
  test(
    `${mode} automatic V3 calls the custom embedding endpoint, ranks memory and retains its categories/tags/unknown fields`,
    { timeout: 20000 },
    async (t) => {
      const original = {
        extra: { keep: true },
        categories: [{ id: "cat", name: "Synthetic" }],
        summaries: [
          {
            text: "hay summary\n\nhay second",
            chatMemos: ["m0"],
            isImportant: false,
            tags: ["keep"],
            extra: { unknown: 7 },
          },
          {
            text: "needle summary\n\nneedle second",
            chatMemos: ["m1"],
            isImportant: false,
            categoryId: "cat",
          },
        ],
      };
      const f = await fixture(t, experimental, {
        chat: { hypaV3Data: original },
        memory: { recentMemoryRatio: 0, similarMemoryRatio: 1 },
      });
      await f.history();
      await f.send("similar");
      const job = await f.finished("similar");
      assert.equal(job.state, "completed", JSON.stringify(job.result));
      assert.ok(f.requests.some((x) => x.kind === "embedding"));
      assert.equal(f.requests.filter((x) => x.kind === "memory").length, 0);
      assert.equal(f.requests.filter((x) => x.kind === "main").length, 1);
      assert.ok(
        f.requests
          .filter((x) => x.kind === "embedding")
          .every((x) => x.body.model === "synthetic-embedding"),
      );
      const data = (await f.api("/chats/a")).chat.metadata.hypaV3Data;
      assert.equal(data.metrics.lastSimilarSummaries[0], 1);
      assert.deepEqual(data.extra, original.extra);
      assert.deepEqual(data.categories, original.categories);
      assert.deepEqual(data.summaries, original.summaries);
    },
  );
  test(
    `${mode} automatic V3 embedding failure leaves canonical memory and messages unchanged`,
    { timeout: 20000 },
    async (t) => {
      const original = {
        summaries: [
          { text: "needle summary", chatMemos: ["m0"], isImportant: false },
        ],
      };
      const f = await fixture(t, experimental, {
        chat: { hypaV3Data: original },
        memory: { recentMemoryRatio: 0, similarMemoryRatio: 1 },
        respond: async (res, body, kind) => {
          if (kind === "embedding") {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Synthetic embedding refusal" }));
          }
        },
      });
      await f.history();
      const before = await f.api("/chats/a");
      await f.send("failed");
      const job = await f.finished("failed");
      assert.equal(job.state, "failed");
      assert.match(job.result.message, /Synthetic embedding refusal/);
      assert.equal(f.requests.filter((x) => x.kind === "main").length, 0);
      const after = await f.api("/chats/a");
      assert.deepEqual(after.chat.metadata, before.chat.metadata);
      assert.deepEqual(after.messages, before.messages);
    },
  );
}

test(
  "automatic V3 keeps admitted configuration semantics and preserves a peer settings edit without repeating calls",
  { timeout: 30000 },
  async (t) => {
    let arrive, release;
    const arrived = new Promise((r) => (arrive = r)),
      held = new Promise((r) => (release = r));
    const f = await fixture(t, false, {
      respond: async (res, body, kind) => {
        if (kind === "memory") {
          arrive();
          await held;
        }
      },
    });
    await f.history(true);
    const before = await f.api("/chats/a");
    await f.send("conflict");
    await arrived;
    // An in-flight generation uses its admitted settings snapshot. Same-incarnation
    // configuration edits do not force a paid request to restart or overwrite them.
    const settings = await f.runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    await f.command("peer-replace", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: { ...settings.payload, maxResponse: 101 },
    });
    release();
    const job = await f.finished("conflict");
    assert.equal(job.state, "completed", JSON.stringify(job.result));
    const after = await f.api("/chats/a");
    assert.equal(after.messages.length, before.messages.length + 2);
    assert.ok(after.chat.metadata.hypaV3Data.summaries.length > 0);
    assert.equal(
      (await f.runtime.store.call("getResource", "settings", "global")).payload
        .maxResponse,
      101,
    );
    const count = f.requests.length;
    await f.restart();
    await delay(80);
    assert.equal(f.requests.length, count);
  },
);

test(
  "automatic V3 peer memory conflict retains computed summaries and reply without overwriting the edit or repeating calls",
  { timeout: 30000 },
  async (t) => {
    let arrive, release;
    const arrived = new Promise((r) => (arrive = r)),
      held = new Promise((r) => (release = r));
    const f = await fixture(t, false, {
      respond: async (res, body, kind) => {
        if (kind === "memory") {
          arrive();
          await held;
        }
      },
    });
    await f.history(true);
    const before = await f.api("/chats/a");
    await f.send("conflict");
    await arrived;
    const field = (
      await f.api("/fields/read", {
        targets: [{ scope: "chat", entityId: "a", key: "hypaV3Data" }],
      })
    ).fields[0];
    const peer = {
      summaries: [
        { text: "Peer memory edit", chatMemos: ["m0"], isImportant: true },
      ],
      extra: { keep: true },
    };
    await f.command("peer-memory", {
      type: "change-fields",
      edits: [
        {
          scope: "chat",
          entityId: "a",
          key: "hypaV3Data",
          expectedEpoch: field.entityEpoch,
          expectedRevision: field.revision,
          value: peer,
        },
      ],
    });
    release();
    const job = await f.finished("conflict");
    assert.equal(job.state, "failed");
    assert.equal(job.result.code, "REVISION_CONFLICT");
    const after = await f.api("/chats/a");
    assert.deepEqual(after.chat.metadata.hypaV3Data, peer);
    assert.deepEqual(after.messages, before.messages);
    const result = await f.api("/jobs/conflict/result");
    assert.ok(
      result.providerOutputs.some((x) =>
        x.candidates.some((y) =>
          y.data.includes("Synthetic compressed needle"),
        ),
      ),
    );
    const count = f.requests.length;
    await f.restart();
    await delay(80);
    assert.equal(f.requests.length, count);
  },
);

test(
  "automatic experimental V3 cancellation during a summary prevents canonical partial effects and automatic retry",
  { timeout: 20000 },
  async (t) => {
    let arrive;
    const arrived = new Promise((r) => (arrive = r));
    const f = await fixture(t, true, {
      respond: async (res, body, kind) => {
        if (kind === "memory") {
          arrive();
          await new Promise((resolve) => res.once("close", resolve));
        }
      },
    });
    await f.history(true);
    const before = await f.api("/chats/a");
    await f.send("cancel");
    await arrived;
    await f.api("/jobs/cancel/cancel", {});
    assert.equal((await f.finished("cancel")).state, "cancelled");
    const after = await f.api("/chats/a");
    assert.deepEqual(after.chat.metadata, before.chat.metadata);
    assert.deepEqual(after.messages, before.messages);
    const count = f.requests.length;
    await f.restart();
    await delay(80);
    assert.equal(f.requests.length, count);
  },
);
