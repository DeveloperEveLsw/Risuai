"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStoreClient } = require("../entity/client.cjs");
const { createNativeProcessWorker } = require("./processWorker.cjs");
const { NativeScheduler } = require("./scheduler.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const { DatabaseSync } = require("node:sqlite");

async function fixture(
  t,
  { ordered = false, response, lua = false, settings = {} } = {},
) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = { path: req.url, body: JSON.parse(body) };
    requests.push(request);
    if (response) await response(res, request, requests.length);
    else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const directory = mkdtempSync(join(tmpdir(), "risu-group-"));
  const file = join(directory, "state.sqlite");
  const store = new EntityStoreClient(file);
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const [id, name] of [
    ["alpha", "Alpha"],
    ["beta", "Beta"],
    ["inactive", "Inactive"],
  ]) {
    await store.call("applyCommand", "member-" + id, {
      type: "create-character",
      characterId: id,
      definition: {
        type: "character",
        name,
        desc: "Synthetic member " + name,
        firstMessage: "Synthetic private greeting " + name,
        customscript: [
          {
            comment: "output",
            in: "raw-output",
            out: name + "-processed",
            type: "editoutput",
          },
        ],
        triggerscript: [
          {
            type: "output",
            conditions: [],
            effect: [
              { type: "setvar", var: "seen-" + id, operator: "+=", value: "1" },
            ],
          },
          ...(lua
            ? [
                {
                  type: "output",
                  conditions: [],
                  effect: [
                    {
                      type: "triggerlua",
                      code: `function onOutput(id) setChatVar(id, 'lua-${id}', 'yes') end`,
                    },
                  ],
                },
              ]
            : []),
        ],
        globalLore: [],
      },
    });
    await store.call("applyCommand", "private-chat-" + id, {
      type: "create-chat",
      chatId: "private-" + id,
      characterId: id,
      metadata: { name: "Synthetic individual history", localLore: [] },
    });
    await store.call("applyCommand", "private-message-" + id, {
      type: "append-message",
      chatId: "private-" + id,
      messageId: "private-message-" + id,
      message: {
        role: "user",
        data: "Synthetic private history sentinel " + name,
      },
    });
  }
  await store.call("applyCommand", "group", {
    type: "create-character",
    characterId: "group",
    definition: {
      type: "group",
      name: "Synthetic group",
      characters: ["alpha", "beta", "inactive"],
      characterTalks: [1, 1, 1],
      characterActive: [true, true, false],
      orderByOrder: ordered,
      autoMode: false,
      useCharacterLore: true,
      customscript: [
        {
          comment: "group output",
          in: "raw-output",
          out: "group-processed",
          type: "editoutput",
        },
      ],
      triggerscript: [],
      globalLore: [],
    },
  });
  await store.call("applyCommand", "group-chat", {
    type: "create-chat",
    chatId: "group-chat",
    characterId: "group",
    metadata: { name: "Synthetic group history", localLore: [] },
  });
  if (lua)
    await store.call("applyCommand", "module-lua", {
      type: "put-resource",
      kind: "module",
      resourceId: "module",
      expectedRevision: 0,
      payload: {
        id: "module",
        name: "Synthetic module",
        trigger: [
          {
            type: "manual",
            conditions: [],
            effect: [
              {
                type: "triggerlua",
                code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'module-output', 'yes')
  return text .. ':module'
end)
`,
              },
            ],
          },
        ],
      },
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
      mainPrompt: "Synthetic system {{char}}",
      jailbreak: "",
      maxContext: 8000,
      maxResponse: 200,
      enabledModules: lua ? ["module"] : [],
      ...settings,
    },
  });

  return { store, file, requests };
}

async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(
    "Synthetic compound group condition timed out: " + JSON.stringify(value),
  );
}

async function start(t, f, id, input = "Alpha Beta", chatId = "group-chat") {
  const command =
    typeof input === "string"
      ? {
          type: "send",
          chatId,
          input,
          messageId: id + "-input",
        }
      : input;
  await f.store.call("enqueueJob", id, command);
  const claimed = await f.store.call("claimJob", id + "-worker");
  const worker = createNativeProcessWorker({
    file: f.file,
    claimed,
    diagnostics: true,
  });
  t.after(() => worker.terminate());
  const progress = [];
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
  return { worker, done, progress, claimed };
}

test(
  "a real failed group persistence can recover its full script effects without repeating provider calls",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { ordered: true, lua: true });
    const db = new DatabaseSync(f.file);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON messages WHEN NEW.chat_id='group-chat' BEGIN SELECT RAISE(ABORT,'Synthetic save blocked'); END;",
    );
    const run = await start(t, f, "save-failure");
    const outcome = await run.done;
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.result.message, "Synthetic save blocked");
    assert.equal(f.requests.length, 2);
    assert.equal(
      (await f.store.call("snapshot", "group-chat")).messages.length,
      0,
    );
    assert.equal((await f.store.call("bootstrap")).statistics[0].messages, 0);
    const blocked = await f.store.call("previewJobResult", "save-failure");
    assert.equal(blocked.canRecover, false);
    db.exec("DROP TRIGGER synthetic_save_failure");
    const preview = await f.store.call("previewJobResult", "save-failure");
    assert.equal(preview.canRecover, true, JSON.stringify(preview.blocked));
    assert.equal(preview.messages.length, 3);
    const command = { type: "recover-job-result", ...preview.target };
    await f.store.call("applyCommand", "recover", command);
    await f.store.call("applyCommand", "recover-again", command);
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.equal(snapshot.messages.length, 3);
    assert.equal(f.requests.length, 2);
    assert.equal((await f.store.call("bootstrap")).statistics[0].messages, 3);
    const vars = Object.fromEntries(
      snapshot.variables.map((v) => [v.key, v.value]),
    );
    assert.equal(vars["$seen-alpha"], "1");
    assert.equal(vars["$seen-beta"], "1");
    assert.equal(vars["$lua-alpha"], "yes");
    assert.equal(vars["$lua-beta"], "yes");
    assert.equal(vars["$module-output"], "yes");
    assert.deepEqual(
      snapshot.messages.map((m) => m.message.data),
      preview.messages.map((m) => m.data),
    );
  },
);

test(
  "explicit retry executes one fresh native group request and does not commit the old failed output",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      ordered: true,
      lua: true,
      settings: { mainPrompt: "Synthetic context {{getvar::context}}" },
    });
    await f.store.call("applyCommand", "context-old", {
      type: "set-chat-variable",
      chatId: "group-chat",
      key: "$context",
      value: "old-context",
    });
    const db = new DatabaseSync(f.file);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON messages WHEN NEW.chat_id='group-chat' BEGIN SELECT RAISE(ABORT,'Synthetic save blocked'); END;",
    );
    const run = await start(t, f, "failed-before-retry");
    const source = await run.done;
    assert.equal(source.state, "failed");
    assert.equal(f.requests.length, 2);
    db.exec("DROP TRIGGER synthetic_save_failure");
    await f.store.call("applyCommand", "context-fresh", {
      type: "set-chat-variable",
      chatId: "group-chat",
      key: "$context",
      value: "fresh-context",
    });
    const preview = await f.store.call("previewJobResult", source.id);
    assert.equal(preview.canRetry, true);
    const command = { type: "retry-job-result", ...preview.target };
    const [a, b] = await Promise.all([
      f.store.call("applyCommand", "retry-left", command),
      f.store.call("applyCommand", "retry-right", command),
    ]);
    assert.equal(a.disposition.resultJobId, b.disposition.resultJobId);
    const scheduler = new NativeScheduler({
      store: f.store,
      file: f.file,
      pollMs: 10,
    });
    t.after(() => scheduler.close());
    const child = await until(
      () => f.store.call("getJob", a.disposition.resultJobId),
      (job) => ["completed", "failed", "interrupted"].includes(job?.state),
    );
    assert.equal(child.state, "completed", JSON.stringify(child.result));
    assert.equal(f.requests.length, 4);
    for (const request of f.requests.slice(0, 2))
      assert.ok(JSON.stringify(request.body).includes("old-context"));
    for (const request of f.requests.slice(2))
      assert.ok(JSON.stringify(request.body).includes("fresh-context"));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.equal(snapshot.messages.length, 3);
    assert.notEqual(snapshot.messages[0].id, "failed-before-retry-input");
    assert.equal(
      snapshot.variables.find((v) => v.key === "$seen-alpha").value,
      "1",
    );
    assert.equal(
      snapshot.variables.find((v) => v.key === "$seen-beta").value,
      "1",
    );
    for (const key of ["$lua-alpha", "$lua-beta", "$module-output"])
      assert.equal(snapshot.variables.find((v) => v.key === key).value, "yes");
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.data),
      ["group-processed:module", "group-processed:module"],
    );
    assert.equal((await f.store.call("bootstrap")).statistics[0].messages, 3);
    assert.deepEqual(await f.store.call("getJob", source.id), source);
  },
);

for (const lifecycle of ["delete", "recreate"])
  test(
    `a pinned group job retains uncommitted replies after member ${lifecycle} during its provider request`,
    { timeout: 30000 },
    async (t) => {
      let reached, release;
      const requested = new Promise((resolve) => {
        reached = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const f = await fixture(t, {
        response: async (res, _request, count) => {
          if (count === 3) {
            reached();
            await held;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        },
      });
      let run;
      try {
        // Let the real engine persist its normal defaults first. A fresh minimal
        // member has incidental definition writes that can mask a read-only
        // lifecycle race by conflicting before final persistence.
        const warmup = await start(t, f, "normalized-member-warmup");
        assert.equal((await warmup.done).state, "completed");
        const before = await f.store.call("snapshot", "group-chat");
        const settingsBefore = await f.store.call(
          "getResource",
          "settings",
          "global",
        );
        run = await start(t, f, "old-member-generation");
        await requested;
        const source = await f.store.call("getCharacter", "alpha");
        await f.store.call("applyCommand", "delete-used-member", {
          type: "delete-character",
          characterId: "alpha",
          expectedRevision: source.revision,
          expectedEpoch: source.entityEpoch,
        });
        let replacement;
        if (lifecycle === "recreate") {
          await f.store.call("applyCommand", "recreate-used-member", {
            type: "create-character",
            characterId: "alpha",
            definition: {
              ...source.definition,
              name: "Replacement Alpha",
              lastInteraction: 25,
            },
          });
          replacement = await f.store.call("getCharacter", "alpha");
          assert.ok(replacement.revision > source.revision);
          assert.ok(replacement.entityEpoch > source.entityEpoch);
        }
        release();
        const outcome = await run.done;
        const after = await f.store.call("snapshot", "group-chat");
        const resultingMember = await f.store.call("getCharacter", "alpha");
        const resultingActivity = resultingMember?.activity;
        assert.equal(
          outcome.state,
          "failed",
          JSON.stringify({
            result: outcome.result,
            replacementActivity: replacement?.activity,
            resultingActivity,
            beforeMessages: before.messages.length,
            afterMessages: after.messages.length,
          }),
        );
        assert.equal(
          outcome.result.code,
          lifecycle === "recreate" ? "REVISION_CONFLICT" : "NOT_FOUND",
        );
        assert.equal(outcome.result.uncommitted.result.providerCalls, 2);
        assert.equal(
          outcome.result.uncommitted.writeSet.statistics[0].expectedEpoch,
          settingsBefore.entityEpoch,
        );
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.variables, before.variables);
        assert.deepEqual(after.character.activity, before.character.activity);
        assert.deepEqual(
          (await f.store.call("getResource", "settings", "global")).statistics,
          settingsBefore.statistics,
        );
        if (lifecycle === "recreate")
          assert.deepEqual(resultingActivity, replacement.activity);
        else assert.equal(resultingMember, null);
        assert.equal(f.requests.length, 4);
      } finally {
        release();
        await run?.worker.terminate();
      }
    },
  );

test(
  "ordinary member and settings edits during a pinned group job remain independent of incarnation guards",
  { timeout: 30000 },
  async (t) => {
    let reached, release;
    const requested = new Promise((resolve) => {
      reached = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      response: async (res, _request, count) => {
        if (count === 3) {
          reached();
          await held;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "raw-output" } }] }),
        );
      },
    });
    let run;
    try {
      const warmup = await start(t, f, "ordinary-edit-warmup");
      assert.equal((await warmup.done).state, "completed");
      const before = await f.store.call("snapshot", "group-chat");
      run = await start(t, f, "ordinary-edit-generation");
      await requested;
      const member = await f.store.call("getCharacter", "alpha");
      const settings = await f.store.call("getResource", "settings", "global");
      await f.store.call("applyCommand", "ordinary-peer-edit", {
        type: "change-fields",
        edits: [
          {
            scope: "character",
            entityId: "alpha",
            key: "name",
            expectedRevision: member.fieldRevisions.name,
            expectedEpoch: member.entityEpoch,
            value: "Peer Alpha",
          },
          {
            scope: "resource",
            resourceKind: "settings",
            entityId: "global",
            key: "username",
            expectedRevision: settings.fieldRevisions.username ?? 0,
            expectedEpoch: settings.entityEpoch,
            value: "Peer user",
          },
        ],
      });
      release();
      const outcome = await run.done;
      assert.equal(outcome.state, "completed", JSON.stringify(outcome.result));
      assert.equal(outcome.result.providerCalls, 2);
      const after = await f.store.call("snapshot", "group-chat");
      assert.deepEqual(
        after.messages.slice(0, before.messages.length),
        before.messages,
      );
      assert.equal(after.messages.length, 6);
      assert.equal(
        (await f.store.call("getCharacter", "alpha")).definition.name,
        "Peer Alpha",
      );
      const saved = await f.store.call("getResource", "settings", "global");
      assert.equal(saved.payload.username, "Peer user");
      // The original counter includes the admitted user and both replies.
      assert.equal(saved.statistics.messages, settings.statistics.messages + 3);
      assert.match(
        JSON.stringify(f.requests[2].body.messages),
        /next reply only as Alpha/,
      );
      assert.equal(f.requests.length, 4);
    } finally {
      release();
      await run?.worker.terminate();
    }
  },
);

test(
  "compound group shutdown preserves both provisional replies and only queued work executes after reopening the database",
  { timeout: 30000 },
  async (t) => {
    const delta = (text) =>
      "data: " +
      JSON.stringify({ choices: [{ delta: { content: text } }] }) +
      "\n\n";
    const f = await fixture(t, {
      settings: { useStreaming: true },
      response: async (res, _request, count) => {
        res.setHeader("content-type", "text/event-stream");
        res.write(delta(count === 2 ? "Synthetic Beta partial" : "raw-output"));
        if (count === 2)
          await new Promise((resolve) => res.on("close", resolve));
        else res.end("data: [DONE]\n\n");
      },
    });
    let scheduler, reopened;
    const interruptedCommand = {
      type: "send",
      chatId: "group-chat",
      input: "Alpha Beta",
      messageId: "interrupted-user",
    };
    const queuedCommand = {
      type: "send",
      chatId: "group-chat",
      input: "Alpha Beta queued",
      messageId: "queued-user",
    };
    try {
      const before = await f.store.call("snapshot", "group-chat");
      await f.store.call(
        "enqueueJob",
        "compound-interrupted",
        interruptedCommand,
      );
      scheduler = new NativeScheduler({
        store: f.store,
        file: f.file,
        concurrency: 1,
        pollMs: 20,
        progressIntervalMs: 10,
      });
      const progress = await until(
        () => f.store.call("getJob", "compound-interrupted"),
        (job) =>
          job.progress.providerCalls === 2 &&
          job.progress.messages?.filter((m) => m.role === "char").length ===
            2 &&
          job.progress.messages.at(-1).data === "Synthetic Beta partial",
      );
      const replies = progress.progress.messages.filter(
        (m) => m.role === "char",
      );
      assert.deepEqual(
        replies.map((m) => m.saying),
        ["alpha", "beta"],
      );
      assert.equal(replies[0].data, "group-processed");
      const during = await f.store.call("snapshot", "group-chat");
      assert.deepEqual(during.messages, before.messages);
      assert.deepEqual(during.variables, before.variables);
      await f.store.call("enqueueJob", "compound-queued", queuedCommand);
      assert.equal(
        (await f.store.call("getJob", "compound-queued")).state,
        "queued",
      );
      await scheduler.close();
      const stopped = await f.store.call("getJob", "compound-interrupted");
      assert.equal(stopped.state, "interrupted");
      assert.equal(stopped.result.mayHaveExternalEffects, true);
      assert.deepEqual(stopped.progress.messages, progress.progress.messages);
      assert.equal(f.requests.length, 2);
      await f.store.close();
      reopened = new EntityStoreClient(f.file);
      const restored = await reopened.call("getJob", "compound-interrupted");
      assert.deepEqual(restored, stopped);
      assert.equal(
        (
          await reopened.call(
            "enqueueJob",
            "compound-interrupted",
            interruptedCommand,
          )
        ).state,
        "interrupted",
      );
      assert.equal(
        (await reopened.call("enqueueJob", "compound-queued", queuedCommand))
          .state,
        "queued",
      );
      await assert.rejects(
        reopened.call(
          "writeJobProgress",
          "compound-interrupted",
          progress.owner,
          progress.fence,
          {},
        ),
        { code: "STALE_WORKER" },
      );
      await assert.rejects(
        reopened.call(
          "finishJob",
          "compound-interrupted",
          progress.owner,
          progress.fence,
          { state: "completed", messages: [], variables: [] },
        ),
        { code: "STALE_WORKER" },
      );
      scheduler = new NativeScheduler({
        store: reopened,
        file: f.file,
        concurrency: 1,
        pollMs: 20,
        progressIntervalMs: 10,
      });
      const completed = await until(
        () => reopened.call("getJob", "compound-queued"),
        (job) => job.state === "completed" || job.state === "failed",
      );
      assert.equal(
        completed.state,
        "completed",
        JSON.stringify(completed.result),
      );
      assert.equal(completed.result.providerCalls, 2);
      await scheduler.close();
      assert.equal(f.requests.length, 4);
      const after = await reopened.call("snapshot", "group-chat");
      assert.equal(after.messages.length, 3);
      assert.equal(after.messages[0].id, "queued-user");
      assert.equal(after.messages[0].message.data, "Alpha Beta queued");
      assert.ok(
        after.messages.every(
          (row) => !progress.progress.messages.some((m) => m.chatId === row.id),
        ),
      );
      assert.equal(
        after.variables.find((row) => row.key === "$seen-alpha").value,
        "1",
      );
      assert.equal(
        after.variables.find((row) => row.key === "$seen-beta").value,
        "1",
      );
      assert.equal(
        (await reopened.call("getJob", "compound-interrupted")).state,
        "interrupted",
      );
      assert.deepEqual(
        (await reopened.call("getJob", "compound-interrupted")).progress
          .messages,
        stopped.progress.messages,
      );
      for (const id of ["alpha", "beta", "inactive"])
        assert.equal(
          (await reopened.call("snapshot", "private-" + id)).messages.length,
          1,
        );
    } finally {
      await scheduler?.close();
      await reopened?.close();
    }
  },
);

test(
  "first group reroll replaces the original latest speaker batch rather than retaining a prior member reply",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const first = await start(t, f, "original-batch");
    assert.equal((await first.done).state, "completed");
    const before = await f.store.call("snapshot", "group-chat");
    const last = before.messages.at(-1);
    assert.deepEqual(
      before.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    const reroll = await start(t, f, "rerolled-batch", {
      type: "reroll",
      chatId: "group-chat",
      messageId: last.id,
      expectedRevision: last.revision,
      expectedChatEpoch: before.chat.entityEpoch,
    });
    const result = await reroll.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(result.result.providerCalls, 2);
    const after = await f.store.call("snapshot", "group-chat");
    assert.equal(after.messages.length, 3);
    assert.equal(after.messages[0].id, before.messages[0].id);
    assert.ok(
      after.messages
        .slice(1)
        .every((row) => !before.messages.some((old) => old.id === row.id)),
    );
    assert.deepEqual(
      after.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    assert.equal(f.requests.length, 4);
  },
);

test(
  "real native unequal group rerolls persist complete immutable batches and selecting them never repeats regex, Lua or statistics",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { ordered: true, lua: true });
    const first = await start(t, f, "history-group-A");
    assert.equal((await first.done).state, "completed");
    const before = await f.store.call("snapshot", "group-chat");
    const member = await f.store.call("readGroupMember", "group", "beta");
    await f.store.call("applyCommand", "disable-beta", {
      type: "change-group-member",
      groupId: "group",
      memberId: "beta",
      action: "set-active",
      value: false,
      position: member.member.slots[0].position,
      expectedEpoch: member.entityEpoch,
      expectedOrderRevision: member.orderRevision,
      expectedMemberRevision: member.member.revision,
    });
    const last = before.messages.at(-1);
    const run = await start(t, f, "history-group-B", {
      type: "reroll",
      chatId: "group-chat",
      messageId: last.id,
      expectedRevision: last.revision,
      expectedChatEpoch: 0,
    });
    const outcome = await run.done;
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.result));
    const after = await f.store.call("snapshot", "group-chat"),
      settings = await f.store.call("getResource", "settings", "global");
    assert.equal(before.messages.length, 3);
    assert.equal(after.messages.length, 2);
    assert.equal(f.requests.length, 3);
    for (const [i, direction] of [
      "previous",
      "next",
      "previous",
      "next",
    ].entries()) {
      const snapshot = await f.store.call("snapshot", "group-chat"),
        row = snapshot.messages.at(-1);
      const head = await f.store.call(
        "readReplyChoices",
        "group-chat",
        row.id,
        row.revision,
        0,
      );
      assert.equal(head.batch.count, 2);
      assert.equal(head.batch.available, true);
      const result = await f.store.call("applyCommand", "history-move-" + i, {
        type: "move-reply-choice",
        ...head.target,
        direction,
      });
      assert.equal(result.kind, "batch");
      const selected = await f.store.call("snapshot", "group-chat"),
        expected = direction === "previous" ? before : after;
      assert.deepEqual(
        selected.messages.map((r) => r.message),
        expected.messages.map((r) => r.message),
      );
      assert.deepEqual(selected.variables, after.variables);
      assert.deepEqual(selected.chat.metadata, after.chat.metadata);
      assert.deepEqual(
        (await f.store.call("getResource", "settings", "global")).statistics,
        settings.statistics,
      );
      assert.equal(f.requests.length, 3);
      assert.equal((await f.store.call("listJobs", "group-chat")).length, 2);
    }
    assert.deepEqual(
      (await f.store.call("getCharacter", "group")).definition.characterActive,
      [true, false, false],
    );
  },
);

test(
  "group continue keeps the original group speaker-switch behavior and existing reply identities",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      initial = await start(t, f, "before-continue");
    assert.equal((await initial.done).state, "completed");
    const before = await f.store.call("snapshot", "group-chat"),
      last = before.messages.at(-1);
    const next = await start(t, f, "continued-group", {
      type: "continue",
      chatId: "group-chat",
      messageId: last.id,
      expectedRevision: last.revision,
      expectedChatEpoch: before.chat.entityEpoch,
    });
    const result = await next.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(result.result.providerCalls, 1);
    const after = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      after.messages.slice(0, 3).map((row) => row.id),
      before.messages.map((row) => row.id),
    );
    assert.equal(after.messages.length, 4);
    assert.equal(after.messages.at(-1).message.saying, "alpha");
    assert.equal(
      after.messages[2].message.data,
      before.messages[2].message.data,
    );
  },
);

test(
  "cancelled compound reroll retains every original group reply and original variables",
  { timeout: 30000 },
  async (t) => {
    let reached;
    const finalRequest = new Promise((resolve) => (reached = resolve));
    const f = await fixture(t, {
      response: async (res, _request, count) => {
        res.setHeader("content-type", "application/json");
        if (count < 4)
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        else {
          res.flushHeaders();
          reached();
          await new Promise((resolve) => res.on("close", resolve));
        }
      },
    });
    const first = await start(t, f, "retained-before-cancel");
    assert.equal((await first.done).state, "completed");
    const before = await f.store.call("snapshot", "group-chat"),
      last = before.messages.at(-1);
    const reroll = await start(t, f, "cancelled-reroll", {
      type: "reroll",
      chatId: "group-chat",
      messageId: last.id,
      expectedRevision: last.revision,
    });
    await finalRequest;
    await f.store.call("requestCancel", "cancelled-reroll");
    reroll.worker.postMessage({ type: "cancel", jobId: "cancelled-reroll" });
    assert.equal((await reroll.done).state, "cancelled");
    const after = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.variables, before.variables);
    assert.equal(f.requests.length, 4);
  },
);

test(
  "a peer-changed reroll target is rejected before another provider call and retains the group batch",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      first = await start(t, f, "stale-first");
    assert.equal((await first.done).state, "completed");
    const before = await f.store.call("snapshot", "group-chat"),
      last = before.messages.at(-1);
    await f.store.call("applyCommand", "peer-message-edit", {
      type: "edit-message",
      messageId: last.id,
      expectedRevision: last.revision,
      text: "Synthetic peer edit",
    });
    const reroll = await start(t, f, "stale-reroll", {
      type: "reroll",
      chatId: "group-chat",
      messageId: last.id,
      expectedRevision: last.revision,
    });
    const rejected = await reroll.done;
    assert.equal(rejected.state, "failed");
    assert.match(rejected.result.message, /target is absent or has changed/);
    const after = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      after.messages.map((row) => row.id),
      before.messages.map((row) => row.id),
    );
    assert.equal(after.messages.at(-1).message.data, "Synthetic peer edit");
    assert.equal(f.requests.length, 2);
  },
);

test(
  "durable member settings and ordered mode reach the native speaker snapshot without individual history writes",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    for (const [memberId, value] of [
      ["alpha", false],
      ["beta", false],
      ["inactive", true],
    ]) {
      const h = await f.store.call("readGroupMember", "group", memberId);
      await f.store.call("applyCommand", "active-" + memberId, {
        type: "change-group-member",
        groupId: "group",
        memberId,
        action: "set-active",
        value,
        position: h.member.slots[0].position,
        expectedEpoch: h.entityEpoch,
        expectedOrderRevision: h.orderRevision,
        expectedMemberRevision: h.member.revision,
      });
    }
    const g = await f.store.call("getCharacter", "group");
    await f.store.call("applyCommand", "ordered-setting", {
      type: "change-fields",
      edits: [
        {
          scope: "character",
          entityId: "group",
          key: "orderByOrder",
          value: true,
          expectedRevision: g.fieldRevisions.orderByOrder,
          expectedEpoch: g.entityEpoch,
        },
      ],
    });
    const run = await start(t, f, "durable-members"),
      result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    assert.equal(result.result.providerCalls, 1);
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.saying),
      ["inactive"],
    );
    assert.deepEqual(snapshot.character.definition.characterActive, [
      false,
      false,
      true,
    ]);
    for (const memberId of ["alpha", "beta", "inactive"])
      assert.equal(
        (await f.store.call("snapshot", "private-" + memberId)).messages.length,
        1,
      );
  },
);

test(
  "native group generation uses original mention order, group regex, member triggers and shared group history",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const run = await start(t, f, "mention-group");
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.equal(result.result.providerCalls, 2);
    assert.deepEqual(
      snapshot.messages.map((row) => row.message.data),
      ["Alpha Beta", "group-processed", "group-processed"],
    );
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    assert.equal(new Set(snapshot.messages.map((row) => row.id)).size, 3);
    assert.ok(snapshot.messages.every((row) => row.id === row.message.chatId));
    const prompt = (request) => JSON.stringify(request.body.messages);
    assert.match(prompt(f.requests[0]), /next reply only as Alpha/);
    assert.match(prompt(f.requests[1]), /next reply only as Beta/);
    assert.match(prompt(f.requests[1]), /group-processed/);
    assert.equal(
      snapshot.variables.find((row) => row.key === "$seen-alpha").value,
      "1",
    );
    assert.equal(
      snapshot.variables.find((row) => row.key === "$seen-beta").value,
      "1",
    );
    assert.ok(!snapshot.variables.some((row) => row.key === "$seen-inactive"));
    assert.ok(
      f.requests.every(
        (request) => !prompt(request).includes("private history sentinel"),
      ),
    );
    for (const id of ["alpha", "beta", "inactive"]) {
      assert.equal(
        (await f.store.call("snapshot", "private-" + id)).messages.length,
        1,
      );
    }
  },
);

test(
  "native group ordered mode ignores mention priority and excludes inactive members",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { ordered: true });
    const run = await start(t, f, "ordered-group", "Beta Alpha");
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "beta"],
    );
    assert.equal(f.requests.length, 2);
  },
);

test(
  "native group keeps original repeated-name semantics and gives every reply a stable distinct ID",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const run = await start(t, f, "repeated-group", "Alpha Alpha Beta");
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.saying),
      ["alpha", "alpha", "beta"],
    );
    assert.equal(new Set(snapshot.messages.map((row) => row.id)).size, 4);
    assert.equal(
      snapshot.variables.find((row) => row.key === "$seen-alpha").value,
      "2",
    );
    assert.equal(f.requests.length, 3);
  },
);

test(
  "cancelling the second group response saves neither the first reply nor its trigger side effects",
  { timeout: 30000 },
  async (t) => {
    let reached;
    const second = new Promise((resolve) => {
      reached = resolve;
    });
    const f = await fixture(t, {
      response: async (res, _request, count) => {
        res.setHeader("content-type", "application/json");
        if (count === 1)
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "raw-output" } }],
            }),
          );
        else {
          res.flushHeaders();
          reached();
          await new Promise((resolve) => res.on("close", resolve));
        }
      },
    });
    const run = await start(t, f, "cancel-group");
    await second;
    await f.store.call("requestCancel", "cancel-group");
    run.worker.postMessage({ type: "cancel", jobId: "cancel-group" });
    const result = await run.done;
    assert.equal(result.state, "cancelled", JSON.stringify(result.result));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.variables.length, 0);
    assert.equal(f.requests.length, 2);
  },
);

test(
  "different group chats run independently with separate variables and stable message owners",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { ordered: true });
    await f.store.call("applyCommand", "group-chat-b", {
      type: "create-chat",
      chatId: "group-chat-b",
      characterId: "group",
      metadata: { name: "Synthetic group B", localLore: [] },
    });
    const [a, b] = await Promise.all([
      start(t, f, "independent-a", "Synthetic A"),
      start(t, f, "independent-b", "Synthetic B", "group-chat-b"),
    ]);
    const results = await Promise.all([a.done, b.done]);
    assert.ok(
      results.every((result) => result.state === "completed"),
      JSON.stringify(results),
    );
    const sa = await f.store.call("snapshot", "group-chat");
    const sb = await f.store.call("snapshot", "group-chat-b");
    assert.equal(sa.messages[0].message.data, "Synthetic A");
    assert.equal(sb.messages[0].message.data, "Synthetic B");
    assert.equal(sa.messages.length, 3);
    assert.equal(sb.messages.length, 3);
    assert.equal(
      sa.variables.find((row) => row.key === "$seen-alpha").value,
      "1",
    );
    assert.equal(
      sb.variables.find((row) => row.key === "$seen-alpha").value,
      "1",
    );
    assert.ok(
      sa.messages.every(
        (row) => !sb.messages.some((other) => other.id === row.id),
      ),
    );
    assert.equal(f.requests.length, 4);
  },
);

test(
  "native group runs original module edit Lua and member output Lua under the admitted group chat",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { lua: true });
    const run = await start(t, f, "lua-group");
    const result = await run.done;
    assert.equal(result.state, "completed", JSON.stringify(result.result));
    const snapshot = await f.store.call("snapshot", "group-chat");
    assert.deepEqual(
      snapshot.messages.slice(1).map((row) => row.message.data),
      ["group-processed:module", "group-processed:module"],
    );
    for (const key of ["$lua-alpha", "$lua-beta", "$module-output"]) {
      assert.equal(
        snapshot.variables.find((row) => row.key === key)?.value,
        "yes",
        key,
      );
    }
    for (const id of ["alpha", "beta", "inactive"]) {
      assert.equal(
        (await f.store.call("snapshot", "private-" + id)).variables.length,
        0,
      );
    }
  },
);
