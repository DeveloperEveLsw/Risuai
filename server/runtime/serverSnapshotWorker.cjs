"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { prepareSnapshot, snapshotChunks } = require("./serverSnapshot.cjs");
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
  const prepared = await prepareSnapshot(workerData);
  await send({
    start: true,
    mime: "application/octet-stream",
    filename: "risu-server-backup.risusnapshot",
  });
  for await (const chunk of snapshotChunks(prepared)) await send({ chunk });
  parentPort.postMessage({ done: true });
  parentPort.close();
})().catch((error) => {
  parentPort.postMessage({
    error: {
      code: error.code ?? "ARCHIVE_FAILED",
      message: "Server snapshot could not be completed",
    },
  });
  parentPort.close();
});
