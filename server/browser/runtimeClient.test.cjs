"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Browser condition timed out: " + JSON.stringify(last));
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function seed(runtime, providerUrl) {
  await runtime.store.call("applyCommand", "character", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      desc: "Synthetic definition",
      firstMessage: "Greeting",
    },
  });
  for (const chatId of ["a", "b"])
    await runtime.store.call("applyCommand", "chat-" + chatId, {
      type: "create-chat",
      characterId: "c",
      chatId,
      metadata: { name: chatId, localLore: [] },
    });
  await runtime.store.call("applyCommand", "settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: providerUrl + "/v1/chat/completions",
      customTokenizer: "tik",
      useStreaming: true,
      maxContext: 8000,
      maxResponse: 100,
      mainPrompt: "Synthetic",
      jailbreak: "",
    },
  });
}
const variable = (chatId, key, value, expectedRevision) => ({
  type: "set-chat-variable",
  chatId,
  key,
  value,
  expectedRevision,
});
const enqueue = (page, id, command, kind = "command") =>
  page.evaluate(
    `harness.client.enqueue(${JSON.stringify(kind)}, ${JSON.stringify(command)}, ${JSON.stringify(id)})`,
  );

test(
  "real Chromium runtime client and IndexedDB protocol acceptance",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-client-browser-"));
    let browser, runtime, foreign, frontend, provider;
    let releaseProvider;
    const providerGate = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    let providerCalls = 0;
    t.after(async () => {
      releaseProvider();
      if (browser) await browser.close();
      if (foreign) await foreign.close();
      if (runtime) await runtime.close();
      if (frontend) await close(frontend);
      if (provider) await close(provider);
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const { build } = await import("vite");
    const bundle = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: resolve(__dirname, "clientHarness.ts"),
          output: { format: "es" },
        },
      },
    });
    const script = bundle.output.find(
      (chunk) => chunk.type === "chunk" && chunk.isEntry,
    ).code;
    frontend = createServer((req, res) => {
      if (req.url === "/harness.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(script);
      } else {
        res.setHeader("content-type", "text/html");
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Isolated client protocol fixture</title><script type="module" src="/harness.js"></script>',
        );
      }
    });
    const frontUrl = await listen(frontend);
    provider = createServer(async (_req, res) => {
      providerCalls++;
      res.setHeader("content-type", "text/event-stream");
      const delta = (text) =>
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: text } }] }) +
        "\n\n";
      res.write(delta("partial"));
      await providerGate;
      res.end(delta(" final") + "data: [DONE]\n\n");
    });
    const providerUrl = await listen(provider);
    runtime = await createRuntimeService({
      file: join(directory, "state.sqlite"),
      origins: [frontUrl],
      eventsPollMs: 20,
      scheduler: { pollMs: 20, progressIntervalMs: 25 },
    });
    await seed(runtime, providerUrl);
    browser = await launchChromium(directory);
    const contextA = await browser.newContext(),
      contextB = await browser.newContext();
    const newPage = async (context) => {
      const page = await browser.page(frontUrl, context);
      await until(() => page.evaluate("!!window.harness"));
      return page;
    };
    let a = await newPage(contextA),
      b = await newPage(contextB);
    const open = (page, url = runtime.url, id, start = true) =>
      page.evaluate(
        `harness.open(${JSON.stringify(url)}, ${JSON.stringify(id) ?? "undefined"}, ${start})`,
      );
    const serverId = await open(a);
    await open(b);
    const canonical = async (chatId, key) =>
      (await runtime.store.call("snapshot", chatId)).variables.find(
        (v) => v.key === key,
      );

    await t.test(
      "an offline command survives tab destruction and reopens under the same durable request ID",
      async () => {
        await a.evaluate("harness.offline=true");
        await enqueue(a, "offline", variable("a", "$choice", "one", 0));
        assert.equal((await a.evaluate("harness.outbox.list()")).length, 1);
        assert.equal(await canonical("a", "$choice"), undefined);
        await a.close();
        a = await newPage(contextA);
        await open(a);
        await until(
          () => canonical("a", "$choice"),
          (value) => value?.value === "one",
        );
        await until(() => a.evaluate("harness.pending.length===0"));
        await until(() => b.evaluate("harness.variables.a.$choice==='one'"));
        assert.equal((await canonical("a", "$choice")).revision, 1);
      },
    );
    await t.test(
      "explicit retry admission waits for unresolved group configuration on the device",
      async () => {
        try {
          await a.evaluate(
            "harness.outbox.enqueue('retry-held-configuration','command',{type:'change-group-member',groupId:'synthetic-group',memberId:'synthetic-member',action:'set-active',value:true}).then(()=>harness.outbox.block('retry-held-configuration',{code:'REVISION_CONFLICT',message:'Synthetic unresolved configuration'}))",
          );
          await enqueue(a, "retry-held-admission", {
            type: "retry-job-result",
            jobId: "synthetic-source-not-executed",
            chatId: "a",
            expectedChatEpoch: 0,
            expectedContentRevision: 1,
          });
          await a.evaluate("harness.client.flush()");
          assert.equal(
            await a.evaluate("harness.posts.includes('retry-held-admission')"),
            false,
          );
          assert.equal(
            (await a.evaluate("harness.outbox.list()")).find(
              (x) => x.requestId === "retry-held-admission",
            ).state,
            "pending",
          );
        } finally {
          await a.evaluate(
            "harness.outbox.remove('retry-held-admission').then(()=>harness.outbox.remove('retry-held-configuration')).then(()=>harness.client.flush())",
          );
        }
      },
    );
    await t.test(
      "reply-choice fallback admission waits for unresolved device configuration",
      async () => {
        try {
          await a.evaluate(
            "harness.outbox.enqueue('choice-held-config','command',{type:'change-group-member',groupId:'synthetic-group',memberId:'synthetic-member',action:'set-active',value:true}).then(()=>harness.outbox.block('choice-held-config',{code:'REVISION_CONFLICT',message:'Synthetic unresolved configuration'}))",
          );
          await enqueue(a, "choice-held-admission", {
            type: "move-reply-choice",
            chatId: "a",
            messageId: "not-executed",
            expectedRevision: 1,
            expectedChatEpoch: 0,
            setId: "synthetic",
            expectedChoiceRevision: 1,
            direction: "next",
          });
          await a.evaluate("harness.client.flush()");
          assert.equal(
            await a.evaluate("harness.posts.includes('choice-held-admission')"),
            false,
          );
          assert.equal(
            (await a.evaluate("harness.outbox.list()")).find(
              (x) => x.requestId === "choice-held-admission",
            ).state,
            "pending",
          );
        } finally {
          await a.evaluate(
            "harness.outbox.remove('choice-held-admission').then(()=>harness.outbox.remove('choice-held-config')).then(()=>harness.client.flush())",
          );
        }
      },
    );
    await t.test(
      "a discarded committed acknowledgement is retried without another mutation",
      async () => {
        await a.evaluate("harness.loseAck=true");
        await enqueue(a, "lost", variable("a", "$choice", "two", 1));
        await until(() =>
          a.evaluate(
            "harness.pending.length===0 && harness.posts.filter(id=>id==='lost').length>=2",
          ),
        );
        assert.deepEqual(await canonical("a", "$choice"), {
          key: "$choice",
          value: "two",
          revision: 2,
        });
        await until(() => b.evaluate("harness.variables.a.$choice==='two'"));
      },
    );
    await t.test(
      "a failed asynchronous projection replays from the last applied cursor",
      async () => {
        await a.evaluate("harness.failKey='$replay'");
        await enqueue(b, "replay", variable("a", "$replay", "retained", 0));
        await until(() =>
          a.evaluate("harness.variables.a.$replay==='retained'"),
        );
        const attempts = await a.evaluate("harness.attempts"),
          applied = await a.evaluate("harness.applied");
        const duplicate = attempts.find(
          (sequence, index) => attempts.indexOf(sequence) !== index,
        );
        assert.ok(duplicate);
        assert.equal(
          applied.filter((sequence) => sequence === duplicate).length,
          1,
        );
        assert.ok(
          (await a.evaluate("harness.errors")).some((error) =>
            error.includes("projection failure"),
          ),
        );
      },
    );
    await t.test(
      "changes between bootstrap and stream subscription are replayed without a gap",
      async () => {
        await a.evaluate("harness.close()");
        await a.evaluate(
          `harness.pauseBootstrap=true;window.starting=harness.open(${JSON.stringify(runtime.url)});true`,
        );
        await until(() => a.evaluate("harness.bootstrapPaused===true"));
        await enqueue(b, "handoff", variable("a", "$handoff", "between", 0));
        await until(
          () => canonical("a", "$handoff"),
          (value) => value?.value === "between",
        );
        await a.evaluate("harness.resumeBootstrap();window.starting");
        await until(() =>
          a.evaluate("harness.variables.a.$handoff==='between'"),
        );
      },
    );
    await t.test(
      "pruned replay history refreshes partial snapshots and restores the live feed",
      async () => {
        await a.evaluate("harness.offline=true;harness.client.reconnect()");
        await enqueue(b, "pruned", variable("a", "$pruned", "snapshot", 0));
        await until(
          () => canonical("a", "$pruned"),
          (value) => value?.value === "snapshot",
        );
        const head = (await runtime.store.call("bootstrap")).cursor;
        await runtime.store.call("pruneChanges", head);
        await a.evaluate("harness.offline=false;harness.client.reconnect()");
        await until(() =>
          a.evaluate(
            "harness.variables.a.$pruned==='snapshot' && harness.status==='connected'",
          ),
        );
        assert.ok(
          (await a.evaluate("harness.errors")).includes("RESYNC_REQUIRED"),
        );
      },
    );
    await t.test(
      "a revision conflict remains visible and holds later same-chat intent while another chat progresses",
      async () => {
        await enqueue(a, "conflict", variable("a", "$choice", "stale", 0));
        await until(() =>
          a.evaluate(
            "harness.pending.some(e=>e.requestId==='conflict' && e.state==='blocked')",
          ),
        );
        await enqueue(a, "following", variable("a", "$choice", "three", 2));
        await enqueue(a, "independent", variable("b", "$choice", "other", 0));
        await until(
          () => canonical("b", "$choice"),
          (value) => value?.value === "other",
        );
        assert.equal((await canonical("a", "$choice")).value, "two");
        const pending = await a.evaluate("harness.outbox.list()");
        assert.equal(
          pending.find((e) => e.requestId === "conflict").error.code,
          "REVISION_CONFLICT",
        );
        assert.equal(
          pending.find((e) => e.requestId === "following").state,
          "pending",
        );
        await a.evaluate(
          "harness.outbox.remove('conflict').then(()=>harness.client.flush())",
        );
        await until(
          () => canonical("a", "$choice"),
          (value) => value?.value === "three",
        );
      },
    );
    await t.test(
      "two tabs sharing IndexedDB retain one immutable command and server execution",
      async () => {
        const sibling = await newPage(contextA);
        try {
          await open(sibling);
          await a.evaluate("harness.offline=true");
          await sibling.evaluate("harness.offline=true");
          const command = variable("a", "$choice", "four", 3);
          await Promise.all([
            enqueue(a, "shared", command),
            enqueue(sibling, "shared", command),
          ]);
          assert.equal(
            (await a.evaluate("harness.outbox.list()")).filter(
              (e) => e.requestId === "shared",
            ).length,
            1,
          );
          assert.equal(
            await sibling.evaluate(
              `harness.client.enqueue('command', ${JSON.stringify({ ...command, value: "changed" })}, 'shared').then(()=>false, e=>e.code)`,
            ),
            "IDEMPOTENCY_CONFLICT",
          );
          await a.evaluate("harness.offline=false;harness.client.kick()");
          await sibling.evaluate("harness.offline=false;harness.client.kick()");
          await until(
            () => canonical("a", "$choice"),
            (value) => value?.value === "four",
          );
          assert.equal((await canonical("a", "$choice")).revision, 4);
          await until(() => b.evaluate("harness.variables.a.$choice==='four'"));
          await sibling.evaluate("harness.close()");
        } finally {
          await sibling.close();
        }
      },
    );
    await t.test(
      "native generation completes after every observing tab closes and a fresh tab restores the terminal job",
      async () => {
        await enqueue(
          a,
          "generation",
          {
            type: "send",
            chatId: "a",
            input: "synthetic input",
            messageId: "input-generation",
          },
          "job",
        );
        const progressing = await until(
          () => runtime.store.call("getJob", "generation"),
          (job) =>
            job?.progress?.messages?.some(
              (message) => message.data === "partial",
            ),
        );
        const outputId = progressing.progress.messages.find(
          (message) => message.role === "char",
        ).chatId;
        await until(() =>
          a.evaluate(
            "harness.pending.some(e=>e.requestId==='generation' && e.state==='accepted')",
          ),
        );
        await a.close();
        await b.close();
        releaseProvider();
        const done = await until(
          () => runtime.store.call("getJob", "generation"),
          (job) => job?.state === "completed",
        );
        assert.equal(done.state, "completed");
        assert.equal(providerCalls, 1);
        a = await newPage(contextA);
        await open(a);
        await until(() =>
          a.evaluate(
            "harness.pending.length===0 && harness.messages.a.some(m=>m.data==='partial final')",
          ),
        );
        assert.equal(
          await a.evaluate(
            "harness.messages.a.find(m=>m.data==='partial final').chatId",
          ),
          outputId,
        );
        assert.equal(providerCalls, 1);
        assert.equal(
          (await a.evaluate("harness.posts")).filter(
            (id) => id === "generation",
          ).length,
          0,
        );
      },
    );
    await t.test(
      "a replacement database rejects the old identity before admitting its pending command",
      async () => {
        await a.evaluate("harness.close()");
        foreign = await createRuntimeService({
          file: join(directory, "foreign.sqlite"),
          origins: [frontUrl],
        });
        await seed(foreign, providerUrl);
        await open(a, foreign.url, serverId, false);
        await enqueue(
          a,
          "foreign-danger",
          variable("a", "$choice", "must not apply", 0),
        );
        assert.equal(
          await a.evaluate("harness.client.start().then(()=>false,e=>e.code)"),
          "SERVER_CHANGED",
        );
        assert.equal(
          (await foreign.store.call("snapshot", "a")).variables.length,
          0,
        );
        assert.equal(
          (await a.evaluate("harness.outbox.list()")).find(
            (e) => e.requestId === "foreign-danger",
          ).state,
          "pending",
        );
        assert.equal(
          (await a.evaluate("harness.posts")).filter(
            (id) => id === "foreign-danger",
          ).length,
          0,
        );
        await a.evaluate("harness.close()");
      },
    );
    await t.test(
      "failure to persist a browser command prevents its network admission",
      async () => {
        const isolated = await newPage(await browser.newContext());
        try {
          await open(isolated);
          await isolated.evaluate("harness.outbox.close()");
          assert.equal(
            await isolated.evaluate(
              `harness.client.enqueue('command', ${JSON.stringify(variable("b", "$unsafe", "must not apply", 0))}, 'unsaved').then(()=>false,e=>e.name)`,
            ),
            "InvalidStateError",
          );
          assert.equal(await canonical("b", "$unsafe"), undefined);
          assert.equal((await isolated.evaluate("harness.posts")).length, 0);
          await isolated.evaluate("harness.client.close()");
        } finally {
          await isolated.close();
        }
      },
    );
    await t.test(
      "closing during asynchronous hydration leaves no retry timer or admission pump",
      async () => {
        const isolated = await newPage(await browser.newContext());
        try {
          await isolated.evaluate(
            `harness.pauseBootstrap=true;window.starting=harness.open(${JSON.stringify(runtime.url)}).then(()=>false,e=>e.code);true`,
          );
          await until(() =>
            isolated.evaluate("harness.bootstrapPaused===true"),
          );
          await isolated.evaluate("harness.client.close()");
          assert.equal(
            await isolated.evaluate(
              "harness.resumeBootstrap();window.starting",
            ),
            "CLIENT_CLOSED",
          );
          assert.equal(
            await isolated.evaluate(
              "harness.client.timer===undefined && harness.client.ready===false",
            ),
            true,
          );
          assert.equal((await isolated.evaluate("harness.posts")).length, 0);
          await isolated.evaluate("harness.outbox.close()");
        } finally {
          await isolated.close();
        }
      },
    );
    await t.test(
      "variable revisions allocate atomically across tabs and retain a head after projection removed the entry",
      async () => {
        await open(a);
        const sibling = await newPage(contextA);
        try {
          await open(sibling);
          await a.evaluate("harness.offline=true");
          await sibling.evaluate("harness.offline=true");
          const edit = {
            scope: "chat",
            chatId: "b",
            key: "$rapid",
            value: "one",
            expectedRevision: 0,
          };
          await Promise.all([
            a.evaluate(
              `harness.client.enqueueVariables([${JSON.stringify(edit)}], 'rapid-1')`,
            ),
            sibling.evaluate(
              `harness.client.enqueueVariables([${JSON.stringify({ ...edit, value: "two" })}], 'rapid-2')`,
            ),
          ]);
          const entries = (await a.evaluate("harness.outbox.list()")).filter(
            (entry) => entry.requestId.startsWith("rapid-"),
          );
          assert.deepEqual(
            entries.map((entry) => entry.command.edits[0].expectedRevision),
            [0, 1],
          );
          assert.deepEqual(entries[1].command.after, [entries[0].requestId]);
          assert.equal(
            await a.evaluate(
              `harness.client.enqueueVariables([${JSON.stringify({ ...edit, value: "changed" })}], 'rapid-1').then(()=>false,e=>e.code)`,
            ),
            "IDEMPOTENCY_CONFLICT",
          );
          await a.evaluate("harness.offline=false;harness.client.kick()");
          await until(
            () => canonical("b", "$rapid"),
            (value) => value?.revision === 2,
          );
          await until(() =>
            a.evaluate(
              "harness.outbox.list().then(entries=>!entries.some(e=>e.requestId.startsWith('rapid-')))",
            ),
          );
          // This tab deliberately supplies an older confirmed revision; the shared durable head closes the projection race.
          const next = await sibling.evaluate(
            `harness.outbox.enqueueVariables('rapid-3',[${JSON.stringify({ ...edit, value: "three" })}])`,
          );
          assert.equal(next.command.edits[0].expectedRevision, 2);
          assert.deepEqual(next.command.after, [entries[1].requestId]);
          await sibling.evaluate("harness.offline=false;harness.client.kick()");
          await until(
            () => canonical("b", "$rapid"),
            (value) => value?.value === "three" && value.revision === 3,
          );
        } finally {
          await sibling.evaluate(
            "harness.client.close();harness.outbox.close()",
          );
          await sibling.close();
        }
      },
    );
    await t.test(
      "a conflicting variable chain holds only dependent keys and explicit resolution preserves its last intent",
      async () => {
        await a.evaluate("harness.offline=true");
        const edit = {
          scope: "chat",
          chatId: "b",
          key: "$conflict-chain",
          expectedRevision: 0,
          value: "first",
        };
        await a.evaluate(
          `harness.client.enqueueVariables([${JSON.stringify(edit)}], 'chain-first')`,
        );
        await a.evaluate(
          `harness.client.enqueueVariables([${JSON.stringify({ ...edit, value: "last" })}], 'chain-last')`,
        );
        await runtime.store.call("applyCommand", "chain-remote", {
          type: "change-variables",
          edits: [{ ...edit, value: "remote" }],
        });
        await a.evaluate("harness.offline=false;harness.client.kick()");
        await until(() =>
          a.evaluate(
            "harness.outbox.list().then(entries=>entries.some(e=>e.requestId==='chain-first'&&e.state==='blocked'))",
          ),
        );
        assert.equal((await canonical("b", "$conflict-chain")).value, "remote");
        await a.evaluate(
          `harness.client.enqueueVariables([${JSON.stringify({ ...edit, key: "$independent", value: "works" })}], 'chain-independent')`,
        );
        await until(
          () => canonical("b", "$independent"),
          (value) => value?.value === "works",
        );
        const target = { scope: "chat", chatId: "b", key: "$conflict-chain" };
        const values = (await runtime.store.call("readVariables", [target]))
          .variables;
        await a.evaluate(
          `harness.client.resolveVariableChain('chain-first', ${JSON.stringify(values)}, true)`,
        );
        await until(
          () => canonical("b", "$conflict-chain"),
          (value) => value?.value === "last" && value.revision === 2,
        );
        assert.equal(
          (await a.evaluate("harness.outbox.list()")).some(
            (entry) =>
              entry.requestId === "chain-first" ||
              entry.requestId === "chain-last",
          ),
          false,
        );
      },
    );
    await t.test(
      "field intents allocate across tabs, retry lost acknowledgements and resolve complete conflict chains",
      async () => {
        const edit = {
          scope: "chat",
          entityId: "b",
          key: "note",
          value: "Synthetic first field",
          expectedRevision: 0,
          expectedEpoch: 0,
        };
        const record = async () =>
          (
            await runtime.store.call("readFields", [
              { scope: edit.scope, entityId: edit.entityId, key: edit.key },
            ])
          ).fields[0];
        edit.expectedRevision = (await record()).revision;
        const sibling = await newPage(contextA);
        try {
          await sibling.evaluate(
            `harness.open(${JSON.stringify(runtime.url)})`,
          );
          await a.evaluate("harness.offline=true");
          await sibling.evaluate("harness.offline=true");
          await Promise.all([
            a.evaluate(
              `harness.client.enqueueFields([${JSON.stringify(edit)}], 'field-tab-first')`,
            ),
            sibling.evaluate(
              `harness.client.enqueueFields([${JSON.stringify({ ...edit, value: "Synthetic latest field" })}], 'field-tab-last')`,
            ),
          ]);
          const entries = (await a.evaluate("harness.outbox.list()")).filter(
            (entry) => entry.requestId.startsWith("field-tab-"),
          );
          assert.deepEqual(
            entries.map((entry) => entry.command.edits[0].expectedRevision),
            [edit.expectedRevision, edit.expectedRevision + 1],
          );
          assert.deepEqual(entries[1].command.after, [entries[0].requestId]);
          assert.deepEqual(
            new Set(entries.map((entry) => entry.requestId)),
            new Set(["field-tab-first", "field-tab-last"]),
          );
          const firstAllocated = entries[0].requestId;
          assert.equal(
            await a.evaluate(
              `harness.client.enqueueFields([${JSON.stringify({ ...edit, value: "Synthetic changed identity" })}], 'field-tab-first').then(()=>false,e=>e.code)`,
            ),
            "IDEMPOTENCY_CONFLICT",
          );
          await runtime.store.call("applyCommand", "field-tab-remote", {
            type: "change-fields",
            edits: [{ ...edit, value: "Synthetic remote field" }],
          });
          await a.evaluate("harness.offline=false;harness.client.kick()");
          await until(() =>
            a.evaluate(
              `harness.outbox.list().then(entries=>entries.some(e=>e.requestId===${JSON.stringify(firstAllocated)}&&e.state==='blocked'))`,
            ),
          );
          assert.equal((await record()).value, "Synthetic remote field");
          const independent = {
            ...edit,
            key: "syntheticIndependent",
            expectedRevision: 0,
            value: "Synthetic independent",
          };
          await a.evaluate(
            `harness.client.enqueueFields([${JSON.stringify(independent)}], 'field-independent')`,
          );
          await until(
            async () =>
              (
                await runtime.store.call("readFields", [
                  {
                    scope: edit.scope,
                    entityId: edit.entityId,
                    key: independent.key,
                  },
                ])
              ).fields[0].value === independent.value,
          );
          const values = [await record()];
          const last = entries.at(-1).command.edits[0].value;
          await a.evaluate(
            `harness.loseAck=true;harness.client.resolveFieldChain(${JSON.stringify(firstAllocated)}, ${JSON.stringify(values)}, true)`,
          );
          await until(
            record,
            (value) =>
              value.revision === edit.expectedRevision + 2 &&
              value.value === last,
          );
          await until(() =>
            a.evaluate(
              "harness.outbox.list().then(entries=>!entries.some(e=>e.command.type==='change-fields'))",
            ),
          );
          assert.equal((await record()).revision, edit.expectedRevision + 2);
          const next = await sibling.evaluate(
            `harness.outbox.enqueueFields('field-tab-after',[${JSON.stringify({ ...edit, value: "Synthetic next field" })}])`,
          );
          assert.equal(
            next.command.edits[0].expectedRevision,
            edit.expectedRevision + 2,
          );
          await sibling.evaluate("harness.offline=false;harness.client.kick()");
          await until(
            record,
            (value) => value.value === "Synthetic next field",
          );
        } finally {
          await sibling.evaluate("harness.close()");
          await sibling.close();
        }
      },
    );
    await t.test(
      "field heads separate entity incarnations and resolution preserves a new incarnation's pending intent",
      async () => {
        const result = await a.evaluate(`(async()=>{
        const outbox=new harness.outbox.constructor('synthetic-field-incarnations');
        const edit={scope:'resource',resourceKind:'persona',entityId:'synthetic',key:'name',expectedRevision:0,expectedEpoch:0,value:'Synthetic old'};
        await outbox.enqueueFields('old-field',[edit]);
        await outbox.block('old-field',{code:'REVISION_CONFLICT',message:'Synthetic recreated entity'});
        const next=await outbox.enqueueFields('new-field',[{...edit,expectedRevision:2,expectedEpoch:7,value:'Synthetic new'}]);
        const value={scope:edit.scope,resourceKind:edit.resourceKind,entityId:edit.entityId,key:edit.key,revision:2,entityEpoch:7,exists:true,value:'Synthetic server'};
        const rejected=await outbox.resolveFieldChain('old-field',[value],'reapply-old').then(()=>false,e=>e.code);
        const before=await outbox.list();
        await outbox.resolveFieldChain('old-field',[value]);
        const after=await outbox.list();
        const child=await outbox.enqueueFields('new-child',[{...edit,expectedRevision:2,expectedEpoch:7,value:'Synthetic child'}]);
        const draft={...edit,key:'snapshot',value:{text:'Synthetic original'}};
        const saving=outbox.enqueueFields('snapshot-field',[draft]);
        draft.key='changed-after-enqueue';draft.value.text='Synthetic mutated';
        const immutable=await saving;
        await outbox.close();return {next,rejected,before,after,child,immutable};
      })()`);
        assert.deepEqual(result.next.command.after, []);
        assert.equal(result.rejected, "OUTBOX_UNCERTAIN");
        assert.equal(result.before.length, 2);
        assert.deepEqual(
          result.after.map((entry) => entry.requestId),
          ["new-field"],
        );
        assert.equal(result.child.command.edits[0].expectedRevision, 3);
        assert.deepEqual(result.child.command.after, ["new-field"]);
        assert.equal(result.immutable.command.edits[0].key, "snapshot");
        assert.deepEqual(result.immutable.command.edits[0].value, {
          text: "Synthetic original",
        });
        assert.equal(
          JSON.parse(result.immutable.intentPayload).edits[0].key,
          "snapshot",
        );
      },
    );
    await t.test(
      "derived field guards survive IDB reopen and never rebase stale pixels",
      async () => {
        const result = await a.evaluate(`(async()=>{
        const id='synthetic-derived-fields';let outbox=new harness.outbox.constructor(id);
        const edit={scope:'character',entityId:'g',key:'image',expectedRevision:0,expectedEpoch:0,value:'assets/derived.png'};
        const guard={groupId:'g',expectedEpoch:0,expectedMembershipRevision:1,digest:'a'.repeat(64)};
        const dependencies={groupImageSources:guard,checks:[{scope:'character',entityId:'m',key:'image',expectedRevision:1,expectedEpoch:0}]};
        const saving=outbox.enqueueFields('derived',[edit],dependencies);guard.digest='b'.repeat(64);dependencies.checks[0].expectedRevision=7;const first=await saving;
        await outbox.close();outbox=new harness.outbox.constructor(id);const reopened=(await outbox.list())[0];
        await outbox.block('derived',{code:'REVISION_CONFLICT',message:'Authored source conflict'});
        const current={scope:'character',entityId:'g',key:'image',revision:2,entityEpoch:0,exists:true,value:'assets/server.png'};
        const rebase=await outbox.resolveFieldChain('derived',[current],'fresh-pixels').then(()=>false,e=>e.code);
        const retained=(await outbox.list())[0];await outbox.resolveFieldChain('derived',[current]);const remaining=await outbox.list();
        const changedId=await outbox.enqueueFields('same-intent',[edit],{groupImageSources:{...guard,digest:'c'.repeat(64)}});
        const mismatch=await outbox.enqueueFields('same-intent',[edit],{groupImageSources:guard}).then(()=>false,e=>e.code);
        const malformed=await outbox.enqueueFields('malformed',[edit],{groupImageSources:null}).then(()=>false,e=>e.code);
        await outbox.close();return {first,reopened,rebase,retained,remaining,mismatch,malformed};
      })()`);
        assert.equal(
          result.first.command.groupImageSources.digest,
          "a".repeat(64),
        );
        assert.equal(result.first.command.checks[0].expectedRevision, 1);
        assert.deepEqual(result.reopened, result.first);
        assert.equal(result.rebase, "DERIVED_RESULT_STALE");
        assert.deepEqual(result.retained.command, result.first.command);
        assert.deepEqual(result.remaining, []);
        assert.equal(result.mismatch, "IDEMPOTENCY_CONFLICT");
        assert.equal(result.malformed, "INVALID_COMMAND");
      },
    );
    await t.test(
      "guarded transport fails closed on a server without its endpoint",
      async () => {
        await a.evaluate("harness.noGuardedFields=true;harness.postPaths=[]");
        const target = {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "temperature",
        };
        const value = (await runtime.store.call("readFields", [target]))
          .fields[0];
        await a.evaluate(
          `harness.client.enqueueFields([${JSON.stringify({ ...target, expectedRevision: value.revision, expectedEpoch: value.entityEpoch, value: 42 })}], 'old-server-derived', {checks:[${JSON.stringify({ ...target, expectedRevision: value.revision, expectedEpoch: value.entityEpoch })}]})`,
        );
        await until(() =>
          a.evaluate(
            "harness.outbox.list().then(e=>e.find(x=>x.requestId==='old-server-derived')?.state==='blocked')",
          ),
        );
        const paths = await a.evaluate("harness.postPaths");
        assert.ok(paths.length);
        assert.ok(paths.every((p) => p.endsWith("/commands/guarded-fields")));
        const current = (await runtime.store.call("readFields", [target]))
          .fields[0];
        assert.deepEqual(current, value);
        await a.evaluate(
          "harness.outbox.remove('old-server-derived');harness.noGuardedFields=false",
        );
      },
    );
    await t.test(
      "IndexedDB version-one upgrade preserves immutable pending commands while adding variable heads",
      async () => {
        const result = await a.evaluate(`(async()=>{
        const name='risu-runtime-outbox:synthetic-upgrade';
        const old=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{const store=request.result.createObjectStore('entries',{keyPath:'sequence',autoIncrement:true});store.createIndex('requestId','requestId',{unique:true})};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
        const command={type:'set-chat-variable',chatId:'b',key:'$legacy',value:'retained',expectedRevision:0};
        const payload=JSON.stringify(command);
        await new Promise((resolve,reject)=>{const tx=old.transaction('entries','readwrite');tx.objectStore('entries').add({requestId:'legacy-upgrade',kind:'command',command,payload,createdAt:1,state:'pending'});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});old.close();
        const upgraded=new harness.outbox.constructor('synthetic-upgrade');
        const entries=await upgraded.list();
        await upgraded.enqueueVariables('new-upgrade',[{scope:'chat',chatId:'b',key:'$new',value:'new',expectedRevision:0}]);
        const all=await upgraded.list();await upgraded.close();
        return {entries,all,payload};
      })()`);
        assert.equal(result.entries[0].payload, result.payload);
        assert.equal(result.entries[0].state, "pending");
        assert.equal(result.all.length, 2);
        assert.equal(result.all[1].command.edits[0].expectedRevision, 0);
      },
    );
    console.log(
      "Client protocol browser acceptance: actual IndexedDB and Chromium; Risu UI/mobile/latency acceptance remains separate.",
    );
  },
);
