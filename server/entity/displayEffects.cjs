"use strict";
const { createHash } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const variables = require("./variables.cjs");
const MAX_BYTES = 256 * 1024;

function hash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new RuntimeError("INVALID_COMMAND", `${label} must be SHA-256 hex`);
  return value;
}

/** External input clocks survive journal pruning. Display effects never advance them. */
function noteEvent(store, type, entityId, chatId, payload, sequence) {
  if (
    store.displayEffect ||
    [
      "job",
      "job-progress",
      "notice",
      "interaction",
      "statistics",
      "character-activity",
      "display-effect",
    ].includes(type)
  )
    return;
  const field = type === "fields" ? payload.fields?.[0] : null;
  const scope = chatId
    ? "chat"
    : type === "character" || field?.scope === "character"
      ? "character"
      : "global";
  const identity = chatId ?? (scope === "character" ? entityId : "global");
  store.db
    .prepare(
      "INSERT INTO display_input_clocks(scope, id, sequence) VALUES (?, ?, ?) ON CONFLICT(scope, id) DO UPDATE SET sequence=MAX(sequence, excluded.sequence)",
    )
    .run(scope, identity, sequence);
}

function inputClock(store, chat) {
  return store.db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM display_input_clocks WHERE (scope='chat' AND id=?) OR (scope='character' AND id=?) OR (scope='global' AND id='global')",
    )
    .get(chat.id, chat.character_id).sequence;
}

function state(store, chatId, options, validation) {
  const chat = store.requireChat(chatId),
    clock = inputClock(store, chat);
  const limit = Math.min(
    validation.integer(options.limit ?? 100, "limit", 1),
    1000,
  );
  const after = options.after === undefined ? "" : hash(options.after, "after");
  const epoch = store.fieldEpoch({ scope: "chat", entityId: chat.id });
  const rows = store.db
    .prepare(
      "SELECT display_key FROM display_effects WHERE chat_id=? AND chat_epoch=? AND input_clock=? AND display_key>? ORDER BY display_key LIMIT ?",
    )
    .all(chat.id, epoch, clock, after, limit + 1);
  const more = rows.length > limit;
  return {
    cursor: store.cursor(),
    chatId: chat.id,
    characterId: chat.character_id,
    chatEpoch: epoch,
    characterEpoch: store.fieldEpoch({
      scope: "character",
      entityId: chat.character_id,
    }),
    inputClock: clock,
    applied: rows.slice(0, limit).map((row) => row.display_key),
    next: more ? rows[limit - 1].display_key : null,
  };
}

function targets(command, validation) {
  const reads = new Set(),
    writes = new Set();
  for (const read of command.reads) {
    const target = variables.target(read, validation);
    if (target.chatId && target.chatId !== command.chatId)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Display reads cannot target another chat",
      );
    const identity = variables.identity(target);
    if (reads.has(identity))
      throw new RuntimeError("INVALID_COMMAND", "Duplicate display read");
    reads.add(identity);
    validation.integer(read.expectedRevision, "read revision");
  }
  for (const edit of command.edits) {
    const target = variables.target(edit, validation);
    if (target.scope !== "chat" || target.chatId !== command.chatId)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Display writes must target ordinary variables in this chat",
      );
    const identity = variables.identity(target);
    if (writes.has(identity))
      throw new RuntimeError("INVALID_COMMAND", "Duplicate display write");
    writes.add(identity);
    validation.integer(edit.expectedRevision, "write revision");
    if (edit.remove !== undefined && typeof edit.remove !== "boolean")
      throw new RuntimeError("INVALID_COMMAND", "remove must be a boolean");
    if (edit.remove && Object.hasOwn(edit, "value"))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "A deletion cannot include a value",
      );
    if (!edit.remove) variables.scalar(edit.value);
  }
  if (command.messageEdits !== undefined) {
    if (!Array.isArray(command.messageEdits) || command.messageEdits.length > 1)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Display can rewrite only its own stable source message",
      );
    for (const edit of command.messageEdits) {
      validation.object(edit, "message edit");
      if (
        command.source.kind !== "message" ||
        edit.messageId !== command.source.messageId ||
        edit.expectedRevision !== command.source.expectedRevision ||
        Object.keys(edit).some(
          (key) => !["messageId", "expectedRevision", "text"].includes(key),
        ) ||
        typeof edit.text !== "string"
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Display message intent must match its captured source",
        );
    }
  }
}

