"use strict";
const { RuntimeError } = require("./errors.cjs");

/** Indexed, read-only sources for the original memory modal; no archive hydration. */
function read(store, chatId, options, validation) {
  validation.id(chatId, "chatId");
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Memory source options are required",
    );
  const epoch = validation.integer(options.expectedEpoch, "expectedEpoch");
  const chat = store.requireChat(chatId);
  store.expectRevision(
    epoch,
    store.fieldEpoch({ scope: "chat", entityId: chatId }),
  );
  if (!["membership", "message", "next"].includes(options.mode))
    throw new RuntimeError("INVALID_COMMAND", "Unknown memory source mode");
  const greeting = store.db
    .prepare(
      `WITH selected AS (SELECT json_extract(?, '$.fmIndex') AS idx, json_type(?, '$.fmIndex') AS kind)
    SELECT revision,
    CASE WHEN COALESCE(idx, -1) = -1
    THEN json_extract(definition, '$.firstMessage')
    WHEN (selected.kind = 'integer' OR (selected.kind = 'text' AND CAST(CAST(idx AS INTEGER) AS TEXT) = idx)) AND CAST(idx AS INTEGER) >= 0
    THEN json_extract(definition, '$.alternateGreetings[' || CAST(idx AS INTEGER) || ']')
    ELSE NULL END AS text
    FROM characters, selected WHERE id=?`,
    )
    .get(chat.metadata, chat.metadata, chat.character_id);
  const first =
    typeof greeting.text === "string" && greeting.text
      ? {
          message: { role: "char", data: greeting.text, chatId: "first" },
          index: -1,
          revision: greeting.revision,
        }
      : null;
  const output = {
    chatId,
    epoch,
    cursor: store.cursor(),
    contentRevision: chat.content_revision,
    characterRevision: greeting.revision,
  };
  if (options.mode === "membership") {
    if (!Array.isArray(options.memos) || options.memos.length > 256)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "At most 256 memory source references are allowed",
      );
    for (const memo of options.memos)
      if (memo !== null) validation.id(memo, "memo");
    const ids = [...new Set(options.memos.filter((memo) => memo !== null))];
    const found = new Set(
      ids.length
        ? store.db
            .prepare(
              `SELECT id FROM messages WHERE chat_id=? AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(chatId, ...ids)
            .map((row) => row.id)
        : [],
    );
    return {
      ...output,
      present: options.memos.map((memo) =>
        memo === null ? !!first : found.has(memo),
      ),
    };
  }
  const memo = options.memo ?? null;
  if (memo !== null) validation.id(memo, "memo");
  let row =
    memo === null
      ? null
      : store.db
          .prepare("SELECT * FROM messages WHERE chat_id=? AND id=?")
          .get(chatId, memo);
  if (options.mode === "next") {
    if (row)
      row = store.db
        .prepare(
          "SELECT * FROM messages WHERE chat_id=? AND position>? ORDER BY position LIMIT 1",
        )
        .get(chatId, row.position);
    else if (first) return { ...output, source: first };
    else
      row = store.db
        .prepare(
          "SELECT * FROM messages WHERE chat_id=? ORDER BY position LIMIT 1",
        )
        .get(chatId);
  } else if (memo === null) return { ...output, source: first };
  if (!row) return { ...output, source: null };
  const { index } = store.db
    .prepare(
      "SELECT count(*) AS 'index' FROM messages WHERE chat_id=? AND position<?",
    )
    .get(chatId, row.position);
  return {
    ...output,
    source: { message: JSON.parse(row.payload), index, revision: row.revision },
  };
}
module.exports = { read };
