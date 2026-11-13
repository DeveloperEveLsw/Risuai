"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { tmpdir } = require("node:os"),
  { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("./production.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-production-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, "entity.sqlite"),
    passwordFile = join(root, "password");
  const store = new EntityStore(file);
  store.initializeState({ settings: { synthetic: true }, resources: [] });
  store.close();
  await fs.writeFile(
    passwordFile,
    createHash("sha256").update("synthetic-password").digest("hex"),
  );
  await fs.writeFile(
    join(root, "index.html"),
    "<html>Synthetic static fixture</html>",
  );
  const service = await createProductionService({
    file,
    passwordFile,
    staticDirectory: root,
    origin: "https://risu.test",
    insecureLocalTest: true,
    host: "127.0.0.1",
    port: 0,
    version: "synthetic",
  });
  t.after(() => service.close());
  return service;
}
test("production front door guards static/API data, preserves original password, streams authenticated SSE and rejects foreign origins", async (t) => {
  const service = await fixture(t),
    url = service.url;
  let response = await fetch(url + "/", { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
  response = await fetch(url + "/api/runtime/bootstrap");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  response = await fetch(url + "/api/runtime/server-snapshot");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  response = await fetch(url + "/_health");
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.engine, "native-entity");
  assert.equal(
    health.schema,
    await service.runtime.store.call("schemaVersion"),
  );
  response = await fetch(url + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=wrong",
  });
  assert.equal(response.status, 401);
  response = await fetch(url + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=synthetic-password",
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  response = await fetch(url + "/", { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Synthetic static/);
  response = await fetch(url + "/api/runtime/bootstrap", {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.ok(bootstrap.serverId);
  response = await fetch(url + "/api/runtime/server-snapshot", {
    headers: { cookie, "risu-runtime-id": bootstrap.serverId },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-disposition"),
    /risu-server-backup\.risusnapshot/,
  );
  assert.ok(
    Buffer.from(await response.arrayBuffer())
      .subarray(-8)
      .equals(Buffer.from("RTDONE01")),
  );
  response = await fetch(url + "/api/runtime/bootstrap", {
    headers: { cookie: cookie + "forged" },
  });
  assert.equal(response.status, 401);
  response = await fetch(url + "/api/runtime/bootstrap", {
    headers: { cookie, origin: "https://foreign.test" },
  });
  assert.equal(response.status, 403);
  const abort = new AbortController();
  response = await fetch(
    url + "/api/runtime/events?after=" + bootstrap.cursor,
    { headers: { cookie }, signal: abort.signal },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  abort.abort();
  response = await fetch(url + "/logout", {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("front health rejects readiness when its database worker has closed", async (t) => {
  const service = await fixture(t);
  await service.runtime.store.close();
  const response = await fetch(service.url + "/_health");
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.ready, false);
  assert.equal(health.error.code, "STORE_UNAVAILABLE");
  assert.equal(Object.hasOwn(health, "schema"), false);
});
