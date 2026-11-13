"use strict";
const { createHash } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const pluginStorage = require("./pluginStorage.cjs");
const { validateVariableReads } = require("./variableReads.cjs");
const { validateResourceReads } = require("./resourceReads.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

// Internal, caller-owned transactions only. Public routes accept registered
// action identities, never these scopes/write sets. The parent service captures
// the scope and receives write sets from its owned plugin execution child.
function invalid(message) {
  throw new RuntimeError("INVALID_COMMAND", message);
}
function text(value, label) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 256)
    invalid(`${label} must be nonempty bounded text`);
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    invalid(`${label} must be a nonnegative safe integer`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function eventIdentity(input) {
  const eventId = text(input.eventId, "Plugin UI event ID");
  if (
    !/^plugin-ui:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      eventId,
    )
  )
    invalid("Plugin UI event ID must be a prefixed UUID");
  const sessionId = text(input.sessionId, "Plugin UI session ID");
  const requestHash = input.requestHash;
  if (
    requestHash !== undefined &&
    (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash))
  )
    invalid("Plugin UI request hash is invalid");
  return { eventId, sessionId, requestHash };
}
function normalizedScope(input) {
  object(input, "Plugin UI scope");
  const allowed = [
    "chatId",
    "chatEpoch",
    "characterId",
    "characterEpoch",
    "revision",
    "contentRevision",
    "metadataRevision",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    invalid("Plugin UI scope includes unsupported fields");
  return {
    chatId: text(input.chatId, "Plugin UI chat ID"),
    chatEpoch: integer(input.chatEpoch, "Plugin UI chat incarnation"),
    characterId: text(input.characterId, "Plugin UI character ID"),
    characterEpoch: integer(
      input.characterEpoch,
      "Plugin UI character incarnation",
    ),
    revision: integer(input.revision, "Plugin UI snapshot revision"),
    contentRevision: integer(
      input.contentRevision,
      "Plugin UI content revision",
    ),
    metadataRevision: integer(
      input.metadataRevision,
      "Plugin UI metadata revision",
    ),
  };
}
function idle(store, chatId) {
  const active = store.db
    .prepare(
      "SELECT id FROM jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1",
    )
    .get(chatId);
  if (active)
    throw new RuntimeError(
      "CHAT_BUSY",
      "Finish or cancel accepted jobs before committing a plugin UI edit",
      { jobId: active.id },
    );
}
function capture(store, input) {
  const chat = store.requireChat(text(input.chatId, "Plugin UI chat ID"));
  idle(store, chat.id);
  return {
    chatId: chat.id,
    chatEpoch: store.fieldEpoch({ scope: "chat", entityId: chat.id }),
    characterId: chat.character_id,
    characterEpoch: store.fieldEpoch({
      scope: "character",
      entityId: chat.character_id,
    }),
    revision: chat.revision,
    contentRevision: chat.content_revision,
    metadataRevision: store.metadataRevision(chat.id),
  };
}
function guardScope(store, input) {
  const scope = normalizedScope(input),
    chat = store.requireChat(scope.chatId);
  idle(store, scope.chatId);
  if (chat.character_id !== scope.characterId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Plugin UI scope belongs to another character",
    );
  if (
    !store.db
      .prepare("SELECT 1 FROM characters WHERE id=?")
      .get(scope.characterId)
  )
    throw new RuntimeError("NOT_FOUND", "Plugin UI character was removed");
  store.expectRevision(
    scope.chatEpoch,
    store.fieldEpoch({ scope: "chat", entityId: scope.chatId }),
  );
  store.expectRevision(
    scope.characterEpoch,
    store.fieldEpoch({ scope: "character", entityId: scope.characterId }),
  );
  store.expectRevision(scope.revision, chat.revision);
  store.expectRevision(scope.contentRevision, chat.content_revision);
  store.expectRevision(scope.metadataRevision, store.metadataRevision(chat.id));
  return scope;
}
function browserLease(store, input) {
  object(input, "Plugin UI lease");
  const namespace = pluginStorage.namespaceOf(input.namespace);
  // keys validates the current plugin incarnation and exact code hash without
  // decoding its graph. Actual graph writes still pass pluginStorage.commit.
  pluginStorage.keys(store, namespace);
  const lease = {
    namespace,
    writerId: text(input.writerId, "Plugin UI writer ID"),
    token: text(input.token, "Plugin UI writer token"),
    fence: integer(input.fence, "Plugin UI writer fence"),
  };
  const row = store.db
    .prepare(
      "SELECT writer_id,lease_token,fence,lease_until,authority FROM plugin_storage_namespaces WHERE plugin_id=? AND bundle_sha=? AND plugin_epoch=?",
    )
    .get(namespace.pluginId, namespace.bundleSha, namespace.pluginEpoch);
  if (
    !row ||
    row.writer_id !== lease.writerId ||
    row.lease_token !== lease.token ||
    row.fence !== lease.fence ||
    row.lease_until <= store.now()
  )
    throw new RuntimeError(
      "STALE_PLUGIN_WORKER",
      "Plugin UI writer ownership is absent, expired or fenced",
    );
  if (JSON.parse(row.authority)?.kind !== "browser")
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Plugin UI edits require a browser-owned lease",
    );
  const enabled = store.db
    .prepare(
      "SELECT json_type(payload,'$.enabled') AS enabled FROM resources WHERE kind='plugin' AND id=?",
    )
    .get(namespace.pluginId);
  if (enabled?.enabled !== "true")
    throw new RuntimeError(
      "PLUGIN_DISABLED",
      "Disabled plugins cannot commit UI edits",
    );
  return lease;
}
function getEvent(store, input, required = false) {
  const identity = eventIdentity(input);
  const row = store.db
    .prepare("SELECT payload,result,created_at FROM commands WHERE id=?")
    .get(identity.eventId);
  if (!row) {
    if (required)
      throw new RuntimeError("NOT_FOUND", "Plugin UI event was not admitted");
    return null;
  }
  const payload = JSON.parse(row.payload),
    result = row.result === null ? null : JSON.parse(row.result);
  if (payload.type !== "plugin-ui-event")
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Command is not a plugin UI event",
    );
  if (payload.sessionId !== identity.sessionId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Plugin UI event belongs to another session",
    );
  if (
    identity.requestHash !== undefined &&
    payload.requestHash !== identity.requestHash
  )
    throw new RuntimeError(
      "IDEMPOTENCY_CONFLICT",
      "Plugin UI event was reused with different input",
    );
  if (!result || !["admitted", "completed", "failed"].includes(result.state))
    throw new RuntimeError(
      "PLUGIN_UI_EVENT_UNCERTAIN",
      "Plugin UI event has no supported execution receipt",
    );
  return { payload, result, createdAt: row.created_at };
}
function header(event) {
  return {
    eventId: event.payload.eventId,
    sessionId: event.payload.sessionId,
    requestHash: event.payload.requestHash,
    state: event.result.state,
    ...(event.result.appliedRevision === undefined
      ? {}
      : { appliedRevision: event.result.appliedRevision }),
    ...(event.result.pluginRevision === undefined
      ? {}
      : {
          pluginRevision: event.result.pluginRevision,
          commitId: event.result.commitId,
        }),
    ...(event.result.code === undefined ? {} : { code: event.result.code }),
  };
}
function read(store, input) {
  const event = getEvent(store, input);
  return event ? header(event) : null;
}
function admit(store, input) {
  const identity = eventIdentity(input);
  if (identity.requestHash === undefined)
    invalid("Plugin UI admission requires a request hash");
  const scope = guardScope(store, input.scope),
    lease = browserLease(store, input.lease);
  const payload = { type: "plugin-ui-event", ...identity, scope, lease };
  const serialized = JSON.stringify(payload),
    hash = digest(serialized);
  const existing = store.db
    .prepare("SELECT payload_hash FROM commands WHERE id=?")
    .get(identity.eventId);
  if (existing) {
    if (existing.payload_hash !== hash)
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Plugin UI event was reused with another scope or writer",
      );
    return { ...header(getEvent(store, identity, true)), replayed: true };
  }
  const result = { state: "admitted" };
  store.db
    .prepare(
      "INSERT INTO commands(id,payload_hash,payload,result,created_at) VALUES (?,?,?,?,?)",
    )
    .run(
      identity.eventId,
      hash,
      serialized,
      JSON.stringify(result),
      store.now(),
    );
  return { ...header({ payload, result }), replayed: false };
}
function commit(store, input) {
  const scope = guardScope(store, input.scope),
    lease = browserLease(store, input.pluginStorage?.lease),
    writes = object(input.writeSet, "Plugin UI write set");
  if (writes.chatId !== scope.chatId)
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Plugin UI write set belongs to another chat",
    );
  store.expectRevision(writes.expectedRevision, scope.revision);
  store.expectRevision(writes.expectedContentRevision, scope.contentRevision);
  if (
    !Array.isArray(writes.characterReads) ||
    !writes.characterReads.some(
      (read) =>
        read.id === scope.characterId &&
        read.expectedEpoch === scope.characterEpoch,
    )
  )
    invalid("Plugin UI write set has no captured owner incarnation");
  const captured = {
    type: "plugin-ui",
    chatId: scope.chatId,
    chatEpoch: scope.chatEpoch,
    startedRevision: scope.revision,
    startedContentRevision: scope.contentRevision,
    startedMetadataRevision: scope.metadataRevision,
  };
  validatePluginReadDependencies(store, input.pluginStorage.reads, {
    chatId: scope.chatId,
    pluginId: lease.namespace.pluginId,
  });
  // This reuses original variable/resource/character point-read guards before
  // applying any writes. A later graph/CAS failure rolls all chat writes back.
  store.commitJobWriteSet(captured, writes);
  const graph = pluginStorage.commit(store, { ...input.pluginStorage, lease });
  return { chatId: scope.chatId, cursor: store.cursor(), pluginStorage: graph };
}
function check(store, input) {
  const scope = guardScope(store, input.scope),
    lease = browserLease(store, input.lease);
  const reads = input.reads ?? {};
  object(reads, "Plugin UI read dependencies");
  validatePluginReadDependencies(
    store,
    input.pluginReads ?? (reads.version === 1 ? reads : undefined),
    { chatId: scope.chatId, pluginId: lease.namespace.pluginId },
  );
  const validation = { id: text, integer, object };
  validateVariableReads(store, scope.chatId, reads.variableReads, validation);
  validateResourceReads(store, reads.resourceReads, validation);
  if (reads.characterReads !== undefined) {
    if (
      !Array.isArray(reads.characterReads) ||
      reads.characterReads.length > 4096
    )
      invalid("Plugin UI character read dependencies are invalid");
    const seen = new Set();
    for (const read of reads.characterReads) {
      object(read, "Plugin UI character read dependency");
      if (
        Object.keys(read).some((key) => !["id", "expectedEpoch"].includes(key))
      )
        invalid(
          "Plugin UI character read dependency includes unsupported fields",
        );
      const id = text(read.id, "Plugin UI read character ID"),
        epoch = integer(
          read.expectedEpoch,
          "Plugin UI read character incarnation",
        );
      if (seen.has(id))
        invalid("Duplicate plugin UI character read dependency");
      seen.add(id);
      if (!store.db.prepare("SELECT 1 FROM characters WHERE id=?").get(id))
        throw new RuntimeError(
          "NOT_FOUND",
          "Plugin UI read character was removed",
        );
      store.expectRevision(
        epoch,
        store.fieldEpoch({ scope: "character", entityId: id }),
      );
    }
  }
  return {
    scope,
    namespace: lease.namespace,
    writerId: lease.writerId,
    writerFence: lease.fence,
  };
}
function complete(store, input) {
  if (eventIdentity(input).requestHash === undefined)
    invalid("Plugin UI completion requires the admitted request hash");
  const appliedRevision = integer(
    input.appliedRevision,
    "Plugin UI applied DOM revision",
  );
  const event = getEvent(store, input, true);
  if (event.result.state === "completed") {
    if (event.result.appliedRevision !== appliedRevision)
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Plugin UI completion reused another DOM revision",
      );
    return header(event);
  }
  if (event.result.state !== "admitted")
    throw new RuntimeError(
      "PLUGIN_UI_EVENT_UNCERTAIN",
      "Failed plugin UI events cannot be replayed",
    );
  const lease = browserLease(store, input.pluginStorage?.lease);
  if (JSON.stringify(lease) !== JSON.stringify(event.payload.lease))
    throw new RuntimeError(
      "IDENTITY_CONFLICT",
      "Plugin UI completion has a different writer incarnation",
    );
  const applied = commit(store, {
    scope: event.payload.scope,
    writeSet: input.writeSet,
    pluginStorage: input.pluginStorage,
  });
  const result = {
    state: "completed",
    appliedRevision,
    pluginRevision: applied.pluginStorage.revision,
    commitId: applied.pluginStorage.commitId,
  };
  store.db
    .prepare("UPDATE commands SET result=? WHERE id=?")
    .run(JSON.stringify(result), event.payload.eventId);
  return {
    ...header({ ...event, result }),
    scope: capture(store, { chatId: event.payload.scope.chatId }),
    snapshot: store.pluginUISnapshot(event.payload.scope.chatId),
    pluginStorage: applied.pluginStorage,
  };
}
function fail(store, input) {
  if (eventIdentity(input).requestHash === undefined)
    invalid("Plugin UI failure requires the admitted request hash");
  const event = getEvent(store, input, true);
  if (event.result.state !== "admitted") return header(event);
  const code = input.code ?? "PLUGIN_UI_EVENT_FAILED";
  if (typeof code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(code))
    invalid("Plugin UI failure must be a bounded error code");
  const result = { state: "failed", code };
  store.db
    .prepare("UPDATE commands SET result=? WHERE id=?")
    .run(JSON.stringify(result), event.payload.eventId);
  return header({ ...event, result });
}
module.exports = { capture, read, admit, commit, complete, fail, check };
