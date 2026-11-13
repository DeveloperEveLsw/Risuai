"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer, request } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");

async function until(read, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < end);
  throw new Error("Synthetic runtime condition did not finish in time");
}
const reply = (res, text) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
};
function delta(text, stop = false) {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { content: text },
          ...(stop ? { finish_reason: "stop" } : {}),
        },
      ],
    }) +
    "\n\n"
  );
}

async function fixture(t, respond, options = {}) {
  const requests = [],
    directory = mkdtempSync(join(tmpdir(), "risu-http-")),
    file = join(directory, "state.sqlite");
  const provider = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const part of req) text += part;
      const body = JSON.parse(text);
      requests.push(body);
      await respond(res, body, requests.length);
    } catch (error) {
      if (!res.destroyed) {
        res.statusCode = 500;
        res.end(error.message);
      }
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const f = { file, requests, errors: [], runtime: null };
  t.after(async () => {
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
      eventsPollMs: 20,
      scheduler: {
        pollMs: 20,
        progressIntervalMs: 25,
        cancelGraceMs: 250,
        onError: (error) => f.errors.push(error),
        ...options.scheduler,
      },
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
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  f.command = (requestId, command) =>
    f.api("/commands", { requestId, command });
  await f.command("character", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      desc: "Synthetic definition",
      firstMessage: "Greeting",
      ...options.character,
    },
  });
  for (const chatId of ["a", "b"])
    await f.command("chat-" + chatId, {
      type: "create-chat",
      chatId,
      characterId: "c",
      metadata: { name: chatId, localLore: [] },
    });
  await f.command("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl:
        "http://127.0.0.1:" + provider.address().port + "/v1/chat/completions",
      customTokenizer: "tik",
      useStreaming: false,
      maxContext: 8000,
      maxResponse: 100,
      mainPrompt: "Synthetic",
      jailbreak: "",
      ...options.settings,
    },
  });
  f.send = (id, chatId, input) =>
    f.api("/jobs", {
      requestId: id,
      command: { type: "send", chatId, input, messageId: "input-" + id },
    });
  f.finished = (id) =>
    until(
      () => f.api("/jobs/" + id),
      (job) => !["queued", "running"].includes(job.state),
    );
  return f;
}

