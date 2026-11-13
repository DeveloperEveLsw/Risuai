"use strict";
// Offline importer. Neither imported strings nor decoder exceptions are logged.
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { decompressSync } = require("fflate");
const { Unpackr } = require("msgpackr");
const { EntityStore } = require("../entity/store.cjs");
const { remapMessageReferences } = require("../entity/lifecycle.cjs");
const { mime } = require("./assets.cjs");
const COLD = "\uEF01COLDSTORAGE\uEF01";
const sha = (data) => createHash("sha256").update(data).digest("hex");
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_BACKUP_OBJECT");
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("INVALID_CHECKSUM");
  return value;
}
const clone = (value) => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const fingerprint = (value) => sha(JSON.stringify(canonical(value)));

function hydrate(database, cold) {
  const used = new Set();
  function get(key) {
    if (!cold.has(key)) fail("MISSING_COLD_STORAGE");
    used.add(key);
    return clone(cold.get(key));
  }
  database.characters = database.characters.map((placeholder) => {
    let character = object(placeholder);
    const seen = new Set();
    while (character.coldstorage) {
      if (seen.has(character.coldstorage)) fail("CYCLIC_COLD_STORAGE");
      seen.add(character.coldstorage);
      const restored = object(get(character.coldstorage)).character;
      if (!restored || restored.chaId !== character.chaId)
        fail("COLD_CHARACTER_MISMATCH");
      character = object(restored);
    }
    delete character.coldstorage;
    delete character.coldStoragedChats;
    if (!Array.isArray(character.chats)) fail("INVALID_CHAT_COLLECTION");
    character.chats = character.chats.map((chat) => {
      object(chat);
      const seenChats = new Set();
      while (chat.message?.[0]?.data?.startsWith(COLD)) {
        const key = chat.message[0].data.slice(COLD.length);
        if (seenChats.has(key)) fail("CYCLIC_COLD_CHAT");
        seenChats.add(key);
        const restored = get(key);
        if (Array.isArray(restored)) chat.message = restored;
        else {
          if (!Array.isArray(restored?.message)) fail("INVALID_COLD_CHAT");
          for (const field of [
            "message",
            "hypaV2Data",
            "hypaV3Data",
            "scriptstate",
            "localLore",
          ])
            if (Object.hasOwn(restored, field)) chat[field] = restored[field];
            else delete chat[field];
        }
      }
      return chat;
    });
    return character;
  });
  if (database.pluginCustomStorage?._coldplugin) {
    for (const [key, id] of Object.entries(
      database.pluginCustomStorage._coldplugin,
    ))
      database.pluginCustomStorage[key] = get(id);
    delete database.pluginCustomStorage._coldplugin;
  }
  return used.size;
}

