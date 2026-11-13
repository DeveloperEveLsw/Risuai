"use strict";
const { Worker } = require("node:worker_threads");
const { join } = require("node:path");
const { RuntimeError } = require("../entity/errors.cjs");

/** Isolated readonly WAL capture; slow exports cannot occupy the command worker. */
class ArchiveExports {
  constructor(file, serverId, options = {}) {
    this.file = file;
    this.serverId = serverId;
    this.options = options;
    this.active = new Set();
    this.closing = false;
  }
  async stream(res, workerOptions = {}) {
    if (res.destroyed || res.writableEnded)
      throw new RuntimeError(
        "ARCHIVE_ABORTED",
        "Archive download already disconnected",
      );
    if (this.closing)
      throw new RuntimeError("STORE_CLOSED", "Archive service is closing");
    if (this.active.size)
      throw new RuntimeError(
        "ARCHIVE_BUSY",
        "Another archive export is in progress",
      );
    const worker = new Worker(
      join(__dirname, this.options.workerFile ?? "archiveWorker.cjs"),
      {
        workerData: {
          file: this.file,
          serverId: this.serverId,
          maxBytes: this.options.maxBytes,
          ...workerOptions,
        },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      },
    );
    this.active.add(worker);
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          res.off("close", disconnect);
          error ? reject(error) : resolve();
        };
        const disconnect = () =>
          finish(
            new RuntimeError(
              "ARCHIVE_ABORTED",
              "Archive download disconnected",
            ),
          );
        res.once("close", disconnect);
        worker.on("message", (value) => {
          if (settled) return;
          try {
            if (value.error)
              return finish(
                new RuntimeError(value.error.code, value.error.message),
              );
            if (value.start) {
              res.type(value.mime ?? "application/json");
              if (value.filename) res.attachment(value.filename);
              worker.postMessage({ next: true });
            } else if (value.chunk !== undefined) {
              res.write(value.chunk, (error) => {
                if (error) finish(error);
                else if (!settled) worker.postMessage({ next: true });
              });
            } else if (value.done) {
              finish();
              res.end();
            }
          } catch (error) {
            finish(error);
          }
        });
        worker.once("error", finish);
        worker.once("exit", (code) => {
          if (!settled)
            finish(
              new RuntimeError(
                "ARCHIVE_FAILED",
                "Archive worker stopped before completion (" + code + ")",
              ),
            );
        });
      });
    } finally {
      await worker.terminate();
      this.active.delete(worker);
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled(
      [...this.active].map((worker) => worker.terminate()),
    );
  }
}
module.exports = { ArchiveExports };
