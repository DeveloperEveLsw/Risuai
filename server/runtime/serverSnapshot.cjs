"use strict";
const { DatabaseSync, backup } = require("node:sqlite");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const { RuntimeError } = require("../entity/errors.cjs");
const {
  snapshotMagic,
  snapshotEnd,
  snapshotLimits,
  validateSnapshotManifest,
} = require("../../src/ts/runtime/serverSnapshotProtocol.mjs");
async function digestFile(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const part of createReadStream(file, { highWaterMark: 65536 })) {
    bytes += part.length;
    hash.update(part);
  }
  return { bytes, sha256: hash.digest("hex") };
}
async function prepareSnapshot({
  file,
  directory,
  serverId,
  afterPinned,
  limits = {},
}) {
  if (typeof backup !== "function")
    throw new RuntimeError(
      "SNAPSHOT_UNAVAILABLE",
      "Server snapshots require Node.js 22.16 or newer",
    );
  const max = { ...snapshotLimits, ...limits };
  const source = new DatabaseSync(file, { readOnly: true });
  const target = join(directory, "snapshot.sqlite");
  let authority, cursor, schema;
  try {
    source.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN;");
    authority = source
      .prepare("SELECT id FROM runtime_identity WHERE singleton=1")
      .get().id;
    if (authority !== serverId)
      throw new RuntimeError(
        "SERVER_CHANGED",
        "Snapshot requires the current authority",
      );
    schema = source.prepare("PRAGMA user_version").get().user_version;
    cursor =
      source
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'")
        .get()?.seq ?? 0;
    const pages = source.prepare("PRAGMA page_count").get().page_count,
      pageSize = source.prepare("PRAGMA page_size").get().page_size;
    if (pages * pageSize > max.databaseBytes)
      throw new RuntimeError(
        "ARCHIVE_TOO_LARGE",
        "Snapshot database exceeds its budget",
      );
    afterPinned?.({ authority, cursor });
    await backup(source, target, { rate: 100 });
    source.exec("COMMIT");
  } finally {
    source.close();
  }
  await fs.chmod(target, 0o600);
  const copy = new DatabaseSync(target, { readOnly: true });
  let blobs;
  try {
    if (
      copy.prepare("SELECT COUNT(DISTINCT digest) AS count FROM assets").get()
        .count +
        1 >
      max.files
    )
      throw new RuntimeError(
        "ARCHIVE_TOO_LARGE",
        "Snapshot asset inventory exceeds its budget",
      );
    blobs = copy
      .prepare(
        "SELECT digest, MIN(byte_length) AS bytes, MAX(byte_length) AS maxBytes FROM assets GROUP BY digest ORDER BY digest",
      )
      .all();
    if (blobs.some((b) => b.bytes !== b.maxBytes))
      throw new RuntimeError(
        "ASSET_STORAGE_ERROR",
        "Asset aliases disagree about stored bytes",
      );
  } finally {
    copy.close();
  }
  const files = [
    { name: "snapshot.sqlite", ...(await digestFile(target)) },
    ...blobs.map((b) => ({
      name: "assets/" + b.digest + ".blob",
      bytes: b.bytes,
      sha256: b.digest,
    })),
  ];
  if (files.reduce((n, f) => n + f.bytes, 0) > max.totalBytes)
    throw new RuntimeError(
      "ARCHIVE_TOO_LARGE",
      "Snapshot exceeds its transfer budget",
    );
  const manifest = validateSnapshotManifest({
    format: "risu-server-snapshot",
    version: 1,
    serverId: authority,
    schema,
    cursor,
    files,
  });
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > max.manifestBytes)
    throw new RuntimeError(
      "ARCHIVE_TOO_LARGE",
      "Snapshot manifest exceeds its budget",
    );
  return {
    manifest,
    json,
    target,
    assetRoot: join(file + ".assets", authority),
  };
}
async function* snapshotChunks(prepared) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(prepared.json.length);
  yield Buffer.from(snapshotMagic);
  yield size;
  for (let at = 0; at < prepared.json.length; at += 65536)
    yield prepared.json.subarray(at, at + 65536);
  for (const file of prepared.manifest.files) {
    const path =
      file.name === "snapshot.sqlite"
        ? prepared.target
        : join(prepared.assetRoot, file.sha256 + ".blob");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const part of createReadStream(path, { highWaterMark: 65536 })) {
      bytes += part.length;
      if (bytes > file.bytes)
        throw new RuntimeError(
          "ASSET_STORAGE_ERROR",
          "Snapshot entry grew during export",
        );
      hash.update(part);
      yield part;
    }
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
      throw new RuntimeError(
        "ASSET_STORAGE_ERROR",
        "Snapshot entry checksum does not match",
      );
  }
  // Required completion marker; a truncated HTTP 200 is never a valid snapshot.
  yield Buffer.from(snapshotEnd);
}
module.exports = { prepareSnapshot, snapshotChunks, digestFile };
