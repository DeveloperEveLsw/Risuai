"use strict";
// Inspect framing and hashes only; never decode or print backed-up content.
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
async function inventoryBackup(backup, inventory) {
  const source = await fs.open(backup, "r");
  const whole = createHash("sha256"),
    entries = [],
    names = new Set();
  let offset = 0;
  try {
    const before = await source.stat();
    async function read(size) {
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        offset + size > before.size
      )
        fail("TRUNCATED_BACKUP");
      const bytes = Buffer.alloc(size);
      let got = 0;
      while (got < size) {
        const result = await source.read(bytes, got, size - got, offset + got);
        if (!result.bytesRead) fail("TRUNCATED_BACKUP");
        got += result.bytesRead;
      }
      offset += size;
      whole.update(bytes);
      return bytes;
    }
    while (offset < before.size) {
      if (entries.length >= 100000) fail("INVENTORY_TOO_LARGE");
      const start = offset,
        length = (await read(4)).readUInt32LE(0);
      if (!length || length > 256) fail("INVALID_BACKUP_NAME");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        await read(length),
      );
      if (names.has(name) || /[\\/\x00]/.test(name)) fail("UNSAFE_BACKUP_NAME");
      names.add(name);
      const size = (await read(4)).readUInt32LE(0);
      if (!size || size > 64 * 1024 * 1024) fail("BACKUP_ENTRY_TOO_LARGE");
      const hash = createHash("sha256");
      for (let remaining = size; remaining > 0;) {
        const bytes = await read(Math.min(65536, remaining));
        hash.update(bytes);
        remaining -= bytes.length;
      }
      entries.push({
        name,
        offset: start,
        bytes: size,
        sha256: hash.digest("hex"),
      });
    }
    if (!names.has("database.risudat")) fail("MISSING_DATABASE_ENTRY");
    const after = await source.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      fail("BACKUP_CHANGED");
    const data = Buffer.from(JSON.stringify(entries, null, 2) + "\n");
    const output = await fs.open(inventory, "wx", 0o600);
    try {
      await output.writeFile(data);
      await output.sync();
    } finally {
      await output.close();
    }
    return {
      backup: resolve(backup),
      inventory: resolve(inventory),
      entries: entries.length,
      bytes: before.size,
      backupSha256: whole.digest("hex"),
      inventorySha256: createHash("sha256").update(data).digest("hex"),
      contentsDecoded: false,
    };
  } finally {
    await source.close();
  }
}
module.exports = { inventoryBackup };
if (require.main === module) {
  const [backup, inventory] = process.argv.slice(2);
  inventoryBackup(backup, inventory)
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          inventoried: false,
          code: error.code ?? "INVENTORY_FAILED",
        }),
      );
      process.exitCode = 1;
    });
}
