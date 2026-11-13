"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const MAX_NOTICE_BYTES = 64 * 1024;
const MAX_JOB_NOTICE_BYTES = 1024 * 1024;
const MAX_JOB_NOTICES = 128;

function validate(position, message) {
  if (
    !Number.isSafeInteger(position) ||
    position < 1 ||
    position > MAX_JOB_NOTICES
  )
    throw new RuntimeError(
      "NOTICE_LIMIT",
      "A job may emit at most 128 notifications",
    );
  if (
    typeof message !== "string" ||
    Buffer.byteLength(message) > MAX_NOTICE_BYTES
  )
    throw new RuntimeError(
      "NOTICE_LIMIT",
      "Notification must be text of at most 64 KiB",
    );
  return Buffer.byteLength(message);
}
function header(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    chatId: row.chat_id,
    chatEpoch: row.chat_epoch,
    position: row.position,
    revision: row.revision,
    unread: row.acknowledged_at === null,
    createdAt: row.created_at,
  };
}

// Called in its own transaction. Notifications are side effects, not canonical chat writes.
function publish(store, jobId, owner, fence, position, message) {
  const bytes = validate(position, message);
  const job = store.requireOwner(jobId, owner, fence);
  if (job.cancelRequested)
    throw new RuntimeError(
      "JOB_CANCELLED",
      "Cancelled jobs cannot emit notifications",
    );
  store.requireChat(job.chatId);
  store.expectRevision(
    job.chatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: job.chatId }),
  );
  const existing = store.db
    .prepare("SELECT * FROM job_notices WHERE job_id=? AND position=?")
    .get(jobId, position);
  if (existing) {
    if (existing.message !== message)
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Notification position was reused with different text",
      );
    return { cursor: store.cursor(), notice: header(existing) };
  }
  const totals = store.db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(message_bytes),0) AS bytes FROM job_notices WHERE job_id=?",
    )
    .get(jobId);
  if (position !== totals.count + 1)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Notifications must be published in order",
    );
  if (totals.bytes + bytes > MAX_JOB_NOTICE_BYTES)
    throw new RuntimeError("NOTICE_LIMIT", "Job notifications exceed 1 MiB");
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO job_notices(id,job_id,chat_id,chat_epoch,position,message,message_bytes,revision,created_at) VALUES (?,?,?,?,?,?,?,1,?)",
    )
    .run(
      id,
      jobId,
      job.chatId,
      job.chatEpoch,
      position,
      message,
      bytes,
      store.now(),
    );
  const notice = header(
    store.db.prepare("SELECT * FROM job_notices WHERE id=?").get(id),
  );
  store.event("notice", id, null, notice.revision, notice);
  return { cursor: store.cursor(), notice };
}
function list(store, options = {}) {
  const limit = options.limit ?? 20,
    after = options.after ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    throw new RuntimeError("INVALID_COMMAND", "Invalid notification page");
  const rows = store.db
    .prepare(
      "SELECT sequence,id,job_id,chat_id,chat_epoch,position,revision,created_at,acknowledged_at FROM job_notices WHERE acknowledged_at IS NULL AND sequence>? ORDER BY sequence LIMIT ?",
    )
    .all(after, limit + 1);
  return {
    cursor: store.cursor(),
    count: store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM job_notices WHERE acknowledged_at IS NULL",
      )
      .get().count,
    items: rows.slice(0, limit).map(header),
    next: rows.length > limit ? rows[limit - 1].sequence : null,
  };
}
function read(store, id) {
  const row =
    typeof id === "string" &&
    store.db.prepare("SELECT * FROM job_notices WHERE id=?").get(id);
  if (!row) throw new RuntimeError("NOT_FOUND", "Notification does not exist");
  return {
    cursor: store.cursor(),
    notice: { ...header(row), message: row.message },
  };
}
function acknowledge(store, command) {
  const row = store.db
    .prepare("SELECT * FROM job_notices WHERE id=?")
    .get(String(command.noticeId ?? ""));
  if (!row) throw new RuntimeError("NOT_FOUND", "Notification does not exist");
  if (command.expectedRevision !== 1)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Notification revision does not match",
    );
  if (row.acknowledged_at === null) {
    store.db
      .prepare(
        "UPDATE job_notices SET revision=revision+1,acknowledged_at=? WHERE id=?",
      )
      .run(store.now(), row.id);
    const notice = header(
      store.db.prepare("SELECT * FROM job_notices WHERE id=?").get(row.id),
    );
    store.event("notice", row.id, null, notice.revision, notice);
  }
  return {
    notice: header(
      store.db.prepare("SELECT * FROM job_notices WHERE id=?").get(row.id),
    ),
  };
}
module.exports = {
  publish,
  list,
  read,
  acknowledge,
  validate,
  MAX_JOB_NOTICES,
  MAX_JOB_NOTICE_BYTES,
};
