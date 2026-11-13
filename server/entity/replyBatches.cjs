"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");

function active(store, chatId) {
  return store.db
    .prepare(
      `SELECT s.* FROM reply_batch_heads h
    JOIN reply_batch_sets s ON s.id=h.set_id WHERE h.chat_id=?`,
    )
    .get(chatId);
}
function rows(store, chatId, position) {
  return store.db
    .prepare(
      "SELECT id,revision,position,payload FROM messages WHERE chat_id=? AND position>=? ORDER BY position",
    )
    .all(chatId, position);
}
function prefix(store, chatId, position) {
  const last = store.db
    .prepare(
      "SELECT id,position FROM messages WHERE chat_id=? AND position<? ORDER BY position DESC LIMIT 1",
    )
    .get(chatId, position);
  const count = store.db
    .prepare(
      "SELECT count(*) AS n FROM messages WHERE chat_id=? AND position<?",
    )
    .get(chatId, position).n;
  return { id: last?.id ?? null, count, position: (last?.position ?? -1) + 1 };
}
function owned(store, set) {
  if (!set) return null;
  if (
    store.fieldEpoch({ scope: "chat", entityId: set.chat_id }) !==
    set.chat_epoch
  )
    return null;
  let position = 0;
  if (set.prefix_message_id !== null) {
    const last = store.db
      .prepare("SELECT position FROM messages WHERE chat_id=? AND id=?")
      .get(set.chat_id, set.prefix_message_id);
    if (!last) return null;
    position = last.position + 1;
  }
  const currentPrefix = prefix(store, set.chat_id, position);
  if (
    currentPrefix.id !== set.prefix_message_id ||
    currentPrefix.count !== set.prefix_count
  )
    return null;
  const expected = store.db
    .prepare(
      "SELECT message_id FROM reply_batch_messages WHERE set_id=? AND batch_position=? ORDER BY position",
    )
    .all(set.id, set.selected_position);
  const current = store.db
    .prepare(
      "SELECT id,revision,position FROM messages WHERE chat_id=? AND position>=? ORDER BY position",
    )
    .all(set.chat_id, position);
  if (
    !expected.length ||
    expected.length !== current.length ||
    expected.some((row, i) => row.message_id !== current[i].id)
  )
    return null;
  return { position, current };
}
function header(store, chatId) {
  const set = active(store, chatId),
    valid = owned(store, set);
  const count = set
    ? store.db
        .prepare("SELECT count(*) AS n FROM reply_batches WHERE set_id=?")
        .get(set.id).n
    : 0;
  return {
    setId: set?.id ?? null,
    revision: set?.revision ?? 0,
    selectedPosition: set?.selected_position ?? 0,
    count,
    available: Boolean(valid),
    unavailable:
      set && !valid
        ? "Saved reply history no longer matches the conversation prefix"
        : null,
  };
}
function save(store, setId, position, messages, jobId) {
  store.db
    .prepare(
      "INSERT INTO reply_batches(set_id,position,source_job_id) VALUES (?,?,?)",
    )
    .run(setId, position, jobId);
  const insert = store.db.prepare(
    "INSERT INTO reply_batch_messages(set_id,batch_position,position,message_id,payload) VALUES (?,?,?,?,?)",
  );
  messages.forEach((row, i) =>
    insert.run(setId, position, i, row.id, row.payload),
  );
}

// Called at final persistence, before message changes. Captures only the native
// replaced tail, never private unrelated histories or variable/metadata snapshots.
function before(store, job, writes) {
  if (
    !["send", "reroll"].includes(job.type) ||
    writes.expectedContentRevision === undefined
  )
    return null;
  if (job.type === "send") {
    const last = store.db
      .prepare(
        "SELECT id,position FROM messages WHERE chat_id=? ORDER BY position DESC LIMIT 1",
      )
      .get(job.chatId);
    return {
      kind: "send",
      job,
      position: (last?.position ?? -1) + 1,
      inputId: store.getJobCommand(job.id)?.messageId,
    };
  }
  // Malformed writes are rejected by the normal write-set validator below.
  if (
    writes.deleteMessages !== undefined &&
    !Array.isArray(writes.deleteMessages)
  )
    return null;
  const deleted = (writes.deleteMessages ?? []).map((row) => row?.id);
  if (!deleted.length) return { kind: "unsupported", job };
  const first = store.db
    .prepare(
      "SELECT min(position) AS position FROM messages WHERE chat_id=? AND id IN (SELECT value FROM json_each(?))",
    )
    .get(job.chatId, JSON.stringify(deleted)).position;
  if (first === null) return { kind: "unsupported", job };
  const tail = rows(store, job.chatId, first),
    ids = new Set(deleted);
  if (
    tail.length !== ids.size ||
    tail.some(
      (row) => !ids.has(row.id) || JSON.parse(row.payload).role !== "char",
    )
  )
    return { kind: "unsupported", job };
  const base = prefix(store, job.chatId, first),
    set = active(store, job.chatId),
    current = owned(store, set);
  const reusable =
    current &&
    current.position === base.position &&
    set.prefix_count === base.count &&
    set.prefix_message_id === base.id;
  return {
    kind: "reroll",
    job,
    position: base.position,
    base,
    tail,
    setId: reusable ? set.id : null,
  };
}
function after(store, plan) {
  if (!plan) return;
  const { job } = plan;
  if (plan.kind === "unsupported") {
    store.db
      .prepare("DELETE FROM reply_batch_heads WHERE chat_id=?")
      .run(job.chatId);
    return;
  }
  let position = plan.position;
  if (plan.kind === "send" && plan.inputId) {
    const input = store.db
      .prepare(
        "SELECT position,json_extract(payload,'$.role') AS role FROM messages WHERE chat_id=? AND id=?",
      )
      .get(job.chatId, plan.inputId);
    if (input?.role === "user")
      position = Math.max(position, input.position + 1);
  }
  const tail = rows(store, job.chatId, position),
    base = prefix(store, job.chatId, position);
  if (
    !tail.length ||
    tail.some((row) => JSON.parse(row.payload).role !== "char") ||
    (plan.kind === "reroll" &&
      (base.id !== plan.base.id || base.count !== plan.base.count))
  ) {
    store.db
      .prepare("DELETE FROM reply_batch_heads WHERE chat_id=?")
      .run(job.chatId);
    return;
  }
  let setId = plan.setId;
  if (!setId) {
    setId = randomUUID();
    store.db
      .prepare(
        "INSERT INTO reply_batch_sets(id,chat_id,chat_epoch,prefix_message_id,prefix_count) VALUES (?,?,?,?,?)",
      )
      .run(setId, job.chatId, job.chatEpoch, base.id, base.count);
    if (plan.kind === "reroll") save(store, setId, 0, plan.tail, null);
  }
  const next = store.db
    .prepare("SELECT count(*) AS n FROM reply_batches WHERE set_id=?")
    .get(setId).n;
  save(store, setId, next, tail, job.id);
  store.db
    .prepare(
      "UPDATE reply_batch_sets SET selected_position=?,revision=revision+1 WHERE id=?",
    )
    .run(next, setId);
  store.db
    .prepare(
      "INSERT INTO reply_batch_heads(chat_id,set_id) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET set_id=excluded.set_id",
    )
    .run(job.chatId, setId);
  const set = active(store, job.chatId);
  store.event("reply-batch-history", setId, job.chatId, set.revision, {
    selectedPosition: next,
    count: next + 1,
  });
}

