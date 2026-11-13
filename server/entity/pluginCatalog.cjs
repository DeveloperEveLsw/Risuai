"use strict";

const { RuntimeError } = require("./errors.cjs");
const PROJECTION = "wyglore-live-gardens-v1";
const CURRENT_SCOPE_PROJECTION = "wyglore-current-scope-v1";
const MAX_ROWS = 4096;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

const CHARACTER_METADATA = `SELECT c.id,c.revision,
  COALESCE((SELECT revision FROM entity_tombstones WHERE kind='character' AND scope='' AND id=c.id),0) AS epoch
  FROM characters c ORDER BY c.rowid`;
const CHAT_METADATA = `SELECT c.id,c.character_id AS characterId,c.revision,
  c.content_revision AS contentRevision,c.sort_position AS sortPosition,
  COALESCE((SELECT revision FROM entity_tombstones WHERE kind='chat' AND scope='' AND id=c.id),0) AS epoch,
  COALESCE((SELECT SUM(revision) FROM entity_field_revisions WHERE scope='chat' AND kind='' AND entity_id=c.id),0) AS metadataRevision,
  (SELECT id FROM messages WHERE chat_id=c.id ORDER BY position LIMIT 1) AS firstMessageId
  FROM chats c ORDER BY c.character_id,c.sort_position,c.rowid`;

// Match the original markerWebKeyOf's FIRST matching entry, including malformed
// first markers. Do not skip a malformed one and expose a later valid marker.
// SQL extracts only the matching marker's key/comment/webKey. It never returns
// other lore text, the marker's fingerprint, or the complete metadata document.
const MARKERS = `WITH entries AS (
  SELECT c.id AS chatId,CAST(j.key AS INTEGER) AS position,
    json_extract(j.value,'$.key') AS key,json_extract(j.value,'$.comment') AS comment,
    CASE WHEN json_type(j.value,'$.content')='text'
      THEN CASE WHEN json_valid(json_extract(j.value,'$.content'))
        THEN (SELECT CASE WHEN w.type='text' THEN w.value END
          FROM json_each(json_extract(j.value,'$.content')) w
          WHERE w.key='webKey' ORDER BY w.id DESC LIMIT 1) END END AS webKey
  FROM chats c,json_each(CASE WHEN json_type(c.metadata,'$.localLore')='array'
    THEN json_extract(c.metadata,'$.localLore') ELSE '[]' END) j WHERE j.type='object'
),matched AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY chatId ORDER BY position) AS ordinal
  FROM entries WHERE key='__wl_marker__' OR (
    typeof(comment)='text' AND lower(substr(comment,1,11))='wl.marker.v'
    AND length(comment)>11 AND substr(comment,12) NOT GLOB '*[^0-9]*'
  )
) SELECT chatId,key,comment,webKey FROM matched WHERE ordinal=1`;

function invalid(message) {
  throw new RuntimeError("PLUGIN_READ_DEPENDENCY_INVALID", message);
}
function identity(value) {
  if (typeof value !== "string" || !value || value.length > 256)
    invalid("Plugin catalog identity is invalid");
  return value;
}
function integer(value, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0))
    invalid("Plugin catalog revision, order or incarnation is invalid");
  return value;
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid("Plugin catalog guard shape is invalid");
}
function boundedRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS)
    invalid("Plugin catalog guard row limit exceeded");
  return Array.from(rows);
}
function checkedGuard(guard) {
  object(guard, ["version", "projection", "characters", "chats"]);
  if (guard.version !== 1 || guard.projection !== PROJECTION)
    invalid("A reviewed live-garden catalog version 1 is required");
  const seenCharacters = new Set(),
    seenChats = new Set();
  const characters = boundedRows(guard.characters).map((row) => {
    object(row, ["id", "revision", "epoch"]);
    const id = identity(row.id);
    if (seenCharacters.has(id)) invalid("Duplicate plugin catalog character");
    seenCharacters.add(id);
    return { id, revision: integer(row.revision), epoch: integer(row.epoch) };
  });
  const chats = boundedRows(guard.chats).map((row) => {
    object(row, [
      "id",
      "characterId",
      "revision",
      "epoch",
      "contentRevision",
      "metadataRevision",
      "sortPosition",
      "firstMessageId",
    ]);
    const id = identity(row.id),
      characterId = identity(row.characterId);
    if (seenChats.has(id) || !seenCharacters.has(characterId))
      invalid("Duplicate or orphaned plugin catalog chat");
    seenChats.add(id);
    return {
      id,
      characterId,
      revision: integer(row.revision),
      epoch: integer(row.epoch),
      contentRevision: integer(row.contentRevision),
      metadataRevision: integer(row.metadataRevision),
      sortPosition: integer(row.sortPosition, true),
      firstMessageId:
        row.firstMessageId === null ? null : identity(row.firstMessageId),
    };
  });
  if (characters.length + chats.length > MAX_ROWS)
    invalid("Plugin catalog guard row limit exceeded");
  return { version: 1, projection: PROJECTION, characters, chats };
}