// Identity references are preserved whenever possible. Branches may share the
// same legacy message ID; only known memory/bookmark references are remapped.
function prepare(database, seed) {
  const ids = new Map(),
    remapped = { character: 0, chat: 0, message: 0, resource: 0 };
  function identity(kind, candidate, location) {
    let used = ids.get(kind);
    if (!used) ids.set(kind, (used = new Set()));
    let id = candidate;
    if (typeof id !== "string" || !id || id.length > 256 || used.has(id)) {
      id = sha(seed + ":" + kind + ":" + location);
      remapped[
        kind === "module" ||
        kind === "preset" ||
        kind === "persona" ||
        kind === "plugin"
          ? "resource"
          : kind
      ]++;
    }
    if (used.has(id)) fail("IMPORT_IDENTITY_COLLISION");
    used.add(id);
    return id;
  }
  const settings = { ...database },
    resources = [],
    characters = [];
  delete settings.characters;
  // Entity mode pages server history and has no browser OPFS cold-storage owner.
  settings.coldstorage = false;
  for (const [collection, kind] of [
    ["modules", "module"],
    ["botPresets", "preset"],
    ["personas", "persona"],
    ["plugins", "plugin"],
  ]) {
    const values = settings[collection] ?? [];
    if (!Array.isArray(values)) fail("INVALID_RESOURCE_COLLECTION");
    settings[kind + "Ids"] = values.map((value, index) => {
      object(value);
      const id = identity(kind, value.id, index);
      resources.push({ kind, id, payload: { ...value, id } });
      return id;
    });
    delete settings[collection];
  }
  for (const [id, payload] of Object.entries(
    settings.globalChatVariables ?? {},
  ))
    resources.push({ kind: "global-variable", id, payload });
  delete settings.globalChatVariables;
  for (const [ci, character] of database.characters.entries()) {
    const id = identity("character", character.chaId, ci);
    // Character IDs referenced by groups/folders cannot be guessed on collision.
    if (character.chaId && id !== character.chaId)
      fail("AMBIGUOUS_CHARACTER_ID");
    const {
      chats,
      chatPage: _page,
      reloadKeys: _reload,
      ...definition
    } = character;
    definition.chaId = id;
    const prepared = { id, definition, chats: [] };
    for (const [ti, chat] of chats.entries()) {
      const chatId = identity("chat", chat.id, ci + ":" + ti);
      const {
        message,
        scriptstate = {},
        isStreaming: _streaming,
        activeStreamingDisplayOptimizationMode: _display,
        ...metadata
      } = chat;
      if (!Array.isArray(message)) fail("INVALID_MESSAGE_COLLECTION");
      const refs = new Map();
      const messages = message.map((value, mi) => {
        object(value);
        const messageId = identity(
          "message",
          value.chatId,
          ci + ":" + ti + ":" + mi,
        );
        if (typeof value.chatId === "string") {
          if (refs.has(value.chatId)) fail("AMBIGUOUS_MESSAGE_REFERENCE");
          refs.set(value.chatId, messageId);
        }
        return { id: messageId, message: { ...value, chatId: messageId } };
      });
      metadata.id = chatId;
      remapMessageReferences(metadata, refs);
      prepared.chats.push({
        id: chatId,
        metadata,
        messages,
        variables: object(scriptstate),
      });
    }
    characters.push(prepared);
  }
  return { settings, resources, characters, remapped };
}

