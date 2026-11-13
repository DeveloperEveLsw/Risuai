"use strict";
const { RuntimeError } = require("./errors.cjs");
const columns = `SELECT m.*, o.message_revision AS display_message_revision,
  o.chat_epoch AS display_chat_epoch, o.character_epoch AS display_character_epoch,
  o.input_clock AS display_input_clock, o.code_hash AS display_code_hash, o.display_key
  FROM messages m LEFT JOIN display_message_origins o
  ON o.message_id=m.id AND o.message_revision=m.revision`;

// Seek through indexed positions and decode only the selected bodies. Dense
// ordinal lookup still scans index entries; gaps never become fabricated IDs.
function read(store, chatId, options, limit, { integer, id }) {
  const modes = ["before", "after", "around"].filter(
    (k) => options[k] !== undefined,
  );
  if (modes.length > 1)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Choose one message window boundary",
    );
  let rows,
    emptyPosition = 0;
  if (options.around !== undefined) {
    const anchor = store.db
      .prepare("SELECT chat_id,position FROM messages WHERE id=?")
      .get(id(options.around, "around"));
    if (!anchor || anchor.chat_id !== chatId)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Navigation message is not in this conversation",
      );
    const history = store.db
      .prepare(
        "SELECT count(*) AS count, COALESCE(sum(position < ?),0) AS ordinal FROM messages WHERE chat_id=?",
      )
      .get(anchor.position, chatId);
    const offset = Math.max(
      0,
      Math.min(history.ordinal - Math.floor(limit / 2), history.count - limit),
    );
    const start = store.db
      .prepare(
        "SELECT position FROM messages WHERE chat_id=? ORDER BY position LIMIT 1 OFFSET ?",
      )
      .get(chatId, offset).position;
    rows = store.db
      .prepare(
        columns +
          " WHERE m.chat_id=? AND m.position>=? ORDER BY m.position LIMIT ?",
      )
      .all(chatId, start, limit);
  } else if (options.after !== undefined) {
    const after = integer(options.after, "after");
    rows = store.db
      .prepare(
        columns +
          " WHERE m.chat_id=? AND m.position>? ORDER BY m.position LIMIT ?",
      )
      .all(chatId, after, limit);
    emptyPosition = after;
  } else {
    const before =
      options.before === undefined
        ? Number.MAX_SAFE_INTEGER
        : integer(options.before, "before");
    rows = store.db
      .prepare(
        columns +
          " WHERE m.chat_id=? AND m.position<? ORDER BY m.position DESC LIMIT ?",
      )
      .all(chatId, before, limit)
      .reverse();
  }
  return { rows, emptyPosition };
}
module.exports = { read };
