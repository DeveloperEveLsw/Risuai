"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os"),
  { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("./production.cjs");
test("interaction reads are authenticated and bounded; captured typed answers require DB identity, durable receipts and explicit conflict status", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-interaction-http-")),
    file = join(root, "state.sqlite"),
    passwordFile = join(root, "password");
  let service;
  t.after(async () => {
    await service?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new EntityStore(file);
  store.initializeState({ settings: { synthetic: true }, resources: [] });
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: { name: "Synthetic" },
    chat: { chatId: "a", metadata: {} },
  });
  store.enqueueJob("job", { type: "button", chatId: "a" });
  const { job } = store.claimJob("worker");
  const prompt = "<script>Synthetic</script>".repeat(1000);
  const { interaction } = store.publishJobInteraction(
    job.id,
    job.owner,
    job.fence,
    1,
    { kind: "confirm", prompt },
  );
  const serverId = store.bootstrap().serverId;
  store.close();
  await fs.writeFile(
    passwordFile,
    createHash("sha256").update("synthetic-password").digest("hex"),
  );
  await fs.writeFile(join(root, "index.html"), "Synthetic");
  service = await createProductionService({
    file,
    passwordFile,
    staticDirectory: root,
    origin: "https://risu.test",
    insecureLocalTest: true,
    host: "127.0.0.1",
    port: 0,
  });
  for (const path of ["/interactions", "/interactions/" + interaction.id])
    assert.equal(
      (await fetch(service.url + "/api/runtime" + path)).status,
      401,
    );
  const login = await fetch(service.url + "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=synthetic-password",
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const read = async (path) =>
    await fetch(service.url + "/api/runtime" + path, { headers: { cookie } });
  const headers = await (await read("/interactions?limit=1")).json();
  assert.equal(headers.count, 1);
  assert.equal(JSON.stringify(headers).includes("Synthetic"), false);
  assert.ok(JSON.stringify(headers).length < 600);
  assert.equal(
    (await (await read("/interactions/" + interaction.id)).json()).interaction
      .descriptor.prompt,
    prompt,
  );
  for (const query of ["?limit=51", "?after=-1", "?limit=1.5", "?limit="])
    assert.equal((await read("/interactions" + query)).status, 400);
  const command = {
    type: "answer-interaction",
    interactionId: interaction.id,
    expectedRevision: 1,
    answer: false,
  };
  const post = (id, value = command, identity = serverId) =>
    fetch(service.url + "/api/runtime/commands", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "risu-runtime-id": identity,
      },
      body: JSON.stringify({ requestId: id, command: value }),
    });
  assert.equal((await post("answer", command, "foreign")).status, 409);
  assert.equal(
    (await post("invalid", { ...command, answer: "false" })).status,
    400,
  );
  const response = await post("answer");
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.deepEqual(await (await post("answer")).json(), receipt);
  assert.equal((await post("peer", { ...command, answer: true })).status, 409);
  assert.equal((await (await read("/interactions")).json()).count, 0);
});
