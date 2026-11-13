"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { inventoryBackup } = require("./inventoryBackup.cjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function record(name, body) {
  const n = Buffer.alloc(4),
    s = Buffer.alloc(4);
  n.writeUInt32LE(Buffer.byteLength(name));
  s.writeUInt32LE(body.length);
  return Buffer.concat([n, Buffer.from(name), s, body]);
}
async function fixture(t, bytes) {
  const dir = await fs.mkdtemp(join(tmpdir(), "risu-inventory-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const backup = join(dir, "backup.bin"),
    inventory = join(dir, "inventory.json");
  await fs.writeFile(backup, bytes);
  return { backup, inventory };
}
test("streamed inventory records exact original framing and checksums without decoding bodies or replacing an existing inventory", async (t) => {
  const body = Buffer.alloc(180000, 127),
    asset = sha(body) + ".wav";
  const bytes = Buffer.concat([
    record(asset, body),
    record("database.risudat", Buffer.from("opaque synthetic bytes")),
  ]);
  const f = await fixture(t, bytes),
    report = await inventoryBackup(f.backup, f.inventory);
  assert.equal(report.contentsDecoded, false);
  assert.equal(report.backupSha256, sha(bytes));
  const data = await fs.readFile(f.inventory),
    entries = JSON.parse(data);
  assert.equal(report.inventorySha256, sha(data));
  assert.deepEqual(entries[0], {
    name: asset,
    offset: 0,
    bytes: body.length,
    sha256: sha(body),
  });
  assert.equal(entries[1].offset, record(asset, body).length);
  await assert.rejects(() => inventoryBackup(f.backup, f.inventory), {
    code: "EEXIST",
  });
  assert.deepEqual(await fs.readFile(f.inventory), data);
});
test("truncated and unsafe backup framing creates no inventory", async (t) => {
  for (const [bytes, code] of [
    [
      record("database.risudat", Buffer.from("x")).subarray(0, 13),
      "TRUNCATED_BACKUP",
    ],
    [record("../database.risudat", Buffer.from("x")), "UNSAFE_BACKUP_NAME"],
    [record("synthetic.wav", Buffer.from("x")), "MISSING_DATABASE_ENTRY"],
  ]) {
    const f = await fixture(t, bytes);
    await assert.rejects(() => inventoryBackup(f.backup, f.inventory), {
      code,
    });
    await assert.rejects(() => fs.stat(f.inventory), { code: "ENOENT" });
  }
});
