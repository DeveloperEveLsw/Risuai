"use strict";
const threads = require("node:worker_threads");
let processData;
function initializeProcess(data) {
  if (threads.parentPort || processData || !process.connected)
    throw new Error("Invalid native process initialization");
  processData = data;
}
function jobChannel() {
  if (threads.parentPort)
    return { parentPort: threads.parentPort, workerData: threads.workerData };
  if (!processData || !process.send)
    throw new Error("Native job requires an owned process or worker channel");
  let pending = 0,
    closing = false;
  const finish = () => {
    if (closing && pending === 0) process.exit(process.exitCode ?? 0);
  };
  return {
    workerData: processData,
    parentPort: {
      on: (event, listener) => process.on(event, listener),
      postMessage(message) {
        pending++;
        process.send(message, (error) => {
          pending--;
          if (error) process.exitCode = 1;
          finish();
        });
      },
      close() {
        closing = true;
        finish();
      },
    },
  };
}
module.exports = { initializeProcess, jobChannel };
