"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os");
const { createRuntimeService } = require("./service.cjs");
test("HTTP source pages use the real entity worker and guarded route rejects races and unguarded commands", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "risu-image-http-")),
    runtime = await createRuntimeService({
      file: join(dir, "synthetic.sqlite"),
    });
  await runtime.scheduler.close();
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const store = runtime.store,
    bootstrap = await store.call("bootstrap"),
    headers = {
      "Content-Type": "application/json",
      "Risu-Runtime-Id": bootstrap.serverId,
    };
  const post = async (path, body) => {
    const r = await fetch(runtime.url + "/api/runtime" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  await store.call("applyCommand", "member", {
    type: "create-character",
    characterId: "m",
    definition: {
      type: "character",
      name: "Authored member",
      image: "assets/seed.png",
      desc: "Authored body which must not be returned",
    },
  });
  await store.call("applyCommand", "group", {
    type: "create-character",
    characterId: "g",
    definition: {
      type: "group",
      name: "Authored group",
      characters: ["m"],
      image: "assets/before.png",
    },
  });
  const page = await post("/groups/g/image-sources", { offset: 0 });
  assert.equal(page.status, 200);
  assert.equal(page.body.sources[0].image, "assets/seed.png");
  assert.ok(!JSON.stringify(page).includes("must not be returned"));
  const target = { scope: "character", entityId: "g", key: "image" },
    field = (await store.call("readFields", [target])).fields[0];
  const command = {
    type: "change-fields",
    edits: [
      {
        ...target,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: "assets/new.png",
      },
    ],
    groupImageSources: page.body.guard,
  };
  const cursor = (await store.call("bootstrap")).cursor;
  const unsupported = await post("/commands/guarded-fields", {
    requestId: "no-checks",
    command: { type: "change-fields", edits: command.edits },
  });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, "INVALID_COMMAND");
  assert.equal((await store.call("bootstrap")).cursor, cursor);
  const invalid = await post("/groups/g/image-sources", { offset: 1 });
  assert.equal(invalid.status, 400);
  const member = { scope: "character", entityId: "m", key: "image" },
    m = (await store.call("readFields", [member])).fields[0];
  await store.call("applyCommand", "peer", {
    type: "change-fields",
    edits: [
      {
        ...member,
        expectedRevision: m.revision,
        expectedEpoch: m.entityEpoch,
        value: "assets/peer.png",
      },
    ],
  });
  const stale = await post("/commands/guarded-fields", {
    requestId: "stale",
    command,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");
  assert.equal(
    (await store.call("getCharacter", "g")).definition.image,
    "assets/before.png",
  );
  command.groupImageSources = (
    await post("/groups/g/image-sources", { offset: 0 })
  ).body.guard;
  const saved = await post("/commands/guarded-fields", {
    requestId: "fresh",
    command,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await store.call("getCharacter", "g")).definition.image,
    "assets/new.png",
  );
  const again = await post("/commands/guarded-fields", {
    requestId: "fresh",
    command,
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, saved.body);
});
