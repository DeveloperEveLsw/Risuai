"use strict";
const { RuntimeError } = require("./errors.cjs");
const { randomUUID } = require("node:crypto");
const providerOutputs = require("./providerOutputs.cjs");
const {
  validateButtonPluginAdmission,
} = require("./buttonPluginAdmission.cjs");

function disposition(store, jobId) {
  const row = store.db
    .prepare(
      "SELECT action, request_id AS requestId, result_job_id AS resultJobId FROM job_result_actions WHERE source_job_id=?",
    )
    .get(jobId);
  return row ? { ...row } : null;
}

// Polling must not download a failed execution snapshot, settings or script bodies.
function status(store, jobId) {
  const row = store.db
    .prepare(
      `SELECT id, chat_id AS chatId, chat_epoch AS chatEpoch,
    type, state, fence, progress_revision AS progressRevision,
    CASE WHEN state IN ('queued','running') THEN progress ELSE '{}' END AS progress,
    json_object('code',substr(json_extract(result,'$.code'),1,80),
      'message',substr(json_extract(result,'$.message'),1,512),
      'reason',substr(json_extract(result,'$.reason'),1,512),
      'mayHaveExternalEffects',json_extract(result,'$.mayHaveExternalEffects'),
      'memoryPreviewAvailable',type='memory-summary' AND state='completed' AND json_type(result,'$.memoryPreview')='object' AND json_type(result,'$.memoryPreview.disposition') IS NULL,
      'retained',json_type(result,'$.uncommitted.writeSet')='object' OR
        COALESCE(json_array_length(progress,'$.messages'),0)>0 OR
        EXISTS(SELECT 1 FROM job_provider_outputs o WHERE o.job_id=jobs.id)) AS result
    FROM jobs WHERE id=?`,
    )
    .get(jobId);
  if (!row) return null;
  return {
    ...row,
    progress: JSON.parse(row.progress),
    result: JSON.parse(row.result),
    disposition: disposition(store, jobId),
  };
}

function requireSource(store, jobId) {
  const job = store.getJob(jobId);
  if (!job) throw new RuntimeError("NOT_FOUND", "Job does not exist");
  if (!["failed", "cancelled", "interrupted"].includes(job.state))
    throw new RuntimeError(
      "RESULT_UNAVAILABLE",
      "Only unsuccessful terminal jobs can be reviewed",
    );
  return job;
}

function failureSummary(result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const failure = {};
  for (const [key, limit] of [
    ["code", 80],
    ["message", 512],
    ["reason", 512],
  ]) {
    if (typeof result[key] === "string")
      failure[key] = result[key].slice(0, limit);
  }
  return Object.keys(failure).length ? failure : null;
}

function requireRecoverable(store, job, command) {
  if (command.chatId !== job.chatId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Result belongs to another chat",
    );
  const chat = store.requireChat(job.chatId);
  const epoch = store.fieldEpoch({ scope: "chat", entityId: job.chatId });
  store.expectRevision(command.expectedChatEpoch, epoch);
  store.expectRevision(job.chatEpoch, epoch);
  store.expectRevision(command.expectedContentRevision, chat.content_revision);
  if (
    store.db
      .prepare(
        "SELECT 1 FROM jobs WHERE chat_id=? AND state IN ('queued','running')",
      )
      .get(job.chatId)
  )
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish or cancel accepted jobs before recovering output",
    );
  const writes = job.result?.uncommitted?.writeSet;
  if (job.result?.uncommitted?.pluginStorage !== undefined)
    throw new RuntimeError(
      "RESULT_NOT_RECOVERABLE",
      "This result includes an uncommitted plugin checkpoint requiring guarded recovery",
    );
  if (job.type === "memory-summary")
    throw new RuntimeError(
      "RESULT_NOT_RECOVERABLE",
      "A failed memory calculation cannot apply partial script effects or a summary preview",
    );
  // Partial checkpoints are not a complete transaction. Old snapshots lack
  // incarnation provenance; do not weaken their guards to make a recovery fit.
  if (
    job.state !== "failed" ||
    !writes ||
    writes.expectedContentRevision === undefined ||
    !Array.isArray(writes.characterReads) ||
    [
      ...(writes.statistics ?? []),
      ...(writes.activities ?? []),
      ...(writes.characters ?? []),
      ...(writes.resources ?? []),
    ].some((entry) => entry.expectedEpoch === undefined) ||
    (writes.characters ?? []).some((entry) => !Array.isArray(entry.fields)) ||
    (writes.resources ?? []).some((entry) => !Array.isArray(entry.fields)) ||
    (writes.deleteResources?.length ?? 0)
  )
    throw new RuntimeError(
      "RESULT_NOT_RECOVERABLE",
      "This result has no complete supported transaction with incarnation guards",
    );
  if (job.result?.uncommitted?.pluginAdmission !== undefined) {
    const admission = job.result.uncommitted.pluginAdmission;
    if (admission?.kind === "browser-generation-v1")
      require("./generationPluginAdmission.cjs").validateGenerationPluginAdmission(
        store,
        job,
        admission,
      );
    else validateButtonPluginAdmission(store, job, admission);
  }
  return writes;
}

