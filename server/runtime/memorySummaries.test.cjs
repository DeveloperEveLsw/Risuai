"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");
async function fixture(t, options = {}) {
  const requests = [],
    dir = mkdtempSync(join(tmpdir(), "risu-summary-http-")),
    file = join(dir, "state.sqlite");
  const provider = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    if (options.respond) return options.respond(res, body, requests.length);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "<Thoughts>Synthetic removed thoughts</Thoughts> Synthetic new summary",
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
    const res = await fetch(
      f.runtime.url + "/api/runtime" + path,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    return { status: res.status, body: await res.json() };
  };
  f.ok = async (path, data) => {
    const r = await f.api(path, data);
    assert.ok(r.status < 300, JSON.stringify(r));
    return r.body;
  };
  f.command = (requestId, command) => f.ok("/commands", { requestId, command });
  await f.command("c", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      firstMessage: "Greeting marker {{user}}",
      alternateGreetings: ["Alternative marker"],
      customscript: [
        {
          type: "editprocess",
          in: "marker",
          out: "processed",
          comment: "Synthetic",
        },
      ],
      ...options.character,
    },
  });
  await f.command("a", {
    type: "create-chat",
    chatId: "a",
    characterId: "c",
    metadata: {
      name: "Synthetic",
      fmIndex: -1,
      hypaV3Data: {
        extra: { unknown: true },
        summaries: [
          {
            text: "First summary",
            chatMemos: [null, "m"],
            isImportant: true,
            extra: { retained: 1 },
          },
          { text: "Second summary", chatMemos: ["m"], isImportant: false },
        ],
      },
    },
  });
  await f.command("m", {
    type: "append-message",
    chatId: "a",
    messageId: "m",
    message: { role: "user", data: "Synthetic marker" },
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
      subModel: "reverse_proxy",
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      username: "SyntheticUser",
      useStreaming: true,
      hypaV3PresetId: 0,
      hypaV3Presets: [
        {
          name: "Synthetic",
          settings: {
            ...settings.payload.hypaV3Presets[0].settings,
            processRegexScript: true,
            ...options.memory,
          },
        },
      ],
    },
  });
  f.capture = async (mode = "single", indices = [0]) => {
    const field = (
      await f.ok("/fields/read", {
        targets: [{ scope: "chat", entityId: "a", key: "hypaV3Data" }],
      })
    ).fields[0];
    return {
      type: "memory-summary",
      chatId: "a",
      expectedChatEpoch: field.entityEpoch,
      expectedMemoryRevision: field.revision,
      mode,
      indices,
    };
  };
  f.job = async (id, mode = "single", indices = [0]) =>
    f.ok("/jobs", { requestId: id, command: await f.capture(mode, indices) });
  f.finished = async (id) => {
    const end = Date.now() + 10000;
    do {
      const job = await f.ok("/jobs/" + id);
      if (!["queued", "running"].includes(job.state)) return job;
      await delay(20);
    } while (Date.now() < end);
    throw Error("Synthetic summary job did not finish");
  };
  return f;
}
test(
  "native original bulk calculation persists after requester leaves and restart; poll omits body; a second requester applies once",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.job("bulk", "bulk", [0, 1]);
    const job = await f.finished("bulk");
    assert.equal(job.state, "completed", JSON.stringify(job.result));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].stream, false);
    const prompt = f.requests[0].messages
      .map((message) => message.content)
      .join("\n");
    assert.match(prompt, /user: First summary\nuser: Second summary/);
    assert.match(prompt, /Re-summarize this summaries/);
    assert.ok(!JSON.stringify(job).includes("Synthetic new summary"));
    assert.ok(
      !JSON.stringify(await f.ok("/jobs/bulk/status")).includes(
        "Synthetic new summary",
      ),
    );
    let source = await f.ok("/chats/a");
    assert.equal(source.chat.metadata.hypaV3Data.summaries.length, 2);
    await f.restart();
    const preview = await f.ok("/jobs/bulk/memory-summary");
    assert.equal(preview.text, "Synthetic new summary");
    assert.equal(preview.canApply, true);
    const command = {
      type: "apply-memory-summary",
      jobId: "bulk",
      chatId: "a",
      expectedChatEpoch: preview.expectedChatEpoch,
    };
    await f.command("apply", command);
    await f.command("apply", command);
    await f.command("apply-again", command);
    source = await f.ok("/chats/a");
    assert.equal(source.messages.length, 1);
    assert.equal(source.chat.metadata.hypaV3Data.summaries.length, 1);
    assert.deepEqual(source.chat.metadata.hypaV3Data.summaries[0].extra, {
      retained: 1,
    });
    assert.deepEqual(source.chat.metadata.hypaV3Data.extra, { unknown: true });
    assert.equal(f.requests.length, 1);
  },
);
test(
  "single native re-summary uses stable memos, greeting, original CBS and editprocess regex",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.job("single");
    const job = await f.finished("single");
    assert.equal(job.state, "completed", JSON.stringify(job.result));
    assert.equal(f.requests.length, 1);
    const prompt = JSON.stringify(f.requests[0].messages);
    assert.match(prompt, /Greeting processed SyntheticUser/);
    assert.match(prompt, /Synthetic processed/);
    assert.ok(!prompt.includes("First summary"));
    assert.ok(!prompt.includes("{{user}}"));
    assert.equal(
      (await f.ok("/jobs/single/memory-summary")).text,
      "Synthetic new summary",
    );
  },
);
test(
  "native WebGPU-only model reports explicit capability failure before any provider request",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, {
      memory: { summarizationModel: "synthetic-local-gpu" },
    });
    await f.job("gpu");
    const job = await f.finished("gpu");
    assert.equal(job.state, "failed");
    assert.match(job.result.message, /WebGPU local summary model/);
    assert.equal(f.requests.length, 0);
    assert.equal(
      (await f.ok("/chats/a")).chat.metadata.hypaV3Data.summaries[0].text,
      "First summary",
    );
  },
);
test(
  "orphaned single memo stops before provider; failure preview offers a guarded retry and refuses partial recovery",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const field = (
      await f.ok("/fields/read", {
        targets: [{ scope: "chat", entityId: "a", key: "hypaV3Data" }],
      })
    ).fields[0];
    field.value.summaries[0].chatMemos = ["absent"];
    await f.command("orphan", {
      type: "change-fields",
      edits: [
        {
          scope: "chat",
          entityId: "a",
          key: "hypaV3Data",
          expectedEpoch: field.entityEpoch,
          expectedRevision: field.revision,
          value: field.value,
        },
      ],
    });
    await f.job("orphan-job");
    assert.equal((await f.finished("orphan-job")).state, "failed");
    assert.equal(f.requests.length, 0);
    const preview = await f.ok("/jobs/orphan-job/result");
    assert.equal(preview.canRetry, true);
    assert.equal(preview.canRecover, false);
    assert.equal(preview.blocked.code, "RESULT_NOT_RECOVERABLE");
  },
);
test(
  "configuration changes during paid calculation reject its commit and preserve provider output without applying summary",
  { timeout: 15000 },
  async (t) => {
    let entered, release;
    const arrived = new Promise((resolve) => (entered = resolve)),
      held = new Promise((resolve) => (release = resolve));
    const f = await fixture(t, {
      respond: async (res) => {
        entered();
        await held;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "Synthetic paid late output" } }],
          }),
        );
      },
    });
    await f.job("conflict", "bulk", [0, 1]);
    await arrived;
    const field = (
      await f.ok("/fields/read", {
        targets: [
          {
            scope: "resource",
            resourceKind: "settings",
            entityId: "global",
            key: "username",
          },
        ],
      })
    ).fields[0];
    await f.command("peer", {
      type: "change-fields",
      edits: [
        {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "username",
          expectedEpoch: field.entityEpoch,
          expectedRevision: field.revision,
          value: "Changed",
        },
      ],
    });
    release();
    const job = await f.finished("conflict");
    assert.equal(job.state, "failed");
    assert.equal(job.result.code, "REVISION_CONFLICT");
    assert.equal(
      (await f.ok("/chats/a")).chat.metadata.hypaV3Data.summaries[0].text,
      "First summary",
    );
    const preview = await f.ok("/jobs/conflict/result");
    assert.equal(preview.canRecover, false);
    assert.equal(preview.canRetry, true);
    assert.ok(
      preview.providerOutputs.some((output) =>
        output.candidates.some((candidate) =>
          candidate.data.includes("Synthetic paid late output"),
        ),
      ),
    );
  },
);
