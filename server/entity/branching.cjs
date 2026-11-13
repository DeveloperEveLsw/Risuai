"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const { idle, remapMessageReferences } = require("./lifecycle.cjs");
const { readField } = require("./fields.cjs");

// Known future anchors cannot remain active in a prefix branch. Unknown strings
// and already orphaned anchors retain their original values, without guessing.
function trimReferences(metadata, omitted) {
  if (Array.isArray(metadata.bookmarks))
    metadata.bookmarks = metadata.bookmarks.filter((id) => !omitted.has(id));
  if (
    metadata.bookmarkNames &&
    typeof metadata.bookmarkNames === "object" &&
    !Array.isArray(metadata.bookmarkNames)
  )
    metadata.bookmarkNames = Object.fromEntries(
      Object.entries(metadata.bookmarkNames).filter(([id]) => !omitted.has(id)),
    );
  if (omitted.has(metadata.lastMemory)) delete metadata.lastMemory;
  const v2 = metadata.hypaV2Data;
  if (Array.isArray(v2?.mainChunks)) {
    const removed = new Set();
    v2.mainChunks = v2.mainChunks.filter((chunk) => {
      const invalid =
        omitted.has(chunk?.lastChatMemo) ||
        (Array.isArray(chunk?.chatMemos) &&
          chunk.chatMemos.some((id) => omitted.has(id)));
      if (invalid) removed.add(chunk.id);
      return !invalid;
    });
    if (removed.size) {
      if (Array.isArray(v2.chunks))
        v2.chunks = v2.chunks.filter(
          (chunk) => !removed.has(chunk?.mainChunkID),
        );
      v2.lastMainChunkID = v2.mainChunks.at(-1)?.id ?? 0;
    }
  }
  const v3 = metadata.hypaV3Data;
  if (Array.isArray(v3?.summaries))
    v3.summaries = v3.summaries.filter(
      (summary) =>
        !(
          Array.isArray(summary?.chatMemos) &&
          summary.chatMemos.some((id) => omitted.has(id))
        ),
    );
  const encoded = metadata.supaMemoryData;
  if (typeof encoded !== "string") return;
  const separator = encoded.indexOf("\n");
  if (separator < 0) return;
  const anchor = encoded.slice(0, separator);
  if (omitted.has(anchor)) {
    delete metadata.supaMemoryData;
    return;
  }
  if (!anchor.startsWith("hypa:")) return;
  let data;
  try {
    data = JSON.parse(encoded.slice(separator + 1));
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;
  const kept = data.filter((item) => !omitted.has(item?.id));
  if (kept.length !== data.length)
    metadata.supaMemoryData = anchor + "\n" + JSON.stringify(kept, null, 2);
}

function branchName(store, source) {
  const base = source.name
    .replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, "")
    .trim();
  const names = new Set(
    store.db
      .prepare("SELECT name FROM chats WHERE character_id=?")
      .all(source.character_id)
      .map((row) => row.name),
  );
  let number = 1,
    name = base + " (Branch)";
  while (names.has(name)) name = base + " (Branch " + ++number + ")";
  return name;
}

