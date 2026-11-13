"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const replyBatches = require("./replyBatches.cjs");

function identity(chatId, epoch, messageId, generationId) {
  return createHash("sha256")
    .update(JSON.stringify([chatId, epoch, messageId, generationId]))
    .digest("hex");
}
function owner(store, chatId, messageId, expectedRevision, expectedChatEpoch) {
  store.requireChat(chatId);
  const epoch = store.fieldEpoch({ scope: "chat", entityId: chatId });
  store.expectRevision(expectedChatEpoch, epoch);
  const row = store.db
    .prepare(
      `SELECT id,revision,json_extract(payload,'$.role') AS role,
        CASE WHEN json_type(payload,'$.generationInfo.generationId')='text'
        THEN json_extract(payload,'$.generationInfo.generationId') END AS generationId
        FROM messages WHERE chat_id=? ORDER BY position DESC LIMIT 1`,
    )
    .get(chatId);
  if (!row || row.id !== messageId)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "The current reply target has changed",
    );
  store.expectRevision(expectedRevision, row.revision);
  if (row.role !== "char")
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Reply choices require a current assistant message",
    );
  const generationId = row.generationId ?? null;
  return {
    epoch,
    row,
    generationId,
    setId: identity(chatId, epoch, messageId, generationId),
  };
}
function header(store, chatId, messageId, expectedRevision, expectedChatEpoch) {
  const value = owner(
    store,
    chatId,
    messageId,
    expectedRevision,
    expectedChatEpoch,
  );
  const set = store.db
    .prepare("SELECT * FROM reply_choice_sets WHERE id=?")
    .get(value.setId);
  const count = store.db
    .prepare("SELECT COUNT(*) AS n FROM reply_choices WHERE set_id=?")
    .get(value.setId).n;
  const busy = Boolean(
    store.db
      .prepare(
        "SELECT 1 FROM jobs WHERE chat_id=? AND state IN ('queued','running')",
      )
      .get(chatId),
  );
  const batch = replyBatches.header(store, chatId);
  return {
    target: {
      chatId,
      messageId,
      expectedRevision,
      expectedChatEpoch,
      setId: value.setId,
      expectedChoiceRevision: set?.revision ?? 0,
      expectedContentRevision: store.requireChat(chatId).content_revision,
      expectedBatchSetId: batch.setId,
      expectedBatchRevision: batch.revision,
    },
    batch,
    selectedPosition: set?.selected_position ?? 0,
    count,
    busy,
    pendingJobId: set?.pending_job_id ?? null,
  };
}

// Native ports collect the original addRerolls values. Preserve their order and
// processing stage instead of rerunning output scripts when selecting one.
function capture(store, job, result) {
  const caches = result?.rerolls;
  if (caches === undefined) return;
  if (!caches || typeof caches !== "object" || Array.isArray(caches))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid native reply-choice cache",
    );
  for (const [generationId, values] of Object.entries(caches)) {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Native reply choices must be strings",
      );
    const rows = store.db
      .prepare(
        `SELECT id FROM messages WHERE chat_id=?
          AND json_extract(payload,'$.generationInfo.generationId')=?
          AND json_type(payload,'$.generationInfo.generationId')='text'
          AND json_extract(payload,'$.role')='char'`,
      )
      .all(job.chatId, generationId);
    for (const row of rows) {
      const setId = identity(job.chatId, job.chatEpoch, row.id, generationId);
      const inserted = store.db
        .prepare(
          "INSERT OR IGNORE INTO reply_choice_sets(id,chat_id,chat_epoch,message_id,generation_id,source_job_id) VALUES (?,?,?,?,?,?)",
        )
        .run(setId, job.chatId, job.chatEpoch, row.id, generationId, job.id);
      if (!inserted.changes) continue;
      const insert = store.db.prepare(
        "INSERT INTO reply_choices(set_id,position,data) VALUES (?,?,?)",
      );
      values.forEach((value, index) => insert.run(setId, index, value));
    }
  }
}

