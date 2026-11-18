"use strict";

const { DatabaseSync } = require("node:sqlite");
const { openDatabase } = require("./openDatabase.cjs");
const { readFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const { applyJobWriteSet } = require("./writeSet.cjs");
const variableOperations = require("./variables.cjs");
const fieldOperations = require("./fields.cjs");
const lifecycle = require("./lifecycle.cjs");
const branching = require("./branching.cjs");
const library = require("./library.cjs");
const catalog = require("./catalog.cjs");
const assets = require("./assets.cjs");
const displayEffects = require("./displayEffects.cjs");
const messageOperations = require("./messages.cjs");
const bookmarkOperations = require("./bookmarks.cjs");
const groupMembers = require("./groupMembers.cjs");
const messageWindow = require("./messageWindow.cjs");
const chatNavigation = require("./chatNavigation.cjs");
const characterNavigation = require("./characterNavigation.cjs");
const jobResults = require("./jobResults.cjs");
const memorySummaries = require("./memorySummaries.cjs");
const memorySources = require("./memorySources.cjs");
const jobHistory = require("./jobHistory.cjs");
const replyChoices = require("./replyChoices.cjs");
const replyBatches = require("./replyBatches.cjs");
const notices = require("./notices.cjs");
const interactions = require("./interactions.cjs");
const providerOutputs = require("./providerOutputs.cjs");
const pluginStorage = require("./pluginStorage.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");
const {
  validateButtonPluginAdmission,
} = require("./buttonPluginAdmission.cjs");
const {
  validateGenerationPluginAdmission,
} = require("./generationPluginAdmission.cjs");
const pluginUIWrites = require("./pluginUIWrites.cjs");
const pluginCatalog = require("./pluginCatalog.cjs");
const {
  separateCharacter,
  separateSettings,
  getActivity,
  createStatistics,
  createActivity,
  migrateBookkeeping,
} = require("./bookkeeping.cjs");

const RESOURCE_KINDS = new Set([
  "module",
  "preset",
  "settings",
  "persona",
  "global-variable",
  "plugin",
]);
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const characterImageColumns = `
  CASE WHEN json_type(definition, '$.image') = 'text'
    THEN json_extract(definition, '$.image') END AS image,
  COALESCE((SELECT revision FROM entity_field_revisions
    WHERE scope='character' AND kind='' AND entity_id=characters.id AND key='image'),0) AS imageRevision`;

function id(value, label = "id") {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      `${label} must be a nonempty string of at most 256 characters`,
    );
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      `${label} must be a safe integer >= ${minimum}`,
    );
  }
  return value;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("Non-JSON object");
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  throw new Error("Non-JSON value");
}

function json(value) {
  let result;
  try {
    result = JSON.stringify(canonical(value));
  } catch {
    throw new RuntimeError("INVALID_COMMAND", "Data must be JSON serializable");
  }
  if (
    typeof result !== "string" ||
    Buffer.byteLength(result) > MAX_JSON_BYTES
  ) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      "JSON payload is absent or too large",
    );
  }
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("INVALID_COMMAND", `${label} must be an object`);
  }
  return value;
}

