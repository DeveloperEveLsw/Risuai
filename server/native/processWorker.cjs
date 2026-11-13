"use strict";
const { fork } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { join } = require("node:path");

/** Worker-compatible supervision of a fresh Node process per native job.
 * Native addons (notably the installed ONNX binding) must not share repeated
 * worker-thread V8 environments. SQLite owns ordering, fencing and results.
 */
function createNativeProcessWorker(workerData, options = {}) {
  const dispatchedAt = Date.now();
  const worker = new EventEmitter();
  const child =
    options.child ??
    fork(join(__dirname, "extensionProcess.cjs"), [], {
      serialization: "advanced",
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
  worker.pid = child.pid;
  worker.buttonPrewarmed = options.prewarmed === true;
  worker.dispatchedAt = dispatchedAt;
  let exited = false,
    exitCode;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = (code, signal) => {
    if (exited) return;
    exited = true;
    exitCode = code ?? (signal ? 1 : 0);
    worker.emit("exit", exitCode);
    resolveDone(exitCode);
  };
  child.once("exit", finish);
  child.once("close", finish);
  child.on("message", (message) => worker.emit("message", message));
  child.on("error", (error) => worker.emit("error", error));
  worker.postMessage = (message) => {
    if (exited || !child.connected) return;
    child.send(message, (error) => {
      if (error && !exited) worker.emit("error", error);
    });
  };
  worker.terminate = () => {
    if (exited) return Promise.resolve(exitCode);
    child.kill("SIGKILL");
    return done;
  };
  worker.postMessage({
    workerData: {
      ...workerData,
      nativeSupervisor: true,
      dispatchedAt,
      buttonPrewarmed: options.prewarmed === true,
    },
  });
  if (child.exitCode != null || child.signalCode != null)
    queueMicrotask(() => finish(child.exitCode, child.signalCode));
  return worker;
}
module.exports = { createNativeProcessWorker };
