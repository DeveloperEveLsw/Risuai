"use strict";
const { RuntimeError } = require("./errors.cjs");
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/** An explicit original-format export, never an ordinary browser projection. */
function readArchive(
  db,
  { serverId, maxBytes = MAX_ARCHIVE_BYTES, afterPinned } = {},
) {
  db.exec("BEGIN");
  try {
    const authority = db
      .prepare("SELECT id FROM runtime_identity WHERE singleton=1")
      .get().id;
    if (serverId && serverId !== authority)
      throw new RuntimeError(
        "SERVER_CHANGED",
        "Archive belongs to another database",
      );
    const cursor =
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get()
        ?.seq ?? 0;
    afterPinned?.({ serverId: authority, cursor });
    const row = db
      .prepare(
        "SELECT payload FROM resources WHERE kind='settings' AND id='global'",
      )
      .get();
    if (!row)
      throw new RuntimeError("NOT_FOUND", "Global settings do not exist");
    // The legacy original database has no slot for additional settings records.
    // Refuse rather than silently discard such records during reconstruction.
    if (
      db
        .prepare(
          "SELECT 1 FROM resources WHERE kind='settings' AND id!='global' LIMIT 1",
        )
        .get()
    )
      throw new RuntimeError(
        "ARCHIVE_UNSUPPORTED_RESOURCE",
        "Additional settings require a server archive format",
      );
    const database = JSON.parse(row.payload);
    const statistics = db
      .prepare(
        "SELECT messages,imports FROM settings_statistics WHERE settings_id='global'",
      )
      .get();
    if (statistics) database.statics = { ...database.statics, ...statistics };
    let bytes = Buffer.byteLength(JSON.stringify(database));
    const account = (value) => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > maxBytes)
        throw new RuntimeError(
          "ARCHIVE_TOO_LARGE",
          "Archive exceeds the explicit export budget",
        );
      return value;
    };
    for (const [collection, kind] of [
      ["modules", "module"],
      ["botPresets", "preset"],
      ["personas", "persona"],
      ["plugins", "plugin"],
    ]) {
      const rows = db
        .prepare("SELECT id,payload FROM resources WHERE kind=? ORDER BY rowid")
        .all(kind);
      const order = Array.isArray(database[kind + "Ids"])
        ? database[kind + "Ids"]
        : [];
      const values = new Map(
        rows.map((r) => [
          r.id,
          account({ ...JSON.parse(r.payload), id: r.id }),
        ]),
      );
      if (
        new Set(order).size !== order.length ||
        order.some((id) => !values.has(id))
      )
        throw new RuntimeError(
          "ARCHIVE_MISSING_RESOURCE",
          "Resource order contains duplicate or missing entries",
        );
      const ids = [...new Set([...order, ...values.keys()])];
      database[collection] = ids.map((id) => values.get(id));
      delete database[kind + "Ids"];
    }
    database.globalChatVariables = Object.fromEntries(
      db
        .prepare(
          "SELECT id,payload FROM resources WHERE kind='global-variable' ORDER BY rowid",
        )
        .all()
        .map((r) => [r.id, account(JSON.parse(r.payload))]),
    );
    const chats = db.prepare(
      "SELECT * FROM chats WHERE character_id=? ORDER BY sort_position,rowid",
    );
    const messages = db.prepare(
      "SELECT id,payload FROM messages WHERE chat_id=? ORDER BY position",
    );
    const variables = db.prepare(
      "SELECT key,value FROM chat_variables WHERE chat_id=? ORDER BY key",
    );
    const globals = db.prepare(
      "SELECT key,value FROM chat_global_variables WHERE chat_id=? ORDER BY key",
    );
    database.characters = db
      .prepare(
        "SELECT c.*,a.last_interaction FROM characters c LEFT JOIN character_activity a ON a.character_id=c.id ORDER BY c.rowid",
      )
      .all()
      .map((c) => {
        const definition = JSON.parse(c.definition);
        const character = {
          ...definition,
          chaId: c.id,
          chats: [],
          chatPage: 0,
        };
        if (c.last_interaction != null)
          character.lastInteraction = c.last_interaction;
        character.chats = chats.all(c.id).map((t) => {
          const metadata = JSON.parse(t.metadata);
          if (metadata.GLGlobalVariables != null)
            metadata.GLGlobalVariables = Object.fromEntries(
              globals.all(t.id).map((v) => [v.key, JSON.parse(v.value)]),
            );
          return {
            ...metadata,
            id: t.id,
            message: messages
              .all(t.id)
              .map((m) => account({ ...JSON.parse(m.payload), chatId: m.id })),
            scriptstate: Object.fromEntries(
              variables
                .all(t.id)
                .map((v) => [v.key, account(JSON.parse(v.value))]),
            ),
          };
        });
        // Messages have already been accounted for without copying their bodies.
        account({
          ...character,
          chats: character.chats.map((t) => ({
            ...t,
            message: [],
            scriptstate: {},
          })),
        });
        return character;
      });
    // Server history is already hydrated; no browser OPFS placeholders are emitted.
    database.coldstorage = false;
    const assets = db
      .prepare(
        "SELECT id,digest,extension,mime,byte_length AS byteLength FROM assets ORDER BY id",
      )
      .all()
      .map((a) => account({ ...a, path: "assets/runtime/" + a.id }));
    const result = {
      format: "risu-original-archive",
      version: 1,
      serverId: authority,
      cursor,
      database,
      assets,
    };
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > maxBytes)
      throw new RuntimeError(
        "ARCHIVE_TOO_LARGE",
        "Archive exceeds the explicit export budget",
      );
    db.exec("COMMIT");
    return json;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
module.exports = { readArchive, MAX_ARCHIVE_BYTES };
