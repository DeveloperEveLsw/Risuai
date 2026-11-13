"use strict";
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { join, resolve } = require("node:path");
const { createNativeProcessWorker } = require("./processWorker.cjs");

/** Bounded reserve of public-code-only processes. Every assignment consumes one. */
function createButtonProcessPool(options = {}) {
  const reserve = options.reserve ?? 1;
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > 2)
    throw new Error("Button process reserve must be between 0 and 2");
  const warmTimeoutMs = options.warmTimeoutMs ?? 10000;
  const backoffMs = options.backoffMs ?? 1000;
  if (
    !Number.isSafeInteger(warmTimeoutMs) ||
    warmTimeoutMs < 1 ||
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < 1
  )
    throw new Error("Button preparation timing must be positive integers");
  const bundlePath = resolve(
    options.bundlePath ?? join(__dirname, "dist/extensionJob.mjs"),
  );
  const spawn = options.spawn ?? fork;
  const entries = new Set();
  const stopping = new Map();
  let closed = false,
    retry,
    closePromise,
    consecutiveFailures = 0;

  function refillLater(failed = false) {
    if (closed || retry || !reserve) return;
    if (!failed) return queueMicrotask(refill);
    // A broken public artifact must not trigger perpetual background process
    // churn. Three failures suspend preparation until a later button arrives.
    if (consecutiveFailures >= 3) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        refill();
      },
      Math.min(30000, backoffMs * 2 ** Math.max(0, consecutiveFailures - 1)),
    );
    retry.unref?.();
  }
  function remove(entry) {
    clearTimeout(entry.timeout);
    entries.delete(entry);
    entry.child.removeListener("message", entry.onMessage);
    entry.child.removeListener("error", entry.onError);
    entry.child.removeListener("exit", entry.onExit);
  }
  function stop(child) {
    if (stopping.has(child)) return stopping.get(child);
    if (child.exitCode != null || child.signalCode != null)
      return Promise.resolve();
    const done = new Promise((resolveDone) => {
      child.once("exit", resolveDone);
      child.kill("SIGKILL");
    }).then(() => {
      stopping.delete(child);
    });
    stopping.set(child, done);
    return done;
  }
  function failed(entry) {
    if (!entries.has(entry)) return;
    remove(entry);
    void stop(entry.child);
    consecutiveFailures++;
    // No raw process error or private job data is exposed by warm diagnostics.
    options.onError?.({ code: "BUTTON_PREWARM_FAILED" });
    refillLater(true);
  }
  function refill() {
    if (closed || retry) return;
    while (entries.size < reserve) {
      let child;
      try {
        child = spawn(join(__dirname, "buttonPrewarmProcess.cjs"), [], {
          serialization: "advanced",
          execArgv: [],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      } catch {
        consecutiveFailures++;
        options.onError?.({ code: "BUTTON_PREWARM_FAILED" });
        refillLater(true);
        return;
      }
      const entry = { child, token: randomUUID(), ready: false };
      // An error can arrive after a failed reserve was removed, before SIGKILL
      // exits it. Assigned workers add their own authoritative error listener.
      child.on("error", () => {});
      entry.onMessage = (message) => {
        if (message?.buttonWarmFailed === entry.token) return failed(entry);
        if (message?.buttonReady !== entry.token || !entries.has(entry)) return;
        if (entry.ready) return failed(entry);
        clearTimeout(entry.timeout);
        entry.ready = true;
        consecutiveFailures = 0;
      };
      entry.onError = () => failed(entry);
      entry.onExit = () => {
        if (!entries.has(entry)) return;
        remove(entry);
        consecutiveFailures++;
        refillLater(true);
      };
      entries.add(entry);
      child.on("message", entry.onMessage);
      child.on("error", entry.onError);
      child.once("exit", entry.onExit);
      entry.timeout = setTimeout(() => failed(entry), warmTimeoutMs);
      entry.timeout.unref?.();
      try {
        // Only immutable source location and a random ownership token cross IPC.
        child.send(
          { type: "prepare-button", token: entry.token, bundlePath },
          (error) => {
            if (error) failed(entry);
          },
        );
      } catch {
        failed(entry);
        return;
      }
    }
  }

  refill();
  return {
    /** Never wait for preparation after claim: an empty reserve uses fresh work. */
    create(claimed, workerData) {
      if (closed) throw new Error("Button process reserve is closed");
      const eligible =
        claimed?.job?.type === "button" &&
        claimed?.command?.type === "button" &&
        resolve(
          workerData.bundlePath ?? join(__dirname, "dist/extensionJob.mjs"),
        ) === bundlePath;
      const entry =
        eligible &&
        [...entries].find(
          (candidate) =>
            candidate.ready &&
            candidate.child.connected &&
            candidate.child.exitCode == null &&
            candidate.child.signalCode == null,
        );
      if (!entry) {
        const worker = createNativeProcessWorker({ ...workerData, claimed });
        if (eligible && consecutiveFailures >= 3) {
          consecutiveFailures = 0;
          refillLater();
        }
        return worker;
      }
      remove(entry);
      const worker = createNativeProcessWorker(
        { ...workerData, claimed },
        { child: entry.child, prewarmed: true },
      );
      refillLater();
      return worker;
    },
    status() {
      const ready = [...entries].filter((entry) => entry.ready).length;
      return { reserve, ready, warming: entries.size - ready, closed };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(retry);
      const pending = [...stopping.values()];
      for (const entry of [...entries]) {
        remove(entry);
        pending.push(stop(entry.child));
      }
      closePromise = Promise.all(pending).then(() => {});
      return closePromise;
    },
  };
}

module.exports = { createButtonProcessPool };
