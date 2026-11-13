"use strict";
const { fork } = require("node:child_process");
const { join } = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { RuntimeError } = require("../entity/errors.cjs");
const {
  matchesWygloreRelease,
  getWygloreRelease,
} = require("../native/wygloreContract.cjs");

class PluginUIOwners {
  constructor(options) {
    this.options = options;
    this.sessions = new Map();
    this.closed = false;
    this.sweep = setInterval(() => {
      for (const entry of this.sessions.values())
        if (
          !entry.running.size &&
          Date.now() - entry.usedAt > (options.idleMs ?? 60000)
        )
          void this.stop(entry).catch(() => {});
    }, 1000);
  }
  async capability(pluginId) {
    const row = await this.options.store.call(
      "getResource",
      "plugin",
      pluginId,
    );
    const reviewed = matchesWygloreRelease(row?.payload);
    return {
      supported:
        this.options.enabled === true &&
        row?.payload?.enabled === true &&
        reviewed,
      enabled: this.options.enabled === true,
      release: reviewed ? getWygloreRelease(row.payload.script).version : null,
      serverId: this.options.serverId,
    };
  }
  async open(input) {
    if (this.closed || this.yielding)
      throw new RuntimeError(
        "PLUGIN_UI_CLOSED",
        "Plugin UI service is closed or yielding to generation",
      );
    if (!(await this.capability(input.pluginId)).supported)
      throw new RuntimeError(
        "PLUGIN_UNSUPPORTED",
        "Reviewed server plugin support must be enabled for this exact release",
      );
    if (this.closed || this.yielding)
      throw new RuntimeError(
        "PLUGIN_UI_CLOSED",
        "Plugin UI service is yielding to generation",
      );
    if (
      !Number.isSafeInteger(input.expectedChatEpoch) ||
      input.expectedChatEpoch < 0
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Plugin UI requires the captured chat incarnation",
      );
    if (
      this.sessions.size >= 2 ||
      [...this.sessions.values()].some(
        (entry) => entry.pluginId === input.pluginId,
      )
    )
      throw new RuntimeError(
        "PLUGIN_STORAGE_BUSY",
        "Close the existing plugin settings window before opening another writer",
      );
    const entry = {
      id: randomUUID(),
      token: randomUUID(),
      pluginId: input.pluginId,
      usedAt: Date.now(),
      pending: new Map(),
      running: new Set(),
    };
    this.sessions.set(entry.id, entry);
    try {
      const child = (entry.child = fork(
        join(__dirname, "../native/pluginUIProcess.cjs"),
        [],
        {
          serialization: "advanced",
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      ));
      const ready = new Promise((resolve, reject) => {
        entry.ready = { resolve, reject };
        entry.initTimer = setTimeout(
          () =>
            reject(
              new RuntimeError(
                "PLUGIN_UI_TIMEOUT",
                "Plugin settings did not open within its startup budget",
              ),
            ),
          30000,
        );
      });
      entry.running.add(ready);
      void ready.then(
        () => entry.running.delete(ready),
        () => entry.running.delete(ready),
      );
      child.on("message", (message) => {
        if (message.lease) entry.lease = message.lease; // Private proof, never returned over HTTP.
        if (message.ready) {
          clearTimeout(entry.initTimer);
          entry.ready.resolve(message.ready);
        }
        if (message.initializationError)
          entry.ready.reject(
            new RuntimeError(
              message.initializationError.code,
              message.initializationError.message,
            ),
          );
        if (message.failed) void this.drain(entry).catch(() => {});
        if (message.requestId) {
          const pending = entry.pending.get(message.requestId);
          if (!pending) return;
          entry.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(
              new RuntimeError(message.error.code, message.error.message),
            );
          else pending.resolve(message.result);
        }
      });
      const ended = (error) => {
        entry.ready.reject(error);
        for (const pending of entry.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        entry.pending.clear();
        void this.stop(entry).catch(() => {});
      };
      child.once("error", ended);
      child.once("exit", () =>
        ended(
          new RuntimeError(
            "PLUGIN_UI_INTERRUPTED",
            "Plugin settings owner ended; admitted actions are never automatically repeated",
          ),
        ),
      );
      child.send({
        initialize: { ...input, sessionId: entry.id, file: this.options.file },
      });
      const snapshot = await ready;
      return { sessionId: entry.id, ownerToken: entry.token, snapshot };
    } catch (error) {
      await this.stop(entry);
      throw error;
    }
  }
  owner(id, token) {
    const entry = this.sessions.get(id);
    const left = Buffer.from(typeof token === "string" ? token : ""),
      right = Buffer.from(entry?.token ?? "");
    if (!entry || left.length !== right.length || !timingSafeEqual(left, right))
      throw new RuntimeError("FORBIDDEN", "Plugin UI owner identity differs");
    entry.usedAt = Date.now();
    return entry;
  }
  async call(id, token, type, event) {
    const entry = this.owner(id, token);
    if (entry.stopping || entry.detached)
      throw new RuntimeError("PLUGIN_UI_CLOSED", "Plugin UI owner is closing");
    const requestId = randomUUID();
    const operation = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          entry.pending.delete(requestId);
          reject(
            new RuntimeError(
              "PLUGIN_UI_EVENT_UNCERTAIN",
              "Plugin action acknowledgement timed out; obtain its saved receipt before any new action",
            ),
          );
          void this.stop(entry).catch(() => {});
        },
        type === "dispatch" ? 300000 : 30000,
      );
      entry.pending.set(requestId, { resolve, reject, timer });
      entry.child.send({ requestId, type, event }, (error) => {
        if (error) {
          clearTimeout(timer);
          entry.pending.delete(requestId);
          reject(error);
        }
      });
    });
    if (type === "dispatch") entry.running.add(operation);
    try {
      return await operation;
    } finally {
      entry.running.delete(operation);
    }
  }
  stop(entry) {
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      clearTimeout(entry.initTimer);
      const child = entry.child;
      if (child && child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          if (child.connected) child.send({ type: "stop" }, () => {});
          else child.kill("SIGKILL");
        });
      if (entry.lease)
        await this.options.store
          .call("releasePluginStorage", entry.lease)
          .catch(() => {});
      this.sessions.delete(entry.id);
    })();
    return entry.stopping;
  }
  drain(entry) {
    if (entry.draining) return entry.draining;
    // A file picker or confirmation awaiting the detached browser is a UI
    // interaction, not a submitted model job. Resolve that original Promise as
    // cancelled so the accepted handler can finish without retaining the global
    // writer indefinitely. An in-flight provider action still settles normally.
    if (!entry.detached && !entry.stopping && entry.child?.connected)
      void this.call(entry.id, entry.token, "cancelEffects").catch(() => {});
    entry.detached = true;
    entry.draining = (async () => {
      await Promise.allSettled([...entry.running]);
      await this.stop(entry);
    })();
    return entry.draining;
  }
  async closeOwner(id, token) {
    const entry = this.owner(id, token);
    const background = entry.running.size > 0;
    const drained = this.drain(entry);
    if (background) void drained.catch(() => {});
    else await drained;
    return { closed: true, background };
  }
  async yieldToGeneration(admit) {
    this.yielding = (this.yielding ?? 0) + 1;
    try {
      await Promise.all(
        [...this.sessions.values()].map((entry) => this.drain(entry)),
      );
      return await admit?.();
    } finally {
      this.yielding--;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.all(
      [...this.sessions.values()].map((entry) => this.stop(entry)),
    );
  }
}
module.exports = { PluginUIOwners };