function move(store, command, helpers) {
  if (
    Object.keys(command).some(
      (key) =>
        ![
          "type",
          "chatId",
          "messageId",
          "expectedRevision",
          "expectedChatEpoch",
          "setId",
          "expectedChoiceRevision",
          "expectedContentRevision",
          "expectedBatchSetId",
          "expectedBatchRevision",
          "direction",
        ].includes(key),
    ) ||
    !["previous", "next"].includes(command.direction)
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid captured reply-choice command",
    );
  const value = owner(
    store,
    command.chatId,
    command.messageId,
    command.expectedRevision,
    command.expectedChatEpoch,
  );
  if (command.setId !== value.setId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Reply choice owner has changed",
    );
  const observed = header(
    store,
    command.chatId,
    command.messageId,
    command.expectedRevision,
    command.expectedChatEpoch,
  );
  store.expectRevision(
    command.expectedChoiceRevision,
    observed.target.expectedChoiceRevision,
  );
  store.expectRevision(
    command.expectedContentRevision,
    observed.target.expectedContentRevision,
  );
  store.expectRevision(
    command.expectedBatchRevision,
    observed.target.expectedBatchRevision,
  );
  if (command.expectedBatchSetId !== observed.target.expectedBatchSetId)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "The saved reply history has changed",
    );
  if (observed.busy)
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish accepted jobs before selecting a reply",
    );
  const position =
    observed.selectedPosition + (command.direction === "next" ? 1 : -1);
  const choice = store.db
    .prepare("SELECT data FROM reply_choices WHERE set_id=? AND position=?")
    .get(value.setId, position);
  if (choice?.data) {
    store.mutate({
      type: "edit-message",
      chatId: command.chatId,
      messageId: command.messageId,
      expectedRevision: command.expectedRevision,
      expectedChatEpoch: command.expectedChatEpoch,
      text: choice.data,
    });
    store.db
      .prepare(
        "UPDATE reply_choice_sets SET selected_position=?,revision=revision+1,pending_job_id=NULL WHERE id=?",
      )
      .run(position, value.setId);
    store.event(
      "reply-choice",
      value.setId,
      command.chatId,
      observed.target.expectedChoiceRevision + 1,
      {
        messageId: command.messageId,
        selectedPosition: position,
        count: observed.count,
      },
    );
    return { kind: "selected", selectedPosition: position };
  }
  const set = store.db
    .prepare("SELECT source_job_id FROM reply_choice_sets WHERE id=?")
    .get(value.setId);
  // Upstream advances past the cache and decrements unless negative. Its UI
  // treats an empty string as a miss. Keep those rules after a failed reroll.
  const nextPosition =
    set?.source_job_id && position >= 0 ? position : observed.selectedPosition;
  if (nextPosition !== observed.selectedPosition) {
    store.db
      .prepare(
        "UPDATE reply_choice_sets SET selected_position=?,revision=revision+1 WHERE id=?",
      )
      .run(nextPosition, value.setId);
  }
  const batch = replyBatches.move(
    store,
    command.chatId,
    command.direction,
    helpers,
  );
  if (batch || command.direction === "previous") {
    if (nextPosition !== observed.selectedPosition)
      store.event(
        "reply-choice",
        value.setId,
        command.chatId,
        observed.target.expectedChoiceRevision + 1,
        {
          messageId: command.messageId,
          selectedPosition: nextPosition,
          count: observed.count,
        },
      );
    return batch ?? { kind: "boundary", selectedPosition: nextPosition };
  }
  // A missing next choice uses the original new-generation path. The head
  // revision guards two devices admitting it from the same observed position.
  store.db
    .prepare(
      "INSERT OR IGNORE INTO reply_choice_sets(id,chat_id,chat_epoch,message_id,generation_id) VALUES (?,?,?,?,?)",
    )
    .run(
      value.setId,
      command.chatId,
      value.epoch,
      command.messageId,
      value.generationId,
    );
  const job = store.admitJob(randomUUID(), {
    type: "reroll",
    chatId: command.chatId,
    expectedChatEpoch: command.expectedChatEpoch,
    messageId: command.messageId,
    expectedRevision: command.expectedRevision,
  });
  store.db
    .prepare(
      "UPDATE reply_choice_sets SET pending_job_id=?,selected_position=?,revision=? WHERE id=?",
    )
    .run(
      job.id,
      nextPosition,
      observed.target.expectedChoiceRevision + 1,
      value.setId,
    );
  store.event(
    "reply-choice",
    value.setId,
    command.chatId,
    observed.target.expectedChoiceRevision + 1,
    {
      messageId: command.messageId,
      pendingJobId: job.id,
      selectedPosition: nextPosition,
    },
  );
  return { kind: "generation", jobId: job.id };
}

module.exports = { header, capture, move };