async function events(t, url, after, lastEventId) {
  const abort = new AbortController();
  const response = await fetch(url + "/api/runtime/events?after=" + after, {
    signal: abort.signal,
    ...(lastEventId === undefined
      ? {}
      : { headers: { "Last-Event-ID": String(lastEventId) } }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  t.after(() => abort.abort());
  return {
    close: () => abort.abort(),
    next: async (predicate) => {
      const timeout = setTimeout(
        () => abort.abort(new Error("Synthetic SSE timeout")),
        10000,
      );
      try {
        while (true) {
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = block
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (line) {
              const event = JSON.parse(line.slice(6));
              if (predicate(event)) return event;
            }
          }
          const part = await reader.read();
          if (part.done) throw new Error("Synthetic event stream ended early");
          buffer += decoder.decode(part.value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

test(
  "HTTP admission survives a discarded acknowledgement and idempotent retry never repeats the provider call",
  { timeout: 15000 },
  async (t) => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const f = await fixture(t, async (res) => {
      await wait;
      reply(res, "reply");
    });
    const payload = {
      requestId: "lost",
      command: {
        type: "send",
        chatId: "a",
        input: "one",
        messageId: "input-lost",
      },
    };
    await new Promise((resolve, reject) => {
      const req = request(
        f.runtime.url + "/api/runtime/jobs",
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          assert.equal(res.statusCode, 202);
          res.destroy();
          resolve();
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(payload));
    });
    await until(
      () => Promise.resolve(f.requests.length),
      (n) => n === 1,
    );
    const accepted = await f.api("/jobs", payload);
    assert.equal(accepted.job.id, "lost");
    const conflict = await fetch(f.runtime.url + "/api/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        command: { ...payload.command, input: "different" },
      }),
    });
    assert.equal(conflict.status, 409);
    release();
    assert.equal((await f.finished("lost")).state, "completed");
    assert.equal(f.requests.length, 1);
    assert.equal((await f.api("/chats/a")).messages[1].message.data, "reply");
  },
);

test(
  "same-chat HTTP generations stay ordered while another chat completes independently",
  { timeout: 15000 },
  async (t) => {
    let release;
    const first = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const f = await fixture(t, async (res, body) => {
      const input = body.messages
        .filter((m) => m.role === "user")
        .at(-1).content;
      if (input === "one") await first;
      reply(res, "reply:" + input);
    });
    await f.send("a1", "a", "one");
    await f.send("a2", "a", "two");
    await f.send("b1", "b", "other");
    assert.equal((await f.finished("b1")).state, "completed");
    assert.equal((await f.api("/jobs/a2")).state, "queued");
    assert.equal(f.requests.length, 2);
    release();
    assert.equal((await f.finished("a2")).state, "completed");
    const a = await f.api("/chats/a");
    assert.deepEqual(
      a.messages.map((m) => m.message.data),
      ["one", "reply:one", "two", "reply:two"],
    );
    assert.ok(
      f.requests.some(
        (body) =>
          body.messages.some((m) => m.content === "reply:one") &&
          body.messages.some((m) => m.content === "two"),
      ),
    );
  },
);

test(
  "group member HTTP headers omit definition/history bodies and require a live group",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => reply(res, "Synthetic unused"));
    await f.command("http-group", {
      type: "create-character",
      characterId: "g",
      definition: {
        type: "group",
        name: "Synthetic group",
        characters: ["c"],
        characterTalks: [0.5],
        characterActive: [true],
        syntheticBulk: "Synthetic body marker ".repeat(10000),
      },
    });
    const header = await f.api("/groups/g/members/c");
    assert.deepEqual(header.member, {
      memberId: "c",
      revision: 1,
      slots: [{ position: 0, talkness: 0.5, active: true }],
    });
    assert.equal(header.entityEpoch, 0);
    assert.equal(header.orderRevision, 1);
    assert.ok(JSON.stringify(header).length < 300);
    assert.ok(!JSON.stringify(header).includes("body marker"));
    const absent = await f.api("/groups/g/members/not-a-member");
    assert.deepEqual(absent.member, {
      memberId: "not-a-member",
      revision: 0,
      slots: [],
    });
    const invalid = await fetch(
      f.runtime.url + "/api/runtime/groups/c/members/c",
    );
    assert.equal(invalid.status, 404);
  },
);

test(
  "partial HTTP reads and SSE replay include changes between snapshot and subscription and honor Last-Event-ID",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => reply(res, "reply"));
    for (let i = 0; i < 4; i++)
      await f.command("message-" + i, {
        type: "append-message",
        chatId: "a",
        messageId: "m-" + i,
        message: { role: "char", data: "text-" + i },
      });
    const snapshot = await f.api("/chats/a?limit=2");
    const character = await f.api("/characters/c");
    assert.equal(character.definition.desc, "Synthetic definition");
    assert.equal("chats" in character.definition, false);
    assert.deepEqual(
      snapshot.messages.map((m) => m.id),
      ["m-2", "m-3"],
    );
    assert.equal(snapshot.hasEarlier, true);
    assert.equal(
      JSON.stringify(await f.api("/bootstrap")).includes("text-"),
      false,
    );
    await f.command("choice-1", {
      type: "set-chat-variable",
      chatId: "a",
      key: "$choice",
      value: "one",
      expectedRevision: 0,
    });
    const stream = await events(t, f.runtime.url, snapshot.cursor);
    const one = await stream.next((e) => e.type === "variable");
    assert.equal(one.payload.value, "one");
    stream.close();
    await f.command("choice-2", {
      type: "set-chat-variable",
      chatId: "a",
      key: "$choice",
      value: "two",
      expectedRevision: 1,
    });
    const resumed = await events(
      t,
      f.runtime.url,
      snapshot.cursor,
      one.sequence,
    );
    const two = await resumed.next((e) => e.type === "variable");
    assert.equal(two.payload.value, "two");
    assert.ok(two.sequence > one.sequence);
    resumed.close();
    const old = await f.api("/chats/a?limit=4&before=2");
    assert.deepEqual(
      old.messages.map((m) => m.id),
      ["m-0", "m-1"],
    );
  },
);

