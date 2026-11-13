"use strict";
const { RuntimeError } = require("./errors.cjs");
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const ID = /^([a-f0-9]{64})\.([a-z0-9]{1,16})$/;
function identity(id) {
  if (typeof id !== "string" || !ID.test(id))
    throw new RuntimeError("INVALID_COMMAND", "Invalid immutable asset ID");
  const [, digest, extension] = ID.exec(id);
  return { id, digest, extension };
}
function assetId(path) {
  const match =
    typeof path === "string" && /^assets\/(?:runtime\/)?([^/]+)$/.exec(path);
  if (!match)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Shared server asset path is required",
    );
  return identity(match[1]).id;
}
function register(store, value) {
  const expected = identity(value?.id);
  if (
    value.digest !== expected.digest ||
    value.extension !== expected.extension ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_ASSET_BYTES ||
    typeof value.mime !== "string" ||
    !/^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|ogg|wav|webm)|video\/(mp4|webm)|application\/octet-stream)$/.test(
      value.mime,
    )
  )
    throw new RuntimeError("INVALID_COMMAND", "Invalid asset metadata");
  return store.transaction(() => {
    const old = read(store, value.id);
    if (old) {
      if (
        old.digest !== value.digest ||
        old.extension !== value.extension ||
        old.byteLength !== value.byteLength ||
        old.mime !== value.mime
      )
        throw new RuntimeError(
          "IDENTITY_CONFLICT",
          "Immutable asset metadata cannot change",
        );
      return old;
    }
    store.db
      .prepare(
        "INSERT INTO assets(id,digest,extension,mime,byte_length,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        value.id,
        value.digest,
        value.extension,
        value.mime,
        value.byteLength,
        store.now(),
      );
    return read(store, value.id);
  });
}
function read(store, id) {
  identity(id);
  const row = store.db
    .prepare(
      "SELECT id,digest,extension,mime,byte_length AS byteLength,created_at AS createdAt FROM assets WHERE id=?",
    )
    .get(id);
  return row ? { ...row, path: "assets/runtime/" + row.id } : null;
}
module.exports = { identity, assetId, register, read, MAX_ASSET_BYTES };
