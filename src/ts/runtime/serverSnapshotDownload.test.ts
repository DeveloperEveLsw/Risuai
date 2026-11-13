import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ServerSnapshotDownload } from "./serverSnapshotDownload";
import {
  snapshotMagic,
  snapshotEnd,
  validateSnapshotManifest,
} from "./serverSnapshotProtocol.mjs";
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const db = new TextEncoder().encode("Synthetic opaque database bytes"),
    asset = new TextEncoder().encode("Synthetic audio bytes");
  const manifest = {
    format: "risu-server-snapshot",
    version: 1,
    serverId: "synthetic",
    schema: 21,
    cursor: 3,
    files: [
      { name: "snapshot.sqlite", bytes: db.length, sha256: sha(db) },
      {
        name: "assets/" + sha(asset) + ".blob",
        bytes: asset.length,
        sha256: sha(asset),
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(manifest)),
    size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return {
    manifest,
    bytes: Buffer.concat([snapshotMagic, size, json, db, asset, snapshotEnd]),
  };
}
describe("streamed server snapshot", () => {
  it("verifies every byte partition without retaining database or asset bodies", () => {
    const f = fixture();
    for (const n of [1, 7, 65536]) {
      const v = new ServerSnapshotDownload("synthetic");
      for (let i = 0; i < f.bytes.length; i += n)
        v.push(f.bytes.subarray(i, i + n));
      expect(v.finish()).toEqual(f.manifest);
      expect(v.bytes).toBe(f.bytes.length);
    }
  });
  it("rejects truncated HTTP success, changed body bytes, authority mismatch and trailing data", () => {
    const f = fixture(),
      short = new ServerSnapshotDownload("synthetic");
    short.push(f.bytes.subarray(0, -1));
    expect(() => short.finish()).toThrow("incomplete");
    const bad = Buffer.from(f.bytes);
    bad[bad.length - 9] ^= 1;
    expect(() => new ServerSnapshotDownload("synthetic").push(bad)).toThrow(
      "checksum mismatch",
    );
    expect(() => new ServerSnapshotDownload("other").push(f.bytes)).toThrow(
      "another database",
    );
    const trailing = new ServerSnapshotDownload("synthetic");
    trailing.push(f.bytes);
    expect(() => trailing.push(new Uint8Array([0]))).toThrow(
      "completion marker",
    );
  });
  it("rejects path traversal, unsupported schema and duplicate asset bodies before use", () => {
    const f = fixture();
    expect(() =>
      validateSnapshotManifest({ ...f.manifest, schema: 23 }),
    ).toThrow("Invalid server");
    expect(() =>
      validateSnapshotManifest({
        ...f.manifest,
        files: [
          f.manifest.files[0],
          { ...f.manifest.files[1], name: "../other" },
        ],
      }),
    ).toThrow("Invalid snapshot asset");
    expect(() =>
      validateSnapshotManifest({
        ...f.manifest,
        files: [...f.manifest.files, f.manifest.files[1]],
      }),
    ).toThrow("Invalid snapshot entry");
  });
});
