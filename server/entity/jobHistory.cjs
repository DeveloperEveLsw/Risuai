"use strict";
const { RuntimeError } = require("./errors.cjs");
const conditions = {
  all: "",
  memory: " AND type='memory-summary'",
  failed: " AND state IN ('failed','cancelled','interrupted')",
};
function indexes(store) {
  // Run after legacy job-table replacement. These are additive physical indexes;
  // portable data and user_version do not change.
  store.db
    .exec(`CREATE INDEX IF NOT EXISTS jobs_history ON jobs(chat_id,chat_epoch,queue_position DESC);
    CREATE INDEX IF NOT EXISTS memory_jobs_history ON jobs(chat_id,chat_epoch,queue_position DESC) WHERE type='memory-summary';
    CREATE INDEX IF NOT EXISTS failed_jobs_history ON jobs(chat_id,chat_epoch,queue_position DESC) WHERE state IN ('failed','cancelled','interrupted');`);
}
function invalid(message) {
  throw new RuntimeError("INVALID_COMMAND", message);
}
function list(store, chatId, options, validation) {
  validation.id(chatId, "chatId");
  if (!options || typeof options !== "object" || Array.isArray(options))
    invalid("Job history options are required");
  const epoch = validation.integer(options.expectedEpoch, "expectedEpoch");
  if (!store.db.prepare("SELECT id FROM chats WHERE id=?").get(chatId))
    throw new RuntimeError("NOT_FOUND", "Chat does not exist");
  store.expectRevision(
    epoch,
    store.fieldEpoch({ scope: "chat", entityId: chatId }),
  );
  const filter = options.filter ?? "all",
    limit = options.limit ?? 20;
  if (typeof filter !== "string" || !Object.hasOwn(conditions, filter))
    invalid("Unknown job history filter");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid("Job history limit must be between 1 and 100");
  const authority = store.db
    .prepare("SELECT id FROM runtime_identity WHERE singleton=1")
    .get().id;
  const where = "chat_id=? AND chat_epoch=?" + conditions[filter];
  let upper,
    anchor,
    direction = "older";
  if (options.after !== undefined) {
    if (
      typeof options.after !== "string" ||
      options.after.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(options.after)
    )
      invalid("Invalid job history cursor");
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(options.after, "base64url").toString());
    } catch {
      invalid("Invalid job history cursor");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 8 ||
      cursor[0] !== 1 ||
      !["older", "newer"].includes(cursor[6]) ||
      !Number.isSafeInteger(cursor[5]) ||
      !Number.isSafeInteger(cursor[7]) ||
      cursor[7] < 1 ||
      cursor[7] > cursor[5]
    )
      invalid("Invalid job history cursor");
    if (
      cursor[1] !== authority ||
      cursor[2] !== chatId ||
      cursor[3] !== epoch ||
      cursor[4] !== filter
    )
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "Job history cursor belongs to a different owner or filter",
      );
    [, , , , , upper, direction, anchor] = cursor;
  } else {
    upper =
      store.db
        .prepare(
          `SELECT queue_position AS position FROM jobs WHERE ${where} ORDER BY queue_position DESC LIMIT 1`,
        )
        .get(chatId, epoch)?.position ?? 0;
  }
  const relation = direction === "older" ? "<" : ">";
  const order = direction === "older" ? "DESC" : "ASC";
  // No result/progress/command bodies are selected or decoded.
  const rows = store.db
    .prepare(
      `SELECT id,chat_id AS chatId,chat_epoch AS chatEpoch,type,state,
    queue_position AS queuePosition,fence,cancel_requested AS cancelRequested,
    progress_revision AS progressRevision,result IS NOT NULL AS resultAvailable,created_at AS createdAt,updated_at AS updatedAt
    FROM jobs WHERE ${where} AND queue_position<=? ${anchor === undefined ? "" : `AND queue_position${relation}?`}
    ORDER BY queue_position ${order} LIMIT ?`,
    )
    .all(
      chatId,
      epoch,
      upper,
      ...(anchor === undefined ? [] : [anchor]),
      limit,
    );
  if (direction === "newer") rows.reverse();
  const token = (direction, anchor) =>
    Buffer.from(
      JSON.stringify([
        1,
        authority,
        chatId,
        epoch,
        filter,
        upper,
        direction,
        anchor,
      ]),
    ).toString("base64url");
  const exists = (relation, anchor) =>
    store.db
      .prepare(
        `SELECT 1 FROM jobs WHERE ${where} AND queue_position<=? AND queue_position${relation}? LIMIT 1`,
      )
      .get(chatId, epoch, upper, anchor);
  return {
    chatId,
    chatEpoch: epoch,
    filter,
    upper,
    cursor: store.cursor(),
    items: rows.map((row) => ({
      ...row,
      cancelRequested: Boolean(row.cancelRequested),
      resultAvailable: Boolean(row.resultAvailable),
    })),
    older:
      rows.length && exists("<", rows.at(-1).queuePosition)
        ? token("older", rows.at(-1).queuePosition)
        : null,
    newer:
      rows.length && exists(">", rows[0].queuePosition)
        ? token("newer", rows[0].queuePosition)
        : null,
  };
}
module.exports = { indexes, list };
