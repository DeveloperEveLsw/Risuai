import { Sha256 } from "@aws-crypto/sha256-js";
import {
  snapshotMagic,
  snapshotEnd,
  snapshotLimits,
  validateSnapshotManifest,
  type ServerSnapshotManifest,
} from "./serverSnapshotProtocol.mjs";
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a: Uint8Array) =>
  Array.from(a, (v) => v.toString(16).padStart(2, "0")).join("");

/** Bounded header plus one incremental hash; file bodies never accumulate. */
export class ServerSnapshotDownload {
  private prefix = new Uint8Array(12);
  private prefixBytes = 0;
  private header: Uint8Array | undefined;
  private headerBytes = 0;
  manifest: ServerSnapshotManifest | undefined;
  private index = 0;
  private entryBytes = 0;
  private hash = new Sha256();
  private endBytes = 0;
  bytes = 0;
  constructor(private serverId: string) {}
  push(chunk: Uint8Array) {
    this.bytes += chunk.length;
    let at = 0;
    while (at < chunk.length) {
      if (this.prefixBytes < 12) {
        const n = Math.min(12 - this.prefixBytes, chunk.length - at);
        this.prefix.set(chunk.subarray(at, at + n), this.prefixBytes);
        this.prefixBytes += n;
        at += n;
        if (this.prefixBytes === 12) {
          if (!equal(this.prefix.subarray(0, 8), snapshotMagic))
            throw Error("Invalid server snapshot magic");
          const n = new DataView(this.prefix.buffer).getUint32(8, true);
          if (!n || n > snapshotLimits.manifestBytes)
            throw Error("Invalid snapshot manifest length");
          this.header = new Uint8Array(n);
        }
      } else if (!this.manifest) {
        const n = Math.min(
          this.header!.length - this.headerBytes,
          chunk.length - at,
        );
        this.header!.set(chunk.subarray(at, at + n), this.headerBytes);
        this.headerBytes += n;
        at += n;
        if (this.headerBytes === this.header!.length) {
          this.manifest = validateSnapshotManifest(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(this.header),
            ),
          );
          this.header = undefined;
          if (this.manifest.serverId !== this.serverId)
            throw Error("Server snapshot belongs to another database");
        }
      } else if (this.index < this.manifest.files.length) {
        const entry = this.manifest.files[this.index],
          n = Math.min(entry.bytes - this.entryBytes, chunk.length - at);
        this.hash.update(chunk.subarray(at, at + n));
        this.entryBytes += n;
        at += n;
        if (this.entryBytes === entry.bytes) {
          if (hex(this.hash.digestSync()) !== entry.sha256)
            throw Error("Server snapshot checksum mismatch");
          this.index++;
          this.entryBytes = 0;
          this.hash = new Sha256();
        }
      } else {
        if (
          this.endBytes >= snapshotEnd.length ||
          chunk[at++] !== snapshotEnd[this.endBytes++]
        )
          throw Error("Invalid server snapshot completion marker");
      }
    }
  }
  finish() {
    if (
      !this.manifest ||
      this.index !== this.manifest.files.length ||
      this.endBytes !== snapshotEnd.length
    )
      throw Error("Server snapshot download is incomplete");
    return this.manifest;
  }
}