for (const performanceMode of ["off", "balanced", "strong"]) {
  test(
    `stream progress survives HTTP observation disconnect and finalization keeps its message ID (${performanceMode})`,
    { timeout: 15000 },
    async (t) => {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      const f = await fixture(
        t,
        async (res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(delta("prefix-"));
          await wait;
          res.end(delta("done", true) + "data: [DONE]\n\n");
        },
        {
          settings: {
            useStreaming: true,
            streamingDisplayOptimizationMode: performanceMode,
          },
        },
      );
      const initial = await f.api("/chats/a");
      const stream = await events(t, f.runtime.url, initial.cursor);
      await f.send("stream", "a", "one");
      const partial = await until(
        () => f.api("/jobs/stream"),
        (job) => job.progress.messages?.[0]?.data === "prefix-",
      );
      const checkpoint = await stream.next((e) => e.type === "job-progress");
      assert.equal("messages" in checkpoint.payload, false);
      stream.close();
      assert.equal((await f.api("/chats/a")).messages.length, 0);
      release();
      assert.equal((await f.finished("stream")).state, "completed");
      const final = await f.api("/chats/a");
      assert.equal(final.messages[1].id, partial.progress.messages[0].chatId);
      assert.equal(final.messages[1].message.data, "prefix-done");
      assert.equal(f.requests.length, 1);
    },
  );
}

test(
  "an engine crash preserves streamed progress, interrupts the job and never repeats its provider request",
  { timeout: 15000 },
  async (t) => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const f = await fixture(
      t,
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta("partial"));
        await wait;
        res.end(delta("tail", true) + "data: [DONE]\n\n");
      },
      { settings: { useStreaming: true } },
    );
    await f.send("crash", "a", "one");
    await until(
      () => f.api("/jobs/crash"),
      (job) => job.progress.messages?.[0]?.data === "partial",
    );
    await f.runtime.scheduler.running.get("crash").worker.terminate();
    const interrupted = await f.finished("crash");
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.progress.messages[0].data, "partial");
    const preview = await f.api("/jobs/crash/result");
    assert.equal(preview.canRecover, false);
    assert.equal(preview.providerOutputs[0].complete, false);
    assert.equal(preview.providerOutputs[0].candidates[0].data, "partial");
    assert.equal(
      JSON.stringify(await f.api("/jobs/crash/status")).includes("partial"),
      false,
    );
    assert.equal(interrupted.progress.providerOutputs, undefined);
    const duplicate = await f.send("crash", "a", "one");
    assert.equal(duplicate.job.progress.providerOutputs, undefined);
    assert.equal((await f.api("/chats/a")).messages.length, 0);
    await f.restart();
    await delay(100);
    assert.equal((await f.api("/jobs/crash")).state, "interrupted");
    assert.deepEqual(
      (await f.api("/jobs/crash/result")).providerOutputs,
      preview.providerOutputs,
    );
    assert.equal(f.requests.length, 1);
  },
);

test(
  "queued HTTP requests recover after a service restart without duplicate execution",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => reply(res, "recovered"));
    await f.runtime.scheduler.close();
    await f.send("queued", "a", "one");
    assert.equal((await f.api("/jobs/queued")).state, "queued");
    assert.equal((await f.api("/jobs/queued/command")).input, "one");
    await f.restart();
    assert.equal((await f.finished("queued")).state, "completed");
    assert.equal(f.requests.length, 1);
  },
);

