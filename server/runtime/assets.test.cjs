"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { request } = require("node:http");
const { mkdtemp, rm, readdir, unlink } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("./service.cjs");
const { MAX_ASSET_BYTES } = require("../entity/assets.cjs");
const bytes = Buffer.from(
  "89504e470d0a1a0a53696e746865746963206173736574",
  "hex",
);
async function until(read) {
  for (let i = 0; i < 200; i++) {
    if (await read()) return;
    await delay(10);
  }
  throw Error("Synthetic asset wait timed out");
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "risu-shared-assets-")),
    file = join(directory, "state.sqlite"),
    f = { directory, file, runtime: null };
  t.after(async () => {
    await f.runtime?.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  f.restart = async () => {
    await f.runtime?.close();
    f.runtime = await createRuntimeService({ file });
    f.serverId = (await f.runtime.store.call("bootstrap")).serverId;
  };
  await f.restart();
  f.upload = async (data = bytes, ext = "png", identity = f.serverId) => {
    const response = await fetch(
      f.runtime.url +
        "/api/runtime/assets?extension=" +
        encodeURIComponent(ext),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Risu-Runtime-Id": identity,
        },
        body: data,
      },
    );
    return { response, body: await response.json() };
  };
  f.url = (id) =>
    f.runtime.url + "/api/runtime/assets/" + id + "?authority=" + f.serverId;
  return f;
}
test("shared binary assets deduplicate durably and support guarded, cacheable range reads after restart", async (t) => {
  const f = await fixture(t),
    before = await f.runtime.store.call("bootstrap");
  const one = await f.upload(),
    two = await f.upload();
  assert.equal(one.response.status, 200);
  assert.deepEqual(two.body, one.body);
  assert.equal(
    one.body.digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await f.runtime.store.call("bootstrap"), before);
  assert.deepEqual((await readdir(f.runtime.assets.root)).sort(), [
    one.body.digest + ".blob",
  ]);
  const response = await fetch(f.url(one.body.id));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control"), /immutable/);
  const cached = await fetch(f.url(one.body.id), {
    headers: { "If-None-Match": response.headers.get("etag") },
  });
  assert.equal(cached.status, 304);
  const range = await fetch(f.url(one.body.id), {
    headers: { Range: "bytes=0-7" },
  });
  assert.equal(range.status, 206);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    bytes.subarray(0, 8),
  );
  assert.equal(
    (await fetch(f.url(one.body.id).replace(f.serverId, "foreign-authority")))
      .status,
    409,
  );
  assert.equal(
    (await f.upload(bytes, "png", "foreign-authority")).response.status,
    409,
  );
  assert.equal(
    (
      await fetch(f.url(one.body.id), {
        headers: { Origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await f.upload(bytes, "../../bad")).response.status, 400);
  const active = await f.upload(
    Buffer.from("<script>Synthetic</script>"),
    "html",
  );
  const passive = await fetch(f.url(active.body.id));
  assert.equal(passive.headers.get("content-type"), "application/octet-stream");
  assert.match(passive.headers.get("content-disposition"), /^attachment/);
  assert.equal(passive.headers.get("x-content-type-options"), "nosniff");
  await f.restart();
  assert.deepEqual(
    Buffer.from(await (await fetch(f.url(one.body.id))).arrayBuffer()),
    bytes,
  );
  assert.deepEqual(
    Buffer.from(await f.runtime.assets.read(one.body.path)),
    bytes,
  );
});
test("an aborted upload leaves no metadata or partial files while ordinary database requests stay responsive", async (t) => {
  const f = await fixture(t);
  const req = request(f.runtime.url + "/api/runtime/assets?extension=png", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Risu-Runtime-Id": f.serverId,
    },
  });
  req.on("error", () => {});
  req.write(bytes);
  await until(async () => {
    try {
      return (await readdir(f.runtime.assets.root)).some((name) =>
        name.endsWith(".part"),
      );
    } catch {
      return false;
    }
  });
  const health = await fetch(f.runtime.url + "/api/runtime/health");
  assert.equal(health.status, 200);
  assert.ok((await f.runtime.store.call("bootstrap")).serverId);
  req.destroy();
  await until(() => f.runtime.assets.pending.size === 0);
  assert.deepEqual(await readdir(f.runtime.assets.root), []);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await f.runtime.store.call("getAsset", digest + ".png"), null);
});
test("oversized uploads clean temporary data and missing immutable blobs report a storage error", async (t) => {
  const f = await fixture(t),
    chunk = Buffer.alloc(1024 * 1024, 1);
  async function* source() {
    for (let size = 0; size <= MAX_ASSET_BYTES; size += chunk.length)
      yield chunk;
  }
  await assert.rejects(f.runtime.assets.upload(source(), "bin"), {
    code: "ASSET_TOO_LARGE",
  });
  assert.deepEqual(await readdir(f.runtime.assets.root), []);
  const one = await f.upload();
  await unlink(join(f.runtime.assets.root, one.body.digest + ".blob"));
  const response = await fetch(f.url(one.body.id));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "ASSET_STORAGE_ERROR");
  assert.equal(
    (await fetch(f.runtime.url + "/api/runtime/health")).status,
    200,
  );
});