// A single event publishes the complete tail replacement. Each resurrected ID
// receives a revision above its tombstone, preventing stale replay from winning.
function move(store, chatId, direction, { json }) {
  const set = active(store, chatId);
  if (!set) return null;
  const owner = owned(store, set);
  if (!owner) {
    if (direction === "previous")
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Saved reply history no longer matches the conversation prefix",
      );
    return null;
  }
  const next = set.selected_position + (direction === "next" ? 1 : -1);
  if (
    next < 0 ||
    !store.db
      .prepare("SELECT 1 FROM reply_batches WHERE set_id=? AND position=?")
      .get(set.id, next)
  )
    return null;
  const target = store.db
    .prepare(
      "SELECT message_id AS id,payload FROM reply_batch_messages WHERE set_id=? AND batch_position=? ORDER BY position",
    )
    .all(set.id, next);
  const current = new Map(owner.current.map((row) => [row.id, row]));
  const targetIds = new Set(target.map((row) => row.id));
  for (const row of target) {
    const live = store.db
      .prepare("SELECT chat_id,position FROM messages WHERE id=?")
      .get(row.id);
    if (live && (live.chat_id !== chatId || live.position < owner.position))
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "An archived reply ID is owned by another message",
      );
    const tombstone = store.db
      .prepare(
        "SELECT scope FROM entity_tombstones WHERE kind='message' AND id=?",
      )
      .get(row.id);
    if (tombstone && tombstone.scope !== chatId)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "An archived reply cannot move between chats",
      );
  }
  const remove = store.db.prepare("DELETE FROM messages WHERE id=?");
  for (const row of owner.current) {
    if (targetIds.has(row.id)) continue;
    store.rememberDeletion("message", chatId, row.id, row.revision + 1);
    remove.run(row.id);
  }
  // Temporarily move shared tail IDs out of the unique position range.
  store.db
    .prepare(
      "UPDATE messages SET position=-position-1 WHERE chat_id=? AND position>=?",
    )
    .run(chatId, owner.position);
  const insert = store.db.prepare(
    "INSERT INTO messages(id,chat_id,position,payload,revision) VALUES (?,?,?,?,?)",
  );
  const update = store.db.prepare(
    "UPDATE messages SET position=?,payload=?,revision=? WHERE id=?",
  );
  const messages = target.map((row, i) => {
    const old = current.get(row.id);
    const revision = old
      ? old.revision + 1
      : store.deletedRevision("message", chatId, row.id) + 1;
    const message = { ...JSON.parse(row.payload), chatId: row.id },
      position = owner.position + i;
    const payload = json(message);
    if (old) update.run(position, payload, revision, row.id);
    else insert.run(row.id, chatId, position, payload, revision);
    return {
      id: row.id,
      message,
      revision,
      position,
      ordinal: set.prefix_count + i,
    };
  });
  const chatRevision = store.bumpChat(chatId);
  store.db
    .prepare(
      "UPDATE reply_batch_sets SET selected_position=?,revision=revision+1 WHERE id=?",
    )
    .run(next, set.id);
  store.event("reply-batch", set.id, chatId, set.revision + 1, {
    position: owner.position,
    messages,
    count: set.prefix_count + messages.length,
    chatRevision,
    entityEpoch: set.chat_epoch,
    selectedPosition: next,
  });
  return { kind: "batch", selectedPosition: next };
}
module.exports = { header, before, after, move };
