"use strict";
const { RuntimeError } = require("../entity/errors.cjs");
const { randomUUID } = require("node:crypto");
const { MAX_BYTES } = require("./pluginUIEffects.cjs");
const HANDLED = Symbol("browser interaction handled");

// HappyDOM element prototypes are shared between windows. Route the guard by
// the element's actual document, so another UI owner or native realm keeps its
// own capabilities. Never patch Node.URL or a process-wide navigator.
const METHODS = new WeakMap();
function intercept(prototype, name, window, before) {
  let methods = METHODS.get(prototype);
  if (!methods) METHODS.set(prototype, (methods = new Map()));
  let registry = methods.get(name);
  if (!registry) {
    const previous = Object.getOwnPropertyDescriptor(prototype, name);
    const original = prototype[name];
    registry = { previous, original, windows: new Map(), wrapped: null };
    registry.wrapped = function (...args) {
      const handled = registry.windows.get(this.ownerDocument?.defaultView)?.(
        this,
        args,
      );
      if (handled === HANDLED) return;
      return original?.apply(this, args);
    };
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: registry.wrapped,
    });
    methods.set(name, registry);
  }
  if (registry.windows.has(window))
    throw new RuntimeError(
      "PLUGIN_UI_OWNER_EXISTS",
      "This UI window already has a file capability guard",
    );
  registry.windows.set(window, before);
  return () => {
    registry.windows.delete(window);
    if (registry.windows.size) return;
    if (prototype[name] === registry.wrapped) {
      if (registry.previous)
        Object.defineProperty(prototype, name, registry.previous);
      else delete prototype[name];
    }
    methods.delete(name);
    if (!methods.size) METHODS.delete(prototype);
  };
}

/** A private UI owner bridges reviewed text files, downloads and writeText to
 * authenticated browser interactions. Unsupported or unbound capabilities fail
 * the entire event even when the original handler catches their error. The
 * reviewed bundle and its JSON/FileReader/import algorithms remain unchanged.
 */
