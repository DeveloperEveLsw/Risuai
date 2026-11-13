"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { EntityStore } = require("./store.cjs");
const store = new EntityStore(workerData.file);
const METHODS = new Set([
  "registerAsset",
  "getAsset",
  "initializeState",
  "applyCommand",
  "bootstrap",
  "listChats",
  "getCharacter",
  "getResource",
  "getResourceSnapshot",
  "listLibrary",
  "resolveModuleCatalog",
  "readVariables",
  "readFields",
  "groupImageSources",
  "displayState",
  "snapshot",
  "readBookmark",
  "readReplyChoices",
  "readGroupMember",
  "listBookmarks",
  "schemaVersion",
  "changes",
  "enqueueJob",
  "getJob",
  "getJobStatus",
  "previewJobResult",
  "previewMemorySummary",
  "readMemorySource",
  "getJobCommand",
  "listJobs",
  "listJobHistory",
  "writeJobProgress",
  "publishJobNotice",
  "listNotices",
  "readNotice",
  "publishJobInteraction",
  "listInteractions",
  "readInteraction",
  "pollJobInteraction",
  "interruptJob",
  "claimJob",
  "heartbeat",
  "requestCancel",
  "finishJob",
  "claimPluginStorage",
  "renewPluginStorage",
  "releasePluginStorage",
  "readPluginStorage",
  "readAllPluginStorage",
  "readPluginStorageKeys",
  "commitPluginStorage",
  "readPluginStorageCommit",
  "readPluginJobSnapshot",
  "capturePluginUI",
  "claimPluginUIStorage",
  "checkPluginUI",
  "readPluginUIEvent",
  "admitPluginUIEvent",
  "completePluginUIEvent",
  "failPluginUIEvent",
  "pruneChanges",
]);

parentPort.on("message", ({ id, method, args }) => {
  try {
    if (method === "close") {
      store.close();
      parentPort.postMessage({ id, result: null });
      parentPort.close();
      return;
    }
    if (!METHODS.has(method)) throw new Error("Unknown database worker method");
    parentPort.postMessage({ id, result: store[method](...args) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        code: error.code ?? "DATABASE_ERROR",
        message: error.message,
        details: error.details ?? {},
      },
    });
  }
});

parentPort.postMessage({ ready: true });
