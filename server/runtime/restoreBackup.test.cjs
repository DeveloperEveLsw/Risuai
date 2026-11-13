"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { Packr } = require("msgpackr");
const { gzipSync } = require("fflate");
const { EntityStore } = require("../entity/store.cjs");
const { AssetStorage } = require("./assets.cjs");
const { restoreBackup } = require("./restoreBackup.cjs");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const COLD = "\uEF01COLDSTORAGE\uEF01";
const characterKey = "11111111-1111-4111-8111-111111111111",
  chatKey = "22222222-2222-4222-8222-222222222222",
  pluginKey = "33333333-3333-4333-8333-333333333333";
async function fixture(t, change = (value) => value, extraAssets = []) {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-restore-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    name = sha(png) + ".png";
  const message = {
    role: "char",
    data: "Authored synthetic text",
    chatId: "legacy-message",
    custom: { unchanged: true },
  };
  const character = {
    chaId: "character",
    name: "Authored fixture",
    type: "character",
    image: "assets/" + name,
    lastInteraction: 123,
    unknown: { value: 7 },
    chats: [
      {
        id: "first",
        name: "cold",
        message: [{ role: "char", data: COLD + chatKey }],
        lastDate: 456,
      },
      {
        id: "first",
        name: "branch",
        message: [message],
        bookmarks: ["legacy-message"],
        bookmarkNames: { "legacy-message": "bookmark" },
        lastMemory: "legacy-message",
        scriptstate: { flag: true },
      },
    ],
  };
  const database = change({
    characters: [{ chaId: "character", coldstorage: characterKey, chats: [] }],
    modules: [{ id: "module", name: "Synthetic module", unknown: 5 }],
    botPresets: [{ id: "preset", name: "Synthetic preset" }],
    personas: [],
    plugins: [],
    globalChatVariables: { global: "kept" },
    pluginCustomStorage: { _coldplugin: { synthetic: pluginKey } },
    statics: { messages: 42, imports: 3, extra: "kept" },
    coldstorage: true,
    unknownRoot: { asset: "assets/" + name },
  });
  const records = [
    [name, png],
    ...extraAssets,
    [
      "coldstorage_" + characterKey + ".json",
      Buffer.from(JSON.stringify({ character })),
    ],
    [
      "coldstorage_" + chatKey + ".json",
      Buffer.from(
        JSON.stringify({
          message: [message],
          scriptstate: { counter: 9 },
          localLore: [],
          hypaV3Data: { summaries: [{ chatMemos: ["legacy-message"] }] },
        }),
      ),
    ],
    [
      "coldstorage_" + pluginKey + ".json",
      Buffer.from(JSON.stringify(["synthetic value"])),
    ],
    [
      "database.risudat",
      Buffer.concat([
        Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]),
        Buffer.from(gzipSync(new Packr({ useRecords: false }).pack(database))),
      ]),
    ],
  ];
  let offset = 0;
  const parts = [],
    entries = [];
  for (const [name, data] of records) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(Buffer.byteLength(name));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    entries.push({ name, offset, bytes: data.length, sha256: sha(data) });
    const record = Buffer.concat([header, Buffer.from(name), size, data]);
    parts.push(record);
    offset += record.length;
  }
  const bytes = Buffer.concat(parts),
    inventoryBytes = Buffer.from(JSON.stringify(entries));
  const backup = join(root, "backup.bin"),
    inventory = join(root, "entries.json"),
    file = join(root, "entity.sqlite");
  await fs.writeFile(backup, bytes);
  await fs.writeFile(inventory, inventoryBytes);
  return {
    options: {
      backup,
      inventory,
      file,
      expectedSha256: sha(bytes),
      expectedInventorySha256: sha(inventoryBytes),
    },
    root,
    png,
    name,
  };
}
test("offline backup restores cold data, branch identities, unknown fields, statistics and legacy assets without private logging", async (t) => {
  const f = await fixture(t),
    report = await restoreBackup(f.options);
  assert.equal(report.restored, true);
  assert.equal(report.coldHydrated, 3);
  assert.equal(report.counts.characters, 1);
  assert.equal(report.counts.chats, 2);
  assert.equal(report.counts.messages, 2);
  assert.equal(report.remapped.chat, 1);
  assert.equal(report.remapped.message, 1);
  assert.equal(report.normalizedSourceSha256, report.normalizedDatabaseSha256);
  const store = new EntityStore(f.options.file);
  t.after(() => store.close());
  assert.equal(report.schema, store.schemaVersion());
  const settings = store.getResource("settings", "global").payload;
  assert.deepEqual(settings.statics, {
    messages: 42,
    imports: 3,
    extra: "kept",
  });
  assert.equal(settings.coldstorage, false);
  assert.deepEqual(settings.pluginCustomStorage.synthetic, ["synthetic value"]);
  const rows = store.db
    .prepare("SELECT id,metadata FROM chats ORDER BY sort_position")
    .all();
  assert.equal(JSON.parse(rows[0].metadata).lastDate, 456);
  const remapped = store.db
    .prepare("SELECT id FROM messages WHERE chat_id=?")
    .get(rows[1].id).id;
  assert.deepEqual(JSON.parse(rows[1].metadata).bookmarks, [remapped]);
  assert.equal(store.readBookmark(rows[1].id, remapped).occurrences, 1);
  const storage = new AssetStorage(
    f.options.file,
    { call: (method, ...args) => store[method](...args) },
    report.serverId,
  );
  assert.deepEqual(Buffer.from(await storage.read("assets/" + f.name)), f.png);
  await assert.rejects(() => restoreBackup(f.options), {
    code: "DESTINATION_EXISTS",
  });
});
test("checksum failure never admits a restored database", async (t) => {
  const f = await fixture(t);
  const bytes = await fs.readFile(f.options.backup);
  bytes[80] ^= 1;
  await fs.writeFile(f.options.backup, bytes);
  await assert.rejects(() => restoreBackup(f.options), {
    code: "ENTRY_CHECKSUM_MISMATCH",
  });
  await assert.rejects(() => fs.stat(f.options.file), { code: "ENOENT" });
});
test("missing cold payload fails instead of silently deleting a chat", async (t) => {
  const f = await fixture(t, (d) => ({
    ...d,
    pluginCustomStorage: {
      _coldplugin: { missing: "44444444-4444-4444-8444-444444444444" },
    },
  }));
  await assert.rejects(() => restoreBackup(f.options), {
    code: "MISSING_COLD_STORAGE",
  });
  await assert.rejects(() => fs.stat(f.options.file), { code: "ENOENT" });
});
test("missing referenced assets fail before publication", async (t) => {
  const f = await fixture(t, (d) => ({
    ...d,
    userIcon: "assets/" + "f".repeat(64) + ".png",
  }));
  await assert.rejects(() => restoreBackup(f.options), {
    code: "MISSING_ASSET_REFERENCES",
  });
});
test("an explicitly preserved preexisting inline reference is retained without hiding a missing structured image", async (t) => {
  const f = await fixture(t, (d) => ({
    ...d,
    syntheticInline: "historical assets/" + "e".repeat(64) + ".png",
  }));
  const report = await restoreBackup({
    ...f.options,
    preserveMissingInlineAssets: true,
  });
  assert.equal(report.preservedPreexistingInlineAssetReferences, 1);
  assert.equal(report.missingStructuredAssetReferences, 0);
  assert.equal(report.normalizedSourceSha256, report.normalizedDatabaseSha256);
  const bad = await fixture(t, (d) => ({
    ...d,
    userIcon: "assets/" + "f".repeat(64) + ".png",
  }));
  await assert.rejects(
    () => restoreBackup({ ...bad.options, preserveMissingInlineAssets: true }),
    { code: "MISSING_ASSET_REFERENCES" },
  );
});

