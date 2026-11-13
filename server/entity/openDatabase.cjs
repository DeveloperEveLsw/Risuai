"use strict";

const { DatabaseSync } = require("node:sqlite");

// Concurrent first open can return SQLITE_BUSY while changing journal mode,
// even with busy_timeout. Retry only connection setup, before any schema,
// command, job or user transaction. Close the losing connection before waiting.
function openDatabase(file, timeoutMs = 5000, Database = DatabaseSync) {
  const deadline = performance.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let db;
    try {
      db = new Database(file);
      const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
      db.exec(
        `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${remaining}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
      );
      // Preserve the ordinary transaction wait policy after initialization.
      db.exec("PRAGMA busy_timeout=5000;");
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Keep the original initialization error.
      }
      const remaining = deadline - performance.now();
      if (
        error.code !== "ERR_SQLITE_ERROR" ||
        (error.errcode & 255) !== 5 ||
        remaining <= 0
      )
        throw error;
      Atomics.wait(pause, 0, 0, Math.min(25, remaining));
    }
  }
}

module.exports = { openDatabase };
