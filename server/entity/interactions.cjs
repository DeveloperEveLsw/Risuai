"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const MAX_BYTES = 64 * 1024;
const MAX_COUNT = 128;
const MAX_JOB_BYTES = 1024 * 1024;

function text(value) {
  if (typeof value !== "string")
    throw new RuntimeError(
      "INVALID_INTERACTION",
      "Interaction values must be text",
    );
  return value;
}
function descriptor(value) {
  if (!value || !["input", "select", "confirm"].includes(value.kind))
    throw new RuntimeError("INVALID_INTERACTION", "Unknown interaction kind");
  const result = { kind: value.kind, prompt: text(value.prompt) };
  if (value.kind === "input") {
    result.defaultValue = text(value.defaultValue ?? "");
    const pairs = value.datalist ?? [];
    if (!Array.isArray(pairs) || pairs.length > MAX_COUNT)
      throw new RuntimeError("INTERACTION_LIMIT", "Too many input suggestions");
    result.datalist = pairs.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2)
        throw new RuntimeError(
          "INVALID_INTERACTION",
          "Invalid input suggestion",
        );
      return pair.map(text);
    });
  }
  if (value.kind === "select") {
    if (
      !Array.isArray(value.options) ||
      !value.options.length ||
      value.options.length > MAX_COUNT
    )
      throw new RuntimeError(
        "INTERACTION_LIMIT",
        "Selection requires 1 to 128 options",
      );
    result.options = value.options.map(text);
  }
  const payload = JSON.stringify(result),
    bytes = Buffer.byteLength(payload);
  if (bytes > MAX_BYTES)
    throw new RuntimeError("INTERACTION_LIMIT", "Interaction exceeds 64 KiB");
  return { value: result, payload, bytes };
}
function header(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    chatId: row.chat_id,
    chatEpoch: row.chat_epoch,
    kind: row.kind,
    position: row.position,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    closedReason: row.closed_reason,
  };
}
function live(store, row) {
  const job = store.requireOwner(row.job_id, row.owner, row.fence);
  if (job.cancelRequested)
    throw new RuntimeError("JOB_CANCELLED", "Job cancellation was requested");
  store.requireChat(row.chat_id);
  store.expectRevision(
    row.chat_epoch,
    store.fieldEpoch({ scope: "chat", entityId: row.chat_id }),
  );
  return job;
}
function publish(store, jobId, owner, fence, position, value) {
  const data = descriptor(value);
  if (!Number.isSafeInteger(position) || position < 1 || position > MAX_COUNT)
    throw new RuntimeError(
      "INTERACTION_LIMIT",
      "A job may request at most 128 interactions",
    );
  const job = store.requireOwner(jobId, owner, fence);
  const scope = {
    job_id: job.id,
    owner,
    fence,
    chat_id: job.chatId,
    chat_epoch: job.chatEpoch,
  };
  live(store, scope);
  const existing = store.db
    .prepare("SELECT * FROM job_interactions WHERE job_id=? AND position=?")
    .get(jobId, position);
  if (existing) {
    if (
      existing.payload !== data.payload ||
      existing.owner !== owner ||
      existing.fence !== fence
    )
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Interaction position was reused",
      );
    return { cursor: store.cursor(), interaction: header(existing) };
  }
  const totals = store.db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes),0) AS bytes FROM job_interactions WHERE job_id=?",
    )
    .get(jobId);
  if (position !== totals.count + 1)
    throw new RuntimeError(
      "INVALID_INTERACTION",
      "Interactions must be requested in order",
    );
  if (totals.bytes + data.bytes > MAX_JOB_BYTES)
    throw new RuntimeError(
      "INTERACTION_LIMIT",
      "Job interactions exceed 1 MiB",
    );
  if (
    store.db
      .prepare(
        "SELECT id FROM job_interactions WHERE job_id=? AND state='pending'",
      )
      .get(jobId)
  )
    throw new RuntimeError(
      "INTERACTION_BUSY",
      "The previous interaction requires an answer",
    );
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO job_interactions(id,job_id,chat_id,chat_epoch,owner,fence,position,kind,payload,payload_bytes,state,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',1,?)",
    )
    .run(
      id,
      jobId,
      job.chatId,
      job.chatEpoch,
      owner,
      fence,
      position,
      data.value.kind,
      data.payload,
      data.bytes,
      store.now(),
    );
  const interaction = header(
    store.db.prepare("SELECT * FROM job_interactions WHERE id=?").get(id),
  );
  store.event("interaction", id, null, 1, interaction);
  return { cursor: store.cursor(), interaction };
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
    throw new RuntimeError("INVALID_COMMAND", "Invalid interaction page");
  const rows = store.db
    .prepare(
      "SELECT sequence,id,job_id,chat_id,chat_epoch,kind,position,state,revision,created_at,closed_reason FROM job_interactions WHERE state='pending' AND sequence>? ORDER BY sequence LIMIT ?",
    )
    .all(after, limit + 1);
  return {
    cursor: store.cursor(),
    count: store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM job_interactions WHERE state='pending'",
      )
      .get().count,
    items: rows.slice(0, limit).map(header),
    next: rows.length > limit ? rows[limit - 1].sequence : null,
  };
}
function row(store, id) {
  const found =
    typeof id === "string" &&
    store.db.prepare("SELECT * FROM job_interactions WHERE id=?").get(id);
  if (!found) throw new RuntimeError("NOT_FOUND", "Interaction does not exist");
  return found;
}
function read(store, id) {
  const found = row(store, id);
  return {
    cursor: store.cursor(),
    interaction: { ...header(found), descriptor: JSON.parse(found.payload) },
  };
}
function answer(store, command) {
  const found = row(store, command.interactionId);
  if (command.expectedRevision !== 1)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Interaction revision does not match",
    );
  const value = command.answer,
    data = JSON.parse(found.payload);
  const valid =
    found.kind === "confirm"
      ? typeof value === "boolean"
      : typeof value === "string" &&
        (found.kind === "input"
          ? Buffer.byteLength(value) <= MAX_BYTES
          : data.options.some((_, index) => String(index) === value));
  if (!valid)
    throw new RuntimeError(
      "INVALID_INTERACTION_ANSWER",
      "Answer does not match this interaction",
    );
  if (found.state === "answered") {
    if (found.answer !== JSON.stringify(value))
      throw new RuntimeError(
        "INTERACTION_ALREADY_ANSWERED",
        "Another device already answered this interaction",
      );
    return { interaction: header(found) };
  }
  if (found.state !== "pending")
    throw new RuntimeError(
      "INTERACTION_CLOSED",
      "The waiting execution has ended",
    );
  live(store, found);
  store.db
    .prepare(
      "UPDATE job_interactions SET state='answered', answer=?, revision=revision+1, resolved_at=? WHERE id=?",
    )
    .run(JSON.stringify(value), store.now(), found.id);
  const interaction = header(row(store, found.id));
  store.event("interaction", found.id, null, interaction.revision, interaction);
  return { interaction };
}
function poll(store, jobId, owner, fence, id) {
  const found = row(store, id);
  if (found.job_id !== jobId || found.owner !== owner || found.fence !== fence)
    throw new RuntimeError(
      "STALE_WORKER",
      "Interaction belongs to another execution",
    );
  live(store, found);
  if (found.state === "closed")
    throw new RuntimeError(
      "INTERACTION_CLOSED",
      "The waiting execution has ended",
    );
  return {
    state: found.state,
    ...(found.state === "answered" ? { answer: JSON.parse(found.answer) } : {}),
  };
}
function closeJob(store, jobId, reason) {
  const pending = store.db
    .prepare(
      "SELECT id FROM job_interactions WHERE job_id=? AND state='pending'",
    )
    .all(jobId);
  for (const item of pending) {
    store.db
      .prepare(
        "UPDATE job_interactions SET state='closed', revision=revision+1, closed_reason=?, resolved_at=? WHERE id=?",
      )
      .run(reason, store.now(), item.id);
    const value = header(row(store, item.id));
    store.event("interaction", item.id, null, value.revision, value);
  }
}
function cancel(store, command) {
  const found = row(store, command.interactionId);
  if (command.expectedRevision !== 1)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Interaction revision does not match",
    );
  if (found.state === "answered")
    throw new RuntimeError(
      "INTERACTION_ALREADY_ANSWERED",
      "Another device already answered this interaction",
    );
  if (found.state === "pending") {
    const job = live(store, found);
    store.db
      .prepare("UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?")
      .run(store.now(), job.id);
    closeJob(store, job.id, "cancelled");
    store.jobEvent(store.getJob(job.id));
  }
  return { interaction: header(row(store, found.id)) };
}
module.exports = {
  descriptor,
  publish,
  list,
  read,
  answer,
  poll,
  closeJob,
  cancel,
  MAX_BYTES,
  MAX_COUNT,
  MAX_JOB_BYTES,
};