test("offline restore preserves immutable audio aliases sharing one digest and rejects missing non-PNG references", async (t) => {
  const audio = Buffer.from("RIFF synthetic neutral audio bytes");
  const wav = sha(audio) + ".wav",
    ogg = sha(audio) + ".ogg";
  const f = await fixture(
    t,
    (d) => ({
      ...d,
      syntheticAudio: ["assets/runtime/" + wav, "assets/" + ogg],
    }),
    [
      [wav, audio],
      [ogg, audio],
    ],
  );
  const report = await restoreBackup(f.options);
  assert.equal(report.counts.assets, 3);
  const store = new EntityStore(f.options.file);
  try {
    assert.equal(store.getAsset(wav).mime, "audio/wav");
    assert.equal(store.getAsset(ogg).mime, "audio/ogg");
    const storage = new AssetStorage(
      f.options.file,
      { call: (method, ...args) => store[method](...args) },
      report.serverId,
    );
    assert.deepEqual(
      Buffer.from(await storage.read("assets/runtime/" + wav)),
      audio,
    );
    assert.deepEqual(Buffer.from(await storage.read("assets/" + ogg)), audio);
  } finally {
    store.close();
  }
  const missing = await fixture(t, (d) => ({
    ...d,
    unknownAudio: "assets/runtime/" + "e".repeat(64) + ".wav",
  }));
  await assert.rejects(() => restoreBackup(missing.options), {
    code: "MISSING_ASSET_REFERENCES",
  });
  await assert.rejects(() => fs.stat(missing.options.file), { code: "ENOENT" });
});
