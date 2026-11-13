"use strict";
const { RuntimeError } = require("./errors.cjs");
const { validateVariableReads } = require("./variableReads.cjs");
const { validateResourceReads } = require("./resourceReads.cjs");
const {
  applyBookkeeping,
  separateSettings,
  getStatistics,
} = require("./bookkeeping.cjs");

/** Commit a job's bounded changes, inside the store's ownership-checked transaction. */
function applyJobWriteSet(store, job, writes, validation) {
  const { id, integer, object, json, RESOURCE_KINDS } = validation;
  object(writes, "writeSet");
  if (writes.chatId !== job.chatId)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Write set belongs to another chat",
    );
  const modern = writes.expectedContentRevision !== undefined;
  if (modern) {
    store.expectRevision(
      writes.expectedContentRevision,
      job.startedContentRevision,
    );
    const revision = integer(writes.expectedRevision, "snapshot revision");
    if (
      revision < job.startedRevision ||
      revision > store.requireChat(job.chatId).revision
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Execution snapshot revision is outside this job's lifetime",
      );
  } else store.expectRevision(writes.expectedRevision, job.startedRevision);
  const allowed = new Set([
    "chatId",
    "expectedRevision",
    "expectedContentRevision",
    "characterReads",
    "variableReads",
    "resourceReads",
    "metadata",
    "metadataFields",
    "metadataEpoch",
    "characters",
    "messages",
    "deleteMessages",
    "messageOrder",
    "variables",
    "deleteVariables",
    "chatGlobalVariables",
    "deleteChatGlobalVariables",
    "chatGlobalShape",
    "resources",
    "deleteResources",
    "statistics",
    "activities",
  ]);
  for (const key of Object.keys(writes))
    if (!allowed.has(key))
      throw new RuntimeError(
        "INVALID_COMMAND",
        `Unknown write-set field: ${key}`,
      );
  for (const key of allowed) {
    if (
      [
        "chatId",
        "expectedRevision",
        "expectedContentRevision",
        "metadata",
        "metadataEpoch",
        "chatGlobalShape",
      ].includes(key)
    )
      continue;
    if (writes[key] !== undefined && !Array.isArray(writes[key]))
      throw new RuntimeError("INVALID_COMMAND", `${key} must be an array`);
  }
  const chatId = job.chatId;
  validateVariableReads(store, chatId, writes.variableReads, validation);
  validateResourceReads(store, writes.resourceReads, validation);
  const observedCharacters = new Set();
  for (const read of writes.characterReads ?? []) {
    object(read, "character read dependency");
    if (Object.keys(read).some((key) => !["id", "expectedEpoch"].includes(key)))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid character read dependency",
      );
    const characterId = id(read.id, "read character ID");
    if (observedCharacters.has(characterId))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Duplicate character read dependency",
      );
    observedCharacters.add(characterId);
    if (
      !store.db.prepare("SELECT 1 FROM characters WHERE id=?").get(characterId)
    )
      throw new RuntimeError("NOT_FOUND", "Read character no longer exists");
    store.expectRevision(
      read.expectedEpoch,
      store.fieldEpoch({ scope: "character", entityId: characterId }),
    );
  }
  if (writes.metadataFields !== undefined) {
    if (
      !modern ||
      writes.metadata !== undefined ||
      !writes.metadataFields.length
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Metadata field writes require modern content guards and cannot include a whole metadata replacement",
      );
    if (writes.metadataFields.length)
      store.applyFields(
        writes.metadataFields.map((change) => ({
          ...change,
          scope: "chat",
          entityId: chatId,
          expectedEpoch: writes.metadataEpoch,
        })),
        true,
      );
  }
  if (
    !modern &&
    (writes.chatGlobalVariables !== undefined ||
      writes.deleteChatGlobalVariables !== undefined ||
      writes.chatGlobalShape !== undefined)
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Per-key local globals require the execution content revision",
    );
  if (writes.chatGlobalShape !== undefined) {
    const shape = object(writes.chatGlobalShape, "chat-global shape");
    if (!["absent", "null", "object"].includes(shape.type))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid chat-global map shape",
      );
    const expectedShapeRevision = integer(
      shape.expectedRevision,
      "chat-global shape revision",
    );
    const current = store.requireChat(chatId);
    if (expectedShapeRevision > current.chat_global_revision)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Chat-global shape revision is ahead of the stored map",
      );
    const metadata = JSON.parse(current.metadata);
    const currentType =
      metadata.GLGlobalVariables === undefined
        ? "absent"
        : metadata.GLGlobalVariables === null
          ? "null"
          : "object";
    if (shape.type !== currentType)
      store.expectRevision(expectedShapeRevision, current.chat_global_revision);
  }
  for (const change of writes.characters ?? []) {
    const characterId = id(change.id, "character ID");
    if (change.fields !== undefined) {
      if (
        !modern ||
        change.definition !== undefined ||
        !Array.isArray(change.fields) ||
        !change.fields.length
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Character field writes cannot include a whole definition replacement",
        );
      if (change.fields.length)
        store.applyFields(
          change.fields.map((field) => ({
            ...field,
            scope: "character",
            entityId: characterId,
            expectedEpoch: change.expectedEpoch,
          })),
          true,
        );
      continue;
    }
    const row = store.db
      .prepare("SELECT * FROM characters WHERE id=?")
      .get(characterId);
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Changed character does not exist");
    const definition = object(change.definition, "character definition");
    if (
      ["chats", "chatPage", "lastInteraction", "reloadKeys"].some(
        (key) => key in definition,
      )
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Character definitions cannot include chats, navigation or derived activity",
      );
    if (definition.chaId !== undefined && definition.chaId !== characterId)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "Character identity cannot change",
      );
    const kind = definition.type === "group" ? "group" : "character";
    const serialized = json({ ...definition, chaId: characterId });
    try {
      store.expectRevision(change.expectedRevision, row.revision);
    } catch (error) {
      // Concurrent upstream normalization may have persisted exactly the same value.
      // Reusing it performs no write; a different value still retains a real conflict.
      if (
        error.code !== "REVISION_CONFLICT" ||
        change.expectedRevision > row.revision ||
        serialized !== row.definition
      )
        throw error;
    }
    if (serialized === row.definition) continue;
    store.recordFields(
      { scope: "character", entityId: characterId },
      JSON.parse(row.definition),
      { ...definition, chaId: characterId },
    );
    const revision = row.revision + 1;
    store.db
      .prepare(
        "UPDATE characters SET definition=?, name=?, kind=?, trash_time=?, revision=?, updated_at=? WHERE id=?",
      )
      .run(
        serialized,
        String(definition.name ?? ""),
        kind,
        Number.isSafeInteger(definition.trashTime)
          ? definition.trashTime
          : null,
        revision,
        store.now(),
        characterId,
      );
    if (
      !!row.trash_time !==
      (Number.isSafeInteger(definition.trashTime) && definition.trashTime !== 0)
    )
      store.bumpCharacterNavigation();
    store.event("character", characterId, null, revision, {
      id: characterId,
      name: definition.name ?? "",
      kind,
    });
  }
  if (writes.metadata !== undefined) {
    const metadata = object(writes.metadata, "chat metadata");
    if (
      [
        "message",
        "scriptstate",
        "isStreaming",
        "activeStreamingDisplayOptimizationMode",
      ].some((key) => key in metadata)
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Chat metadata includes transient or separately stored data",
      );
    if (metadata.id !== undefined && metadata.id !== chatId)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "Chat identity cannot change",
      );
    let separated;
    if (modern) {
      if (Object.hasOwn(metadata, "GLGlobalVariables"))
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Local globals must use their own write-set fields",
        );
      separated = { ...metadata };
      const old = JSON.parse(store.requireChat(chatId).metadata);
      if (Object.hasOwn(old, "GLGlobalVariables"))
        separated.GLGlobalVariables = old.GLGlobalVariables;
    } else separated = store.separateLocalGlobals(chatId, metadata);
    store.recordFields(
      { scope: "chat", entityId: chatId },
      JSON.parse(store.requireChat(chatId).metadata),
      { ...separated, id: chatId },
    );
    store.db
      .prepare("UPDATE chats SET metadata=?, name=?, updated_at=? WHERE id=?")
      .run(
        json({ ...separated, id: chatId }),
        String(metadata.name ?? ""),
        store.now(),
        chatId,
      );
    const revision = store.bumpChat(chatId);
    store.event("chat", chatId, chatId, revision, {
      id: chatId,
      characterId: store.requireChat(chatId).character_id,
      metadata: store.chatMetadata(store.requireChat(chatId)),
    });
  }
  for (const change of writes.deleteMessages ?? []) {
    const messageId = id(change.id, "message ID");
    const row = store.db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(messageId);
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Deleted message does not exist");
    if (row.chat_id !== chatId)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Job cannot delete another chat's message",
      );
    store.expectRevision(change.expectedRevision, row.revision);
    store.db.prepare("DELETE FROM messages WHERE id=?").run(messageId);
    const revision = row.revision + 1,
      chatRevision = store.bumpChat(chatId);
    store.rememberDeletion("message", chatId, messageId, revision);
    store.event("message", messageId, chatId, revision, {
      id: messageId,
      deleted: true,
      position: row.position,
      chatRevision,
    });
  }
  for (const change of writes.messages ?? []) {
    const messageId = id(change.id, "message ID");
    const message = object(change.message, "message");
    if (
      !["user", "char"].includes(message.role) ||
      typeof message.data !== "string"
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Message needs a supported role and string data",
      );
    if (message.chatId !== undefined && message.chatId !== messageId)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "Message identity cannot change",
      );
    const row = store.db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(messageId);
    if (!row) {
      store.appendMessage(chatId, messageId, message, change.expectedRevision);
      continue;
    }
    if (row.chat_id !== chatId)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Job cannot edit another chat's message",
      );
    store.expectRevision(change.expectedRevision, row.revision);
    const revision = row.revision + 1,
      payload = { ...message, chatId: messageId };
    store.db
      .prepare("UPDATE messages SET payload=?, revision=? WHERE id=?")
      .run(json(payload), revision, messageId);
    const chatRevision = store.bumpChat(chatId);
    store.event("message", messageId, chatId, revision, {
      id: messageId,
      message: payload,
      position: row.position,
      chatRevision,
    });
  }
  if (writes.messageOrder !== undefined) {
    const order = writes.messageOrder.map((value) => id(value, "message ID"));
    const current = store.db
      .prepare("SELECT id FROM messages WHERE chat_id=? ORDER BY position")
      .all(chatId)
      .map((row) => row.id);
    const ids = new Set(order);
    if (
      order.length !== current.length ||
      ids.size !== order.length ||
      current.some((value) => !ids.has(value))
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Message order must contain every current message ID exactly once",
      );
    if (order.some((value, i) => value !== current[i])) {
      // Negative positions avoid the UNIQUE(chat_id, position) constraint during permutation.
      store.db
        .prepare("UPDATE messages SET position=-position-1 WHERE chat_id=?")
        .run(chatId);
      const update = store.db.prepare(
        "UPDATE messages SET position=? WHERE id=? AND chat_id=?",
      );
      order.forEach((messageId, index) => update.run(index, messageId, chatId));
      const revision = store.bumpChat(chatId);
      store.event("message-order", chatId, chatId, revision, {
        ids: order,
        chatRevision: revision,
      });
    }
  }
  for (const change of writes.deleteVariables ?? []) {
    const key = id(change.key, "variable key");
    const row = store.db
      .prepare("SELECT revision FROM chat_variables WHERE chat_id=? AND key=?")
      .get(chatId, key);
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Deleted variable does not exist");
    store.expectRevision(change.expectedRevision, row.revision);
    store.db
      .prepare("DELETE FROM chat_variables WHERE chat_id=? AND key=?")
      .run(chatId, key);
    const revision = row.revision + 1,
      chatRevision = store.bumpChat(chatId, false);
    store.rememberDeletion("variable", chatId, key, revision);
    store.event("variable", `${chatId}:${key}`, chatId, revision, {
      key,
      deleted: true,
      chatRevision,
    });
  }
  for (const change of writes.variables ?? [])
    store.setVariable(
      chatId,
      change.key,
      change.value,
      change.expectedRevision,
    );
  for (const change of writes.deleteChatGlobalVariables ?? []) {
    id(change.key, "variable key");
    store.changeChatGlobalVariable({
      chatId,
      key: change.key,
      expectedRevision: change.expectedRevision,
      remove: true,
    });
  }
  for (const change of writes.chatGlobalVariables ?? []) {
    id(change.key, "variable key");
    store.changeChatGlobalVariable({
      chatId,
      key: change.key,
      expectedRevision: change.expectedRevision,
      value: change.value,
    });
  }
  if (writes.chatGlobalShape !== undefined) {
    const metadata = JSON.parse(store.requireChat(chatId).metadata),
      type = writes.chatGlobalShape.type;
    const before = json(metadata);
    if (type === "absent") delete metadata.GLGlobalVariables;
    else metadata.GLGlobalVariables = type === "null" ? null : {};
    if (before !== json(metadata)) {
      if (
        type !== "object" &&
        store.db
          .prepare(
            "SELECT 1 FROM chat_global_variables WHERE chat_id=? LIMIT 1",
          )
          .get(chatId)
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "A removed map cannot contain live variable rows",
        );
      store.db
        .prepare("UPDATE chats SET metadata=?, updated_at=? WHERE id=?")
        .run(json(metadata), store.now(), chatId);
      const chatRevision = store.bumpChat(chatId, false, true);
      store.event(
        "chat-global-shape",
        chatId,
        chatId,
        store.requireChat(chatId).chat_global_revision,
        { shape: type, chatRevision },
      );
    }
  }
  for (const change of writes.deleteResources ?? []) {
    if (!RESOURCE_KINDS.has(change.kind))
      throw new RuntimeError("INVALID_COMMAND", "Unknown resource kind");
    const resourceId = id(change.id, "resource ID");
    const row = store.db
      .prepare("SELECT revision, payload FROM resources WHERE kind=? AND id=?")
      .get(change.kind, resourceId);
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Deleted resource does not exist");
    store.expectRevision(change.expectedRevision, row.revision);
    if (change.kind === "settings") {
      const statistics = getStatistics(store, resourceId);
      if (statistics)
        store.rememberDeletion(
          "statistics",
          "settings",
          resourceId,
          statistics.revision + 1,
        );
    }
    store.db
      .prepare("DELETE FROM resources WHERE kind=? AND id=?")
      .run(change.kind, resourceId);
    if (change.kind !== "global-variable")
      store.recordFields(
        { scope: "resource", resourceKind: change.kind, entityId: resourceId },
        JSON.parse(row.payload),
        {},
      );
    const revision = row.revision + 1;
    store.rememberDeletion("resource", change.kind, resourceId, revision);
    store.event("resource", `${change.kind}:${resourceId}`, null, revision, {
      kind: change.kind,
      id: resourceId,
      deleted: true,
    });
  }
  for (const change of writes.resources ?? []) {
    if (change.fields !== undefined) {
      if (
        !modern ||
        change.payload !== undefined ||
        !Array.isArray(change.fields) ||
        !change.fields.length
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Resource field writes cannot include a whole payload replacement",
        );
      if (change.fields.length)
        store.applyFields(
          change.fields.map((field) => ({
            ...field,
            scope: "resource",
            resourceKind: change.kind,
            entityId: change.id,
            expectedEpoch: change.expectedEpoch,
          })),
          true,
        );
      continue;
    }
    const payload =
      change.kind === "settings"
        ? separateSettings(change.payload).payload
        : change.payload;
    const row = store.db
      .prepare("SELECT payload, revision FROM resources WHERE kind=? AND id=?")
      .get(change.kind, change.id);
    if (row && row.payload === json(payload)) {
      try {
        store.expectRevision(change.expectedRevision, row.revision);
      } catch (error) {
        if (
          error.code !== "REVISION_CONFLICT" ||
          change.expectedRevision > row.revision
        )
          throw error;
      }
      continue;
    }
    store.mutate({
      type: "put-resource",
      kind: change.kind,
      resourceId: change.id,
      expectedRevision: change.expectedRevision,
      payload: change.payload,
    });
  }
  applyBookkeeping(store, writes, id);
}
module.exports = { applyJobWriteSet };