/** A read-only projection for the reviewed original plugin's three catalog
 * consumers: live-garden enumeration, garden name maps and stale toggle cleanup.
 * This is deliberately not a full getDatabase().characters/history capability.
 * Message arrays contain only the first stable message ID required by legacy
 * garden keys. All source bodies remain outside the returned facade.
 * The caller owns a consistent read transaction; no transaction or write here.
 */
function capture(store, options = {}) {
  const maxRows = options.maxRows ?? MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > MAX_ROWS)
    invalid("Plugin catalog capture limit is invalid");
  const rows = store.db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM characters)+(SELECT COUNT(*) FROM chats) AS rows",
    )
    .get().rows;
  if (rows > maxRows)
    throw new RuntimeError(
      "PLUGIN_CATALOG_LIMIT",
      "The complete live-garden catalog exceeds its row budget; partial deletion evidence is refused",
    );
  const budget = store.db
    .prepare(
      `SELECT
    (SELECT COALESCE(SUM(length(CAST(name AS BLOB))),0) FROM characters) AS nameBytes,
    (SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))),0) FROM chats) AS metadataBytes`,
    )
    .get();
  if (
    budget.nameBytes > MAX_OUTPUT_BYTES ||
    budget.metadataBytes > MAX_METADATA_BYTES
  )
    throw new RuntimeError(
      "PLUGIN_CATALOG_LIMIT",
      "The complete live-garden catalog exceeds its read budget; partial deletion evidence is refused",
    );
  const characterRows = store.db
    .prepare(
      CHARACTER_METADATA.replace("c.id,c.revision", "c.id,c.name,c.revision"),
    )
    .all();
  const chatRows = store.db
    .prepare(
      CHAT_METADATA.replace(
        "c.id,c.character_id",
        "c.id,c.name,json_extract(c.metadata,'$.bindedPersona') AS bindedPersona,json_type(c.metadata,'$.bindedPersona') AS personaType,c.character_id",
      ),
    )
    .all();
  const markers = new Map(
    store.db
      .prepare(MARKERS)
      .all()
      .map((row) => [row.chatId, row]),
  );
  const characters = characterRows.map((row) => ({
    chaId: row.id,
    name: row.name,
    chats: [],
  }));
  const byCharacter = new Map(characters.map((row) => [row.chaId, row]));
  for (const row of chatRows) {
    if (row.personaType && !["text", "null"].includes(row.personaType))
      throw new RuntimeError(
        "PLUGIN_CATALOG_UNSUPPORTED",
        "Live-garden bound persona must be a string or null",
      );
    const marker = markers.get(row.id);
    const localLore = marker
      ? [
          {
            ...(marker.key === "__wl_marker__"
              ? { key: marker.key }
              : { comment: marker.comment }),
            content: JSON.stringify(
              typeof marker.webKey === "string"
                ? { webKey: marker.webKey }
                : {},
            ),
          },
        ]
      : [];
    byCharacter.get(row.characterId).chats.push({
      id: row.id,
      name: row.name,
      ...(row.personaType ? { bindedPersona: row.bindedPersona } : {}),
      message:
        row.firstMessageId === null ? [] : [{ chatId: row.firstMessageId }],
      localLore,
    });
  }
  const guard = checkedGuard({
    version: 1,
    projection: PROJECTION,
    characters: characterRows.map(({ id, revision, epoch }) => ({
      id,
      revision,
      epoch,
    })),
    chats: chatRows.map(
      ({
        id,
        characterId,
        revision,
        epoch,
        contentRevision,
        metadataRevision,
        sortPosition,
        firstMessageId,
      }) => ({
        id,
        characterId,
        revision,
        epoch,
        contentRevision,
        metadataRevision,
        sortPosition,
        firstMessageId,
      }),
    ),
  });
  const result = { projection: PROJECTION, characters, guard };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
    throw new RuntimeError(
      "PLUGIN_CATALOG_LIMIT",
      "The complete live-garden projection exceeds its output budget",
    );
  return result;
}

