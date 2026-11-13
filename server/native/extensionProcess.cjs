"use strict";
const { initializeProcess } = require("./jobChannel.cjs");
process.once("message", (message) => {
  if (!message?.workerData?.file || !message.workerData.claimed?.job?.id)
    process.exit(1);
  initializeProcess(message.workerData);
  require("./extensionWorker.cjs");
});
// A lost supervisor must not leave an orphan executing a provider request.
process.once("disconnect", () => process.exit(1));
