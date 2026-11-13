"use strict";
const { EntityStore } = require("../entity/store.cjs");

/** A consistent WAL read on the engine thread, outside durable command admission. */
function readExecutionSnapshot(reader, job) {
  const view = Object.create(EntityStore.prototype);
  view.db = reader;
  view.now = Date.now;
  reader.exec("BEGIN");
  try {
    view.requireOwner(job.id, job.owner, job.fence);
    const snapshot = view.executionSnapshot(job.chatId);
    view.expectRevision(
      job.startedContentRevision ?? job.startedRevision,
      snapshot.chat.contentRevision ?? snapshot.chat.revision,
    );
    reader.exec("COMMIT");
    return snapshot;
  } catch (error) {
    reader.exec("ROLLBACK");
    throw error;
  }
}
/** Lazy definitions and their field guards must come from the same WAL view. */
function readCharacterSnapshot(reader, id) {
  const view = Object.create(EntityStore.prototype);
  view.db = reader;
  reader.exec("BEGIN");
  try {
    // This reader already pins the definition and its guards in one WAL view.
    // getCharacter owns a separate transaction for standalone API reads.
    const character = view.characterView(id);
    reader.exec("COMMIT");
    return character;
  } catch (error) {
    reader.exec("ROLLBACK");
    throw error;
  }
}
module.exports = { readExecutionSnapshot, readCharacterSnapshot };