/** Validate only metadata, including full catalog membership and chat order.
 * Character/chat revisions conservatively reject unrelated source edits too.
 * Exact first message ID remains guarded even if a writer violated counters.
 */
function validate(store, input) {
  const guard = checkedGuard(input);
  const total = store.db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM characters)+(SELECT COUNT(*) FROM chats) AS rows",
    )
    .get().rows;
  if (
    total > MAX_ROWS ||
    total !== guard.characters.length + guard.chats.length
  )
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Plugin live-garden catalog membership changed",
    );
  const characters = store.db.prepare(CHARACTER_METADATA).all(),
    chats = store.db.prepare(CHAT_METADATA).all();
  const byCharacter = new Map(characters.map((row) => [row.id, row])),
    byChat = new Map(chats.map((row) => [row.id, row]));
  if (
    characters.length !== guard.characters.length ||
    chats.length !== guard.chats.length
  )
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Plugin live-garden catalog membership changed",
    );
  for (const row of guard.characters) {
    const current = byCharacter.get(row.id);
    if (!current)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Plugin live-garden character membership changed",
      );
    store.expectRevision(row.revision, current.revision);
    store.expectRevision(row.epoch, current.epoch);
  }
  for (const row of guard.chats) {
    const current = byChat.get(row.id);
    if (
      !current ||
      current.characterId !== row.characterId ||
      current.sortPosition !== row.sortPosition ||
      current.firstMessageId !== row.firstMessageId
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Plugin live-garden chat identity, order or legacy-key source changed",
      );
    for (const key of [
      "revision",
      "epoch",
      "contentRevision",
      "metadataRevision",
    ])
      store.expectRevision(row[key], current[key]);
  }
  return true;
}

function checkedScopeGuard(input) {
  object(input, [
    "version",
    "projection",
    "characterId",
    "chatId",
    "characterIndex",
    "chatIndex",
    "characterRevision",
    "characterEpoch",
    "chats",
  ]);
  if (input.version !== 1 || input.projection !== CURRENT_SCOPE_PROJECTION)
    invalid("A reviewed current-garden scope version 1 is required");
  const characterId = identity(input.characterId),
    chatId = identity(input.chatId),
    characterIndex = integer(input.characterIndex),
    chatIndex = integer(input.chatIndex),
    characterRevision = integer(input.characterRevision),
    characterEpoch = integer(input.characterEpoch);
  const normalized = checkedGuard({
    version: 1,
    projection: PROJECTION,
    characters: [
      { id: characterId, revision: characterRevision, epoch: characterEpoch },
    ],
    chats: input.chats,
  });
  if (normalized.chats[chatIndex]?.id !== chatId)
    invalid("Current-garden index does not identify the captured chat");
  return {
    version: 1,
    projection: CURRENT_SCOPE_PROJECTION,
    characterId,
    chatId,
    characterIndex,
    chatIndex,
    characterRevision,
    characterEpoch,
    chats: normalized.chats,
  };
}
function currentCharacter(store, characterId) {
  return store.db
    .prepare(
      `SELECT c.id,c.revision,
    (SELECT COUNT(*) FROM characters previous WHERE previous.rowid<c.rowid) AS characterIndex,
    COALESCE((SELECT revision FROM entity_tombstones WHERE kind='character' AND scope='' AND id=c.id),0) AS epoch
    FROM characters c WHERE c.id=?`,
    )
    .get(characterId);
}
function currentChatRows(store, characterId, projection = false) {
  const sql = CHAT_METADATA.replace(
    "FROM chats c ORDER BY",
    "FROM chats c WHERE c.character_id=? ORDER BY",
  );
  return store.db
    .prepare(
      projection
        ? sql.replace(
            "c.id,c.character_id",
            "c.id,c.name,json_extract(c.metadata,'$.bindedPersona') AS bindedPersona,json_type(c.metadata,'$.bindedPersona') AS personaType,c.character_id",
          )
        : sql,
    )
    .all(characterId);
}
function projectedChat(row, marker) {
  if (row.personaType && !["text", "null"].includes(row.personaType))
    throw new RuntimeError(
      "PLUGIN_CATALOG_UNSUPPORTED",
      "Live-garden bound persona must be a string or null",
    );
  return {
    id: row.id,
    name: row.name,
    ...(row.personaType ? { bindedPersona: row.bindedPersona } : {}),
    message:
      row.firstMessageId === null ? [] : [{ chatId: row.firstMessageId }],
    localLore: marker
      ? [
          {
            ...(marker.key === "__wl_marker__"
              ? { key: marker.key }
              : { comment: marker.comment }),
            content: JSON.stringify(
              typeof marker.webKey === "string"
                ? { webKey: marker.webKey }
                : {},
            ),
          },
        ]
      : [],
  };
}
/** Native jobs need only the current character's sibling headers and numeric
 * global character index. They never enumerate other histories or characters.
 * Both UI and generation now derive the exact same original-plugin garden key.
 */
