"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash, createHmac } = require("node:crypto");
const { RuntimeDiagnostics } = require("./diagnostics.cjs");
const { createProductionService } = require("./production.cjs");
const { EntityStore } = require("../entity/store.cjs");
const {
  diagnosticEndpoint,
  runtimeDiagnosticRecord,
} = require("../../src/ts/runtime/runtimeDiagnosticProtocol.mjs");
const uuid = "60c52b16-430a-4cf0-a9e4-a165950015a2";
async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const root = await directory(t),
    file = join(root, "entity.sqlite"),
    passwordFile = join(root, "password");
  const store = new EntityStore(file);
  store.initializeState({ settings: { synthetic: true }, resources: [] });
  store.close();
  const secret = createHash("sha256")
    .update("synthetic-password")
    .digest("hex");
  await fs.writeFile(passwordFile, secret);
  const options = {
    file,
    passwordFile,
    staticDirectory: root,
    origin: "https://risu.test",
    insecureLocalTest: true,
    host: "127.0.0.1",
    port: 0,
    runtime: { eventsPollMs: 5 },
  };
  const service = await createProductionService(options);
  t.after(() => service.close());
  const expires = String(Math.floor(Date.now() / 1000) + 86400);
  const cookie =
    "risu-entity-session=" +
    expires +
    "." +
    createHmac("sha256", secret)
      .update("risu-entity:" + expires)
      .digest("base64url");
  return { root, file, service, cookie, options };
}
test("diagnostic metadata discards bodies, messages, credentials, arbitrary codes and URL identities", () => {
  const record = runtimeDiagnosticRecord({
    code: "PRIVATE_SENTINEL",
    method: "PRIVATE_SENTINEL",
    endpoint:
      "https://PRIVATE_SENTINEL/api/runtime/chats/PRIVATE_SENTINEL?token=PRIVATE_SENTINEL",
    requestId: "PRIVATE_SENTINEL",
    message: "PRIVATE_SENTINEL",
    details: { token: "PRIVATE_SENTINEL" },
    body: "PRIVATE_SENTINEL",
  });
  assert.equal(record.endpoint, "/api/runtime/chats/:id");
  assert.equal(record.code, "RUNTIME_ERROR");
  assert.equal(record.method, "OTHER");
  assert.ok(!JSON.stringify(record).includes("PRIVATE_SENTINEL"));
  for (const path of [
    "/api/runtime/chats/x/jobs",
    "/api/runtime/chats/x/display",
    "/api/runtime/libraries/module/resolve",
    "/api/runtime/libraries/module",
  ])
    assert.notEqual(diagnosticEndpoint(path), "unknown");
  assert.equal(diagnosticEndpoint("/PRIVATE_SENTINEL"), "unknown");
});
test("bounded journal rotates, survives restart and uses private file permissions", async (t) => {
  const file = join(await directory(t), "journal"),
    options = { maxBytes: 700 };
  let journal = new RuntimeDiagnostics(file, options);
  for (let i = 0; i < 12; i++)
    journal.record({
      kind: "http-error",
      code: "ERR_SQLITE_ERROR",
      requestId: uuid,
      method: "GET",
      endpoint: "/api/runtime/bootstrap",
      status: 500,
    });
  await journal.close();
  for (const p of [file, file + ".1"]) {
    const stat = await fs.stat(p);
    assert.ok(stat.size <= 700);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  const before = await fs.readFile(file, "utf8");
  journal = new RuntimeDiagnostics(file, options);
  journal.record({
    code: "NOT_FOUND",
    endpoint: "/api/runtime/jobs/private",
    requestId: uuid,
  });
  await journal.close();
  const combined =
    (await fs.readFile(file, "utf8")) +
    (await fs.readFile(file + ".1", "utf8"));
  assert.ok(combined.includes(before));
  assert.ok(combined.includes('"code":"NOT_FOUND"'));
});
test("queue overflow and storage failure remain bounded and cannot throw into request handling", async (t) => {
  const root = await directory(t),
    journal = new RuntimeDiagnostics(join(root, "journal"), { maxQueued: 2 });
  for (let i = 0; i < 100; i++) journal.record({ code: "DATABASE_ERROR" });
  assert.equal(journal.dropped, 98);
  await journal.close();
  const bad = new RuntimeDiagnostics(join(root, "missing", "journal"));
  bad.record({ code: "DATABASE_ERROR" });
  await bad.close();
  assert.equal(bad.writeFailures, 1);
});
test("initial DB failure correlates front door, HTTP body/header and persistent journal without private values", async (t) => {
  const f = await fixture(t),
    call = f.service.runtime.store.call.bind(f.service.runtime.store);
  f.service.runtime.store.call = (method, ...args) => {
    if (method === "bootstrap") {
      const error = new Error("PRIVATE_SENTINEL prompt and SQL values");
      error.code = "ERR_SQLITE_ERROR";
      return Promise.reject(error);
    }
    return call(method, ...args);
  };
  const response = await fetch(
    f.service.url + "/api/runtime/bootstrap?token=PRIVATE_SENTINEL",
    {
      headers: {
        cookie: f.cookie,
        "risu-request-id": uuid,
        authorization: "PRIVATE_SENTINEL",
      },
    },
  );
  const body = await response.json(),
    trace = response.headers.get("risu-request-id");
  assert.equal(response.status, 500);
  assert.equal(body.error.code, "ERR_SQLITE_ERROR");
  assert.equal(body.error.requestId, trace);
  assert.notEqual(trace, uuid);
  await f.service.runtime.diagnostics.flush();
  const raw = await fs.readFile(f.file + ".diagnostics.jsonl", "utf8"),
    records = raw.trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].requestId, trace);
  assert.equal(records[0].endpoint, "/api/runtime/bootstrap");
  assert.ok(records[0].elapsedMs >= 0);
  assert.ok(!raw.includes("PRIVATE_SENTINEL"));
  f.service.runtime.store.call = call;
  await f.service.close();
  const again = await createProductionService(f.options);
  t.after(() => again.close());
  assert.equal(await fs.readFile(f.file + ".diagnostics.jsonl", "utf8"), raw);
});
test("authentication and malformed JSON failures have safe trace IDs; ordinary SSE close is quiet", async (t) => {
  const f = await fixture(t);
  const anonymous = await fetch(f.service.url + "/api/runtime/bootstrap");
  assert.equal(anonymous.status, 401);
  assert.equal(
    (await anonymous.json()).error.requestId,
    anonymous.headers.get("risu-request-id"),
  );
  const malformed = await fetch(f.service.url + "/api/runtime/commands", {
    method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: '{"PRIVATE_SENTINEL":',
  });
  assert.equal(malformed.status, 400);
  const abort = new AbortController();
  const boot = await (
    await fetch(f.service.url + "/api/runtime/bootstrap", {
      headers: { cookie: f.cookie },
    })
  ).json();
  const stream = await fetch(
    f.service.url + "/api/runtime/events?after=" + boot.cursor,
    { headers: { cookie: f.cookie }, signal: abort.signal },
  );
  assert.equal(stream.status, 200);
  abort.abort();
  await f.service.runtime.diagnostics.flush();
  const raw = await fs.readFile(f.file + ".diagnostics.jsonl", "utf8");
  assert.ok(!raw.includes("PRIVATE_SENTINEL"));
  const records = raw.trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.ok(!records.some((v) => v.kind === "stream-reset"));
});
test("a live SSE database failure is correlated in the reset frame and persistent journal", async (t) => {
  const f = await fixture(t),
    call = f.service.runtime.store.call.bind(f.service.runtime.store),
    abort = new AbortController();
  const boot = await (
    await fetch(f.service.url + "/api/runtime/bootstrap", {
      headers: { cookie: f.cookie },
    })
  ).json();
  const stream = await fetch(
    f.service.url + "/api/runtime/events?after=" + boot.cursor,
    { headers: { cookie: f.cookie }, signal: abort.signal },
  );
  f.service.runtime.store.call = (method, ...args) =>
    method === "changes"
      ? Promise.reject(
          Object.assign(new Error("PRIVATE_SENTINEL"), {
            code: "ERR_SQLITE_ERROR",
          }),
        )
      : call(method, ...args);
  const raw = await stream.text();
  assert.match(raw, /event: reset/);
  const reset = JSON.parse(raw.match(/data: (.*)/)[1]);
  assert.equal(reset.requestId, stream.headers.get("risu-request-id"));
  f.service.runtime.store.call = call;
  await f.service.runtime.diagnostics.flush();
  const saved = JSON.parse(
    (await fs.readFile(f.file + ".diagnostics.jsonl", "utf8")).trim(),
  );
  assert.equal(saved.kind, "stream-reset");
  assert.equal(saved.code, "ERR_SQLITE_ERROR");
  assert.equal(saved.requestId, reset.requestId);
  assert.ok(!JSON.stringify(saved).includes("PRIVATE_SENTINEL"));
});
