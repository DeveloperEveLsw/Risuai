"use strict";
const { RuntimeError } = require("./errors.cjs");

function idle(store, chatId) {
  const job = store.db
    .prepare(
      "SELECT id FROM jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1",
    )
    .get(chatId);
  if (job)
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish or cancel accepted jobs before changing saved messages",
      { jobId: job.id },
    );
}
function remove(store, command, { id, integer }) {
  const chatId = id(command.chatId, "chatId");
  const chat = store.requireChat(chatId);
  store.expectRevision(
    command.expectedChatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: chatId }),
  );
  store.expectRevision(command.expectedChatRevision, chat.revision);
  const messageId = id(command.messageId, "messageId");
  const target = store.db
    .prepare("SELECT id, chat_id, position, revision FROM messages WHERE id=?")
    .get(messageId);
  if (!target) throw new RuntimeError("NOT_FOUND", "Message does not exist");
  if (target.chat_id !== chatId)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Message belongs to another chat",
    );
  store.expectRevision(command.expectedRevision, target.revision);
  if (!["one", "from"].includes(command.mode))
    throw new RuntimeError("INVALID_COMMAND", "Unknown message removal mode");
  idle(store, chatId);
  const condition =
    command.mode === "one" ? "id=?" : "chat_id=? AND position>=?";
  const args = command.mode === "one" ? [messageId] : [chatId, target.position];
  const removed = store.db
    .prepare(`SELECT id, revision FROM messages WHERE ${condition}`)
    .all(...args);
  const tombstone = store.db.prepare(
    "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES ('message',?,?,?) ON CONFLICT(kind,scope,id) DO UPDATE SET revision=excluded.revision",
  );
  for (const row of removed)
    tombstone.run(
      chatId,
      row.id,
      integer(row.revision + 1, "deleted revision"),
    );
  store.db.prepare(`DELETE FROM messages WHERE ${condition}`).run(...args);
  const revision = store.bumpChat(chatId);
  const count = store.db
    .prepare("SELECT count(*) AS count FROM messages WHERE chat_id=?")
    .get(chatId).count;
  // One compact journal entry projects the complete removal atomically. No
  // bodies or one-entry-per-deleted-row traffic are needed for a large range.
  store.event("messages-removed", messageId, chatId, target.revision + 1, {
    mode: command.mode,
    position: target.position,
    removedCount: removed.length,
    count,
    chatRevision: revision,
    entityEpoch: command.expectedChatEpoch,
  });
  return {
    id: messageId,
    chatId,
    revision: target.revision + 1,
    chatRevision: revision,
    removedCount: removed.length,
    count,
  };
}
function setDisabled(store, command, { id, json }) {
  const chatId = id(command.chatId, "chatId"),
    messageId = id(command.messageId, "messageId");
  store.requireChat(chatId);
  store.expectRevision(
    command.expectedChatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: chatId }),
  );
  const row = store.db
    .prepare("SELECT id,chat_id,position,revision FROM messages WHERE id=?")
    .get(messageId);
  if (!row) throw new RuntimeError("NOT_FOUND", "Message does not exist");
  if (row.chat_id !== chatId)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Message belongs to another chat",
    );
  store.expectRevision(command.expectedRevision, row.revision);
  if (
    command.disabled !== false &&
    command.disabled !== true &&
    command.disabled !== "allBefore"
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Message disabled must be boolean or allBefore",
    );
  idle(store, chatId);
  store.db
    .prepare(
      "UPDATE messages SET payload=json_set(payload,'$.disabled',json(?)),revision=revision+1 WHERE id=?",
    )
    .run(json(command.disabled), messageId);
  const chatRevision = store.bumpChat(chatId);
  store.event("message-disabled", messageId, chatId, row.revision + 1, {
    id: messageId,
    disabled: command.disabled,
    entityEpoch: command.expectedChatEpoch,
    position: row.position,
    chatRevision,
  });
  return { id: messageId, revision: row.revision + 1, chatRevision };
}
module.exports = { remove, setDisabled };
