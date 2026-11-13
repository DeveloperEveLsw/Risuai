"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { readArchive } = require("../entity/archive.cjs");
const { RuntimeError } = require("../entity/errors.cjs");
let resume;
parentPort.on("message", () => resume?.());
async function send(value) {
  await new Promise((resolve) => {
    resume = resolve;
    parentPort.postMessage(value);
  });
  resume = null;
}
(async () => {
  const db = new DatabaseSync(workerData.file, { readOnly: true });
  let json;
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;");
    json = readArchive(db, {
      ...workerData,
      afterPinned: () => {
        // Inspect in readArchive's pinned transaction, before any body is sent.
        // Legacy JSON has no portable slot for server plugin memory. Never
        // silently produce a backup that omits a nonempty plugin namespace.
        const exists = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_storage_items'",
          )
          .get();
        if (
          exists &&
          db
            .prepare(
              "SELECT 1 FROM plugin_storage_items WHERE value IS NOT NULL LIMIT 1",
            )
            .get()
        )
          throw new RuntimeError(
            "ARCHIVE_PLUGIN_STORAGE_UNSUPPORTED",
            "Plugin memory requires a complete server snapshot backup; original-format JSON cannot retain shared plugin storage",
          );
      },
    });
  } finally {
    db.close();
  }
  await send({ start: true });
  for (let i = 0; i < json.length; i += 32768) {
    // Keep surrogate pairs intact when Node encodes each response chunk.
    let end = Math.min(i + 32768, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    await send({ chunk: json.slice(i, end) });
    i = end - 32768;
  }
  parentPort.postMessage({ done: true });
  parentPort.close();
})().catch((error) => {
  parentPort.postMessage({
    error: { code: error.code ?? "ARCHIVE_FAILED", message: error.message },
  });
  parentPort.close();
});
