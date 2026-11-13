"use strict";
const { RuntimeError } = require("./errors.cjs");
const fieldOperations = require("./fields.cjs");

const invalid = (message) => {
  throw new RuntimeError("INVALID_COMMAND", message);
};
const target = (chatId) => ({
  scope: "chat",
  entityId: chatId,
  key: "hypaV3Data",
});
function validateSelection(command) {
  const indices = command.indices;
  if (
    !Array.isArray(indices) ||
    !indices.length ||
    indices.length > 128 ||
    indices.some(
      (index, i) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        (i > 0 && index <= indices[i - 1]),
    ) ||
    !["single", "bulk"].includes(command.mode) ||
    (command.mode === "single" ? indices.length !== 1 : indices.length < 2)
  )
    invalid("Expected a sorted, unique memory summary selection");
}
function requireMemory(store, chatId, epoch, revision) {
  store.requireChat(chatId);
  const field = fieldOperations.readField(store, target(chatId));
  store.expectRevision(epoch, field.entityEpoch);
  store.expectRevision(revision, field.revision);
  if (!field.exists || !field.value || !Array.isArray(field.value.summaries))
    invalid("Chat has no editable Hypa V3 summaries");
  return field;
}
function admit(store, command) {
  if (
    Object.keys(command).some(
      (key) =>
        ![
          "type",
          "chatId",
          "expectedChatEpoch",
          "expectedMemoryRevision",
          "mode",
          "indices",
        ].includes(key),
    )
  )
    invalid("Memory summary jobs accept only a captured selection");
  validateSelection(command);
  const field = requireMemory(
    store,
    command.chatId,
    command.expectedChatEpoch,
    command.expectedMemoryRevision,
  );
  if (command.indices.some((index) => !field.value.summaries[index]))
    invalid("Selected summary does not exist");
  const chat = store.requireChat(command.chatId);
  if (store.characterView(chat.character_id).definition.type === "group")
    invalid("Memory summary requires an explicit character context");
}
function resources(store) {
  return store.db
    .prepare(
      "SELECT kind,id,revision FROM resources WHERE kind!='global-variable' ORDER BY kind,id",
    )
    .all()
    .map((row) => ({
      ...row,
      epoch: store.fieldEpoch({
        scope: "resource",
        resourceKind: row.kind,
        entityId: row.id,
      }),
    }));
}
function requireSource(store, job, preview, configuration = false) {
  const source = preview.source;
  if (!source || typeof source !== "object")
    invalid("Summary preview lacks source guards");
  const field = requireMemory(
    store,
    job.chatId,
    source.chatEpoch,
    source.memoryRevision,
  );
  store.expectRevision(job.chatEpoch, field.entityEpoch);
  const chat = store.requireChat(job.chatId);
  store.expectRevision(source.contentRevision, chat.content_revision);
  if (source.characterId !== chat.character_id)
    invalid("Summary belongs to another character");
  store.expectRevision(
    source.characterEpoch,
    store.fieldEpoch({ scope: "character", entityId: source.characterId }),
  );
  store.expectRevision(
    source.characterRevision,
    store.characterView(source.characterId).revision,
  );
  if (configuration) {
    if (!Array.isArray(source.resources))
      invalid("Summary lacks configuration guards");
    const current = resources(store);
    const captured = [...source.resources].sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind)) ||
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
    if (captured.length !== current.length)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Summary configuration membership has changed",
      );
    for (let i = 0; i < current.length; i++) {
      const a = current[i],
        b = captured[i];
      if (a.kind !== b.kind || a.id !== b.id)
        throw new RuntimeError(
          "REVISION_CONFLICT",
          "Summary configuration membership has changed",
        );
      store.expectRevision(b.epoch, a.epoch);
      store.expectRevision(b.revision, a.revision);
    }
  }
  return field;
}
/** Fence the paid calculation before committing any regex/Lua effects. */
function prepareCompletion(store, job, result, writes) {
  const command = store.getJobCommand(job.id),
    preview = result?.memoryPreview;
  if (
    !writes ||
    !preview ||
    typeof preview.text !== "string" ||
    !preview.text.trim() ||
    preview.mode !== command.mode ||
    JSON.stringify(preview.indices) !== JSON.stringify(command.indices) ||
    preview.source?.memoryRevision !== command.expectedMemoryRevision ||
    preview.source?.chatEpoch !== command.expectedChatEpoch
  )
    invalid("Memory summary output does not match its accepted command");
  if (preview.source.contentRevision !== job.startedContentRevision)
    invalid("Memory summary source is outside the owned execution snapshot");
  const field = requireSource(store, job, preview, true);
  // Changing the source aggregate during its own calculation cannot yield a safe preview.
  if (
    writes.metadata !== undefined ||
    (writes.metadataFields ?? []).some((edit) => edit.key === "hypaV3Data")
  )
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Summary calculation modified its source memory",
    );
  const memos = [
    ...new Set(
      command.indices.flatMap(
        (index) => field.value.summaries[index]?.chatMemos ?? [],
      ),
    ),
  ];
  if (JSON.stringify(preview.chatMemos) !== JSON.stringify(memos))
    invalid("Summary memo provenance does not match its source");
  return {
    memoryPreview: {
      text: preview.text,
      mode: command.mode,
      indices: [...command.indices],
      chatMemos: memos,
      source: { ...preview.source },
    },
  };
}
function finalizeCompletion(store, job, result) {
  const source = result.memoryPreview.source;
  source.contentRevision = store.requireChat(job.chatId).content_revision;
  source.characterRevision = store.characterView(source.characterId).revision;
  // Settings mutations made by original editprocess hooks are now durable too.
  source.resources = resources(store);
  return result;
}
function requirePreview(store, jobId) {
  const job = store.getJob(jobId);
  if (!job) throw new RuntimeError("NOT_FOUND", "Job does not exist");
  if (
    job.type !== "memory-summary" ||
    job.state !== "completed" ||
    !job.result?.memoryPreview
  )
    throw new RuntimeError(
      "RESULT_UNAVAILABLE",
      "A completed memory summary preview is required",
    );
  return job;
}
function preview(store, jobId) {
  const job = requirePreview(store, jobId),
    value = job.result.memoryPreview;
  let blocked = null;
  if (!value.disposition) {
    try {
      requireSource(store, job, value);
      store.requireUnlocked(job.chatId);
    } catch (error) {
      blocked = {
        code: error.code ?? "DATABASE_ERROR",
        message: String(error.message).slice(0, 512),
      };
    }
  }
  return {
    jobId: job.id,
    chatId: job.chatId,
    expectedChatEpoch: job.chatEpoch,
    ...value,
    ...(value.disposition?.action === "apply"
      ? {
          // The immutable command receipt retains the explicit user edit. Never
          // replace the provider output or infer it from today's canonical memory.
          appliedText:
            store.db
              .prepare(
                "SELECT json_extract(payload,'$.editedText') AS text FROM commands WHERE id=?",
              )
              .get(value.disposition.requestId)?.text ?? value.text,
        }
      : {}),
    canApply: !blocked && !value.disposition,
    blocked,
  };
}
function act(store, command, requestId, validation) {
  if (
    Object.keys(command).some(
      (key) =>
        ![
          "type",
          "jobId",
          "chatId",
          "expectedChatEpoch",
          "editedText",
        ].includes(key),
    )
  )
    invalid(
      "Apply or dismiss only the stored selection and an optional edited text",
    );
  if (
    Object.hasOwn(command, "editedText") &&
    (command.type !== "apply-memory-summary" ||
      typeof command.editedText !== "string" ||
      !command.editedText.length)
  )
    invalid("Only applying a summary accepts a nonempty edited text");
  const job = requirePreview(store, command.jobId),
    value = job.result.memoryPreview;
  if (
    command.chatId !== job.chatId ||
    command.expectedChatEpoch !== job.chatEpoch
  )
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Summary owner does not match the stored job",
    );
  if (value.disposition)
    return {
      jobId: job.id,
      disposition: value.disposition,
      alreadyApplied: true,
    };
  let fields;
  const action = command.type === "apply-memory-summary" ? "apply" : "dismiss";
  if (action === "apply") {
    const field = requireSource(store, job, value);
    store.requireUnlocked(job.chatId);
    const data = field.value,
      summaries = [...data.summaries],
      first = value.indices[0];
    if (!summaries[first]) invalid("Selected summary no longer exists");
    summaries[first] = {
      ...summaries[first],
      text: command.editedText ?? value.text,
      ...(value.mode === "bulk" ? { chatMemos: value.chatMemos } : {}),
    };
    if (value.mode === "bulk")
      for (const index of value.indices.slice(1).reverse())
        summaries.splice(index, 1);
    fields = store.applyFields([
      {
        ...target(job.chatId),
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: { ...data, summaries },
      },
    ]);
  }
  value.disposition = {
    action,
    requestId,
    appliedAt: store.now(),
    ...(command.editedText === undefined
      ? {}
      : { edited: command.editedText !== value.text }),
  };
  store.db
    .prepare("UPDATE jobs SET result=?,updated_at=? WHERE id=?")
    .run(validation.json(job.result), store.now(), job.id);
  store.jobEvent(store.getJob(job.id));
  return {
    jobId: job.id,
    disposition: value.disposition,
    alreadyApplied: false,
    ...(fields ? { fields: fields.fields } : {}),
  };
}
module.exports = { admit, prepareCompletion, finalizeCompletion, preview, act };