/** One logical source occurrence per external input, shared by every device. */
function apply(store, command, validation) {
  validation.id(command.chatId, "chatId");
  for (const key of [
    "expectedChatEpoch",
    "expectedCharacterEpoch",
    "inputClock",
  ])
    validation.integer(command[key], key);
  validation.object(command.source, "source");
  if (!["message", "view"].includes(command.source.kind))
    throw new RuntimeError("INVALID_COMMAND", "Unknown display source kind");
  hash(command.source.contentHash, "contentHash");
  const sourceKeys =
    command.source.kind === "message"
      ? ["kind", "contentHash", "messageId", "expectedRevision"]
      : ["kind", "contentHash"];
  if (Object.keys(command.source).some((key) => !sourceKeys.includes(key)))
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Unknown display source identity field",
    );
  hash(command.codeHash, "codeHash");
  if (command.source.kind === "message") {
    validation.id(command.source.messageId, "messageId");
    validation.integer(command.source.expectedRevision, "message revision", 1);
  } else if (
    command.source.messageId !== undefined ||
    command.source.expectedRevision !== undefined
  ) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      "A transient view cannot claim a canonical message",
    );
  }
  if (
    !Array.isArray(command.reads) ||
    command.reads.length > 128 ||
    !Array.isArray(command.edits) ||
    command.edits.length > 128
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Display reads and writes must each contain at most 128 keys",
    );
  const candidate = { reads: command.reads, edits: command.edits };
  if (command.messageEdits?.length)
    candidate.messageEdits = command.messageEdits;
  if (Buffer.byteLength(validation.json(candidate)) > MAX_BYTES)
    throw new RuntimeError("INVALID_COMMAND", "Display effect exceeds 256 KiB");
  targets(command, validation);
  const chat = store.requireChat(command.chatId);
  store.expectRevision(
    command.expectedChatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: chat.id }),
  );
  store.expectRevision(
    command.expectedCharacterEpoch,
    store.fieldEpoch({ scope: "character", entityId: chat.character_id }),
  );
  const occurrence = {
    chatId: chat.id,
    chatEpoch: command.expectedChatEpoch,
    characterId: chat.character_id,
    characterEpoch: command.expectedCharacterEpoch,
    inputClock: command.inputClock,
    codeHash: command.codeHash,
    source: command.source,
  };
  const key = createHash("sha256")
    .update(validation.json(occurrence))
    .digest("hex");
  if (
    command.displayKey !== undefined &&
    hash(command.displayKey, "displayKey") !== key
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Display key does not match its source",
    );
  const intent = createHash("sha256")
    .update(validation.json(candidate))
    .digest("hex");
  const existing = store.db
    .prepare(
      "SELECT result, intent_hash FROM display_effects WHERE display_key=?",
    )
    .get(key);
  // A new transport ID cannot replay an already admitted logical occurrence.
  if (existing)
    return {
      ...JSON.parse(existing.result),
      deduplicated: true,
      matchesOriginalIntent: existing.intent_hash === intent,
    };
  if (command.inputClock !== inputClock(store, chat))
    throw new RuntimeError(
      "DISPLAY_INPUT_CHANGED",
      "Display inputs changed before admission",
      { currentInputClock: inputClock(store, chat) },
    );
  let message;
  if (command.source.kind === "message") {
    message = store.db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(command.source.messageId);
    if (!message || message.chat_id !== chat.id)
      throw new RuntimeError(
        "NOT_FOUND",
        "Display message does not belong to the target chat",
      );
    store.expectRevision(command.source.expectedRevision, message.revision);
    const origin = store.db
      .prepare(
        "SELECT display_key FROM display_message_origins WHERE message_id=? AND message_revision=? AND chat_epoch=? AND character_epoch=? AND input_clock=? AND code_hash=?",
      )
      .get(
        message.id,
        message.revision,
        command.expectedChatEpoch,
        command.expectedCharacterEpoch,
        command.inputClock,
        command.codeHash,
      );
    if (origin)
      return {
        displayKey: key,
        inputClock: command.inputClock,
        variables: [],
        messages: [],
        sequence: store.cursor(),
        deduplicated: true,
        matchesOriginalIntent: false,
        derivedFrom: origin.display_key,
      };
  }
  for (const read of command.reads) {
    const target = variables.target(read, validation);
    store.expectRevision(
      validation.integer(read.expectedRevision, "read revision"),
      variables.readVariable(store, target).revision,
    );
  }
  const previous = store.displayEffect,
    previousClock = store.displayInputClock;
  store.displayEffect = key;
  store.displayInputClock = command.inputClock;
  let result;
  try {
    const changes = command.edits.map((edit) =>
      variables.writeVariable(store, edit, validation),
    );
    const messages = [];
    for (const edit of command.messageEdits ?? []) {
      store.requireUnlocked(chat.id);
      const payload = JSON.parse(message.payload);
      if (payload.data === edit.text) continue;
      payload.data = edit.text;
      store.db
        .prepare(
          "UPDATE messages SET payload=?, revision=revision+1 WHERE id=?",
        )
        .run(validation.json(payload), message.id);
      const chatRevision = store.bumpChat(chat.id);
      const revision = message.revision + 1;
      store.event("message", message.id, chat.id, revision, {
        id: message.id,
        message: payload,
        position: message.position,
        chatRevision,
        displayCodeHash: command.codeHash,
        displayOrigin: {
          messageRevision: revision,
          chatEpoch: command.expectedChatEpoch,
          characterEpoch: command.expectedCharacterEpoch,
          inputClock: command.inputClock,
          codeHash: command.codeHash,
          displayKey: key,
        },
      });
      messages.push({ id: message.id, revision, chatRevision });
    }
    const sequence = store.event("display-effect", key, chat.id, null, {
      displayKey: key,
      inputClock: command.inputClock,
    });
    result = {
      displayKey: key,
      inputClock: command.inputClock,
      variables: changes,
      sequence,
      deduplicated: false,
      matchesOriginalIntent: true,
    };
    if (command.messageEdits?.length) result.messages = messages;
  } finally {
    store.displayEffect = previous;
    store.displayInputClock = previousClock;
  }
  store.db
    .prepare(
      "INSERT INTO display_effects(display_key, chat_id, chat_epoch, input_clock, intent_hash, result) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      key,
      chat.id,
      command.expectedChatEpoch,
      command.inputClock,
      intent,
      validation.json(result),
    );
  for (const message of result.messages ?? []) {
    store.db
      .prepare(
        "INSERT INTO display_message_origins(message_id,message_revision,chat_epoch,character_epoch,input_clock,code_hash,display_key) VALUES (?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET message_revision=excluded.message_revision,chat_epoch=excluded.chat_epoch,character_epoch=excluded.character_epoch,input_clock=excluded.input_clock,code_hash=excluded.code_hash,display_key=excluded.display_key",
      )
      .run(
        message.id,
        message.revision,
        command.expectedChatEpoch,
        command.expectedCharacterEpoch,
        command.inputClock,
        command.codeHash,
        key,
      );
  }
  return result;
}

module.exports = { noteEvent, inputClock, state, apply };
