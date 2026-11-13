"use strict";
const { RuntimeError } = require("./errors.cjs");
const { readVariable } = require("./variables.cjs");

/** Recheck every declared point read before any canonical final write or recovery. */
function validateVariableReads(store, chatId, reads, { id, integer, object }) {
  if (reads === undefined) return; // Trusted legacy internal write sets retain their explicit policy.
  if (!Array.isArray(reads) || reads.length > 4096)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Expected at most 4096 variable read dependencies",
    );
  const seen = new Set();
  for (const read of reads) {
    object(read, "variable read dependency");
    if (
      Object.keys(read).some(
        (key) =>
          !["scope", "key", "expectedRevision", "expectedExists"].includes(key),
      ) ||
      !["chat", "chat-global", "global"].includes(read.scope) ||
      typeof read.expectedExists !== "boolean"
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid variable read dependency",
      );
    const key = id(read.key, "read variable key");
    integer(read.expectedRevision, "variable read revision");
    const identity = JSON.stringify([read.scope, key]);
    if (seen.has(identity))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Duplicate variable read dependency",
      );
    seen.add(identity);
    const current = readVariable(store, {
      scope: read.scope,
      key,
      ...(read.scope === "global" ? {} : { chatId }),
    });
    store.expectRevision(read.expectedRevision, current.revision);
    if (read.expectedExists !== current.exists)
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Read variable presence changed after execution snapshot",
      );
  }
}
module.exports = { validateVariableReads };
