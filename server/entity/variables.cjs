"use strict";

const { RuntimeError } = require("./errors.cjs");

function scalar(value) {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Variables must be JSON scalar values",
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw new RuntimeError("INVALID_COMMAND", "Variable number must be finite");
  return value;
}

function target(input, { id, object }) {
  object(input, "variable target");
  if (!["chat", "chat-global", "global"].includes(input.scope))
    throw new RuntimeError("INVALID_COMMAND", "Unknown variable scope");
  const result = { scope: input.scope, key: id(input.key, "variable key") };
  if (input.scope !== "global") result.chatId = id(input.chatId, "chatId");
  else if (input.chatId !== undefined)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Global variables cannot have a chat ID",
    );
  return result;
}

function identity(value) {
  return JSON.stringify([value.scope, value.chatId ?? null, value.key]);
}

/** One key read includes deletion revisions; it never loads message history. */
function readVariable(store, value) {
  const global = value.scope === "global";
  if (!global) store.requireChat(value.chatId);
  const table =
    value.scope === "chat" ? "chat_variables" : "chat_global_variables";
  const row = global
    ? store.db
        .prepare(
          "SELECT payload AS value, revision FROM resources WHERE kind='global-variable' AND id=?",
        )
        .get(value.key)
    : store.db
        .prepare(
          `SELECT value, revision FROM ${table} WHERE chat_id=? AND key=?`,
        )
        .get(value.chatId, value.key);
  return {
    ...value,
    exists: !!row,
    ...(row ? { value: JSON.parse(row.value) } : {}),
    revision:
      row?.revision ??
      store.deletedRevision(
        global
          ? "resource"
          : value.scope === "chat"
            ? "variable"
            : "chat-global-variable",
        global ? "global-variable" : value.chatId,
        value.key,
      ),
  };
}

function writeVariable(store, edit, validation, publish = true) {
  const { json } = validation;
  const current = readVariable(store, edit);
  store.expectRevision(edit.expectedRevision, current.revision);
  const revision = current.revision + 1;
  if (edit.scope === "global") {
    if (edit.remove) {
      store.db
        .prepare("DELETE FROM resources WHERE kind='global-variable' AND id=?")
        .run(edit.key);
      store.rememberDeletion("resource", "global-variable", edit.key, revision);
    } else {
      store.db
        .prepare(
          "INSERT INTO resources(kind, id, payload, revision) VALUES ('global-variable', ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision",
        )
        .run(edit.key, json(scalar(edit.value)), revision);
    }
    if (publish)
      store.event("resource", "global-variable:" + edit.key, null, revision, {
        kind: "global-variable",
        id: edit.key,
        ...(edit.remove ? { deleted: true } : {}),
      });
  } else {
    const ordinary = edit.scope === "chat";
    const table = ordinary ? "chat_variables" : "chat_global_variables";
    const kind = ordinary ? "variable" : "chat-global-variable";
    if (edit.remove) {
      store.db
        .prepare(`DELETE FROM ${table} WHERE chat_id=? AND key=?`)
        .run(edit.chatId, edit.key);
      store.rememberDeletion(kind, edit.chatId, edit.key, revision);
    } else {
      store.db
        .prepare(
          `INSERT INTO ${table}(chat_id, key, value, revision) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value=excluded.value, revision=excluded.revision`,
        )
        .run(edit.chatId, edit.key, json(scalar(edit.value)), revision);
      if (!ordinary) {
        const metadata = JSON.parse(store.requireChat(edit.chatId).metadata);
        if (metadata.GLGlobalVariables == null) {
          metadata.GLGlobalVariables = {};
          store.db
            .prepare("UPDATE chats SET metadata=? WHERE id=?")
            .run(json(metadata), edit.chatId);
        }
      }
    }
    if (publish) {
      const chatRevision = store.bumpChat(edit.chatId, false, !ordinary);
      store.event(kind, edit.chatId + ":" + edit.key, edit.chatId, revision, {
        key: edit.key,
        ...(edit.remove ? { deleted: true } : { value: edit.value }),
        chatRevision,
      });
    }
  }
  return {
    scope: edit.scope,
    key: edit.key,
    ...(edit.chatId ? { chatId: edit.chatId } : {}),
    revision,
  };
}

