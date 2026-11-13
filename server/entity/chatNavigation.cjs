"use strict";
const { RuntimeError } = require("./errors.cjs");
const fields = require("./fields.cjs");

// runtime_meta already persists integer protocol counters. This namespace is
// independent of content/definition revisions and survives identity reuse.
const counterKey = (characterId) =>
  "chat-navigation:" + JSON.stringify(characterId);
function revision(store, characterId) {
  return (
    store.db
      .prepare("SELECT value FROM runtime_meta WHERE key=?")
      .get(counterKey(characterId))?.value ?? 0
  );
}
function bump(store, characterId) {
  const current = revision(store, characterId);
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Chat navigation counter is exhausted",
    );
  store.db
    .prepare(
      "INSERT INTO runtime_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(counterKey(characterId), current + 1);
  return current + 1;
}
function folderList(field, validation) {
  const value = field.exists && field.value != null ? field.value : [];
  if (!Array.isArray(value))
    throw new RuntimeError("INVALID_COMMAND", "Chat folders must be an array");
  const seen = new Set();
  for (const item of value) {
    validation.object(item, "chat folder");
    validation.id(item.id, "folder ID");
    if (seen.has(item.id))
      throw new RuntimeError("INVALID_COMMAND", "Duplicate chat folder ID");
    seen.add(item.id);
  }
  return value;
}
function permutation(value, existing, validation, label) {
  if (
    !Array.isArray(value) ||
    value.length !== existing.length ||
    new Set(value).size !== existing.length
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      label + " must include every current ID exactly once",
    );
  const allowed = new Set(existing);
  for (const item of value) {
    validation.id(item, label + " ID");
    if (!allowed.has(item))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Foreign or missing " + label + " ID",
      );
  }
  return value;
}

/** applyCommand owns the durable transaction, including every affected member. */
function apply(store, command, validation) {
  const characterId = validation.id(command.characterId, "characterId");
  const target = {
    scope: "character",
    entityId: characterId,
    key: "chatFolders",
  };
  const folder = fields.readField(store, target);
  store.expectRevision(command.expectedCharacterEpoch, folder.entityEpoch);
  store.expectRevision(command.expectedFolderRevision, folder.revision);
  const folders = folderList(folder, validation);
  const setFolders = (value) =>
    store.applyFields([
      {
        ...target,
        expectedRevision: folder.revision,
        expectedEpoch: folder.entityEpoch,
        value,
      },
    ]);

  if (command.type === "remove-chat-folder") {
    const folderId = validation.id(command.folderId, "folderId");
    if (!folders.some((item) => item.id === folderId))
      throw new RuntimeError("NOT_FOUND", "Chat folder does not exist");
    // Membership is discovered canonically at commit, rather than trusting an
    // incomplete client list or clearing a peer's already-moved membership.
    const members = store.db
      .prepare(
        "SELECT id FROM chats WHERE character_id=? AND json_type(metadata,'$.folderId')='text' AND json_extract(metadata,'$.folderId')=?",
      )
      .all(characterId, folderId);
    setFolders(folders.filter((item) => item.id !== folderId));
    for (const member of members) {
      const value = fields.readField(store, {
        scope: "chat",
        entityId: member.id,
        key: "folderId",
      });
      store.applyFields([
        {
          scope: "chat",
          entityId: member.id,
          key: "folderId",
          expectedRevision: value.revision,
          expectedEpoch: value.entityEpoch,
          value: null,
        },
      ]);
    }
    return { characterId, folderId, clearedMembers: members.length };
  }
  if (command.type !== "reorder-chat-navigation")
    throw new RuntimeError("INVALID_COMMAND", "Unknown chat navigation action");
  validation.integer(
    command.expectedNavigationRevision,
    "chat navigation revision",
  );
  store.expectRevision(
    command.expectedNavigationRevision,
    revision(store, characterId),
  );
  const rows = store.db
    .prepare(
      "SELECT id,sort_position AS position,COALESCE((SELECT revision FROM entity_tombstones t WHERE t.kind='chat' AND t.scope='' AND t.id=chats.id),0) AS epoch FROM chats WHERE character_id=? ORDER BY sort_position,rowid",
    )
    .all(characterId);
  const order = permutation(
    command.chatIds,
    rows.map((row) => row.id),
    validation,
    "chat order",
  );
  const folderIds = permutation(
    command.folderIds,
    folders.map((item) => item.id),
    validation,
    "folder order",
  );
  const memberships = command.memberships ?? [];
  if (!Array.isArray(memberships) || memberships.length > rows.length)
    throw new RuntimeError("INVALID_COMMAND", "Invalid chat memberships");
  const live = new Set(rows.map((row) => row.id)),
    seen = new Set();
  const edits = memberships.map((input) => {
    validation.object(input, "chat membership");
    validation.id(input.chatId, "chatId");
    if (!live.has(input.chatId) || seen.has(input.chatId))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Foreign or duplicate chat membership",
      );
    seen.add(input.chatId);
    if (input.folderId !== null && !folderIds.includes(input.folderId))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Membership folder does not exist",
      );
    return {
      scope: "chat",
      entityId: input.chatId,
      key: "folderId",
      expectedRevision: input.expectedRevision,
      expectedEpoch: input.expectedEpoch,
      value: input.folderId,
    };
  });
  // Individual guarded writes remain inside this outer transaction; the public
  // 128-field batch limit does not cap server-owned semantic bulk operations.
  for (const edit of edits) store.applyFields([edit]);
  if (folderIds.some((folderId, index) => folderId !== folders[index].id)) {
    const byId = new Map(folders.map((item) => [item.id, item]));
    setFolders(folderIds.map((folderId) => byId.get(folderId)));
  }
  const changed = order.some(
    (chatId, index) =>
      chatId !== rows[index].id || rows[index].position !== index,
  );
  let navigationRevision = revision(store, characterId);
  if (changed) {
    const update = store.db.prepare(
      "UPDATE chats SET sort_position=? WHERE id=? AND character_id=?",
    );
    order.forEach((chatId, index) => update.run(index, chatId, characterId));
    navigationRevision = bump(store, characterId);
    const epochs = new Map(rows.map((row) => [row.id, row.epoch]));
    store.event("chat-order", characterId, null, navigationRevision, {
      characterId,
      characterEpoch: folder.entityEpoch,
      navigationRevision,
      order: order.map((chatId, position) => ({
        id: chatId,
        position,
        epoch: epochs.get(chatId),
      })),
    });
  }
  return { characterId, navigationRevision, changedMemberships: edits.length };
}
module.exports = { revision, bump, apply };