test(
  "HTTP cancellation aborts a live provider body without committing provisional messages",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta("partial"));
      },
      { settings: { useStreaming: true } },
    );
    await f.send("cancel", "a", "one");
    await until(
      () => f.api("/jobs/cancel"),
      (job) => job.progress.messages?.[0]?.data === "partial",
    );
    const cancelling = await f.api("/jobs/cancel/cancel", {});
    assert.equal(cancelling.progress.providerOutputs, undefined);
    assert.equal((await f.finished("cancel")).state, "cancelled");
    const preview = await f.api("/jobs/cancel/result");
    assert.equal(preview.canRecover, false);
    assert.equal(preview.providerOutputs[0].complete, false);
    assert.equal(preview.providerOutputs[0].candidates[0].data, "partial");
    assert.equal((await f.api("/chats/a")).messages.length, 0);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "a non-cooperative Lua loop leaves HTTP state commands responsive and is forcibly cancelled without partial writes",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => reply(res, "unused"), {
      character: {
        triggerscript: [
          {
            effect: [
              {
                type: "triggerlua",
                code: `
function onButtonClick(id, data)
  setChatVar(id, 'temporary', 'yes')
  while true do end
end`,
              },
            ],
          },
        ],
      },
    });
    await f.api("/jobs", {
      requestId: "cpu",
      command: { type: "button", chatId: "a", data: "synthetic" },
    });
    await until(
      () =>
        Promise.resolve(
          f.runtime.scheduler.running.get("cpu")?.activityObserved,
        ),
      Boolean,
    );
    await f.command("other-toggle", {
      type: "set-chat-variable",
      chatId: "b",
      key: "$choice",
      value: "immediate",
      expectedRevision: 0,
    });
    assert.equal((await f.api("/jobs/cpu")).state, "running");
    assert.equal((await f.api("/chats/b")).variables[0].value, "immediate");
    await f.api("/jobs/cpu/cancel", {});
    assert.equal((await f.finished("cpu")).state, "cancelled");
    assert.equal((await f.api("/chats/a")).variables.length, 0);
    assert.equal(f.requests.length, 0);
  },
);

test(
  "the local HTTP API rejects foreign origins, malformed input and cursors that need resynchronization",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, async (res) => reply(res, "unused"));
    const foreign = await fetch(f.runtime.url + "/api/runtime/bootstrap", {
      headers: { origin: "https://untrusted.example" },
    });
    assert.equal(foreign.status, 403);
    const invalid = await fetch(
      f.runtime.url + "/api/runtime/chats/a?limit=-1",
    );
    assert.equal(invalid.status, 400);
    const snapshot = await f.api("/chats/a");
    const future = await fetch(
      f.runtime.url + "/api/runtime/events?after=" + (snapshot.cursor + 100),
    );
    assert.equal(future.status, 409);
    await f.runtime.store.call("pruneChanges", snapshot.cursor);
    const expired = await fetch(f.runtime.url + "/api/runtime/events?after=0");
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error.code, "RESYNC_REQUIRED");
  },
);

test("HTTP field reads and atomic commands preserve independent settings edits and expose own revisions without chat history", async (t) => {
  const f = await fixture(t, (res) => reply(res, "unused"));
  const targets = [
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "maxResponse",
    },
    {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "maxContext",
    },
    { scope: "chat", entityId: "a", key: "note" },
  ];
  const before = await f.api("/fields/read", { targets });
  assert.equal(before.fields.length, 3);
  assert.equal(JSON.stringify(before).includes("Synthetic"), false);
  const changes = before.fields.map((value, i) => ({
    ...targets[i],
    expectedRevision: value.revision,
    expectedEpoch: value.entityEpoch,
    value: [150, 16000, "Synthetic edited note"][i],
  }));
  const first = await f.command("field-first", {
    type: "change-fields",
    edits: [changes[0]],
  });
  const second = await f.command("field-second", {
    type: "change-fields",
    edits: changes.slice(1),
  });
  assert.ok(second.cursor > first.cursor);
  assert.deepEqual(
    await f.command("field-first", {
      type: "change-fields",
      edits: [changes[0]],
    }),
    first,
  );
  const response = await fetch(f.runtime.url + "/api/runtime/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "stale-field",
      command: { type: "change-fields", edits: [changes[0]] },
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "REVISION_CONFLICT");
  assert.deepEqual(
    (await f.api("/fields/read", { targets })).fields.map(
      (field) => field.value,
    ),
    [150, 16000, "Synthetic edited note"],
  );
  const settings = await f.api("/resources/settings/global");
  assert.equal(settings.payload.maxResponse, 150);
  assert.equal(settings.payload.maxContext, 16000);
  assert.equal(settings.fieldRevisions.maxResponse, 2);
  assert.equal(f.requests.length, 0);
});