function createPluginUICapabilities(window, options = {}) {
  if (
    !window?.document ||
    !window.HTMLInputElement ||
    !window.HTMLAnchorElement
  )
    throw new RuntimeError(
      "PLUGIN_UI_DOM_REQUIRED",
      "File capability guards require a private original UI window",
    );
  let failure;
  const effects = options.effects;
  const objects = new Map(),
    ownedFiles = new WeakSet();
  const restore = [];
  const reject = (capability) => {
    failure ??= new RuntimeError(
      "PLUGIN_UI_CAPABILITY_REQUIRED",
      `This server plugin window requires a browser bridge for ${capability}; the operation was not saved`,
      { capability },
    );
    throw failure;
  };
  function event(capability) {
    if (!effects?.activeEvent()) reject(capability);
    effects.assertHealthy();
  }
  function original(operation) {
    try {
      return operation();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  }
  function replace(target, key, value) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    restore.push(() => {
      if (target[key] !== value) return;
      if (previous) Object.defineProperty(target, key, previous);
      else delete target[key];
    });
  }
  restore.push(
    intercept(window.HTMLInputElement.prototype, "click", window, (element) => {
      if (element.type.toLowerCase() !== "file") return;
      event("file selection");
      if (element.multiple) reject("multiple file selection");
      original(() => effects.request("file", { accept: element.accept }))
        .then((file) => {
          const transfer = new window.DataTransfer();
          if (file) {
            const uploaded = new window.File([file.text], file.name, {
              type: file.name.toLowerCase().endsWith(".json")
                ? "application/json"
                : "text/plain",
            });
            ownedFiles.add(uploaded);
            transfer.items.add(uploaded);
          }
          element.files = transfer.files;
          element.dispatchEvent(new window.Event("change"));
        })
        .catch((error) => {
          // Closing still wakes the original picker promise through its own
          // empty FileList/change branch. It never creates an import or a write.
          element.files = new window.DataTransfer().files;
          element.dispatchEvent(new window.Event("change"));
          if (error.code !== "PLUGIN_UI_EFFECT_CLOSED") failure ??= error;
        });
      return HANDLED;
    }),
    intercept(
      window.HTMLAnchorElement.prototype,
      "click",
      window,
      (element) => {
        if (!element.hasAttribute("download")) return;
        event("file download");
        const object = objects.get(element.href);
        if (!object?.blob || object.eventId !== effects.activeEvent())
          reject("an owned file download");
        original(() =>
          effects.stageDownload(
            element.download || "download.json",
            object.blob.type,
            object.blob,
          ),
        );
        return HANDLED;
      },
    ),
  );
  class UIURL extends URL {
    static createObjectURL(blob) {
      event("object URLs and file export");
      for (const [key, value] of objects)
        if (!value.blob && value.expires <= Date.now()) objects.delete(key);
      if (
        !(blob instanceof Blob) ||
        blob.size > MAX_BYTES ||
        objects.size >= 32 ||
        [...objects.values()].reduce(
          (sum, value) => sum + (value.blob?.size ?? 0),
          0,
        ) +
          blob.size >
          MAX_BYTES
      )
        throw (failure ??= new RuntimeError(
          "PLUGIN_UI_EFFECT_LIMIT",
          "Plugin UI object URL exceeds its bounded transfer budget",
        ));
      const url = "blob:risu-plugin-ui/" + randomUUID();
      objects.set(url, { blob, eventId: effects.activeEvent() });
      return url;
    }
    static revokeObjectURL(url) {
      if (!objects.has(url)) reject("object URLs and file export");
      objects.delete(url);
    }
  }
  const FileReader = window.FileReader;
  class UIFileReader extends FileReader {
    constructor() {
      event("file reading");
      super();
    }
    readAsText(file, encoding) {
      event("file reading");
      if (!ownedFiles.has(file) || (encoding && !/^utf-?8$/i.test(encoding)))
        reject("an owned UTF-8 file read");
      return super.readAsText(file, encoding);
    }
    readAsArrayBuffer() {
      reject("binary file reading");
    }
    readAsBinaryString() {
      reject("binary file reading");
    }
    readAsDataURL() {
      reject("binary file reading");
    }
  }
  const clipboard = Object.freeze(
    Object.fromEntries(
      ["read", "readText", "write", "writeText"].map((method) => [
        method,
        method === "writeText"
          ? (text) => {
              event("clipboard access");
              return original(() => effects.request("clipboard", { text }));
            }
          : () => reject("clipboard access"),
      ]),
    ),
  );
  replace(window, "URL", UIURL);
  replace(window, "FileReader", UIFileReader);
  replace(window.navigator, "clipboard", clipboard);
  const confirm = () => reject("a reviewed asynchronous confirmation");
  // A Promise returned from an unmodified synchronous confirm site is truthy.
  // Only the three reviewed await-instrumented imports use the separate port.
  replace(window, "confirm", confirm);
  const execCommand = window.document.execCommand;
  replace(window.document, "execCommand", function (command, ...args) {
    if (["copy", "cut", "paste"].includes(String(command).toLowerCase()))
      return reject("clipboard access");
    return execCommand?.call(this, command, ...args) ?? false;
  });
  return {
    // serverPluginHost uses these only for a UI DOM. Native generation's global
    // URL and navigator keep their existing implementation.
    globals: {
      URL: UIURL,
      FileReader: UIFileReader,
      navigator: window.navigator,
      confirm,
      __RISU_PLUGIN_UI_CONFIRM: (text) => {
        event("confirmation");
        return original(() => effects.request("confirm", { text }));
      },
    },
    beginEvent: (eventId) => effects?.beginEvent(eventId),
    prepareEvent: (eventId) => effects?.prepareEvent(eventId),
    commitEvent: (eventId) => effects?.commitEvent(eventId),
    endEvent(eventId) {
      effects?.endEvent(eventId);
      for (const object of objects.values())
        if (object.eventId === eventId) {
          object.blob = undefined;
          object.expires = Date.now() + 5000;
        }
    },
    failEvent: (eventId) => effects?.failEvent(eventId),
    cancelledEvent: (eventId) => effects?.cancelledEvent(eventId) ?? false,
    snapshot: () => effects?.snapshot() ?? [],
    resolve: (input) => effects?.resolve(input),
    readArtifact: (input) => effects?.readArtifact(input),
    cancelPending: () => effects?.cancelPending() ?? { cancelled: true },
    assertHealthy() {
      if (failure) throw failure;
      effects?.assertHealthy();
    },
    close() {
      effects?.close();
      objects.clear();
      for (const undo of restore.splice(0).reverse()) undo();
    },
  };
}
module.exports = { createPluginUICapabilities };
