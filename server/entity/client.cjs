"use strict";

const { Worker } = require("node:worker_threads");
const { join } = require("node:path");
const { RuntimeError } = require("./errors.cjs");

class EntityStoreClient {
  constructor(file) {
    this.worker = new Worker(join(__dirname, "worker.cjs"), {
      workerData: { file },
    });
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.failure = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.on("message", (message) => {
      if (message.ready) return this.resolveReady();
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new RuntimeError(
            message.error.code,
            message.error.message,
            message.error.details,
          ),
        );
      else {
        if (pending.method === "close") this.closed = true;
        pending.resolve(message.result);
      }
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed || this.pending.size)
        this.fail(
          new RuntimeError(
            "STORE_UNAVAILABLE",
            `Database worker exited (${code})`,
          ),
        );
    });
  }

  fail(error) {
    this.failure = error;
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async call(method, ...args) {
    return await this.request(method, args);
  }

  async request(method, args, allowClosing = false) {
    if (this.closed || (this.closing && !allowClosing))
      throw new RuntimeError("STORE_CLOSED", "Database worker is closed");
    await this.ready;
    if (this.closed || (this.closing && !allowClosing))
      throw new RuntimeError("STORE_CLOSED", "Database worker is closed");
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.request("close", [], true);
      } finally {
        this.closed = true;
        await this.worker.terminate();
      }
    })();
    return this.closePromise;
  }
}

module.exports = { EntityStoreClient };
