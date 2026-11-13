"use strict";
const providerOutputs = require("../entity/providerOutputs.cjs");
const { buttonTiming } = require("./buttonTimings.cjs");

/** Coalesced recoverable progress, separate from the canonical chat and final write set. */
function createProgressCheckpoint(store, job, options = {}) {
  const latest = {};
  const pendingOutputs = new Map();
  let version = 0,
    saved = 0,
    timer,
    draining,
    failure,
    stopped = false;
  const interval = options.intervalMs ?? 250;
  function schedule() {
    if (!stopped && !timer && !draining && !failure)
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => {}); // Failure is retained and observed before committing the job.
      }, interval);
  }
  function receive(event) {
    if (stopped) return;
    switch (event.type) {
      case "button-timing": {
        const timing = buttonTiming(event);
        if (!timing || job.type !== "button") return;
        latest.buttonTimings ??= {};
        latest.buttonTimings[timing.phase] = timing.durationMs;
        break;
      }
      case "stage":
        latest.stage = event.stage;
        break;
      case "messages":
        latest.messages = event.messages;
        latest.streaming = Boolean(event.streaming);
        break;
      case "provider-started":
        latest.providerStarted = true;
        latest.providerCalls = event.call;
        break;
      case "provider-response":
        if (event.status !== undefined) latest.providerStatus = event.status;
        if (event.success !== undefined) latest.providerSuccess = event.success;
        break;
      case "notice":
        latest.notice = String(event.message);
        break;
      case "state-updated":
        latest.engineStateChanged = true;
        break;
      default:
        return;
    }
    version += 1;
    schedule();
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (failure) return Promise.reject(failure);
    if (!draining) {
      draining = (async () => {
        while (saved < version) {
          const at = version;
          const updates = [...pendingOutputs.values()];
          await store.call(
            "writeJobProgress",
            job.id,
            job.owner,
            job.fence,
            structuredClone(latest),
            updates,
          );
          for (const update of updates)
            if (pendingOutputs.get(update.request) === update)
              pendingOutputs.delete(update.request);
          saved = at;
        }
      })()
        .catch((error) => {
          failure = error;
          throw error;
        })
        .finally(() => {
          draining = null;
          if (saved < version) schedule();
        });
    }
    return draining;
  }
  return {
    receive,
    flush,
    retainProviderOutput: async (output) => {
      // Private rows travel only while dirty and share the public progress
      // transaction. Later stage/message changes never resend saved raw text.
      const value = providerOutputs.normalize(output);
      pendingOutputs.set(value.request, value);
      version += 1;
      return flush();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
module.exports = { createProgressCheckpoint };
