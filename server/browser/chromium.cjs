"use strict";
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { access } = require("node:fs/promises");
const { join } = require("node:path");
const { homedir } = require("node:os");
const WebSocket = require("ws");

async function launchChromium(directory) {
  const executable =
    process.env.RISU_BROWSER_CHROMIUM ??
    join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
  await access(executable);
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + join(directory, "chromium-profile"),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = once(child, "exit").catch(() => {});
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error("Chromium startup timed out: " + stderr)),
      10000,
    );
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Chromium exited before its endpoint was ready"));
    });
  }).catch(async (error) => {
    child.kill("SIGKILL");
    await exited;
    throw error;
  });
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.method) {
      const key = message.sessionId + ":" + message.method;
      for (const callback of listeners.get(key) ?? []) callback(message.params);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Chromium connection closed"));
    }
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  return {
    send,
    newContext: async () =>
      (await send("Target.createBrowserContext")).browserContextId,
    page: async (url, context, options = {}) => {
      const { targetId } = await send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context,
      });
      const { sessionId } = await send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      if (options.viewport)
        await send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: options.viewport.width,
            height: options.viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          },
          sessionId,
        );
      if (options.blockHttps) {
        await send("Network.enable", {}, sessionId);
        await send(
          "Network.setBlockedURLs",
          { urls: ["https://*"] },
          sessionId,
        );
      }
      await send("Page.navigate", { url }, sessionId);
      return {
        send: (method, params = {}) => send(method, params, sessionId),
        on: (method, callback) => {
          const key = sessionId + ":" + method;
          const callbacks = listeners.get(key) ?? new Set();
          callbacks.add(callback);
          listeners.set(key, callbacks);
          return () => {
            callbacks.delete(callback);
            if (!callbacks.size) listeners.delete(key);
          };
        },
        evaluate: async (expression) => {
          const result = await send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          );
          if (result.exceptionDetails)
            throw new Error(
              result.exceptionDetails.exception?.description ??
                result.exceptionDetails.text,
            );
          return result.result.value;
        },
        close: () => {
          for (const key of listeners.keys())
            if (key.startsWith(sessionId + ":")) listeners.delete(key);
          return send("Target.closeTarget", { targetId });
        },
      };
    },
    close: async () => {
      listeners.clear();
      socket.close();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    },
  };
}
module.exports = { launchChromium };
