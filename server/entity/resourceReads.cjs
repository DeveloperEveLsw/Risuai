"use strict";
const { RuntimeError } = require("./errors.cjs");
const kinds = new Set(["settings", "module", "preset", "persona", "plugin"]);

/** Selected configuration rows keep snapshot values but cannot cross a deleted incarnation. */
function validateResourceReads(store, reads, validation) {
  if (reads === undefined) return;
  if (!Array.isArray(reads) || reads.length > 4096)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Expected at most 4096 resource read dependencies",
    );
  const seen = new Set();
  for (const read of reads) {
    validation.object(read, "resource read dependency");
    if (
      !kinds.has(read.kind) ||
      Object.keys(read).some(
        (key) => !["kind", "id", "expectedEpoch"].includes(key),
      )
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid resource read dependency",
      );
    const id = validation.id(read.id, "read resource ID"),
      epoch = validation.integer(read.expectedEpoch, "read resource epoch");
    const key = JSON.stringify([read.kind, id]);
    if (seen.has(key))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Duplicate resource read dependency",
      );
    seen.add(key);
    if (
      !store.db
        .prepare("SELECT 1 FROM resources WHERE kind=? AND id=?")
        .get(read.kind, id)
    )
      throw new RuntimeError("NOT_FOUND", "Read resource no longer exists");
    store.expectRevision(
      epoch,
      store.fieldEpoch({
        scope: "resource",
        resourceKind: read.kind,
        entityId: id,
      }),
    );
  }
}
module.exports = { validateResourceReads };
