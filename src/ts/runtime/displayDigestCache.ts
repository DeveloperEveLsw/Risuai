import { displayHash } from "./displayEffects";

type Entry = { promise: Promise<string>; bytes: number };

/** Exact SHA-256 inputs only. Never retain scopes, Lua results or write proposals. */
export class DisplayDigestCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private closed = false;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private implementation?: {
    subtle: SubtleCrypto;
    digest: SubtleCrypto["digest"];
  };
  constructor(
    private maxBytes = 2 * 1024 * 1024,
    private maxEntries = 256,
    private digest: (value: string) => Promise<string> = displayHash,
  ) {
    for (const limit of [maxBytes, maxEntries])
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw Error("Invalid display digest cache budget");
  }
  hash(value: string): Promise<string> {
    if (this.closed)
      return Promise.reject(Error("Display digest owner closed"));
    if (this.digest === displayHash) {
      const subtle = globalThis.crypto?.subtle;
      if (
        this.implementation?.subtle !== subtle ||
        this.implementation?.digest !== subtle?.digest
      ) {
        // A replaced browser adapter must not inherit old successes or mask its
        // errors. Already issued promises keep their own original invocation.
        this.entries.clear();
        this.bytes = 0;
        this.implementation = { subtle, digest: subtle?.digest };
      }
    }
    const existing = this.entries.get(value);
    if (existing) {
      this.entries.delete(value);
      this.entries.set(value, existing);
      this.hits++;
      return existing.promise;
    }
    this.misses++;
    // UTF-16 input plus the 64-character digest; entry count bounds other overhead.
    const bytes = value.length * 2 + 128;
    const reusable = this.maxEntries > 0 && bytes <= this.maxBytes;
    if (reusable)
      while (
        this.entries.size &&
        (this.entries.size >= this.maxEntries ||
          this.bytes + bytes > this.maxBytes)
      ) {
        const key = this.entries.keys().next().value;
        this.bytes -= this.entries.get(key).bytes;
        this.entries.delete(key);
        this.evictions++;
      }
    let promise: Promise<string>;
    try {
      promise = this.digest(value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (reusable) {
      const entry = { promise, bytes };
      this.entries.set(value, entry);
      this.bytes += bytes;
      // Failure, close or eviction cannot install a late result for a new owner.
      void promise.catch(() => {
        if (this.entries.get(value) !== entry) return;
        this.entries.delete(value);
        this.bytes -= bytes;
      });
    }
    return promise;
  }
  close() {
    this.closed = true;
    this.entries.clear();
    this.bytes = 0;
  }
  diagnostics() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
