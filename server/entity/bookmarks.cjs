"use strict";
const { RuntimeError } = require("./errors.cjs");

// The original JSON collections remain the portable representation. This
// relation keeps member revisions (including removals) and bounded lookup order.
function members(metadata) {
  const result = new Map();
  for (const [position, value] of (Array.isArray(metadata.bookmarks)
    ? metadata.bookmarks
    : []
  ).entries()) {
    if (typeof value !== "string") continue;
    const old = result.get(value);
    if (old) {
      old.count++;
      old.positions.push(position);
    } else
      result.set(value, {
        count: 1,
        position,
        positions: [position],
        nameExists: false,
      });
  }
  const names = metadata.bookmarkNames;
  if (names && typeof names === "object" && !Array.isArray(names))
    for (const [key, value] of Object.entries(names)) {
      const entry = result.get(key) ?? {
        count: 0,
        position: -1,
        positions: [],
        nameExists: false,
      };
      entry.nameExists = true;
      entry.name = value;
      result.set(key, entry);
    }
  return result;
}
function collectionRevision(store, chatId) {
  const versions = store.fieldRevisions({ scope: "chat", entityId: chatId });
  return (versions.bookmarks ?? 0) + (versions.bookmarkNames ?? 0);
}
function record(store, chatId, before, after, json, journal = true) {
  if (
    before.bookmarks === after.bookmarks &&
    before.bookmarkNames === after.bookmarkNames
  )
    return;
  const old = members(before),
    next = members(after);
  const absent = { count: 0, position: -1, positions: [], nameExists: false };
  const statement = store.db.prepare(`INSERT INTO chat_bookmarks
    (chat_id,message_id,revision,occurrences,sort_position,name_exists,name_json)
    VALUES (?,?,1,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET
    revision=revision+1,occurrences=excluded.occurrences,
    sort_position=excluded.sort_position,name_exists=excluded.name_exists,name_json=excluded.name_json`);
  for (const messageId of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(messageId) ?? absent,
      b = next.get(messageId) ?? absent;
    if (
      a.count === b.count &&
      a.nameExists === b.nameExists &&
      (!a.nameExists || json(a.name) === json(b.name))
    ) {
      if (a.position !== b.position)
        store.db
          .prepare(
            "UPDATE chat_bookmarks SET sort_position=? WHERE chat_id=? AND message_id=?",
          )
          .run(b.position, chatId, messageId);
      continue;
    }
    statement.run(
      chatId,
      messageId,
      b.count,
      b.position,
      Number(b.nameExists),
      b.nameExists ? json(b.name) : null,
    );
    if (journal) {
      const member = header(store, chatId, messageId);
      store.event("bookmark", messageId, chatId, member.revision, {
        ...member,
        positions: b.positions,
        collectionExists: {
          bookmarks: Object.hasOwn(after, "bookmarks"),
          bookmarkNames: Object.hasOwn(after, "bookmarkNames"),
        },
        fieldRevisions: Object.fromEntries(
          Object.entries(
            store.fieldRevisions({ scope: "chat", entityId: chatId }),
          ).filter(([key]) => ["bookmarks", "bookmarkNames"].includes(key)),
        ),
      });
    }
  }
}
function migrate(store, json) {
  for (const row of store.db.prepare("SELECT id,metadata FROM chats").all())
    record(store, row.id, {}, JSON.parse(row.metadata), json, false);
}
function header(store, chatId, messageId, validateOwner = false) {
  const chat = store.requireChat(chatId);
  const row = store.db
    .prepare("SELECT * FROM chat_bookmarks WHERE chat_id=? AND message_id=?")
    .get(chatId, messageId);
  let message = store.db
    .prepare("SELECT chat_id,revision,position FROM messages WHERE id=?")
    .get(messageId);
  if (message && message.chat_id !== chatId) {
    if (validateOwner)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Message belongs to another chat",
      );
    message = undefined;
  }
  return {
    chatId,
    messageId,
    entityEpoch: store.fieldEpoch({ scope: "chat", entityId: chatId }),
    revision: row?.revision ?? 0,
    occurrences: row?.occurrences ?? 0,
    present: Boolean(row?.occurrences),
    nameExists: Boolean(row?.name_exists),
    ...(row?.name_exists ? { name: JSON.parse(row.name_json) } : {}),
    position: row?.sort_position ?? -1,
    messageRevision: message?.revision ?? null,
    chatRevision: chat.revision,
    collectionRevision: collectionRevision(store, chatId),
  };
}
function apply(store, command, { id, json }) {
  const chatId = id(command.chatId, "chatId"),
    messageId = id(command.messageId, "messageId");
  const current = header(store, chatId, messageId, true);
  store.expectRevision(command.expectedChatEpoch, current.entityEpoch);
  store.expectRevision(command.expectedRevision, current.revision);
  if (current.messageRevision === null) {
    if (command.expectedMessageRevision !== null)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Saved bookmark message was removed",
      );
  } else
    store.expectRevision(
      command.expectedMessageRevision,
      current.messageRevision,
    );
  if (!["add", "rename", "remove"].includes(command.action))
    throw new RuntimeError("INVALID_COMMAND", "Unknown bookmark action");
  if (command.action === "add" && (!current.messageRevision || current.present))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Bookmark addition needs an unbookmarked saved message",
    );
  if (command.action !== "add" && !current.present)
    throw new RuntimeError("NOT_FOUND", "Bookmark does not exist");
  if (command.action !== "remove" && typeof command.name !== "string")
    throw new RuntimeError("INVALID_COMMAND", "Bookmark name must be a string");
  const job = store.db
    .prepare(
      "SELECT id FROM jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1",
    )
    .get(chatId);
  if (job)
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish or cancel accepted jobs before changing saved bookmarks",
      { jobId: job.id },
    );
  const before = JSON.parse(store.requireChat(chatId).metadata);
  if (
    (before.bookmarks != null && !Array.isArray(before.bookmarks)) ||
    (before.bookmarkNames != null &&
      (typeof before.bookmarkNames !== "object" ||
        Array.isArray(before.bookmarkNames)))
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Bookmark collections need an array and a name object",
    );
  const after = {
    ...before,
    bookmarks: [...(before.bookmarks ?? [])],
    bookmarkNames: { ...(before.bookmarkNames ?? {}) },
  };
  if (command.action === "remove") {
    after.bookmarks.splice(after.bookmarks.indexOf(messageId), 1);
    delete after.bookmarkNames[messageId];
  } else {
    if (command.action === "add") after.bookmarks.push(messageId);
    Object.defineProperty(after.bookmarkNames, messageId, {
      value: command.name,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  if (json(before) !== json(after)) {
    store.db
      .prepare("UPDATE chats SET metadata=? WHERE id=?")
      .run(json(after), chatId);
    store.bumpChat(chatId, false);
    store.recordFields({ scope: "chat", entityId: chatId }, before, after);
  }
  return header(store, chatId, messageId);
}
function list(store, chatId, options, { integer }) {
  const chat = store.requireChat(chatId),
    limit = Math.min(integer(options.limit ?? 50, "limit", 1), 100);
  const epoch = store.fieldEpoch({ scope: "chat", entityId: chatId }),
    revision = collectionRevision(store, chatId);
  let offset = 0;
  if (options.after !== undefined) {
    let token;
    try {
      token = JSON.parse(Buffer.from(options.after, "base64url").toString());
    } catch {
      throw new RuntimeError("INVALID_COMMAND", "Invalid bookmark page token");
    }
    if (!token || typeof token !== "object" || Array.isArray(token))
      throw new RuntimeError("INVALID_COMMAND", "Invalid bookmark page token");
    offset = integer(token.offset, "bookmark offset");
    if (
      token.chatId !== chatId ||
      token.epoch !== epoch ||
      token.revision !== revision ||
      token.contentRevision !== chat.content_revision
    )
      throw new RuntimeError(
        "PAGE_CHANGED",
        "Bookmark page changed; reload its first page",
      );
  }
  const count = store.db
    .prepare(
      "SELECT count(*) AS count FROM chat_bookmarks b JOIN messages m ON m.id=b.message_id AND m.chat_id=b.chat_id WHERE b.chat_id=? AND b.occurrences>0",
    )
    .get(chatId).count;
  const rows = store.db
    .prepare(
      `SELECT b.message_id,b.revision AS bookmark_revision,b.sort_position,b.name_exists,b.name_json,
    m.revision AS message_revision,m.position,m.payload,
    o.message_revision AS display_message_revision,o.chat_epoch AS display_chat_epoch,
    o.character_epoch AS display_character_epoch,o.input_clock AS display_input_clock,o.code_hash AS display_code_hash,o.display_key,
    (SELECT count(*) FROM messages h WHERE h.chat_id=m.chat_id AND h.position<m.position) AS ordinal
    FROM chat_bookmarks b JOIN messages m ON m.id=b.message_id AND m.chat_id=b.chat_id
    LEFT JOIN display_message_origins o ON o.message_id=m.id AND o.message_revision=m.revision
    WHERE b.chat_id=? AND b.occurrences>0 ORDER BY b.sort_position,b.message_id LIMIT ? OFFSET ?`,
    )
    .all(chatId, limit + 1, offset);
  return {
    chatId,
    entityEpoch: epoch,
    cursor: store.cursor(),
    collectionRevision: revision,
    contentRevision: chat.content_revision,
    count,
    historyCount: store.db
      .prepare("SELECT count(*) AS count FROM messages WHERE chat_id=?")
      .get(chatId).count,
    items: rows.slice(0, limit).map((row) => ({
      messageId: row.message_id,
      bookmarkRevision: row.bookmark_revision,
      messageRevision: row.message_revision,
      position: row.position,
      ordinal: row.ordinal,
      nameExists: Boolean(row.name_exists),
      ...(row.name_exists ? { name: JSON.parse(row.name_json) } : {}),
      message: JSON.parse(row.payload),
      ...(row.display_key
        ? {
            displayOrigin: {
              messageRevision: row.display_message_revision,
              chatEpoch: row.display_chat_epoch,
              characterEpoch: row.display_character_epoch,
              inputClock: row.display_input_clock,
              codeHash: row.display_code_hash,
              displayKey: row.display_key,
            },
          }
        : {}),
    })),
    next:
      rows.length <= limit
        ? null
        : Buffer.from(
            JSON.stringify({
              chatId,
              epoch,
              revision,
              contentRevision: chat.content_revision,
              offset: offset + limit,
            }),
          ).toString("base64url"),
  };
}
module.exports = { record, migrate, header, apply, list };