/** applyCommand already owns the single durable SQLite transaction. */
function apply(store, command, validation) {
  const { id, json } = validation;
  const source = store.requireChat(command.sourceChatId);
  store.expectRevision(command.expectedChatRevision, source.revision);
  store.expectRevision(
    command.expectedChatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: source.id }),
  );
  store.expectRevision(
    command.expectedCharacterEpoch,
    store.fieldEpoch({ scope: "character", entityId: source.character_id }),
  );
  idle(store, source.id);
  const boundary = store.db
    .prepare(
      "SELECT id,position,revision FROM messages WHERE chat_id=? AND id=?",
    )
    .get(source.id, id(command.messageId, "messageId"));
  if (!boundary)
    throw new RuntimeError(
      "NOT_FOUND",
      "The branch boundary is not a live message in this chat",
    );
  store.expectRevision(command.expectedRevision, boundary.revision);
  const chatId = id(command.chatId, "chatId");
  if (store.db.prepare("SELECT 1 FROM chats WHERE id=?").get(chatId))
    throw new RuntimeError("IDENTITY_CONFLICT", "Chat ID already exists");
  const policy = readField(store, {
    scope: "resource",
    resourceKind: "settings",
    entityId: "global",
    key: "createFolderOnBranch",
  });
  store.expectRevision(command.expectedSettingRevision, policy.revision);
  store.expectRevision(command.expectedSettingEpoch, policy.entityEpoch);
  const metadata = store.chatMetadata(source);
  let folderId = metadata.folderId;
  if (policy.value && !folderId) {
    const folder = readField(store, {
      scope: "character",
      entityId: source.character_id,
      key: "chatFolders",
    });
    store.expectRevision(command.expectedFolderRevision, folder.revision);
    if (folder.exists && folder.value !== null && !Array.isArray(folder.value))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Chat folders must be an array",
      );
    folderId = randomUUID();
    store.applyFields([
      {
        scope: "character",
        entityId: source.character_id,
        key: "chatFolders",
        expectedRevision: folder.revision,
        expectedEpoch: command.expectedCharacterEpoch,
        value: [
          { id: folderId, name: "Branches of " + source.name, folded: false },
          ...(folder.value ?? []),
        ],
      },
      {
        scope: "chat",
        entityId: source.id,
        key: "folderId",
        expectedRevision:
          store.fieldRevisions({ scope: "chat", entityId: source.id })
            .folderId ?? 0,
        expectedEpoch: command.expectedChatEpoch,
        value: folderId,
      },
    ]);
    metadata.folderId = folderId;
  }
  const identities = new Map(
    store.db
      .prepare(
        "SELECT id FROM messages WHERE chat_id=? AND position<=? ORDER BY position",
      )
      .all(source.id, boundary.position)
      .map((row) => [row.id, randomUUID()]),
  );
  const omitted = new Set(
    store.db
      .prepare("SELECT id FROM messages WHERE chat_id=? AND position>?")
      .all(source.id, boundary.position)
      .map((row) => row.id),
  );
  trimReferences(metadata, omitted);
  remapMessageReferences(metadata, identities);
  metadata.name = branchName(store, source);
  metadata.id = chatId;
  const seedRevision = store.deletedRevision("chat", "", chatId) + 1;
  const sortPosition = store.db
    .prepare(
      "SELECT COALESCE(MIN(sort_position),1)-1 AS position FROM chats WHERE character_id=?",
    )
    .get(source.character_id).position;
  const revision = seedRevision + identities.size + 1;
  store.db
    .prepare(
      "INSERT INTO chats(id,character_id,name,metadata,revision,content_revision,sort_position,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      chatId,
      source.character_id,
      metadata.name,
      json(metadata),
      revision,
      revision,
      sortPosition,
      store.now(),
    );
  const separated = store.separateLocalGlobals(chatId, metadata, true);
  store.db
    .prepare("UPDATE chats SET metadata=? WHERE id=?")
    .run(json(separated), chatId);
  store.recordFields({ scope: "chat", entityId: chatId }, {}, separated);
  const insert = store.db.prepare(
    "INSERT INTO messages(id,chat_id,position,payload,revision) VALUES (?,?,?,?,1)",
  );
  let position = 0;
  // One source body at a time. No per-body journal events or browser archive read.
  for (const row of store.db
    .prepare(
      "SELECT id,payload FROM messages WHERE chat_id=? AND position<=? ORDER BY position",
    )
    .iterate(source.id, boundary.position)) {
    const messageId = identities.get(row.id);
    insert.run(
      messageId,
      chatId,
      position++,
      json({ ...JSON.parse(row.payload), chatId: messageId }),
    );
  }
  const commentId = randomUUID();
  insert.run(
    commentId,
    chatId,
    position,
    json({
      role: "char",
      disabled: true,
      isComment: true,
      chatId: commentId,
      data:
        "{{specialcomment::branchedfrom::" +
        source.id +
        "::" +
        source.name +
        "::" +
        boundary.id +
        "::}}",
      branchOrigin: {
        characterId: source.character_id,
        chatId: source.id,
        messageId: boundary.id,
        name: source.name,
      },
    }),
  );
  const copyVariable = store.db.prepare(
    "INSERT INTO chat_variables(chat_id,key,value,revision) VALUES (?,?,?,?)",
  );
  for (const row of store.db
    .prepare("SELECT key,value FROM chat_variables WHERE chat_id=?")
    .iterate(source.id))
    copyVariable.run(
      chatId,
      row.key,
      row.value,
      store.deletedRevision("variable", chatId, row.key) + 1,
    );
  store.event("chat", chatId, chatId, revision, {
    id: chatId,
    characterId: source.character_id,
    metadata: separated,
    created: true,
    sortPosition,
    historyCount: position + 1,
    branchedFrom: { chatId: source.id, messageId: boundary.id },
  });
  return {
    id: chatId,
    revision,
    historyCount: position + 1,
    boundaryMessageId: identities.get(boundary.id),
    commentId,
    ...(folderId ? { folderId } : {}),
    referencePolicy:
      "remap copied IDs; drop known future anchors; preserve unknown/orphan strings; copy current variables; fresh display occurrence",
  };
}
module.exports = { apply };
