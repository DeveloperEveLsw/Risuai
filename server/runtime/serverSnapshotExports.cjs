"use strict";
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { ArchiveExports } = require("./archive.cjs");
const { RuntimeError } = require("../entity/errors.cjs");
class ServerSnapshotExports extends ArchiveExports {
  constructor(file, serverId, options = {}) {
    super(file, serverId, {
      ...options,
      workerFile: "serverSnapshotWorker.cjs",
    });
    this.pending = null;
  }
  stream(res) {
    if (this.closing)
      return Promise.reject(
        new RuntimeError("STORE_CLOSED", "Snapshot service is closing"),
      );
    if (this.pending)
      return Promise.reject(
        new RuntimeError(
          "ARCHIVE_BUSY",
          "Another server snapshot is in progress",
        ),
      );
    this.pending = this.capture(res).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async capture(res) {
    const root = this.file + ".snapshot-tmp";
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(join(root, "capture-"));
    try {
      await super.stream(res, { directory, limits: this.options.limits });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async close() {
    await super.close();
    await this.pending?.catch(() => {});
  }
}
module.exports = { ServerSnapshotExports };