function retryCommand(store, job, target) {
  if (target.chatId !== job.chatId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Result belongs to another chat",
    );
  const chat = store.requireChat(job.chatId);
  const epoch = store.fieldEpoch({ scope: "chat", entityId: job.chatId });
  store.expectRevision(target.expectedChatEpoch, epoch);
  store.expectRevision(job.chatEpoch, epoch);
  store.expectRevision(target.expectedContentRevision, chat.content_revision);
  const source = store.getJobCommand(job.id);
  if (
    !source ||
    !["send", "continue", "reroll", "button", "memory-summary"].includes(
      source.type,
    )
  )
    throw new RuntimeError(
      "RETRY_UNAVAILABLE",
      "The original command is unsupported",
    );
  const command = {
    type: source.type,
    chatId: job.chatId,
    expectedChatEpoch: epoch,
  };
  if (source.type === "memory-summary") {
    Object.assign(command, {
      mode: source.mode,
      indices: source.indices,
      expectedMemoryRevision: source.expectedMemoryRevision,
    });
    require("./memorySummaries.cjs").admit(store, command);
  } else if (source.type === "send") {
    if (typeof source.input !== "string")
      throw new RuntimeError(
        "RETRY_UNAVAILABLE",
        "The original input is unavailable",
      );
    command.input = source.input;
    command.messageId = randomUUID();
  } else if (source.type === "button") {
    for (const key of ["data", "manualName", "triggerId"]) {
      if (source[key] == null) continue;
      if (typeof source[key] !== "string")
        throw new RuntimeError(
          "RETRY_UNAVAILABLE",
          "The original button invocation is invalid",
        );
      command[key] = source[key];
    }
  } else {
    if (
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE chat_id=? AND state IN ('queued','running')",
        )
        .get(job.chatId)
    )
      throw new RuntimeError(
        "CHAT_BUSY",
        "Finish accepted jobs before reviewing the current reply target",
      );
    const tail = store.db
      .prepare(
        "SELECT id,revision,json_extract(payload,'$.role') AS role FROM messages WHERE chat_id=? ORDER BY position DESC LIMIT 1",
      )
      .get(job.chatId);
    if (!tail || tail.role !== "char")
      throw new RuntimeError(
        "RETRY_UNAVAILABLE",
        "There is no current assistant reply to continue or regenerate",
      );
    if (
      target.retryMessageId !== tail.id ||
      target.retryMessageRevision !== tail.revision
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "The reviewed reply target has changed",
      );
    command.messageId = tail.id;
    command.expectedRevision = tail.revision;
  }
  return command;
}

