"use strict";
const { appendFile, chmod, rename, stat, unlink } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  diagnosticRequestId,
  runtimeDiagnosticRecord,
} = require("../../src/ts/runtime/runtimeDiagnosticProtocol.mjs");

/** Independent, bounded metadata journal; never writes through the entity DB. */
class RuntimeDiagnostics {
  constructor(file, options = {}) {
    this.file = file;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.maxQueued = options.maxQueued ?? 256;
    this.queue = [];
    this.writing = null;
    this.closed = false;
    this.dropped = 0;
    this.writeFailures = 0;
  }
  record(value) {
    if (this.closed || this.queue.length >= this.maxQueued) {
      this.dropped++;
      return;
    }
    this.queue.push(JSON.stringify(runtimeDiagnosticRecord(value)) + "\n");
    this.writing ??= this.drain();
  }
  async drain() {
    try {
      let size = await stat(this.file)
        .then((v) => v.size)
        .catch((e) => {
          if (e.code === "ENOENT") return 0;
          throw e;
        });
      while (this.queue.length) {
        const line = this.queue.shift(),
          bytes = Buffer.byteLength(line);
        if (size + bytes > this.maxBytes) {
          await unlink(this.file + ".1").catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          await rename(this.file, this.file + ".1").catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          size = 0;
        }
        if (bytes > this.maxBytes) {
          this.dropped++;
          continue;
        }
        await appendFile(this.file, line, { mode: 0o600 });
        // Restrict an existing journal as well as newly created files.
        if (!size) await chmod(this.file, 0o600);
        size += bytes;
      }
    } catch {
      this.writeFailures++;
      this.dropped += this.queue.length;
      this.queue.length = 0;
    } finally {
      this.writing = null;
    }
  }
  async flush() {
    while (this.writing) await this.writing;
  }
  async close() {
    this.closed = true;
    await this.flush();
  }
}
function traceRequest(req, res, trustForwarded = false) {
  req.runtimeRequestId = trustForwarded
    ? diagnosticRequestId(req.headers["risu-request-id"])
    : undefined;
  req.runtimeRequestId ??= randomUUID();
  req.runtimeStartedAt = performance.now();
  res.setHeader("Risu-Request-Id", req.runtimeRequestId);
}
function recordRequestFailure(journal, req, code, status, kind = "http-error") {
  journal.record({
    kind,
    code,
    status,
    requestId: req.runtimeRequestId,
    endpoint: req.originalUrl,
    method: req.method,
    elapsedMs: performance.now() - req.runtimeStartedAt,
  });
}
module.exports = { RuntimeDiagnostics, traceRequest, recordRequestFailure };