function captureCurrentScope(store, inputChatId) {
  const chatId = identity(inputChatId),
    target = store.db
      .prepare("SELECT character_id FROM chats WHERE id=?")
      .get(chatId);
  if (!target)
    throw new RuntimeError("NOT_FOUND", "Current-garden chat was removed");
  const characterId = target.character_id,
    character = currentCharacter(store, characterId);
  const budget = store.db
    .prepare(
      "SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(metadata AS BLOB))),0) AS metadataBytes FROM chats WHERE character_id=?",
    )
    .get(characterId);
  if (budget.rows + 1 > MAX_ROWS || budget.metadataBytes > MAX_METADATA_BYTES)
    throw new RuntimeError(
      "PLUGIN_CATALOG_LIMIT",
      "Complete current-garden sibling headers exceed their read budget",
    );
  const rows = currentChatRows(store, characterId, true),
    markers = new Map(
      store.db
        .prepare(
          MARKERS.replace(
            "WHERE j.type='object'",
            "WHERE j.type='object' AND c.character_id=?",
          ),
        )
        .all(characterId)
        .map((row) => [row.chatId, row]),
    );
  const guard = checkedScopeGuard({
    version: 1,
    projection: CURRENT_SCOPE_PROJECTION,
    characterId,
    chatId,
    characterIndex: character.characterIndex,
    chatIndex: rows.findIndex((row) => row.id === chatId),
    characterRevision: character.revision,
    characterEpoch: character.epoch,
    chats: rows.map(
      ({
        id,
        characterId,
        revision,
        epoch,
        contentRevision,
        metadataRevision,
        sortPosition,
        firstMessageId,
      }) => ({
        id,
        characterId,
        revision,
        epoch,
        contentRevision,
        metadataRevision,
        sortPosition,
        firstMessageId,
      }),
    ),
  });
  const result = {
    projection: CURRENT_SCOPE_PROJECTION,
    characterId,
    chatId,
    characterIndex: guard.characterIndex,
    chatIndex: guard.chatIndex,
    chats: rows.map((row) => projectedChat(row, markers.get(row.id))),
    guard,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
    throw new RuntimeError(
      "PLUGIN_CATALOG_LIMIT",
      "Complete current-garden scope exceeds its output budget",
    );
  return result;
}
function validateCurrentScope(store, input) {
  const guard = checkedScopeGuard(input),
    character = currentCharacter(store, guard.characterId);
  if (!character || character.characterIndex !== guard.characterIndex)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Current-garden character index changed",
    );
  store.expectRevision(guard.characterRevision, character.revision);
  store.expectRevision(guard.characterEpoch, character.epoch);
  const count = store.db
    .prepare("SELECT COUNT(*) AS count FROM chats WHERE character_id=?")
    .get(guard.characterId).count;
  if (count !== guard.chats.length || count + 1 > MAX_ROWS)
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Current-garden sibling membership changed",
    );
  const rows = currentChatRows(store, guard.characterId);
  for (let index = 0; index < rows.length; index++) {
    const row = guard.chats[index],
      current = rows[index];
    if (
      row.id !== current.id ||
      row.characterId !== current.characterId ||
      row.sortPosition !== current.sortPosition ||
      row.firstMessageId !== current.firstMessageId
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Current-garden sibling identity, order or legacy-key source changed",
      );
    for (const key of [
      "revision",
      "epoch",
      "contentRevision",
      "metadataRevision",
    ])
      store.expectRevision(row[key], current[key]);
  }
  return true;
}

module.exports = {
  PROJECTION,
  CURRENT_SCOPE_PROJECTION,
  MAX_ROWS,
  capture,
  checkedGuard,
  validate,
  captureCurrentScope,
  checkedScopeGuard,
  validateCurrentScope,
};
