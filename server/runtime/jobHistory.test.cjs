"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("./service.cjs");

test(
  "HTTP history uses worker pagination, owner guards and body-free headers across restart",
  { timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "risu-history-http-")),
      file = join(dir, "synthetic.sqlite");
    let runtime;
    t.after(async () => {
      await runtime?.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const seed = new EntityStore(file);
    seed.applyCommand("c", {
      type: "create-character",
      characterId: "c",
      definition: { type: "character", name: "Synthetic" },
    });
    for (const chatId of ["a", "b"])
      seed.applyCommand(chatId, {
        type: "create-chat",
        chatId,
        characterId: "c",
      });
    for (let i = 0; i < 125; i++) {
      seed.enqueueJob("history-" + i, {
        type: "send",
        chatId: "a",
        text: "Authored history",
      });
      seed.db
        .prepare(
          "UPDATE jobs SET state=?,type=?,result=?,progress=? WHERE id=?",
        )
        .run(
          i % 4 ? "completed" : "failed",
          i % 2 ? "send" : "memory-summary",
          '{"text":"RESULT_BODY_MARKER"}',
          '{"text":"PROGRESS_BODY_MARKER"}',
          "history-" + i,
        );
    }
    seed.close();
    const restart = async () => {
      await runtime?.close();
      runtime = await createRuntimeService({ file });
    };
    await restart();
    const api = async (chatId = "a", query = "expectedEpoch=0&limit=20") => {
      const response = await fetch(
        runtime.url + "/api/runtime/chats/" + chatId + "/job-history?" + query,
      );
      return { status: response.status, value: await response.json() };
    };
    const first = await api();
    assert.equal(first.status, 200);
    assert.equal(first.value.items.length, 20);
    assert.equal(first.value.items[0].id, "history-124");
    assert.equal(first.value.newer, null);
    assert.ok(!JSON.stringify(first).includes("BODY_MARKER"));
    assert.equal((await api("a", "limit=20")).status, 400);
    assert.equal((await api("a", "expectedEpoch=0&limit=101")).status, 400);
    assert.equal((await api("a", "expectedEpoch=0&after=invalid")).status, 400);
    assert.equal((await api("a", "expectedEpoch=1")).status, 409);
    assert.equal(
      (await api("b", "expectedEpoch=0&after=" + first.value.older)).status,
      409,
    );
    assert.equal(
      (
        await api(
          "a",
          "expectedEpoch=0&filter=memory&after=" + first.value.older,
        )
      ).status,
      409,
    );
    await restart();
    const ids = [...first.value.items.map((row) => row.id)];
    let after = first.value.older;
    while (after) {
      const next = await api("a", "expectedEpoch=0&limit=20&after=" + after);
      assert.equal(next.status, 200);
      assert.ok(!JSON.stringify(next).includes("BODY_MARKER"));
      ids.push(...next.value.items.map((row) => row.id));
      after = next.value.older;
    }
    assert.equal(ids.length, 125);
    assert.equal(new Set(ids).size, 125);
    assert.equal(ids.at(-1), "history-0");
    const failed = await api("a", "expectedEpoch=0&filter=failed");
    assert.equal(failed.status, 200);
    assert.ok(failed.value.items.every((row) => row.state === "failed"));
    const memory = await api("a", "expectedEpoch=0&filter=memory");
    assert.ok(memory.value.items.every((row) => row.type === "memory-summary"));
    assert.equal((await runtime.store.call("listJobs", "a")).length, 50);
    const current = await runtime.store.call("snapshot", "a");
    await runtime.store.call("applyCommand", "delete", {
      type: "delete-chat",
      chatId: "a",
      expectedRevision: current.chat.revision,
      expectedEpoch: 0,
    });
    await runtime.store.call("applyCommand", "recreate", {
      type: "create-chat",
      chatId: "a",
      characterId: "c",
    });
    assert.equal((await api()).status, 409);
    const epoch = (await runtime.store.call("snapshot", "a")).chat.entityEpoch;
    assert.deepEqual(
      (await api("a", "expectedEpoch=" + epoch)).value.items,
      [],
    );
  },
);
