"use strict";
const { initializeProcess } = require("./jobChannel.cjs");
const { prepare } = require("./buttonPrewarm.cjs");
let phase = "new",
  token;

function invalid() {
  process.exit(1);
}
process.on("message", async (message) => {
  if (message?.type === "prepare-button") {
    if (phase !== "new" || typeof message.token !== "string") return invalid();
    phase = "preparing";
    token = message.token;
    try {
      await prepare({ bundlePath: message.bundlePath });
      if (!process.connected) return invalid();
      phase = "ready";
      process.send({ buttonReady: token }, (error) => {
        if (error) invalid();
      });
    } catch {
      if (process.connected)
        process.send({ buttonWarmFailed: token }, () => invalid());
      else invalid();
    }
    return;
  }
  if (message?.workerData) {
    const data = message.workerData;
    if (
      phase !== "ready" ||
      !data.file ||
      !data.claimed?.job?.id ||
      data.claimed?.command?.type !== "button" ||
      data.claimed?.job?.type !== "button" ||
      data.buttonPrewarmed !== true
    )
      return invalid();
    phase = "running";
    // This process receives private state for exactly one admitted job. Its
    // original extensionWorker/jobChannel lifecycle exits after that job.
    initializeProcess(data);
    require("./extensionWorker.cjs");
  }
});
// The reserve and assigned job both belong to one live supervisor.
process.once("disconnect", invalid);
