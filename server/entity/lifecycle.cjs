"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");

// Terminal jobs remain addressable by request ID after their chat is removed.
// Their captured incarnation prevents old progress appearing in a recreated chat.
function migrateJobs(store) {
  if (
    store.db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .some((c) => c.name === "chat_epoch")
  )
    return;
  store.db.exec(`CREATE TABLE jobs_replacement (
    id TEXT PRIMARY KEY REFERENCES commands(id), chat_id TEXT NOT NULL,
    chat_epoch INTEGER NOT NULL DEFAULT 0 CHECK (chat_epoch >= 0),
    type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','interrupted')),
    queue_position INTEGER NOT NULL UNIQUE, owner TEXT, fence INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
    started_revision INTEGER, started_content_revision INTEGER, started_metadata_revision INTEGER,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress)), progress_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO jobs_replacement SELECT id, chat_id,
    COALESCE((SELECT revision FROM entity_tombstones WHERE kind='chat' AND scope='' AND entity_tombstones.id=jobs.chat_id),0),
    type,state,queue_position,owner,fence,lease_until,cancel_requested,
    started_revision,started_content_revision,started_metadata_revision,result,progress,progress_revision,created_at,updated_at FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_replacement RENAME TO jobs;
  CREATE UNIQUE INDEX one_running_job_per_chat ON jobs(chat_id) WHERE state='running';
  CREATE INDEX job_queue ON jobs(state,queue_position);`);
}

function idle(store, chatId) {
  const job = store.db
    .prepare(
      "SELECT id FROM jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1",
    )
    .get(chatId);
  if (job)
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish or cancel accepted jobs before this operation",
      { jobId: job.id },
    );
}