function preview(store, jobId) {
  const job = requireSource(store, jobId);
  const chat = store.db
    .prepare("SELECT content_revision FROM chats WHERE id=?")
    .get(job.chatId);
  const target = {
    jobId,
    chatId: job.chatId,
    expectedChatEpoch: job.chatEpoch,
    expectedContentRevision: chat?.content_revision ?? 0,
  };
  const sourceCommand = store.getJobCommand(jobId);
  let retryTarget = null;
  if (["continue", "reroll"].includes(sourceCommand?.type)) {
    const tail = store.db
      .prepare(
        "SELECT id,revision,payload FROM messages WHERE chat_id=? ORDER BY position DESC LIMIT 1",
      )
      .get(job.chatId);
    if (tail)
      Object.assign(target, {
        retryMessageId: tail.id,
        retryMessageRevision: tail.revision,
      });
    if (tail) {
      const message = JSON.parse(tail.payload);
      retryTarget = {
        id: tail.id,
        data: typeof message.data === "string" ? message.data : "",
        saying: message.saying,
      };
    }
  }
  const action = disposition(store, jobId);
  let blocked = null;
  let canRecover = false;
  let canRetry = false;
  let retryBlocked = null;
  let retryIntent = null;
  if (!action) {
    try {
      const command = retryCommand(store, job, target);
      canRetry = true;
      const {
        chatId: _chat,
        expectedChatEpoch: _epoch,
        messageId: _message,
        ...summary
      } = command;
      retryIntent = summary;
    } catch (error) {
      retryBlocked = {
        code: error.code ?? "DATABASE_ERROR",
        message: String(error.message).slice(0, 512),
      };
    }
  }
  if (!action) {
    store.db.exec("SAVEPOINT result_preview");
    try {
      const writes = requireRecoverable(store, job, target);
      store.commitJobWriteSet(job, writes);
      store.captureReplyChoices(job, job.result?.uncommitted?.result);
      canRecover = true;
    } catch (error) {
      blocked = {
        code: error.code ?? "DATABASE_ERROR",
        message: String(error.message).slice(0, 512),
      };
    } finally {
      store.db.exec("ROLLBACK TO result_preview; RELEASE result_preview;");
    }
  }
  const writes = job.result?.uncommitted?.writeSet;
  const messages = Array.isArray(writes?.messages)
    ? writes.messages
    : Array.isArray(job.progress.messages)
      ? job.progress.messages
      : [];
  return {
    target,
    state: job.state,
    // Keep the execution failure separate from the later recovery rejection.
    // Match compact status limits without exposing the stored execution result.
    failure: failureSummary(job.result),
    disposition: action,
    canRecover,
    canRetry,
    retryBlocked,
    retryIntent,
    retryTarget,
    blocked,
    complete: Boolean(
      writes && typeof writes === "object" && !Array.isArray(writes),
    ),
    providerOutputs: providerOutputs.read(store, job.id),
    messages: messages
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const message =
          entry.message && typeof entry.message === "object"
            ? entry.message
            : entry;
        return {
          id: entry.id ?? message.chatId,
          role: message.role,
          saying: message.saying,
          data: typeof message.data === "string" ? message.data : "",
        };
      }),
  };
}

function recover(store, command, requestId) {
  if (
    Object.keys(command).some(
      (key) =>
        ![
          "type",
          "jobId",
          "chatId",
          "expectedChatEpoch",
          "expectedContentRevision",
          "retryMessageId",
          "retryMessageRevision",
        ].includes(key),
    )
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Recover only a stored result, without client supplied writes",
    );
  const job = requireSource(store, command.jobId);
  // Even duplicate disposition requests must refer to the original owner.
  if (
    command.chatId !== job.chatId ||
    command.expectedChatEpoch !== job.chatEpoch
  )
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Recovery owner does not match the stored job",
    );
  const existing = disposition(store, job.id);
  if (existing)
    return { jobId: job.id, disposition: existing, alreadyApplied: true };
  const writes = requireRecoverable(store, job, command);
  store.commitJobWriteSet(job, writes);
  store.captureReplyChoices(job, job.result?.uncommitted?.result);
  store.db
    .prepare(
      "INSERT INTO job_result_actions(source_job_id,request_id,action,created_at) VALUES (?,?,'recover',?)",
    )
    .run(job.id, requestId, store.now());
  // Keep the original failed result immutable and broadcast its new disposition.
  store.jobEvent(job);
  return {
    jobId: job.id,
    disposition: disposition(store, job.id),
    alreadyApplied: false,
  };
}

function retry(store, command, requestId) {
  if (
    Object.keys(command).some(
      (key) =>
        ![
          "type",
          "jobId",
          "chatId",
          "expectedChatEpoch",
          "expectedContentRevision",
          "retryMessageId",
          "retryMessageRevision",
        ].includes(key),
    )
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Retry only the original invocation with a captured current target",
    );
  const job = requireSource(store, command.jobId);
  if (
    command.chatId !== job.chatId ||
    command.expectedChatEpoch !== job.chatEpoch
  )
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Retry owner does not match the stored job",
    );
  const existing = disposition(store, job.id);
  if (existing)
    return { jobId: job.id, disposition: existing, alreadyApplied: true };
  const nativeCommand = retryCommand(store, job, command);
  const child = store.admitJob(randomUUID(), nativeCommand);
  store.db
    .prepare(
      "INSERT INTO job_result_actions(source_job_id,request_id,action,result_job_id,created_at) VALUES (?,?,'retry',?,?)",
    )
    .run(job.id, requestId, child.id, store.now());
  store.jobEvent(job);
  return {
    jobId: job.id,
    disposition: disposition(store, job.id),
    alreadyApplied: false,
  };
}

module.exports = { status, preview, recover, retry };
