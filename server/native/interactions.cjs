"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const { descriptor } = require("../entity/interactions.cjs");
const { RuntimeError } = require("../entity/errors.cjs");

/** The live Lua VM awaits a durable answer. A lost VM is never reconstructed by replaying side effects. */
function createInteractionHost(store, job, options = {}) {
  let position = 0,
    active = 0,
    failure;
  const closed = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([closed.signal, options.signal])
    : closed.signal;
  function check() {
    if (failure) throw failure;
    if (active)
      throw new RuntimeError(
        "UNAWAITED_INTERACTION",
        "Interactive calls must be awaited before final persistence",
      );
  }
  async function run(value) {
    if (failure) throw failure;
    signal.throwIfAborted();
    if (active)
      throw new RuntimeError(
        "INTERACTION_BUSY",
        "Only one interactive call can be awaited at a time",
      );
    descriptor(value);
    active++;
    try {
      const published = await store.call(
        "publishJobInteraction",
        job.id,
        job.owner,
        job.fence,
        ++position,
        value,
      );
      options.onWaiting?.(published.interaction);
      while (true) {
        signal.throwIfAborted();
        const result = await store.call(
          "pollJobInteraction",
          job.id,
          job.owner,
          job.fence,
          published.interaction.id,
        );
        if (result.state === "answered") {
          await options.onResume?.(published.interaction);
          signal.throwIfAborted();
          const confirmed = await store.call(
            "pollJobInteraction",
            job.id,
            job.owner,
            job.fence,
            published.interaction.id,
          );
          return confirmed.answer;
        }
        await delay(options.pollMs ?? 250, undefined, { signal });
      }
    } catch (error) {
      failure ??= error;
      throw error;
    } finally {
      active--;
    }
  }
  function request(value) {
    const result = run(value);
    result.catch((error) => {
      failure ??= error;
    });
    return result;
  }
  return {
    alertInput: (prompt, datalist, defaultValue) =>
      request({ kind: "input", prompt, datalist, defaultValue }),
    alertConfirm: (prompt) => request({ kind: "confirm", prompt }),
    alertSelect: (items, display) => {
      // Preserve the original alert.ts / AlertComp serialized delimiter behavior.
      if (
        !Array.isArray(items) ||
        items.some((item) => typeof item !== "string")
      )
        return request({ kind: "select", prompt: "", options: items });
      const encoded =
        display !== undefined
          ? `__DISPLAY__${display}||${items.join("||")}`
          : items.join("||");
      const parts = encoded.startsWith("__DISPLAY__")
        ? encoded.substring(11).split("||")
        : encoded.split("||");
      return request({
        kind: "select",
        prompt: encoded.startsWith("__DISPLAY__") ? parts.shift() : "",
        options: parts,
      });
    },
    check,
    stop: () => closed.abort(new Error("Interaction host closed")),
  };
}
module.exports = { createInteractionHost };