// Only upstream-defined identity references are rewritten. Summary text, script
// variables and unknown extension fields can contain arbitrary strings.
function remapMessageReferences(metadata, identities) {
  const remap = (value) => identities.get(value) ?? value;
  if (Object.hasOwn(metadata, "lastMemory"))
    metadata.lastMemory = remap(metadata.lastMemory);
  if (Array.isArray(metadata.bookmarks))
    metadata.bookmarks = metadata.bookmarks.map(remap);
  if (
    metadata.bookmarkNames &&
    typeof metadata.bookmarkNames === "object" &&
    !Array.isArray(metadata.bookmarkNames)
  )
    metadata.bookmarkNames = Object.fromEntries(
      Object.entries(metadata.bookmarkNames).map(([key, value]) => [
        remap(key),
        value,
      ]),
    );
  for (const [field, collection] of [
    ["hypaV2Data", "mainChunks"],
    ["hypaV3Data", "summaries"],
  ]) {
    const memory = metadata[field];
    if (!Array.isArray(memory?.[collection])) continue;
    for (const summary of memory[collection]) {
      if (!summary || typeof summary !== "object") continue;
      if (Array.isArray(summary.chatMemos))
        summary.chatMemos = summary.chatMemos.map(remap);
      if (Object.hasOwn(summary, "lastChatMemo"))
        summary.lastChatMemo = remap(summary.lastChatMemo);
    }
  }
  const encoded = metadata.supaMemoryData;
  if (typeof encoded !== "string") return;
  const separator = encoded.indexOf("\n");
  if (separator < 0) return;
  const header = encoded.slice(0, separator);
  if (identities.has(header)) {
    metadata.supaMemoryData = remap(header) + encoded.slice(separator);
  } else if (header.startsWith("hypa:")) {
    // Invalid legacy memory remains unchanged, retaining upstream error behavior.
    let data;
    try {
      data = JSON.parse(encoded.slice(separator + 1));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    let changed = false;
    for (const item of data) {
      if (!item || typeof item !== "object" || !identities.has(item.id))
        continue;
      item.id = remap(item.id);
      changed = true;
    }
    if (changed)
      metadata.supaMemoryData = header + "\n" + JSON.stringify(data, null, 2);
  }
}

function removeChat(store, row, characterDeleted = false) {
  const chatId = row.id;
  idle(store, chatId);
  for (const [table, kind, key] of [
    ["messages", "message", "id"],
    ["chat_variables", "variable", "key"],
    ["chat_global_variables", "chat-global-variable", "key"],
  ]) {
    for (const value of store.db
      .prepare(`SELECT ${key} AS id, revision FROM ${table} WHERE chat_id=?`)
      .all(chatId))
      store.rememberDeletion(kind, chatId, value.id, value.revision + 1);
  }
  store.recordFields(
    { scope: "chat", entityId: chatId },
    JSON.parse(row.metadata),
    {},
  );
  const revision = row.revision + 1;
  store.rememberDeletion("chat", "", chatId, revision);
  store.db.prepare("DELETE FROM chats WHERE id=?").run(chatId);
  store.event("chat", chatId, chatId, revision, {
    id: chatId,
    characterId: row.character_id,
    deleted: true,
    entityEpoch: revision,
    characterDeleted,
    navigationRevision: store.bumpChatNavigation(row.character_id),
    characterEpoch: store.fieldEpoch({
      scope: "character",
      entityId: row.character_id,
    }),
  });
  return { id: chatId, revision, deleted: true };
}

function apply(store, command, { id, object, json }) {
  if (command.type === "delete-chat") {
    const row = store.requireChat(command.chatId);
    store.expectRevision(command.expectedRevision, row.revision);
    store.expectRevision(
      command.expectedEpoch,
      store.fieldEpoch({ scope: "chat", entityId: row.id }),
    );
    if (
      store.db
        .prepare("SELECT count(*) AS count FROM chats WHERE character_id=?")
        .get(row.character_id).count <= 1
    )
      throw new RuntimeError(
        "LAST_CHAT",
        "A character must retain at least one chat",
      );
    return removeChat(store, row);
  }
  if (command.type === "delete-character") {
    const characterId = id(command.characterId, "characterId");
    const row = store.db
      .prepare("SELECT * FROM characters WHERE id=?")
      .get(characterId);
    if (!row) throw new RuntimeError("NOT_FOUND", "Character does not exist");
    store.expectRevision(command.expectedRevision, row.revision);
    store.expectRevision(
      command.expectedEpoch,
      store.fieldEpoch({ scope: "character", entityId: characterId }),
    );
    const chats = store.db
      .prepare("SELECT * FROM chats WHERE character_id=?")
      .all(characterId);
    for (const chat of chats) idle(store, chat.id);
    for (const chat of chats) removeChat(store, chat, true);
    const revision = row.revision + 1;
    store.recordFields(
      { scope: "character", entityId: characterId },
      JSON.parse(row.definition),
      {},
    );
    store.rememberDeletion("character", "", characterId, revision);
    store.db.prepare("DELETE FROM characters WHERE id=?").run(characterId);
    const characterNavigationRevision = store.bumpCharacterNavigation();
    store.event("character", characterId, null, revision, {
      id: characterId,
      deleted: true,
      entityEpoch: revision,
      characterNavigationRevision,
    });
    store.removeCharacterOrderReferences(characterId);
    return { id: characterId, revision, deleted: true };
  }
  if (command.type === "clone-chat") {
    const source = store.requireChat(command.sourceChatId);
    store.expectRevision(command.expectedRevision, source.revision);
    store.expectRevision(
      command.expectedEpoch,
      store.fieldEpoch({ scope: "chat", entityId: source.id }),
    );
    idle(store, source.id);
    const chatId = id(command.chatId, "chatId");
    const messages = store.db
      .prepare(
        "SELECT id,payload FROM messages WHERE chat_id=? ORDER BY position",
      )
      .all(source.id);
    const identities = new Map(
      messages.map((message) => [message.id, randomUUID()]),
    );
    const metadata = {
      ...JSON.parse(source.metadata),
      name: String(command.name ?? source.name),
    };
    remapMessageReferences(metadata, identities);
    if (
      Object.hasOwn(metadata, "GLGlobalVariables") &&
      metadata.GLGlobalVariables !== null
    )
      metadata.GLGlobalVariables = Object.fromEntries(
        store.db
          .prepare(
            "SELECT key,value FROM chat_global_variables WHERE chat_id=?",
          )
          .all(source.id)
          .map((v) => [v.key, JSON.parse(v.value)]),
      );
    const result = store.mutate({
      type: "create-chat",
      characterId: source.character_id,
      chatId,
      metadata,
      prepend: true,
    });
    for (const message of messages)
      store.appendMessage(
        chatId,
        identities.get(message.id),
        JSON.parse(message.payload),
      );
    for (const variable of store.db
      .prepare("SELECT key,value FROM chat_variables WHERE chat_id=?")
      .all(source.id))
      store.mutate({
        type: "set-chat-variable",
        chatId,
        key: variable.key,
        value: JSON.parse(variable.value),
      });
    return { ...result, revision: store.requireChat(chatId).revision };
  }
  throw new RuntimeError("INVALID_COMMAND", "Unsupported lifecycle command");
}
module.exports = { migrateJobs, apply, idle, remapMessageReferences };
