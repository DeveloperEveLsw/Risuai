"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os"),
  { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("./production.cjs");
test("notice headers and single body reads require authentication; acknowledgement uses database identity and durable receipts", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-notice-http-")),
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
  const text = "<script>synthetic</script>".repeat(2000);
  const { notice } = store.publishJobNotice(
    job.id,
    job.owner,
    job.fence,
    1,
    text,
  );
  store.finishJob(job.id, job.owner, job.fence, {
    state: "completed",
    result: {},
  });
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
  for (const path of ["/notices", "/notices/" + notice.id])
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
    (
      await fetch(service.url + "/api/runtime" + path, { headers: { cookie } })
    ).json();
  const list = await read("/notices?limit=1");
  assert.equal(list.count, 1);
  assert.equal(list.items[0].id, notice.id);
  assert.ok(JSON.stringify(list).length < 500);
  assert.equal(JSON.stringify(list).includes("synthetic"), false);
  assert.equal((await read("/notices/" + notice.id)).notice.message, text);
  for (const query of [
    "?limit=51",
    "?limit=1.5",
    "?after=-1",
    "?limit=",
    "?after=Infinity",
  ])
    assert.equal(
      (
        await fetch(service.url + "/api/runtime/notices" + query, {
          headers: { cookie },
        })
      ).status,
      400,
    );
  const body = {
    requestId: "ack",
    command: {
      type: "acknowledge-notice",
      noticeId: notice.id,
      expectedRevision: 1,
    },
  };
  const post = (identity) =>
    fetch(service.url + "/api/runtime/commands", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "risu-runtime-id": identity,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("foreign")).status, 409);
  const receipt = await (await post(serverId)).json();
  assert.deepEqual(await (await post(serverId)).json(), receipt);
  assert.equal((await read("/notices")).count, 0);
  assert.equal((await read("/notices/" + notice.id)).notice.unread, false);
});