test("HTTP bookmark headers/pages and commands use the durable database worker and scoped ownership/versions", async (t) => {
  const f = await fixture(t, (res) => reply(res, "Synthetic unused"));
  for (let i = 0; i < 110; i++)
    await f.command("bookmark-msg-" + i, {
      type: "append-message",
      chatId: "a",
      messageId: "bm" + i,
      message: { role: "char", data: "Synthetic bookmark " + i },
    });
  const a = await f.api("/chats/a/bookmarks/bm0"),
    b = await f.api("/chats/a/bookmarks/bm109");
  const intent = (h) => ({
    type: "set-bookmark",
    chatId: h.chatId,
    messageId: h.messageId,
    expectedRevision: h.revision,
    expectedChatEpoch: h.entityEpoch,
    expectedMessageRevision: h.messageRevision,
    action: "add",
    name: "Synthetic HTTP",
  });
  const receipt = await f.command("bookmark-once", intent(a));
  await f.command("bookmark-independent", intent(b));
  assert.deepEqual(await f.command("bookmark-once", intent(a)), receipt);
  const around = await f.api("/chats/a?limit=20&around=bm0");
  assert.equal(around.messages.length, 20);
  assert.equal(around.messages[0].id, "bm0");
  assert.equal(around.hasEarlier, false);
  assert.equal(around.hasLater, true);
  const onward = await f.api("/chats/a?limit=20&after=19");
  assert.equal(onward.messages[0].id, "bm20");
  assert.equal(onward.messages[0].ordinal, 20);
  const conflicting = await fetch(
    f.runtime.url + "/api/runtime/chats/a?after=19&around=bm0",
  );
  assert.equal(conflicting.status, 400);
  const partial = await f.api("/chats/a?limit=100");
  assert.equal(partial.messages.length, 100);
  assert.ok(partial.messages.every((row) => row.id !== "bm0"));
  const first = await f.api("/chats/a/bookmarks?limit=1");
  assert.equal(first.items[0].messageId, "bm0");
  assert.equal(first.items[0].ordinal, 0);
  assert.equal(first.historyCount, 110);
  const second = await f.api("/chats/a/bookmarks?limit=1&after=" + first.next);
  assert.equal(second.items[0].messageId, "bm109");
  assert.equal(second.next, null);
  const invalid = await fetch(
    f.runtime.url + "/api/runtime/chats/b/bookmarks/bm0",
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_COMMAND");
});

test("HTTP bookmark observation headers forward cursor fencing without a body and reject uncovered observations", async (t) => {
  const f = await fixture(t, (res) => reply(res, "Synthetic unused"));
  await f.command("observed-message", {
    type: "append-message",
    chatId: "a",
    messageId: "observed",
    message: { role: "char", data: "Synthetic body" },
  });
  const h = await f.api("/chats/a/bookmarks/observed");
  await f.command("observed-add", {
    type: "set-bookmark",
    chatId: "a",
    messageId: "observed",
    expectedRevision: h.revision,
    expectedChatEpoch: h.entityEpoch,
    expectedMessageRevision: h.messageRevision,
    action: "add",
    name: "Synthetic name",
  });
  const changed = await f.api(
    "/chats/a/bookmarks/observed?observedCursor=" + h.cursor,
  );
  assert.equal(changed.changedAfterObservedCursor, true);
  assert.equal(JSON.stringify(changed).includes("Synthetic body"), false);
  assert.equal(
    (
      await f.api(
        "/chats/a/bookmarks/observed?observedCursor=" + changed.cursor,
      )
    ).changedAfterObservedCursor,
    false,
  );
  for (const observed of ["-1", "x", String(changed.cursor + 1)]) {
    const response = await fetch(
      f.runtime.url +
        "/api/runtime/chats/a/bookmarks/observed?observedCursor=" +
        observed,
    );
    assert.equal(
      response.status,
      observed === String(changed.cursor + 1) ? 409 : 400,
    );
  }
  await f.runtime.store.call("pruneChanges", changed.cursor);
  const expired = await fetch(
    f.runtime.url +
      "/api/runtime/chats/a/bookmarks/observed?observedCursor=" +
      h.cursor,
  );
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error.code, "RESYNC_REQUIRED");
});