class EntityStore {
  constructor(file, options = {}) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.now = options.now ?? Date.now;
    this.db = openDatabase(file, 5000, DatabaseSync);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 22) {
      this.db.close();
      throw new RuntimeError(
        "SCHEMA_TOO_NEW",
        "Database belongs to a newer runtime",
      );
    }
    try {
      this.transaction(() => {
        this.db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
        this.db
          .prepare(
            "INSERT OR IGNORE INTO runtime_identity(singleton, id) VALUES (1, ?)",
          )
          .run(randomUUID());
        if (version < 3) migrateBookkeeping(this, json);
        if (version < 6) {
          for (const chat of this.db
            .prepare("SELECT id, metadata FROM chats")
            .all()) {
            const metadata = this.separateLocalGlobals(
              chat.id,
              JSON.parse(chat.metadata),
              true,
            );
            this.db
              .prepare("UPDATE chats SET metadata=? WHERE id=?")
              .run(json(metadata), chat.id);
          }
        }
        const columns = new Set(
          this.db
            .prepare("PRAGMA table_info(jobs)")
            .all()
            .map((row) => row.name),
        );
        const chatColumns = new Set(
          this.db
            .prepare("PRAGMA table_info(chats)")
            .all()
            .map((row) => row.name),
        );
        if (!chatColumns.has("content_revision")) {
          this.db.exec(
            "ALTER TABLE chats ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1; UPDATE chats SET content_revision=revision;",
          );
        }
        if (!chatColumns.has("chat_global_revision"))
          this.db.exec(
            "ALTER TABLE chats ADD COLUMN chat_global_revision INTEGER NOT NULL DEFAULT 0;",
          );
        if (!columns.has("started_content_revision")) {
          this.db.exec(
            "ALTER TABLE jobs ADD COLUMN started_content_revision INTEGER; UPDATE jobs SET started_content_revision=started_revision;",
          );
        }
        if (!columns.has("started_metadata_revision"))
          this.db.exec(
            "ALTER TABLE jobs ADD COLUMN started_metadata_revision INTEGER;",
          );
        if (version < 8) {
          fieldOperations.migrate(this, json);
          this.db
            .exec(`UPDATE jobs SET started_metadata_revision=(SELECT COALESCE(SUM(revision), 0) FROM entity_field_revisions f
            WHERE f.scope='chat' AND f.kind='' AND f.entity_id=jobs.chat_id) WHERE started_revision IS NOT NULL;`);
        }
        if (!columns.has("progress"))
          this.db.exec(
            "ALTER TABLE jobs ADD COLUMN progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress));",
          );
        if (
          !this.db
            .prepare("PRAGMA table_info(characters)")
            .all()
            .some((c) => c.name === "trash_time")
        ) {
          this.db.exec("ALTER TABLE characters ADD COLUMN trash_time INTEGER;");
          for (const c of this.db
            .prepare("SELECT id, definition FROM characters")
            .all()) {
            const value = JSON.parse(c.definition).trashTime;
            this.db
              .prepare("UPDATE characters SET trash_time=? WHERE id=?")
              .run(Number.isSafeInteger(value) ? value : null, c.id);
          }
        }
        if (!chatColumns.has("sort_position"))
          this.db.exec(
            "ALTER TABLE chats ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0;",
          );
        if (!columns.has("progress_revision"))
          this.db.exec(
            "ALTER TABLE jobs ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0;",
          );
        lifecycle.migrateJobs(this);
        jobHistory.indexes(this);
        if (version < 10) catalog.migrate(this);
        if (version < 14) bookmarkOperations.migrate(this, json);
        if (version < 15) groupMembers.migrate(this, json);
        if (version < 12)
          this.db
            .prepare(
              "INSERT OR REPLACE INTO display_input_clocks(scope, id, sequence) VALUES ('global', 'global', ?)",
            )
            .run(this.cursor());
        if (version < 21) providerOutputs.migrate(this);
        if (version < 22) pluginStorage.initialize(this);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  registerAsset(value) {
    return assets.register(this, value);
  }
  getAsset(id) {
    return assets.read(this, id);
  }
  displayState(chatId, options = {}) {
    return this.transaction(
      () => displayEffects.state(this, chatId, options, { integer }),
      true,
    );
  }

  initializeState(state) {
    return this.transaction(() => {
      if (
        this.getResource("settings", "global") ||
        this.deletedRevision("resource", "settings", "global")
      )
        return { initialized: false };
      object(state, "initial state");
      if (!Array.isArray(state.resources))
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Initial resources must be an array",
        );
      for (const resource of state.resources)
        this.mutate({
          type: "put-resource",
          kind: resource.kind,
          resourceId: resource.id,
          expectedRevision: 0,
          payload: resource.payload,
        });
      this.mutate({
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: this.deletedRevision(
          "resource",
          "settings",
          "global",
        ),
        payload: object(state.settings, "initial settings"),
      });
      return { initialized: true };
    });
  }

  transaction(operation, readOnly = false) {
    this.db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* SQLite may already have rolled the transaction back. */
      }
      throw error;
    }
  }

  cursor() {
    const row = this.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'")
      .get();
    return row?.seq ?? 0;
  }

  event(type, entityId, chatId, revision, payload) {
    const field = type === "fields" ? payload.fields?.[0] : null;
    const kind =
      type === "resource"
        ? payload.kind
        : field?.scope === "resource"
          ? field.resourceKind
          : null;
    const resourceId = type === "resource" ? payload.id : field?.entityId;
    if (kind && !payload.deleted) {
      const item = catalog.entry(this, kind, resourceId);
      if (item) payload = { ...payload, catalog: item };
    }
    if (type === "character" && !payload.deleted)
      payload = {
        ...payload,
        entityEpoch: this.fieldEpoch({ scope: "character", entityId }),
        characterNavigationRevision: this.characterNavigationRevision(),
        ...this.db
          .prepare(
            `SELECT trash_time AS trashTime, ${characterImageColumns}
             FROM characters WHERE id=?`,
          )
          .get(entityId),
      };
    if (type === "chat" && payload.metadata) {
      const target = { scope: "chat", entityId };
      payload = {
        ...payload,
        fieldRevisions: this.fieldRevisions(target),
        entityEpoch: this.fieldEpoch(target),
      };
    }
    if (this.displayEffect)
      payload = {
        ...payload,
        displayEffectId: this.displayEffect,
        displayInputClock: this.displayInputClock,
      };
    const row = this.db
      .prepare(
        `INSERT INTO changes
            (entity_type, entity_id, chat_id, revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(type, entityId, chatId, revision, json(payload), this.now());
    displayEffects.noteEvent(
      this,
      type,
      entityId,
      chatId,
      payload,
      Number(row.lastInsertRowid),
    );
    return Number(row.lastInsertRowid);
  }

  requireChat(chatId) {
    const chat = this.db
      .prepare("SELECT * FROM chats WHERE id=?")
      .get(id(chatId, "chatId"));
    if (!chat) throw new RuntimeError("NOT_FOUND", "Chat does not exist");
    return chat;
  }

  expectRevision(expected, current) {
    if (integer(expected, "expectedRevision") !== current) {
      throw new RuntimeError("REVISION_CONFLICT", "The entity has changed", {
        currentRevision: current,
      });
    }
  }

  deletedRevision(kind, scope, entityId) {
    return (
      this.db
        .prepare(
          "SELECT revision FROM entity_tombstones WHERE kind=? AND scope=? AND id=?",
        )
        .get(kind, scope, entityId)?.revision ?? 0
    );
  }

  rememberDeletion(kind, scope, entityId, revision) {
    this.db
      .prepare(
        "INSERT INTO entity_tombstones(kind, scope, id, revision) VALUES (?, ?, ?, ?) ON CONFLICT(kind, scope, id) DO UPDATE SET revision=excluded.revision",
      )
      .run(kind, scope, entityId, revision);
  }

  requireUnlocked(chatId) {
    const active = this.db
      .prepare("SELECT id FROM jobs WHERE chat_id=? AND state='running'")
      .get(chatId);
    if (active)
      throw new RuntimeError(
        "CHAT_BUSY",
        "This operation must wait for the active chat job",
        { jobId: active.id },
      );
  }

  bumpChat(chatId, content = true, chatGlobal = false) {
    this.db
      .prepare(
        "UPDATE chats SET revision=revision+1, content_revision=content_revision+?, chat_global_revision=chat_global_revision+?, updated_at=? WHERE id=?",
      )
      .run(Number(content), Number(chatGlobal), this.now(), chatId);
    return this.requireChat(chatId).revision;
  }

  applyCommand(requestId, command) {
    return this.transaction(() => {
      if (
        ![
          "create-character",
          "create-chat",
          "clone-chat",
          "branch-chat",
          "delete-chat",
          "delete-character",
          "save-library-resource",
          "delete-library-resource",
          "reorder-library",
          "remove-chat-folder",
          "reorder-chat-navigation",
          "change-character-navigation",
          "activate-library-resource",
          "save-active-library",
          "set-persona-image",
          "record-import",
          "append-message",
          "edit-message",
          "remove-message",
          "set-message-disabled",
          "set-bookmark",
          "change-group-member",
          "set-chat-variable",
          "change-variables",
          "apply-display-effects",
          "change-fields",
          "put-resource",
          "recover-job-result",
          "retry-job-result",
          "apply-memory-summary",
          "dismiss-memory-summary",
          "move-reply-choice",
          "acknowledge-notice",
          "answer-interaction",
          "cancel-interaction",
        ].includes(command?.type)
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Unsupported entity command type",
        );
      this.expireJobs();
      const prepared = this.prepareCommand(requestId, command);
      if (prepared.existing) return JSON.parse(prepared.existing.result);
      const parsed = JSON.parse(prepared.payload);
      const result = [
        "apply-memory-summary",
        "dismiss-memory-summary",
      ].includes(parsed.type)
        ? memorySummaries.act(this, parsed, requestId, { json })
        : parsed.type === "cancel-interaction"
          ? interactions.cancel(this, parsed)
          : parsed.type === "answer-interaction"
            ? interactions.answer(this, parsed)
            : parsed.type === "acknowledge-notice"
              ? notices.acknowledge(this, parsed)
              : parsed.type === "move-reply-choice"
                ? replyChoices.move(this, parsed, { json })
                : parsed.type === "recover-job-result"
                  ? jobResults.recover(this, parsed, requestId)
                  : parsed.type === "retry-job-result"
                    ? jobResults.retry(this, parsed, requestId)
                    : parsed.type === "apply-display-effects"
                      ? displayEffects.apply(this, parsed, {
                          id,
                          integer,
                          object,
                          json,
                        })
                      : parsed.type === "change-variables"
                        ? variableOperations.changeVariables(
                            this,
                            parsed,
                            requestId,
                            {
                              id,
                              integer,
                              object,
                              json,
                            },
                          )
                        : parsed.type === "change-fields"
                          ? fieldOperations.changeFields(
                              this,
                              parsed,
                              requestId,
                              {
                                id,
                                integer,
                                object,
                                json,
                              },
                            )
                          : this.mutate(parsed);
      result.cursor = this.cursor();
      this.db
        .prepare("UPDATE commands SET result=? WHERE id=?")
        .run(json(result), requestId);
      return result;
    });
  }

  prepareCommand(requestId, command) {
    id(requestId, "requestId");
    object(command, "command");
    const payload = json(command);
    const digest = createHash("sha256").update(payload).digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM commands WHERE id=?")
      .get(requestId);
    if (existing) {
      if (existing.payload_hash !== digest)
        throw new RuntimeError(
          "IDEMPOTENCY_CONFLICT",
          "Request ID was reused with different content",
        );
      return { existing };
    }
    this.db
      .prepare(
        "INSERT INTO commands(id, payload_hash, payload, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(requestId, digest, payload, this.now());
    return { payload };
  }

  mutate(command) {
    switch (command.type) {
      case "record-import": {
        const row = this.db
          .prepare(
            "SELECT messages,imports,revision FROM settings_statistics WHERE settings_id='global'",
          )
          .get();
        if (!row)
          throw new RuntimeError(
            "NOT_FOUND",
            "Global import statistics do not exist",
          );
        const imports = integer(row.imports + 1, "imports");
        this.db
          .prepare(
            "UPDATE settings_statistics SET imports=?,revision=revision+1 WHERE settings_id='global'",
          )
          .run(imports);
        this.event("statistics", "global", null, row.revision + 1, {
          settingsId: "global",
          messages: row.messages,
          imports,
        });
        return { imports, revision: row.revision + 1 };
      }
      case "save-library-resource":
      case "delete-library-resource":
      case "reorder-library":
      case "activate-library-resource":
      case "save-active-library":
      case "set-persona-image":
        return library.apply(this, command, { id, integer, object, json });
      case "set-bookmark":
        return bookmarkOperations.apply(this, command, { id, json });
      case "change-group-member":
        return groupMembers.apply(this, command, { id, integer, object, json });
      case "remove-chat-folder":
      case "reorder-chat-navigation":
        return chatNavigation.apply(this, command, {
          id,
          integer,
          object,
          json,
        });
      case "clone-chat":
        return lifecycle.apply(this, command, { id, object, json });
      case "change-character-navigation":
        return characterNavigation.apply(this, command, {
          id,
          integer,
          object,
          json,
        });
      case "delete-chat":
      case "delete-character":
        return lifecycle.apply(this, command, { id, object, json });
      case "branch-chat":
        return branching.apply(this, command, { id, integer, object, json });
      case "create-character": {
        const characterId = id(command.characterId, "characterId");
        if (
          this.db
            .prepare("SELECT 1 FROM characters WHERE id=?")
            .get(characterId)
        )
          throw new RuntimeError(
            "IDENTITY_CONFLICT",
            "Character ID already exists",
          );
        const input = object(command.definition, "definition");
        const { definition, lastInteraction } = separateCharacter(input);
        if ("chats" in definition || "chatPage" in definition)
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Character definitions must exclude chats and device navigation",
          );
        const kind = definition.type === "group" ? "group" : "character";
        const revision = this.deletedRevision("character", "", characterId) + 1;
        this.db
          .prepare(
            "INSERT INTO characters(id, name, kind, definition, revision, trash_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            characterId,
            String(definition.name ?? ""),
            kind,
            json({ ...definition, chaId: characterId }),
            revision,
            Number.isSafeInteger(definition.trashTime)
              ? definition.trashTime
              : null,
            this.now(),
          );
        createActivity(this, characterId, lastInteraction);
        this.bumpCharacterNavigation();
        this.recordFields(
          { scope: "character", entityId: characterId },
          {},
          { ...definition, chaId: characterId },
        );
        this.event("character", characterId, null, revision, {
          id: characterId,
          name: definition.name ?? "",
          kind,
          entityEpoch: this.fieldEpoch({
            scope: "character",
            entityId: characterId,
          }),
        });
        const chat = command.chat
          ? this.mutate({
              ...object(command.chat, "initial chat"),
              type: "create-chat",
              characterId,
            })
          : null;
        return {
          id: characterId,
          revision,
          ...(chat ? { chatId: chat.id } : {}),
        };
      }
      case "create-chat": {
        const chatId = id(command.chatId, "chatId");
        if (this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(chatId))
          throw new RuntimeError("IDENTITY_CONFLICT", "Chat ID already exists");
        const metadata = object(command.metadata ?? {}, "metadata");
        const revision = this.deletedRevision("chat", "", chatId) + 1;
        const characterId = id(command.characterId, "characterId");
        if (
          !this.db
            .prepare("SELECT 1 FROM characters WHERE id=?")
            .get(characterId)
        )
          throw new RuntimeError("NOT_FOUND", "Character does not exist");
        if (command.messages !== undefined && !Array.isArray(command.messages))
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Initial messages must be an array",
          );
        if (command.expectedCharacterEpoch !== undefined)
          this.expectRevision(
            command.expectedCharacterEpoch,
            this.fieldEpoch({ scope: "character", entityId: characterId }),
          );
        const sortPosition = this.db
          .prepare(
            command.prepend
              ? "SELECT COALESCE(MIN(sort_position),1)-1 AS position FROM chats WHERE character_id=?"
              : "SELECT COALESCE(MAX(sort_position),-1)+1 AS position FROM chats WHERE character_id=?",
          )
          .get(characterId).position;
        if (
          "message" in metadata ||
          "scriptstate" in metadata ||
          "isStreaming" in metadata
        )
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Chat metadata must exclude messages, variables and transient streaming state",
          );
        this.db
          .prepare(
            "INSERT INTO chats(id, character_id, name, metadata, revision, content_revision, sort_position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            chatId,
            characterId,
            String(metadata.name ?? ""),
            json({ ...metadata, id: chatId }),
            revision,
            revision,
            sortPosition,
            this.now(),
          );
        const separated = this.separateLocalGlobals(chatId, metadata, true);
        this.db
          .prepare("UPDATE chats SET metadata=? WHERE id=?")
          .run(json({ ...separated, id: chatId }), chatId);
        this.recordFields(
          { scope: "chat", entityId: chatId },
          {},
          { ...separated, id: chatId },
        );
        this.event("chat", chatId, chatId, revision, {
          id: chatId,
          characterId: command.characterId,
          metadata: { ...separated, id: chatId },
          created: true,
          sortPosition,
          navigationRevision: this.bumpChatNavigation(characterId),
          characterEpoch: this.fieldEpoch({
            scope: "character",
            entityId: characterId,
          }),
        });
        for (const message of command.messages ?? [])
          this.appendMessage(
            chatId,
            id(message.id, "messageId"),
            object(message.message, "initial message"),
          );
        return { id: chatId, revision: this.requireChat(chatId).revision };
      }
      case "append-message": {
        this.requireChat(command.chatId);
        this.requireUnlocked(command.chatId);
        return this.appendMessage(
          command.chatId,
          command.messageId,
          command.message,
        );
      }
      case "edit-message": {
        const messageId = id(command.messageId, "messageId");
        const row = this.db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(messageId);
        if (!row) throw new RuntimeError("NOT_FOUND", "Message does not exist");
        this.requireUnlocked(row.chat_id);
        this.expectRevision(command.expectedRevision, row.revision);
        const payload = JSON.parse(row.payload);
        if (typeof command.text !== "string")
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Message text must be a string",
          );
        payload.data = command.text;
        this.db
          .prepare(
            "UPDATE messages SET payload=?, revision=revision+1 WHERE id=?",
          )
          .run(json(payload), messageId);
        const chatRevision = this.bumpChat(row.chat_id);
        this.event("message", messageId, row.chat_id, row.revision + 1, {
          id: messageId,
          message: payload,
          position: row.position,
          chatRevision,
        });
        return { id: messageId, revision: row.revision + 1, chatRevision };
      }
      case "remove-message":
        return messageOperations.remove(this, command, { id, integer });
      case "set-message-disabled":
        return messageOperations.setDisabled(this, command, { id, json });
      case "set-chat-variable": {
        this.requireChat(command.chatId);
        this.requireUnlocked(command.chatId);
        return this.setVariable(
          command.chatId,
          command.key,
          command.value,
          command.expectedRevision,
        );
      }
      case "put-resource": {
        if (!RESOURCE_KINDS.has(command.kind))
          throw new RuntimeError("INVALID_COMMAND", "Unknown resource kind");
        const resourceId = id(command.resourceId, "resourceId");
        const row = this.db
          .prepare(
            "SELECT revision, payload FROM resources WHERE kind=? AND id=?",
          )
          .get(command.kind, resourceId);
        const currentRevision =
          row?.revision ??
          this.deletedRevision("resource", command.kind, resourceId);
        this.expectRevision(command.expectedRevision, currentRevision);
        const revision = currentRevision + 1;
        const separated =
          command.kind === "settings"
            ? separateSettings(command.payload)
            : { payload: command.payload };
        const encoded = json(separated.payload);
        this.db
          .prepare(
            `INSERT INTO resources(kind, id, payload, revision) VALUES (?, ?, ?, ?)
                    ON CONFLICT(kind, id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision`,
          )
          .run(command.kind, resourceId, encoded, revision);
        this.updateResourceCatalog(
          command.kind,
          resourceId,
          separated.payload,
          encoded,
          revision,
        );
        if (command.kind !== "global-variable")
          this.recordFields(
            {
              scope: "resource",
              resourceKind: command.kind,
              entityId: resourceId,
            },
            row ? JSON.parse(row.payload) : {},
            separated.payload,
          );
        // Ordinary settings updates cannot replace counters copied from a stale device.
        // Initial import seeds the counters; subsequent statistics edits use their own revision.
        if (command.kind === "settings" && !row)
          createStatistics(this, resourceId, separated.statistics);
        this.event(
          "resource",
          `${command.kind}:${resourceId}`,
          null,
          revision,
          { kind: command.kind, id: resourceId },
        );
        return { id: resourceId, revision };
      }
      default:
        throw new RuntimeError("INVALID_COMMAND", "Unknown mutation type");
    }
  }

  appendMessage(chatId, messageId, message, expectedRevision = 0) {
    id(messageId, "messageId");
    object(message, "message");
    if (
      !["user", "char"].includes(message.role) ||
      typeof message.data !== "string"
    ) {
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Message needs a supported role and string data",
      );
    }
    const previous = this.db
      .prepare(
        "SELECT scope, revision FROM entity_tombstones WHERE kind='message' AND id=?",
      )
      .get(messageId);
    if (previous && previous.scope !== chatId)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "A message ID cannot move between chats",
      );
    this.expectRevision(expectedRevision, previous?.revision ?? 0);
    const revision = (previous?.revision ?? 0) + 1;
    const ordering = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), -1)+1 AS next, count(*) AS ordinal FROM messages WHERE chat_id=?",
      )
      .get(chatId);
    const position = ordering.next;
    const payload = { ...message, chatId: messageId };
    this.db
      .prepare(
        "INSERT INTO messages(id, chat_id, position, payload, revision) VALUES (?, ?, ?, ?, ?)",
      )
      .run(messageId, chatId, position, json(payload), revision);
    const chatRevision = this.bumpChat(chatId);
    this.event("message", messageId, chatId, revision, {
      id: messageId,
      message: payload,
      position,
      chatRevision,
      added: true,
      ordinal: ordering.ordinal,
    });
    return { id: messageId, revision, chatRevision, position };
  }

  separateLocalGlobals(chatId, metadata, seed = false) {
    return variableOperations.separateLocalGlobals(
      this,
      chatId,
      metadata,
      { id, object, json },
      seed,
    );
  }

  changeChatGlobalVariable(edit) {
    return variableOperations.writeVariable(
      this,
      { ...edit, scope: "chat-global" },
      { json },
    );
  }

  chatMetadata(chat) {
    return variableOperations.chatMetadata(this, chat);
  }

  readVariables(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 128)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Expected 1 to 128 variable targets",
      );
    return this.transaction(() => ({
      cursor: this.cursor(),
      variables: targets.map((input) =>
        variableOperations.readVariable(
          this,
          variableOperations.target(input, { id, object }),
        ),
      ),
    }));
  }

  fieldRevisions(target) {
    return fieldOperations.revisions(this, target);
  }
  fieldEpoch(target) {
    return fieldOperations.epoch(this, target);
  }
  recordFields(target, before, after) {
    fieldOperations.record(this, target, before, after, json);
    if (target.scope === "character")
      this.recordGroupMembers(target.entityId, before, after);
    if (target.scope === "chat")
      this.recordBookmarks(target.entityId, before, after);
  }
  recordGroupMembers(groupId, before, after) {
    return groupMembers.record(this, groupId, before, after, json);
  }
  groupMemberHeaders(groupId) {
    return groupMembers.headers(this, groupId);
  }
  readGroupMember(groupId, memberId) {
    id(groupId, "group ID");
    id(memberId, "member ID");
    return this.transaction(() => groupMembers.read(this, groupId, memberId));
  }
  recordBookmarks(chatId, before, after) {
    bookmarkOperations.record(
      this,
      chatId,
      before,
      after,
      json,
      Object.hasOwn(before, "id") && Object.hasOwn(after, "id"),
    );
  }
  readBookmark(chatId, messageId, options = {}) {
    id(chatId, "chatId");
    id(messageId, "messageId");
    return this.transaction(() => {
      const header = bookmarkOperations.header(this, chatId, messageId, true),
        cursor = this.cursor();
      if (options.observedCursor === undefined) return { ...header, cursor };
      const observed = integer(options.observedCursor, "observedCursor"),
        floor = this.db
          .prepare("SELECT value FROM runtime_meta WHERE key='change_floor'")
          .get().value;
      if (observed < floor || observed > cursor)
        throw new RuntimeError(
          "RESYNC_REQUIRED",
          "Bookmark observation is outside the retained change history",
          { floor, head: cursor },
        );
      // Value equality cannot detect removal and re-addition with the same name.
      // Other members remain independent; inspect only journal headers, not bodies.
      const changed = this.db
        .prepare(
          "SELECT 1 FROM changes WHERE entity_type='bookmark' AND chat_id=? AND entity_id=? AND sequence>? LIMIT 1",
        )
        .get(chatId, messageId, observed);
      return {
        ...header,
        cursor,
        changedAfterObservedCursor: Boolean(changed),
      };
    }, true);
  }
  listBookmarks(chatId, options = {}) {
    return this.transaction(
      () => bookmarkOperations.list(this, chatId, options, { integer }),
      true,
    );
  }
  applyFields(edits, coalesce = false) {
    return fieldOperations.apply(
      this,
      edits,
      { id, integer, object, json },
      coalesce,
    );
  }
  metadataRevision(chatId) {
    return this.db
      .prepare(
        "SELECT COALESCE(SUM(revision), 0) AS revision FROM entity_field_revisions WHERE scope='chat' AND kind='' AND entity_id=?",
      )
      .get(chatId).revision;
  }
  readFields(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 128)
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Expected 1 to 128 field targets",
      );
    return this.transaction(() => {
      const cache = new Map();
      return {
        cursor: this.cursor(),
        fields: targets.map((input) =>
          fieldOperations.readField(
            this,
            fieldOperations.target(input, { id, object }),
            cache,
          ),
        ),
      };
    });
  }

  setVariable(chatId, key, value, expectedRevision) {
    id(key, "variable key");
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Variables must be JSON scalar values",
      );
    }
    if (typeof value === "number" && !Number.isFinite(value))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Variable number must be finite",
      );
    const row = this.db
      .prepare("SELECT revision FROM chat_variables WHERE chat_id=? AND key=?")
      .get(chatId, key);
    const currentRevision =
      row?.revision ?? this.deletedRevision("variable", chatId, key);
    if (expectedRevision !== undefined)
      this.expectRevision(expectedRevision, currentRevision);
    const revision = currentRevision + 1;
    this.db
      .prepare(
        `INSERT INTO chat_variables(chat_id, key, value, revision) VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_id, key) DO UPDATE SET value=excluded.value, revision=excluded.revision`,
      )
      .run(chatId, key, json(value), revision);
    const chatRevision = this.bumpChat(chatId, false);
    this.event("variable", `${chatId}:${key}`, chatId, revision, {
      key,
      value,
      chatRevision,
    });
    return { revision, chatRevision };
  }

  bootstrap() {
    return this.transaction(
      () => ({
        serverId: this.db
          .prepare("SELECT id FROM runtime_identity WHERE singleton=1")
          .get().id,
        cursor: this.cursor(),
        fieldReadChecksVersion: 1,
        groupImageSourcesVersion: 1,
        characters: this.db
          .prepare(
            `SELECT id, name, kind, revision, trash_time AS trashTime, ${characterImageColumns},
                COALESCE((SELECT revision FROM entity_tombstones t WHERE t.kind='character' AND t.scope='' AND t.id=characters.id),0) AS entityEpoch,
                (SELECT last_interaction FROM character_activity WHERE character_id=characters.id) AS lastInteraction,
                (SELECT revision FROM character_activity WHERE character_id=characters.id) AS activityRevision,
                (SELECT count(*) FROM chats WHERE character_id=characters.id) AS chatCount FROM characters ORDER BY rowid`,
          )
          .all(),
        lifecycleTombstones: this.db
          .prepare(
            "SELECT kind, id, revision FROM entity_tombstones WHERE scope='' AND kind IN ('character','chat')",
          )
          .all(),
        statistics: this.statistics(),
        characterNavigation: characterNavigation.header(this),
        resources: this.db
          .prepare(
            "SELECT kind, id, revision, 0 AS deleted FROM resources UNION ALL SELECT scope AS kind, id, revision, 1 AS deleted FROM entity_tombstones t WHERE kind='resource' AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.kind=t.scope AND r.id=t.id)",
          )
          .all(),
      }),
      true,
    );
  }

  listChats(characterId) {
    return this.transaction(() => this.chatSummaries(characterId), true);
  }
  groupImageSources(groupId, offset, expected) {
    return this.transaction(
      () => require("./groupImages.cjs").page(this, groupId, offset, expected),
      true,
    );
  }

  chatNavigationRevision(characterId) {
    return chatNavigation.revision(this, id(characterId, "characterId"));
  }
  bumpChatNavigation(characterId) {
    return chatNavigation.bump(this, id(characterId, "characterId"));
  }

  characterNavigationRevision() {
    return characterNavigation.revision(this);
  }
  bumpCharacterNavigation() {
    return characterNavigation.bump(this);
  }
  removeCharacterOrderReferences(characterId) {
    return characterNavigation.removeCharacter(this, characterId);
  }

  // getCharacter already owns a transaction; the standalone endpoint above
  // also pins values and field revisions together rather than retagging values.
  chatSummaries(characterId) {
    return this.db
      .prepare(
        `SELECT id, name, revision, sort_position AS sortPosition, updated_at AS updatedAt,
            metadata -> '$.folderId' AS folderJson,
            COALESCE((SELECT revision FROM entity_tombstones t WHERE t.kind='chat' AND t.scope='' AND t.id=chats.id),0) AS entityEpoch,
            (SELECT count(*) FROM messages WHERE chat_id=chats.id) AS messageCount FROM chats WHERE character_id=? ORDER BY sort_position, rowid`,
      )
      .all(id(characterId, "characterId"))
      .map(({ folderJson, ...row }) => ({
        ...row,
        navigation: {
          folderId: {
            exists: folderJson !== null,
            ...(folderJson !== null ? { value: JSON.parse(folderJson) } : {}),
          },
        },
        fieldRevisions: this.fieldRevisions({
          scope: "chat",
          entityId: row.id,
        }),
      }));
  }

  getCharacter(characterId) {
    return this.transaction(() => this.characterView(characterId));
  }

  characterView(characterId) {
    const row = this.db
      .prepare(
        `SELECT c.*, a.last_interaction, a.revision AS activity_revision
      FROM characters c LEFT JOIN character_activity a ON a.character_id=c.id WHERE c.id=?`,
      )
      .get(id(characterId, "characterId"));
    return row
      ? {
          id: row.id,
          revision: row.revision,
          definition: JSON.parse(row.definition),
          ...(row.kind === "group"
            ? { groupMembers: this.groupMemberHeaders(row.id) }
            : {}),
          cursor: this.cursor(),
          chatSummaries: this.chatSummaries(row.id),
          navigationRevision: this.chatNavigationRevision(row.id),
          fieldRevisions: this.fieldRevisions({
            scope: "character",
            entityId: row.id,
          }),
          entityEpoch: this.fieldEpoch({
            scope: "character",
            entityId: row.id,
          }),
          activity:
            row.activity_revision === null
              ? null
              : {
                  lastInteraction: row.last_interaction,
                  revision: row.activity_revision,
                },
        }
      : null;
  }

  getResource(kind, resourceId) {
    if (!RESOURCE_KINDS.has(kind))
      throw new RuntimeError("INVALID_COMMAND", "Unknown resource kind");
    const row = this.db
      .prepare(
        `SELECT r.*, s.messages, s.imports, s.revision AS statistics_revision
        FROM resources r LEFT JOIN settings_statistics s ON r.kind='settings' AND s.settings_id=r.id
        WHERE r.kind=? AND r.id=?`,
      )
      .get(kind, id(resourceId));
    const statistics =
      row?.statistics_revision != null
        ? {
            settingsId: resourceId,
            messages: row.messages,
            imports: row.imports,
            revision: row.statistics_revision,
          }
        : null;
    const payload = row ? JSON.parse(row.payload) : null;
    return row
      ? {
          kind,
          id: row.id,
          revision: row.revision,
          payload: statistics
            ? {
                ...payload,
                statics: {
                  ...payload.statics,
                  messages: statistics.messages,
                  imports: statistics.imports,
                },
              }
            : payload,
          ...(kind !== "global-variable"
            ? {
                fieldRevisions: this.fieldRevisions({
                  scope: "resource",
                  resourceKind: kind,
                  entityId: row.id,
                }),
                entityEpoch: this.fieldEpoch({
                  scope: "resource",
                  resourceKind: kind,
                  entityId: row.id,
                }),
              }
            : {}),
          ...(statistics ? { statistics } : {}),
        }
      : null;
  }
  updateResourceCatalog(kind, id, payload, encoded, revision) {
    catalog.update(this, kind, id, payload, encoded, revision);
  }
  getResourceSnapshot(kind, id) {
    return this.transaction(() => {
      const resource = this.getResource(kind, id);
      return resource
        ? {
            ...resource,
            cursor: this.cursor(),
            ...(kind === "settings" && id === "global"
              ? { characterNavigation: characterNavigation.header(this) }
              : {}),
          }
        : null;
    }, true);
  }
  listLibrary(kind, options) {
    return this.transaction(() => catalog.list(this, kind, options), true);
  }
  resolveModuleCatalog(tokens) {
    return this.transaction(
      () => ({
        cursor: this.cursor(),
        items: catalog.resolve(this, tokens),
      }),
      true,
    );
  }

  statistics() {
    return this.db
      .prepare(
        "SELECT settings_id AS settingsId, messages, imports, revision FROM settings_statistics ORDER BY settings_id",
      )
      .all();
  }

  snapshot(chatId, options = {}) {
    return this.transaction(() => this.chatView(chatId, options));
  }
  readMemorySource(chatId, options) {
    return this.transaction(() =>
      memorySources.read(this, chatId, options, { id, integer }),
    );
  }
  schemaVersion() {
    return this.db.prepare("PRAGMA user_version").get().user_version;
  }

  chatView(chatId, options = {}, execution = false) {
    const limit = Math.min(integer(options.limit ?? 100, "limit", 1), 1000);
    const chat = this.requireChat(chatId);
    const character = this.db
      .prepare("SELECT * FROM characters WHERE id=?")
      .get(chat.character_id);
    // Browser pagination must never truncate the server's generation context.
    const window = execution
      ? {
          rows: this.db
            .prepare("SELECT * FROM messages WHERE chat_id=? ORDER BY position")
            .all(chatId),
          emptyPosition: 0,
        }
      : messageWindow.read(this, chatId, options, limit, { integer, id });
    const rows = window.rows;
    const variables = this.db
      .prepare(
        "SELECT key, value, revision FROM chat_variables WHERE chat_id=?",
      )
      .all(chatId);
    // One indexed aggregate, without decoding unloaded bodies. Positions may
    // have gaps after deletion; their dense ordinal is offset + page index.
    const history = this.db
      .prepare(
        "SELECT count(*) AS count, COALESCE(sum(position < ?),0) AS offset FROM messages WHERE chat_id=?",
      )
      .get(rows[0]?.position ?? window.emptyPosition, chatId);
    if (!rows.length && options.after !== undefined)
      history.offset = history.count;
    return {
      cursor: this.cursor(),
      history: { ...history },
      character: {
        id: character.id,
        revision: character.revision,
        definition: JSON.parse(character.definition),
        ...(character.kind === "group"
          ? { groupMembers: this.groupMemberHeaders(character.id) }
          : {}),
        activity: getActivity(this, character.id),
        fieldRevisions: this.fieldRevisions({
          scope: "character",
          entityId: character.id,
        }),
        entityEpoch: this.fieldEpoch({
          scope: "character",
          entityId: character.id,
        }),
      },
      chat: {
        id: chat.id,
        characterId: chat.character_id,
        revision: chat.revision,
        contentRevision: chat.content_revision,
        chatGlobalRevision: chat.chat_global_revision,
        metadata: this.chatMetadata(chat),
        fieldRevisions: this.fieldRevisions({
          scope: "chat",
          entityId: chat.id,
        }),
        entityEpoch: this.fieldEpoch({ scope: "chat", entityId: chat.id }),
      },
      messages: rows.map((row, index) => ({
        id: row.id,
        revision: row.revision,
        position: row.position,
        ordinal: history.offset + index,
        message: JSON.parse(row.payload),
        ...(row.display_key
          ? {
              displayOrigin: {
                messageRevision: row.display_message_revision,
                chatEpoch: row.display_chat_epoch,
                characterEpoch: row.display_character_epoch,
                inputClock: row.display_input_clock,
                codeHash: row.display_code_hash,
                displayKey: row.display_key,
              },
            }
          : {}),
      })),
      variables: variables.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value),
        revision: row.revision,
      })),
      chatGlobalVariables: this.db
        .prepare(
          "SELECT key, value, revision FROM chat_global_variables WHERE chat_id=?",
        )
        .all(chatId)
        .map((row) => ({ ...row, value: JSON.parse(row.value) })),
      deletedChatGlobalVariables: this.db
        .prepare(
          "SELECT id AS key, revision FROM entity_tombstones t WHERE kind='chat-global-variable' AND scope=? AND NOT EXISTS (SELECT 1 FROM chat_global_variables v WHERE v.chat_id=t.scope AND v.key=t.id)",
        )
        .all(chatId),
      deletedVariables: this.db
        .prepare(
          "SELECT id AS key, revision FROM entity_tombstones t WHERE kind='variable' AND scope=? AND NOT EXISTS (SELECT 1 FROM chat_variables v WHERE v.chat_id=t.scope AND v.key=t.id)",
        )
        .all(chatId),
      deletedMessages: this.db
        .prepare(
          "SELECT id, revision FROM entity_tombstones t WHERE kind='message' AND scope=? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=t.id)",
        )
        .all(chatId),
      hasEarlier: !execution && history.offset > 0,
      hasLater: !execution && history.offset + rows.length < history.count,
    };
  }

  changes(after, limit = 100) {
    integer(after, "after");
    integer(limit, "limit", 1);
    return this.transaction(() => {
      const floor = this.db
        .prepare("SELECT value FROM runtime_meta WHERE key='change_floor'")
        .get().value;
      const head = this.cursor();
      if (after > head)
        throw new RuntimeError(
          "RESYNC_REQUIRED",
          "Cursor belongs to a different or newer snapshot",
          { head, floor },
        );
      if (after < floor)
        throw new RuntimeError(
          "RESYNC_REQUIRED",
          "Change history no longer covers this cursor",
          { floor },
        );
      const rows = this.db
        .prepare(
          "SELECT * FROM changes WHERE sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(after, Math.min(limit, 1000));
      return {
        cursor: rows.at(-1)?.sequence ?? after,
        head: this.cursor(),
        changes: rows.map((row) => ({
          sequence: row.sequence,
          type: row.entity_type,
          id: row.entity_id,
          chatId: row.chat_id,
          revision: row.revision,
          payload: JSON.parse(row.payload),
        })),
      };
    });
  }

  pruneChanges(through) {
    integer(through, "through");
    return this.transaction(() => {
      const floor = this.db
        .prepare("SELECT value FROM runtime_meta WHERE key='change_floor'")
        .get().value;
      const next = Math.max(floor, Math.min(through, this.cursor()));
      this.db.prepare("DELETE FROM changes WHERE sequence<=?").run(next);
      this.db
        .prepare("UPDATE runtime_meta SET value=? WHERE key='change_floor'")
        .run(next);
      return next;
    });
  }

  enqueueJob(requestId, command) {
    return this.transaction(() => {
      this.expireJobs();
      return this.admitJob(requestId, command);
    });
  }

  // Called only within an existing store transaction, including explicit retry.
  admitJob(requestId, command) {
    if (
      !["send", "continue", "reroll", "button", "memory-summary"].includes(
        command?.type,
      )
    )
      throw new RuntimeError("INVALID_COMMAND", "Unsupported job type");
    const prepared = this.prepareCommand(requestId, command);
    if (prepared.existing) {
      const job = this.getJob(requestId);
      if (!job)
        throw new RuntimeError(
          "IDEMPOTENCY_CONFLICT",
          "Request ID belongs to a non-job command",
        );
      return job;
    }
    this.requireChat(command.chatId);
    if (command.type === "memory-summary") memorySummaries.admit(this, command);
    if (command.expectedChatEpoch !== undefined)
      this.expectRevision(
        command.expectedChatEpoch,
        this.fieldEpoch({ scope: "chat", entityId: command.chatId }),
      );
    const next = this.db
      .prepare("SELECT COALESCE(MAX(queue_position), 0)+1 AS next FROM jobs")
      .get().next;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO jobs(id, chat_id, chat_epoch, type, state, queue_position, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        requestId,
        command.chatId,
        this.fieldEpoch({ scope: "chat", entityId: command.chatId }),
        command.type,
        next,
        now,
        now,
      );
    const job = this.getJob(requestId);
    this.jobEvent(job);
    this.db
      .prepare("UPDATE commands SET result=? WHERE id=?")
      .run(json({ id: requestId, accepted: true }), requestId);
    return job;
  }

  getJob(jobId) {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(id(jobId, "jobId"));
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      chatEpoch: row.chat_epoch,
      type: row.type,
      state: row.state,
      queuePosition: row.queue_position,
      owner: row.owner,
      fence: row.fence,
      leaseUntil: row.lease_until,
      cancelRequested: Boolean(row.cancel_requested),
      startedRevision: row.started_revision,
      startedContentRevision: row.started_content_revision,
      startedMetadataRevision: row.started_metadata_revision,
      result: row.result === null ? null : JSON.parse(row.result),
      progress: JSON.parse(row.progress),
      progressRevision: row.progress_revision,
    };
  }

  getJobStatus(jobId) {
    return jobResults.status(this, id(jobId, "jobId"));
  }

  previewJobResult(jobId) {
    return this.transaction(() => jobResults.preview(this, id(jobId, "jobId")));
  }

  previewMemorySummary(jobId) {
    return this.transaction(
      () => memorySummaries.preview(this, id(jobId, "jobId")),
      true,
    );
  }

  readReplyChoices(chatId, messageId, expectedRevision, expectedChatEpoch) {
    return this.transaction(
      () =>
        replyChoices.header(
          this,
          chatId,
          messageId,
          expectedRevision,
          expectedChatEpoch,
        ),
      true,
    );
  }

  captureReplyChoices(job, result) {
    return replyChoices.capture(this, job, result);
  }

  commitJobWriteSet(job, writes) {
    const chat = this.requireChat(job.chatId);
    if (writes.expectedContentRevision !== undefined)
      this.expectRevision(job.startedContentRevision, chat.content_revision);
    else this.expectRevision(job.startedRevision, chat.revision);
    if (writes.metadata !== undefined)
      this.expectRevision(
        job.startedMetadataRevision,
        this.metadataRevision(job.chatId),
      );
    const capturedWrites = JSON.parse(json(writes));
    const batch = replyBatches.before(this, job, capturedWrites);
    applyJobWriteSet(this, job, capturedWrites, {
      id,
      integer,
      object,
      json,
      RESOURCE_KINDS,
    });
    replyBatches.after(this, batch);
  }

  jobEvent(job) {
    const { progress: _progress, result, ...summary } = job;
    return this.event("job", job.id, job.chatId, job.fence, {
      ...summary,
      resultAvailable: result !== null,
      ...(job.type === "memory-summary"
        ? {
            memoryPreviewAvailable:
              job.state === "completed" &&
              !!result?.memoryPreview &&
              !result.memoryPreview.disposition,
          }
        : {}),
    });
  }

  getJobCommand(jobId) {
    const row = this.db
      .prepare(
        "SELECT c.payload FROM commands c JOIN jobs j ON j.id=c.id WHERE j.id=?",
      )
      .get(id(jobId, "jobId"));
    return row ? JSON.parse(row.payload) : null;
  }

  listJobs(chatId, limit = 50) {
    this.requireChat(chatId);
    integer(limit, "limit", 1);
    return this.db
      .prepare(
        `SELECT id, chat_id AS chatId, type, state, queue_position AS queuePosition,
      fence, cancel_requested AS cancelRequested, progress_revision AS progressRevision,
      result IS NOT NULL AS resultAvailable,
      type='memory-summary' AND state='completed' AND json_type(result,'$.memoryPreview')='object' AND json_type(result,'$.memoryPreview.disposition') IS NULL AS memoryPreviewAvailable
      FROM jobs WHERE chat_id=? AND chat_epoch=? ORDER BY queue_position DESC LIMIT ?`,
      )
      .all(
        chatId,
        this.fieldEpoch({ scope: "chat", entityId: chatId }),
        Math.min(limit, 100),
      )
      .map((row) => ({
        ...row,
        cancelRequested: Boolean(row.cancelRequested),
        resultAvailable: Boolean(row.resultAvailable),
        memoryPreviewAvailable: Boolean(row.memoryPreviewAvailable),
      }));
  }

  listJobHistory(chatId, options) {
    return this.transaction(
      () => jobHistory.list(this, chatId, options, { id, integer }),
      true,
    );
  }

  writeJobProgress(jobId, owner, fence, progress, providerOutputUpdates = []) {
    object(progress, "progress");
    if (Object.hasOwn(progress, "providerOutputs"))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Retained provider output must use its dedicated relation",
      );
    return this.transaction(() => {
      const job = this.requireOwner(jobId, owner, fence);
      providerOutputs.apply(this, jobId, providerOutputUpdates);
      const encodedProgress = json(progress),
        retainedBytes = providerOutputs.bytes(this, jobId);
      const logicalBytes =
        Buffer.byteLength(encodedProgress) +
        (retainedBytes
          ? retainedBytes +
            Buffer.byteLength('"providerOutputs":') +
            (encodedProgress.length > 2 ? 1 : 0)
          : 0);
      if (logicalBytes > MAX_JSON_BYTES)
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Combined job progress and retained output exceeds the 16 MiB checkpoint budget",
        );
      const revision = job.progressRevision + 1;
      this.db
        .prepare(
          "UPDATE jobs SET progress=?, progress_revision=?, updated_at=? WHERE id=?",
        )
        .run(encodedProgress, revision, this.now(), jobId);
      // Journal only the pointer; replay does not repeatedly transfer the whole growing response.
      this.event("job-progress", jobId, job.chatId, revision, {
        jobId,
        progressRevision: revision,
      });
      return { progressRevision: revision, cursor: this.cursor() };
    });
  }

  interruptJob(jobId, owner, fence, reason) {
    return this.transaction(() => {
      const job = this.requireOwner(jobId, owner, fence);
      const state = job.cancelRequested ? "cancelled" : "interrupted";
      this.db
        .prepare(
          "UPDATE jobs SET state=?, owner=NULL, lease_until=NULL, fence=fence+1, result=?, updated_at=? WHERE id=?",
        )
        .run(
          state,
          json({
            code:
              state === "cancelled" ? "CANCEL_REQUESTED" : "WORKER_INTERRUPTED",
            message: String(reason),
            mayHaveExternalEffects: true,
          }),
          this.now(),
          jobId,
        );
      const updated = this.getJob(jobId);
      interactions.closeJob(this, jobId, updated.state);
      this.jobEvent(updated);
      return updated;
    });
  }

  expireJobs() {
    const rows = this.db
      .prepare(
        "SELECT id, chat_id, cancel_requested FROM jobs WHERE state='running' AND lease_until<=?",
      )
      .all(this.now());
    for (const row of rows) {
      this.db
        .prepare(
          "UPDATE jobs SET state=?, owner=NULL, lease_until=NULL, fence=fence+1, result=?, updated_at=? WHERE id=?",
        )
        .run(
          row.cancel_requested ? "cancelled" : "interrupted",
          json({
            code: "LEASE_EXPIRED",
            message: "Worker ownership expired; automatic replay is disabled",
            mayHaveExternalEffects: true,
          }),
          this.now(),
          row.id,
        );
      interactions.closeJob(this, row.id, "lease-expired");
      this.jobEvent(this.getJob(row.id));
    }
    return rows.length;
  }

  claimJob(owner, leaseMs = 30000, options = {}) {
    id(owner, "owner");
    integer(leaseMs, "leaseMs", 1);
    return this.transaction(() => {
      this.expireJobs();
      const row = this.db
        .prepare(
          `SELECT j.id, j.chat_id, j.created_at FROM jobs j WHERE j.state='queued'
                AND NOT EXISTS (SELECT 1 FROM jobs running WHERE running.chat_id=j.chat_id AND running.state='running')
                ORDER BY j.queue_position LIMIT 1`,
        )
        .get();
      if (!row) return null;
      const chat = this.requireChat(row.chat_id);
      this.db
        .prepare(
          `UPDATE jobs SET state='running', owner=?, fence=fence+1, lease_until=?,
                started_revision=?, started_content_revision=?, started_metadata_revision=?, updated_at=? WHERE id=?`,
        )
        .run(
          owner,
          this.now() + leaseMs,
          chat.revision,
          chat.content_revision,
          this.metadataRevision(chat.id),
          this.now(),
          row.id,
        );
      const job = this.getJob(row.id);
      this.jobEvent(job);
      const command = JSON.parse(
        this.db.prepare("SELECT payload FROM commands WHERE id=?").get(row.id)
          .payload,
      );
      return {
        job,
        command,
        ...(job.type === "button"
          ? { buttonQueueMs: Math.max(0, this.now() - row.created_at) }
          : {}),
        ...(options.includeSnapshot === false
          ? {}
          : { snapshot: this.executionSnapshot(row.chat_id) }),
      };
    });
  }

  executionSnapshot(chatId) {
    return {
      ...this.chatView(chatId, {}, true),
      statistics: this.statistics(),
      characterIndex: this.db
        .prepare("SELECT id, kind, revision FROM characters ORDER BY rowid")
        .all(),
      resources: this.db
        .prepare("SELECT * FROM resources ORDER BY kind, rowid")
        .all()
        .map((row) => ({
          kind: row.kind,
          id: row.id,
          revision: row.revision,
          payload: JSON.parse(row.payload),
          ...(row.kind !== "global-variable"
            ? {
                fieldRevisions: this.fieldRevisions({
                  scope: "resource",
                  resourceKind: row.kind,
                  entityId: row.id,
                }),
                entityEpoch: this.fieldEpoch({
                  scope: "resource",
                  resourceKind: row.kind,
                  entityId: row.id,
                }),
              }
            : {}),
          entityEpoch: this.fieldEpoch({
            scope: "resource",
            resourceKind: row.kind,
            entityId: row.id,
          }),
        })),
      deletedResources: this.db
        .prepare(
          "SELECT scope AS kind, id, revision FROM entity_tombstones t WHERE kind='resource' AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.kind=t.scope AND r.id=t.id)",
        )
        .all(),
    };
  }

  readPluginJobSnapshot(jobId, owner, fence) {
    return this.transaction(() => {
      const job = this.requireOwner(jobId, owner, fence);
      if (job.cancelRequested)
        throw new RuntimeError("JOB_CANCELLED", "Cancellation requested");
      const snapshot = this.executionSnapshot(job.chatId);
      snapshot.pluginCurrentScope = pluginCatalog.captureCurrentScope(
        this,
        job.chatId,
      );
      this.expectRevision(
        job.startedContentRevision ?? job.startedRevision,
        snapshot.chat.contentRevision ?? snapshot.chat.revision,
      );
      return snapshot;
    }, true);
  }

  requireOwner(jobId, owner, fence) {
    const job = this.getJob(jobId);
    if (
      !job ||
      job.state !== "running" ||
      job.owner !== owner ||
      job.fence !== fence ||
      job.leaseUntil <= this.now()
    ) {
      throw new RuntimeError(
        "STALE_WORKER",
        "Job ownership is absent or expired",
      );
    }
    return job;
  }

  claimPluginStorage(input) {
    return this.transaction(() => pluginStorage.claim(this, input));
  }
  renewPluginStorage(input) {
    return this.transaction(() => pluginStorage.renew(this, input));
  }
  releasePluginStorage(lease) {
    return this.transaction(() => pluginStorage.release(this, lease));
  }
  readPluginStorage(namespace, key) {
    return this.transaction(
      () => pluginStorage.read(this, namespace, key),
      true,
    );
  }
  readAllPluginStorage(namespace, options) {
    return this.transaction(
      () => pluginStorage.readAll(this, namespace, options),
      true,
    );
  }
  readPluginStorageKeys(namespace) {
    return this.transaction(() => pluginStorage.keys(this, namespace), true);
  }
  commitPluginStorage(input) {
    return this.transaction(() => pluginStorage.commit(this, input));
  }
  readPluginStorageCommit(input) {
    return this.transaction(() => pluginStorage.readCommit(this, input), true);
  }

  pluginUISnapshot(chatId) {
    return {
      ...this.executionSnapshot(chatId),
      pluginCurrentScope: pluginCatalog.captureCurrentScope(this, chatId),
      pluginCatalog: pluginCatalog.capture(this),
    };
  }

  assertPluginUIAdmissionIdle() {
    const active = this.db
      .prepare(
        "SELECT id FROM jobs WHERE state IN ('queued','running') LIMIT 1",
      )
      .get();
    if (active)
      throw new RuntimeError(
        "CHAT_BUSY",
        "Finish accepted generation before opening the shared plugin writer",
        { jobId: active.id },
      );
  }

  claimPluginUIStorage(input) {
    return this.transaction(() => {
      if (input?.authority?.kind !== "browser")
        throw new RuntimeError(
          "INVALID_PLUGIN_UI",
          "Plugin UI requires its browser owner authority",
        );
      this.assertPluginUIAdmissionIdle();
      return pluginStorage.claim(this, input);
    });
  }

  capturePluginUI(chatId) {
    return this.transaction(() => {
      this.assertPluginUIAdmissionIdle();
      return {
        scope: pluginUIWrites.capture(this, { chatId }),
        snapshot: this.pluginUISnapshot(chatId),
      };
    }, true);
  }
  checkPluginUI(input) {
    return this.transaction(() => pluginUIWrites.check(this, input), true);
  }
  readPluginUIEvent(input) {
    return this.transaction(() => pluginUIWrites.read(this, input), true);
  }
  admitPluginUIEvent(input) {
    return this.transaction(() => pluginUIWrites.admit(this, input));
  }
  completePluginUIEvent(input) {
    return this.transaction(() => pluginUIWrites.complete(this, input));
  }
  failPluginUIEvent(input) {
    return this.transaction(() => pluginUIWrites.fail(this, input));
  }

  publishJobNotice(jobId, owner, fence, position, message) {
    return this.transaction(() =>
      notices.publish(this, jobId, owner, fence, position, message),
    );
  }
  listNotices(options) {
    return this.transaction(() => notices.list(this, options), true);
  }
  readNotice(id) {
    return this.transaction(() => notices.read(this, id), true);
  }

  publishJobInteraction(jobId, owner, fence, position, descriptor) {
    return this.transaction(() =>
      interactions.publish(this, jobId, owner, fence, position, descriptor),
    );
  }
  listInteractions(options) {
    return this.transaction(() => {
      this.expireJobs();
      return interactions.list(this, options);
    });
  }
  readInteraction(id) {
    return this.transaction(() => {
      this.expireJobs();
      return interactions.read(this, id);
    });
  }
  pollJobInteraction(jobId, owner, fence, id) {
    return this.transaction(
      () => interactions.poll(this, jobId, owner, fence, id),
      true,
    );
  }

  heartbeat(jobId, owner, fence, leaseMs = 30000) {
    integer(leaseMs, "leaseMs", 1);
    return this.transaction(() => {
      this.requireOwner(jobId, owner, fence);
      this.db
        .prepare("UPDATE jobs SET lease_until=?, updated_at=? WHERE id=?")
        .run(this.now() + leaseMs, this.now(), jobId);
      return this.getJob(jobId);
    });
  }

  requestCancel(jobId) {
    return this.transaction(() => {
      this.expireJobs();
      const job = this.getJob(jobId);
      if (!job) throw new RuntimeError("NOT_FOUND", "Job does not exist");
      if (job.state === "queued") {
        this.db
          .prepare(
            "UPDATE jobs SET state='cancelled', cancel_requested=1, updated_at=? WHERE id=?",
          )
          .run(this.now(), jobId);
      } else if (job.state === "running") {
        this.db
          .prepare(
            "UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?",
          )
          .run(this.now(), jobId);
      }
      const result = this.getJob(jobId);
      if (result.cancelRequested)
        interactions.closeJob(this, jobId, "cancelled");
      this.jobEvent(result);
      return result;
    });
  }

  finishJob(jobId, owner, fence, outcome) {
    return this.transaction(() => {
      const job = this.requireOwner(jobId, owner, fence);
      if (!["completed", "failed", "cancelled"].includes(outcome?.state))
        throw new RuntimeError("INVALID_COMMAND", "Invalid terminal state");
      // Failure/cancellation must remain reportable after another device edits the chat.
      // Modern jobs guard content and each written key independently; legacy
      // formats still require the whole chat to match its initial revision.
      if (outcome.state === "completed") {
        if (
          this.db
            .prepare(
              "SELECT id FROM job_interactions WHERE job_id=? AND state='pending'",
            )
            .get(jobId)
        )
          throw new RuntimeError(
            "INTERACTION_PENDING",
            "A successful job cannot leave an unanswered interaction",
          );
        const chat = this.requireChat(job.chatId);
        if (outcome.writeSet?.expectedContentRevision !== undefined)
          this.expectRevision(
            job.startedContentRevision,
            chat.content_revision,
          );
        else this.expectRevision(job.startedRevision, chat.revision);
        if (outcome.writeSet?.metadata !== undefined)
          this.expectRevision(
            job.startedMetadataRevision,
            this.metadataRevision(job.chatId),
          );
      }
      if (job.cancelRequested && outcome.state === "completed")
        throw new RuntimeError(
          "CANCEL_REQUESTED",
          "Worker must resolve cancellation before completion",
        );
      const memoryResult =
        job.type === "memory-summary" && outcome.state === "completed"
          ? memorySummaries.prepareCompletion(
              this,
              job,
              outcome.result,
              outcome.writeSet,
            )
          : null;
      if (
        outcome.state !== "completed" &&
        ((outcome.messages?.length ?? 0) ||
          (outcome.variables?.length ?? 0) ||
          outcome.writeSet !== undefined ||
          outcome.pluginStorage !== undefined ||
          outcome.pluginAdmission !== undefined)
      ) {
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Failure and cancellation cannot silently commit a successful output",
        );
      }
      if (outcome.pluginAdmission !== undefined) {
        if (
          outcome.state !== "completed" ||
          outcome.pluginStorage !== undefined
        )
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Request-only plugin admission requires a complete button source guard",
          );
        if (outcome.pluginAdmission?.kind === "browser-generation-v1")
          validateGenerationPluginAdmission(this, job, outcome.pluginAdmission);
        else
          validateButtonPluginAdmission(this, job, outcome.pluginAdmission);
      }
      if (outcome.pluginStorage !== undefined) {
        const pluginId = id(
          outcome.pluginStorage.lease?.namespace?.pluginId,
          "Job plugin source ID",
        );
        validatePluginReadDependencies(this, outcome.pluginStorage.reads, {
          chatId: job.chatId,
          pluginId,
        });
      }
      if (outcome.writeSet !== undefined) {
        if ((outcome.messages?.length ?? 0) || (outcome.variables?.length ?? 0))
          throw new RuntimeError(
            "INVALID_COMMAND",
            "Use one final-write format",
          );
        this.commitJobWriteSet(job, outcome.writeSet);
      }
      if (outcome.pluginStorage !== undefined)
        pluginStorage.commit(this, outcome.pluginStorage, job);
      for (const message of outcome.messages ?? [])
        this.appendMessage(job.chatId, message.id, message.message);
      for (const variable of outcome.variables ?? [])
        this.setVariable(
          job.chatId,
          variable.key,
          variable.value,
          variable.expectedRevision,
        );
      if (outcome.state === "completed")
        this.captureReplyChoices(job, outcome.result);
      this.db
        .prepare(
          "UPDATE jobs SET state=?, result=?, owner=NULL, lease_until=NULL, updated_at=? WHERE id=?",
        )
        .run(
          outcome.state,
          json(
            memoryResult
              ? memorySummaries.finalizeCompletion(this, job, memoryResult)
              : (outcome.result ?? {}),
          ),
          this.now(),
          jobId,
        );
      if (outcome.state === "completed")
        this.db
          .prepare("DELETE FROM job_provider_outputs WHERE job_id=?")
          .run(jobId);
      const result = this.getJob(jobId);
      interactions.closeJob(this, jobId, result.state);
      this.jobEvent(result);
      return { job: result, cursor: this.cursor() };
    });
  }
}

module.exports = { EntityStore };
