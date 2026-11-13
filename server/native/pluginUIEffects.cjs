"use strict";
const { randomUUID } = require("node:crypto");
const { RuntimeError } = require("../entity/errors.cjs");

const MAX_BYTES = 8 * 1024 * 1024;
const EVENT = /^plugin-ui:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function invalid(message) {
  throw new RuntimeError("INVALID_PLUGIN_UI_EFFECT", message);
}
function limit() {
  throw new RuntimeError(
    "PLUGIN_UI_EFFECT_LIMIT",
    "Plugin UI file interaction exceeds its bounded transfer budget",
  );
}
function filename(input) {
  if (typeof input !== "string") invalid("A file name is required");
  const name = input.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim();
  if (!name || Buffer.byteLength(name) > 240) invalid("Invalid file name");
  return name;
}
function text(input) {
  if (typeof input !== "string") invalid("Interaction text must be a string");
  if (Buffer.byteLength(input) > MAX_BYTES) limit();
  return input;
}
/** Ephemeral, one-owner event effects. Bytes/text never enter durable command
 * receipts. The caller validates current SQLite authority before every public
 * resolve/read; prepare precedes the canonical TX and commit publishes only its
 * successful artifacts. A lost artifact GET can repeat until explicit ACK.
 */
function createPluginUIEffects(options = {}) {
  const effects = new Map(),
    cancelled = new Set();
  let active,
    closed = false,
    draining = false,
    failure;
  function healthy() {
    if (failure) throw failure;
    if (closed)
      throw new RuntimeError(
        "PLUGIN_UI_EFFECT_CLOSED",
        "Plugin UI interactions are closed",
      );
  }
  function event() {
    healthy();
    options.check?.();
    if (!active)
      throw new RuntimeError(
        "PLUGIN_UI_CAPABILITY_REQUIRED",
        "A browser file interaction requires an admitted original UI event",
      );
    return active;
  }
  function bytesUsed() {
    return [...effects.values()].reduce(
      (sum, value) => sum + value.reserved,
      0,
    );
  }
  function reserve(bytes) {
    if (effects.size >= 4 || bytesUsed() + bytes > MAX_BYTES) limit();
  }
  function metadata(value) {
    return {
      id: value.id,
      eventId: value.eventId,
      kind: value.kind,
      ...value.public,
    };
  }
  function remove(value) {
    effects.delete(value.id);
    value.bytes = undefined;
    value.blob = undefined;
  }
  function request(kind, fields = {}) {
    const eventId = event();
    if (!["file", "confirm", "clipboard"].includes(kind))
      invalid("Unsupported browser interaction");
    if (draining) {
      if (kind === "file" || kind === "confirm") {
        cancelled.add(eventId);
        return Promise.resolve(kind === "file" ? null : false);
      }
      failure ??= new RuntimeError(
        "PLUGIN_UI_EFFECT_FAILED",
        "The detached browser cannot confirm a clipboard write; the operation was not saved",
      );
      const rejected = Promise.reject(failure);
      rejected.catch(() => {});
      return rejected;
    }
    const publicFields =
      kind === "file"
        ? { accept: text(fields.accept ?? ""), multiple: false }
        : { text: text(fields.text) };
    const reserved = Buffer.byteLength(
      publicFields.text ?? publicFields.accept,
    );
    reserve(reserved);
    const value = {
      id: randomUUID(),
      eventId,
      kind,
      public: publicFields,
      reserved,
      state: "pending",
    };
    const promise = new Promise((resolve, reject) =>
      Object.assign(value, { resolve, reject }),
    );
    // Original clipboard handlers can intentionally ignore their returned promise.
    promise.catch(() => {});
    effects.set(value.id, value);
    return promise;
  }
  function stageDownload(name, mime, blob) {
    const eventId = event();
    if (
      !(blob instanceof Blob) ||
      !Number.isSafeInteger(blob.size) ||
      blob.size > MAX_BYTES
    )
      limit();
    mime = String(mime || "application/json")
      .toLowerCase()
      .split(";")[0]
      .trim();
    if (!["application/json", "text/plain"].includes(mime))
      invalid("Unsupported download content type");
    reserve(blob.size);
    const value = {
      id: randomUUID(),
      eventId,
      kind: "download",
      public: { name: filename(name), mime, bytes: blob.size },
      reserved: blob.size,
      state: "staged",
      blob,
    };
    effects.set(value.id, value);
    return value.id;
  }
  return {
    beginEvent(eventId) {
      healthy();
      options.check?.();
      if (!EVENT.test(eventId ?? ""))
        invalid("Invalid admitted UI event identity");
      if (active)
        throw new RuntimeError(
          "PLUGIN_UI_BUSY",
          "Another original UI event owns browser interactions",
        );
      active = eventId;
    },
    request,
    stageDownload,
    async prepareEvent(eventId) {
      healthy();
      for (const value of effects.values()) {
        if (value.eventId !== eventId) continue;
        if (value.state === "pending")
          invalid("An unresolved browser interaction cannot be checkpointed");
        if (value.state !== "staged") continue;
        const bytes = Buffer.from(await value.blob.arrayBuffer());
        if (bytes.length !== value.public.bytes || bytes.length > MAX_BYTES)
          limit();
        value.bytes = bytes;
        value.blob = undefined;
      }
      healthy();
    },
    commitEvent(eventId) {
      // prepareEvent validated and copied every artifact before the canonical TX.
      for (const value of effects.values())
        if (value.eventId === eventId && value.state === "staged")
          value.state = "committed";
    },
    endEvent(eventId) {
      if (active === eventId) active = undefined;
    },
    failEvent(eventId) {
      for (const value of [...effects.values()])
        if (value.eventId === eventId) {
          value.reject?.(
            new RuntimeError(
              "PLUGIN_UI_EFFECT_CLOSED",
              "The original UI event failed",
            ),
          );
          remove(value);
        }
      if (active === eventId) active = undefined;
    },
    cancelledEvent: (eventId) => cancelled.has(eventId),
    activeEvent: () => active,
    snapshot() {
      healthy();
      return [...effects.values()]
        .filter(
          (value) => value.state === "pending" || value.state === "committed",
        )
        .map(metadata);
    },
    resolve(input) {
      healthy();
      options.check?.();
      if (!input || typeof input !== "object" || Array.isArray(input))
        invalid("Invalid interaction response");
      const value = effects.get(input.effectId);
      if (!value)
        throw new RuntimeError(
          "PLUGIN_UI_EFFECT_CLOSED",
          "This browser interaction has already ended",
        );
      if (input.eventId !== value.eventId || input.kind !== value.kind)
        invalid(
          "Browser interaction identity does not match its admitted event",
        );
      const field = {
        download: "received",
        file: "file",
        confirm: "accepted",
        clipboard: "ok",
      }[value.kind];
      const allowed = [
        "effectId",
        "eventId",
        "kind",
        field,
        ...(value.kind === "clipboard" ? ["error"] : []),
      ];
      if (Object.keys(input).some((key) => !allowed.includes(key)))
        invalid("Unknown interaction response field");
      if (value.kind === "download") {
        if (value.state !== "committed" || typeof input.received !== "boolean")
          invalid("A download acknowledgement requires a completed event");
      } else {
        if (value.state !== "pending" || active !== value.eventId)
          throw new RuntimeError(
            "PLUGIN_UI_EFFECT_CLOSED",
            "The original input event is no longer active",
          );
        if (value.kind === "file") {
          if (input.file !== null) {
            if (
              !input.file ||
              typeof input.file !== "object" ||
              Array.isArray(input.file) ||
              Object.keys(input.file).some(
                (key) => !["name", "text"].includes(key),
              )
            )
              invalid("A file response contains unsupported fields");
            const body = text(input.file.text),
              name = filename(input.file.name);
            if (
              bytesUsed() - value.reserved + Buffer.byteLength(body) >
              MAX_BYTES
            )
              limit();
            input = { ...input, file: { name, text: body } };
          } else cancelled.add(value.eventId);
          value.resolve(input.file);
        } else if (value.kind === "confirm") {
          if (typeof input.accepted !== "boolean")
            invalid("Confirmation must be a boolean");
          if (!input.accepted) cancelled.add(value.eventId);
          value.resolve(input.accepted);
        } else {
          if (
            typeof input.ok !== "boolean" ||
            (input.error !== undefined &&
              (typeof input.error !== "string" ||
                Buffer.byteLength(input.error) > 1024))
          )
            invalid("Invalid clipboard acknowledgement");
          if (input.ok) value.resolve();
          else {
            failure = new RuntimeError(
              "PLUGIN_UI_EFFECT_FAILED",
              "The browser could not confirm the clipboard write; the operation was not saved",
            );
            value.reject(failure);
          }
        }
      }
      remove(value);
      return {
        effectId: value.id,
        eventId: value.eventId,
        kind: value.kind,
        resolved: true,
      };
    },
    readArtifact(input) {
      healthy();
      options.check?.();
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["effectId", "eventId"].includes(key))
      )
        invalid("Invalid artifact request");
      const value = effects.get(input.effectId);
      if (!value || value.kind !== "download" || value.state !== "committed")
        throw new RuntimeError(
          "PLUGIN_UI_EFFECT_CLOSED",
          "This completed download is no longer available",
        );
      if (input.eventId !== value.eventId)
        invalid("Artifact event identity does not match");
      return {
        name: value.public.name,
        mime: value.public.mime,
        bytes: Buffer.from(value.bytes),
      };
    },
    cancelPending() {
      // Closing can race with the original event's prepare/dispatch stage. A
      // detached owner must also cancel a picker that has not been created yet.
      draining = true;
      for (const value of [...effects.values()])
        if (value.state === "pending") {
          if (value.kind === "file") {
            cancelled.add(value.eventId);
            value.resolve(null);
          } else if (value.kind === "confirm") {
            cancelled.add(value.eventId);
            value.resolve(false);
          } else {
            failure ??= new RuntimeError(
              "PLUGIN_UI_EFFECT_FAILED",
              "The pending clipboard write was cancelled; the operation was not saved",
            );
            value.reject(failure);
          }
          remove(value);
        }
      return { cancelled: true };
    },
    assertHealthy: healthy,
    close() {
      closed = true;
      for (const value of [...effects.values()]) {
        value.reject?.(
          new RuntimeError("PLUGIN_UI_EFFECT_CLOSED", "Plugin UI owner closed"),
        );
        remove(value);
      }
      cancelled.clear();
      active = undefined;
    },
  };
}
module.exports = { createPluginUIEffects, MAX_BYTES, filename };