async function restoreBackup(options) {
  const file = resolve(options.file),
    inventoryBytes = await fs.readFile(options.inventory);
  if (sha(inventoryBytes) !== digest(options.expectedInventorySha256))
    fail("INVENTORY_CHECKSUM_MISMATCH");
  const entries = JSON.parse(inventoryBytes);
  if (!Array.isArray(entries)) fail("INVALID_INVENTORY");
  digest(options.expectedSha256);
  try {
    await fs.stat(file);
    fail("DESTINATION_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!options.validateOnly)
    await fs.mkdir(file + ".restore", { recursive: false, mode: 0o700 });
  const started = Date.now(),
    source = await fs.open(options.backup, "r"),
    before = await source.stat();
  const whole = createHash("sha256"),
    names = new Set(),
    copiedDigests = new Set(),
    assets = [],
    cold = new Map();
  let offset = 0,
    databaseBytes,
    store;
  async function read(size) {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > before.size)
      fail("TRUNCATED_BACKUP");
    const data = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const result = await source.read(data, got, size - got, offset + got);
      if (!result.bytesRead) fail("TRUNCATED_BACKUP");
      got += result.bytesRead;
    }
    offset += size;
    whole.update(data);
    return data;
  }
  try {
    for (let index = 0; index < entries.length; index++) {
      const expected = entries[index],
        start = offset;
      const length = (await read(4)).readUInt32LE(0);
      if (!length || length > 256) fail("INVALID_BACKUP_NAME");
      const name = (await read(length)).toString("utf8");
      if (names.has(name) || /[\\/\x00]/.test(name)) fail("UNSAFE_BACKUP_NAME");
      names.add(name);
      const size = (await read(4)).readUInt32LE(0);
      if (!size || size > 64 * 1024 * 1024) fail("BACKUP_ENTRY_TOO_LARGE");
      if (
        expected.name !== name ||
        expected.offset !== start ||
        expected.bytes !== size
      )
        fail("ENTRY_INVENTORY_MISMATCH");
      const data = await read(size),
        hash = sha(data);
      if (hash !== expected.sha256) fail("ENTRY_CHECKSUM_MISMATCH");
      const assetName = /^([a-f0-9]{64})\.([a-z0-9]{1,16})$/.exec(name);
      if (assetName) {
        if (assetName[1] !== hash) fail("UNSUPPORTED_ASSET_ALIAS");
        const extension = assetName[2];
        if (!options.validateOnly && !copiedDigests.has(hash)) {
          const handle = await fs.open(
            join(file + ".restore", hash + ".blob"),
            "wx",
            0o600,
          );
          try {
            await handle.writeFile(data);
            await handle.sync();
          } finally {
            await handle.close();
          }
          copiedDigests.add(hash);
        }
        assets.push({
          id: name,
          digest: hash,
          extension,
          byteLength: size,
          mime: mime(data.subarray(0, 64), extension),
        });
      } else if (name === "database.risudat") databaseBytes = data;
      else {
        const match = /^(?:coldstorage_)?([0-9a-fA-F-]{36})\.json$/.exec(name);
        if (!match) fail("UNSUPPORTED_BACKUP_ENTRY");
        // LocalWriter exports decoded cold payloads as plain UTF-8 JSON,
        // unlike the compressed cold-storage backend files themselves.
        cold.set(match[1], JSON.parse(data.toString("utf8")));
      }
      if (index % 2000 === 0)
        options.onProgress?.({
          stage: "copy",
          entries: index + 1,
          total: entries.length,
        });
    }
    const hash = whole.digest("hex"),
      after = await source.stat();
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      hash !== options.expectedSha256
    )
      fail("BACKUP_CHECKSUM_MISMATCH");
    if (
      !databaseBytes ||
      !databaseBytes
        .subarray(0, 11)
        .equals(Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]))
    )
      fail("UNSUPPORTED_DATABASE_FORMAT");
    const database = clone(
      new Unpackr({ int64AsType: "number", useRecords: false }).unpack(
        decompressSync(databaseBytes.subarray(11)),
      ),
    );
    if (!Array.isArray(database?.characters)) fail("INVALID_DATABASE");
    const coldHydrated = hydrate(database, cold),
      state = prepare(database, hash);
    const assetNames = new Set(assets.map((asset) => asset.id));
    let references = 0,
      missing = 0,
      missingStructured = 0;
    const assetFields = new Set([
      "image",
      "userIcon",
      "customBackground",
      "emotionImages",
      "additionalAssets",
      "ccAssets",
      "assets",
      "vits",
      "uri",
      "icon",
    ]);
    function check(value, structured = false) {
      if (typeof value === "string")
        for (const match of value.matchAll(
          /assets\/(?:runtime\/)?([a-f0-9]{64}\.[a-z0-9]{1,16})(?![a-z0-9.])/g,
        )) {
          references++;
          if (!assetNames.has(match[1])) {
            missing++;
            if (structured) missingStructured++;
          }
        }
      else if (value && typeof value === "object")
        for (const [key, nested] of Object.entries(value))
          check(nested, structured || assetFields.has(key));
    }
    check(database);
    if (
      missing &&
      !options.validateOnly &&
      (!options.preserveMissingInlineAssets || missingStructured)
    )
      fail("MISSING_ASSET_REFERENCES");
    options.onProgress?.({
      stage: "database",
      characters: state.characters.length,
      assets: assets.length,
    });
    store = new EntityStore(options.validateOnly ? ":memory:" : file);
    const serverId = store.db
      .prepare("SELECT id FROM runtime_identity WHERE singleton=1")
      .get().id;
    if (!options.validateOnly) {
      await fs.mkdir(file + ".assets", { mode: 0o700 });
      await fs.rename(file + ".restore", join(file + ".assets", serverId));
      for (const directory of [
        file + ".assets",
        join(file + ".assets", serverId),
      ]) {
        const handle = await fs.open(directory, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    store.transaction(() => {
      for (const resource of state.resources)
        store.mutate({
          type: "put-resource",
          kind: resource.kind,
          resourceId: resource.id,
          payload: resource.payload,
          expectedRevision: 0,
        });
      store.mutate({
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        payload: state.settings,
        expectedRevision: 0,
      });
      for (const character of state.characters) {
        store.mutate({
          type: "create-character",
          characterId: character.id,
          definition: character.definition,
        });
        for (const chat of character.chats) {
          store.mutate({
            type: "create-chat",
            chatId: chat.id,
            characterId: character.id,
            metadata: chat.metadata,
            messages: chat.messages,
          });
          for (const [key, value] of Object.entries(chat.variables))
            store.setVariable(chat.id, key, value);
        }
      }
      const statement = store.db.prepare(
        "INSERT INTO assets(id,digest,extension,mime,byte_length,created_at) VALUES (?,?,?,?,?,?)",
      );
      for (const asset of assets)
        statement.run(
          asset.id,
          asset.digest,
          asset.extension,
          asset.mime,
          asset.byteLength,
          Date.now(),
        );
    });
    // Reconstruct the normalized source in memory and compare every persistent
    // definition, resource, message, metadata, variable and statistics value.
    const expected = clone(state),
      actual = clone(state);
    delete expected.remapped;
    delete actual.remapped;
    expected.settings.statics = {
      messages: 0,
      imports: 0,
      ...expected.settings.statics,
    };
    actual.settings = store.getResource("settings", "global").payload;
    actual.resources = state.resources.map((r) => ({
      ...r,
      payload: store.getResource(r.kind, r.id).payload,
    }));
    actual.characters = state.characters.map((c) => {
      const row = store.db
        .prepare("SELECT definition FROM characters WHERE id=?")
        .get(c.id);
      const definition = JSON.parse(row.definition);
      const activity = store.db
        .prepare(
          "SELECT last_interaction FROM character_activity WHERE character_id=?",
        )
        .get(c.id);
      if (activity) definition.lastInteraction = activity.last_interaction;
      const sourceDefinition = expected.characters.find(
        (v) => v.id === c.id,
      ).definition;
      delete sourceDefinition.reloadKeys;
      return {
        id: c.id,
        definition,
        chats: c.chats.map((t) => {
          const metadata = store.chatMetadata(store.requireChat(t.id));
          return {
            id: t.id,
            metadata,
            messages: store.db
              .prepare(
                "SELECT id,payload FROM messages WHERE chat_id=? ORDER BY position",
              )
              .all(t.id)
              .map((m) => ({ id: m.id, message: JSON.parse(m.payload) })),
            variables: Object.fromEntries(
              store.db
                .prepare("SELECT key,value FROM chat_variables WHERE chat_id=?")
                .all(t.id)
                .map((v) => [v.key, JSON.parse(v.value)]),
            ),
          };
        }),
      };
    });
    const expectedHash = fingerprint(expected),
      actualHash = fingerprint(actual);
    if (expectedHash !== actualHash) fail("RESTORE_ROUNDTRIP_MISMATCH");
    if (
      store.db.prepare("PRAGMA integrity_check").get().integrity_check !==
        "ok" ||
      store.db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail("DATABASE_INTEGRITY_FAILURE");
    const counts = {};
    for (const table of [
      "characters",
      "chats",
      "messages",
      "chat_variables",
      "chat_global_variables",
      "resources",
      "assets",
      "jobs",
    ])
      counts[table] = store.db
        .prepare("SELECT count(*) AS count FROM " + table)
        .get().count;
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const report = {
      restored: !options.validateOnly,
      validated: true,
      backupSha256: hash,
      databaseEntrySha256: sha(databaseBytes),
      normalizedSourceSha256: expectedHash,
      normalizedDatabaseSha256: actualHash,
      counts,
      coldPayloads: cold.size,
      coldHydrated,
      assetReferencesChecked: references,
      missingAssetReferences: missing,
      missingStructuredAssetReferences: missingStructured,
      preservedPreexistingInlineAssetReferences: missing - missingStructured,
      remapped: state.remapped,
      durationSeconds: (Date.now() - started) / 1000,
      schema: store.schemaVersion(),
      serverId,
      coldStorageDisabledForEntityRuntime: true,
      privateContentsLogged: false,
    };
    if (!options.validateOnly)
      await fs.writeFile(
        file + ".restore-report.json",
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    return report;
  } finally {
    store?.close();
    await source.close();
  }
}
module.exports = { restoreBackup, hydrate, prepare };
if (require.main === module) {
  const [
    backup,
    inventory,
    file,
    expectedSha256,
    expectedInventorySha256,
    ...modes
  ] = process.argv.slice(2);
  restoreBackup({
    backup,
    inventory,
    file,
    expectedSha256,
    expectedInventorySha256,
    validateOnly: modes.includes("--validate-only"),
    preserveMissingInlineAssets: modes.includes(
      "--preserve-missing-inline-assets",
    ),
    onProgress: (value) => console.log(JSON.stringify(value)),
  })
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          restored: false,
          code: error.code ?? "RESTORE_FAILED",
        }),
      );
      process.exitCode = 1;
    });
}
