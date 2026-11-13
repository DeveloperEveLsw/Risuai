"use strict";
const { createNativeProcessWorker } = require("./processWorker.cjs");
const { createButtonProcessPool } = require("./buttonProcessPool.cjs");
const { randomUUID } = require("node:crypto");

/** Durable per-chat ordering lives in SQLite; this supervisor owns bounded Node processes. */
class NativeScheduler {
  constructor(options) {
    this.store = options.store;
    this.file = options.file;
    this.concurrency = options.concurrency ?? 2;
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 8
    )
      throw new Error("Native concurrency must be between 1 and 8");
    this.leaseMs = options.leaseMs ?? 30000;
    this.interactionCapacity = options.interactionCapacity ?? 8;
    if (
      !Number.isSafeInteger(this.interactionCapacity) ||
      this.interactionCapacity < 1 ||
      this.interactionCapacity > 32
    )
      throw new Error("Interaction capacity must be between 1 and 32");
    this.cancelGraceMs = options.cancelGraceMs ?? 3000;
    this.progressIntervalMs = options.progressIntervalMs;
    this.onError = options.onError ?? (() => {});
    this.buttonPool = options.workerFactory
      ? undefined
      : createButtonProcessPool({ reserve: options.buttonReserve ?? 1 });
    this.workerFactory =
      options.workerFactory ??
      ((claimed) => {
        const data = {
          file: this.file,
          claimed,
          progressIntervalMs: this.progressIntervalMs,
          reviewedPlugins: options.reviewedPlugins === true,
        };
        return claimed.job.type === "button"
          ? this.buttonPool.create(claimed, data)
          : createNativeProcessWorker(data);
      });
    this.instance = randomUUID();
    this.running = new Map();
    this.stopped = false;
    this.poll = setInterval(() => this.kick(), options.pollMs ?? 250);
    this.heartbeat = setInterval(
      () => this.maintain().catch((error) => this.report(error)),
      Math.min(5000, Math.max(100, this.leaseMs / 3)),
    );
    this.kick();
  }
  report(error) {
    this.lastError = error;
    this.onError(error);
  }
  kick() {
    this.pump().catch((error) => this.report(error));
  }
  pump() {
    if (this.stopped) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      while (
        !this.stopped &&
        [...this.running.values()].filter((entry) => !entry.waiting).length <
          this.concurrency
      ) {
        const resume = [...this.running.values()].find(
          (entry) => entry.waiting && entry.resumeRequested,
        );
        if (resume) {
          resume.waiting = false;
          resume.resumeRequested = false;
          resume.worker.postMessage({
            type: "resume-interaction",
            jobId: resume.job.id,
          });
          continue;
        }
        if (this.running.size >= this.concurrency + this.interactionCapacity)
          break;
        const claimed = await this.store.call(
          "claimJob",
          this.instance + ":" + randomUUID(),
          this.leaseMs,
          { includeSnapshot: false },
        );
        if (!claimed) break;
        if (this.stopped) {
          await this.store.call(
            "interruptJob",
            claimed.job.id,
            claimed.job.owner,
            claimed.job.fence,
            "Scheduler stopped before execution",
          );
          break;
        }
        try {
          this.start(claimed);
        } catch (error) {
          await this.store.call(
            "interruptJob",
            claimed.job.id,
            claimed.job.owner,
            claimed.job.fence,
            "Engine worker could not start",
          );
          this.report(error);
        }
      }
    })().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }
  start(claimed) {
    const worker = this.workerFactory(claimed),
      job = claimed.job;
    let resolveDone;
    const entry = {
      worker,
      job,
      reported: false,
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
    };
    this.running.set(job.id, entry);
    worker.on("message", (message) => {
      if (message.executing) entry.executing = true;
      if (message.interactionWaiting?.jobId === job.id) {
        entry.waiting = true;
        this.kick();
      }
      if (message.interactionResume?.jobId === job.id && entry.waiting) {
        entry.resumeRequested = true;
        this.kick();
      }
      if (message.progress?.type === "state-updated")
        entry.activityObserved = true;
      if (message.completed) entry.reported = true;
      if (message.error) entry.error = message.error;
    });
    worker.on("error", (error) => {
      entry.error = error;
    });
    worker.once("exit", async (code) => {
      clearTimeout(entry.cancelTimer);
      try {
        if (!entry.reported) {
          const current = await this.store.call("getJob", job.id);
          if (
            current?.state === "running" &&
            current.owner === job.owner &&
            current.fence === job.fence
          )
            await this.store.call(
              "interruptJob",
              job.id,
              job.owner,
              job.fence,
              "Engine worker stopped (" +
                code +
                "); automatic replay is disabled",
            );
        }
      } catch (error) {
        if (error.code !== "STALE_WORKER") this.report(error);
      } finally {
        this.running.delete(job.id);
        resolveDone();
        this.kick();
      }
    });
  }
  cancel(jobId) {
    const entry = this.running.get(jobId);
    if (!entry || entry.cancelTimer) return;
    entry.worker.postMessage({ type: "cancel", jobId });
    entry.cancelTimer = setTimeout(
      () => entry.worker.terminate().catch((error) => this.report(error)),
      this.cancelGraceMs,
    );
  }
  maintain() {
    if (this.stopped) return Promise.resolve();
    if (this.maintaining) return this.maintaining;
    this.maintaining = Promise.all(
      [...this.running.values()].map(async (entry) => {
        try {
          const current = await this.store.call(
            "heartbeat",
            entry.job.id,
            entry.job.owner,
            entry.job.fence,
            this.leaseMs,
          );
          if (current.cancelRequested) this.cancel(entry.job.id);
        } catch (error) {
          if (error.code !== "STALE_WORKER") this.report(error);
          await entry.worker.terminate();
        }
      }),
    ).finally(() => {
      this.maintaining = null;
    });
    return this.maintaining;
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.heartbeat);
    this.closing = (async () => {
      await Promise.allSettled([
        this.pumping,
        this.maintaining,
        this.buttonPool?.close(),
      ]);
      const entries = [...this.running.values()];
      await Promise.allSettled(
        entries.map((entry) => entry.worker.terminate()),
      );
      await Promise.all(entries.map((entry) => entry.done));
    })();
    return this.closing;
  }
}
module.exports = { NativeScheduler };