/** Atomic unpin+set and multiple-key changes; no partial writes on a stale key. */
function changeVariables(store, command, requestId, validation) {
  if (
    !Array.isArray(command.edits) ||
    !command.edits.length ||
    command.edits.length > 128
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Expected 1 to 128 variable edits",
    );
  const targets = new Set(),
    chats = new Set();
  const edits = command.edits.map((input) => {
    const value = target(input, validation);
    const key = identity(value);
    if (targets.has(key))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "A variable may appear only once in a command",
      );
    targets.add(key);
    validation.integer(input.expectedRevision, "expectedRevision");
    if (input.remove !== undefined && typeof input.remove !== "boolean")
      throw new RuntimeError("INVALID_COMMAND", "remove must be a boolean");
    if (input.remove && Object.hasOwn(input, "value"))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "A deletion cannot include a value",
      );
    if (!input.remove) scalar(input.value);
    if (value.chatId) chats.add(value.chatId);
    return {
      ...value,
      expectedRevision: input.expectedRevision,
      ...(input.remove ? { remove: true } : { value: input.value }),
    };
  });
  for (const chatId of chats) {
    store.requireChat(chatId);
  }
  if (command.after !== undefined) {
    if (
      !Array.isArray(command.after) ||
      command.after.length > 128 ||
      new Set(command.after).size !== command.after.length
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid variable predecessors",
      );
    for (const previous of command.after) {
      validation.id(previous, "predecessor request ID");
      if (previous === requestId)
        throw new RuntimeError(
          "INVALID_COMMAND",
          "A command cannot depend on itself",
        );
      const row = store.db
        .prepare("SELECT payload, result FROM commands WHERE id=?")
        .get(previous);
      if (!row?.result)
        throw new RuntimeError(
          "DEPENDENCY_PENDING",
          "A preceding variable change has not committed",
          { requestId: previous },
        );
      if (JSON.parse(row.payload).type !== "change-variables")
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Variable predecessors must be variable commands",
        );
    }
  }
  return {
    variables: edits.map((edit) => writeVariable(store, edit, validation)),
  };
}

/** Preserve the upstream optional map shape while storing its keys independently. */
function separateLocalGlobals(store, chatId, input, validation, seed = false) {
  const metadata = { ...input };
  const present = Object.hasOwn(metadata, "GLGlobalVariables");
  const map = present ? metadata.GLGlobalVariables : undefined;
  if (map !== undefined && map !== null)
    validation.object(map, "GLGlobalVariables");
  const desired = new Map(Object.entries(map ?? {}));
  for (const [key, value] of desired) {
    validation.id(key, "variable key");
    scalar(value);
  }
  const existing = new Map(
    store.db
      .prepare(
        "SELECT key, value, revision FROM chat_global_variables WHERE chat_id=?",
      )
      .all(chatId)
      .map((row) => [row.key, row]),
  );
  for (const [key, row] of existing) {
    if (desired.has(key)) continue;
    writeVariable(
      store,
      {
        scope: "chat-global",
        chatId,
        key,
        remove: true,
        expectedRevision: row.revision,
      },
      validation,
      !seed,
    );
  }
  for (const [key, value] of desired) {
    if (existing.get(key)?.value === validation.json(value)) continue;
    writeVariable(
      store,
      {
        scope: "chat-global",
        chatId,
        key,
        value,
        expectedRevision:
          existing.get(key)?.revision ??
          store.deletedRevision("chat-global-variable", chatId, key),
      },
      validation,
      !seed,
    );
  }
  if (present && map !== null && map !== undefined)
    metadata.GLGlobalVariables = {};
  return metadata;
}

function chatMetadata(store, chat) {
  const metadata = JSON.parse(chat.metadata);
  if (metadata.GLGlobalVariables != null)
    metadata.GLGlobalVariables = Object.fromEntries(
      store.db
        .prepare("SELECT key, value FROM chat_global_variables WHERE chat_id=?")
        .all(chat.id)
        .map((row) => [row.key, JSON.parse(row.value)]),
    );
  return metadata;
}

module.exports = {
  identity,
  writeVariable,
  target,
  scalar,
  readVariable,
  changeVariables,
  separateLocalGlobals,
  chatMetadata,
};
