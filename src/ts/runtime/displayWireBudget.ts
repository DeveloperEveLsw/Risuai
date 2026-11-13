import { isImmutableDisplayJson } from "./displayScopeIdentity";

/** Equivalent UTF-8 JSON size without building a whole scope string on the UI thread.
 * Private registered immutable bodies use weak size entries; mutable shells and
 * unregistered/shallow-frozen containers are read afresh on every invocation.
 */
export class DisplayWireBudget {
  private immutableSizes = new WeakMap<object, number>();
  private immutableHits = 0;
  private immutableMisses = 0;
  private strings = new Map<string, { bytes: number; retained: number }>();
  private retained = 0;
  private hits = 0;
  private misses = 0;
  private encoder = new TextEncoder();
  private encodingScratch?: Uint8Array;
  constructor(
    private limit = 16 * 1024 * 1024,
    private maxStrings = 1024,
    private maxRetainedBytes = 8 * 1024 * 1024,
  ) {}
  /** Check an already serialized, privately constructed JSON projection. The
   * producer still checks source types/depth and reads every fresh field. This
   * avoids walking its generated tag arrays again; never use it for raw inputs.
   */
  measureSerializedJson(json: string): number {
    if (json.length > this.limit)
      throw new Error("Display Lua scope exceeds 16 MiB");
    if (typeof this.encoder.encodeInto !== "function") {
      const bytes = this.encoder.encode(json).length;
      if (bytes > this.limit)
        throw new Error("Display Lua scope exceeds 16 MiB");
      return bytes;
    }
    const scratch = (this.encodingScratch ??= new Uint8Array(16384));
    let offset = 0,
      bytes = 0;
    while (offset < json.length) {
      // encodeInto consumes complete Unicode scalars, including at the buffer
      // boundary. The fixed scratch retains no input object and cannot grow.
      const part = this.encoder.encodeInto(json.slice(offset), scratch);
      if (!part.read)
        throw new Error("Display serialized scope encoding made no progress");
      offset += part.read;
      bytes += part.written;
      if (bytes > this.limit)
        throw new Error("Display Lua scope exceeds 16 MiB");
    }
    return bytes;
  }
  private stringBytes(value: string) {
    const previous = this.strings.get(value);
    if (previous) {
      this.hits++;
      this.strings.delete(value);
      this.strings.set(value, previous);
      return previous.bytes;
    }
    this.misses++;
    const bytes = this.encoder.encode(JSON.stringify(value)).length;
    const retained = value.length * 2;
    if (this.maxStrings > 0 && retained <= this.maxRetainedBytes) {
      while (
        this.strings.size &&
        (this.strings.size >= this.maxStrings ||
          this.retained + retained > this.maxRetainedBytes)
      ) {
        const key = this.strings.keys().next().value;
        this.retained -= this.strings.get(key).retained;
        this.strings.delete(key);
      }
      this.strings.set(value, { bytes, retained });
      this.retained += retained;
    }
    return bytes;
  }
  measure(value: unknown): number {
    // Scalar checks and already registered immutable roots need no traversal
    // state. The decoder measures every field/key separately; allocating two
    // collections and recursive closures for each one creates avoidable churn.
    let direct: number | undefined;
    if (value === null) direct = 4;
    else if (typeof value === "string") direct = this.stringBytes(value);
    else if (typeof value === "boolean") direct = value ? 4 : 5;
    else if (typeof value === "number") direct = JSON.stringify(value).length;
    else if (typeof value === "object") {
      // Entries are added only after successful sizing of privately registered
      // immutable JSON. Mutable or shallow-frozen values never qualify here.
      direct = this.immutableSizes.get(value);
      if (direct !== undefined) this.immutableHits++;
    }
    if (direct !== undefined) {
      if (direct > this.limit)
        throw new Error("Display Lua scope exceeds 16 MiB");
      return direct;
    }
    const ancestors = new Set<object>();
    const sizes = new Map<object, number>();
    const bounded = (bytes: number) => {
      if (bytes > this.limit)
        throw new Error("Display Lua scope exceeds 16 MiB");
      return bytes;
    };
    const size = (item: unknown): number => {
      if (item === null) return 4;
      if (typeof item === "string") return bounded(this.stringBytes(item));
      if (typeof item === "boolean") return item ? 4 : 5;
      if (typeof item === "number") return JSON.stringify(item).length;
      if (typeof item !== "object")
        throw new Error("Display Lua scope requires JSON values");
      if (ancestors.has(item))
        throw new Error("Display Lua scope cannot contain circular values");
      if (sizes.has(item)) return sizes.get(item);
      const immutable = isImmutableDisplayJson(item);
      if (immutable) {
        const cached = this.immutableSizes.get(item);
        if (cached !== undefined) {
          this.immutableHits++;
          return bounded(cached);
        }
        this.immutableMisses++;
      }
      ancestors.add(item);
      let bytes = 2,
        count = 0;
      if (Array.isArray(item)) {
        for (const entry of item) {
          bytes = bounded(
            bytes + (count++ ? 1 : 0) + (entry === undefined ? 4 : size(entry)),
          );
        }
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (
          !(item instanceof Map) &&
          prototype !== Object.prototype &&
          prototype !== null
        )
          throw new Error("Display Lua scope requires JSON containers");
        for (const key of Object.keys(item)) {
          const entry = item[key];
          if (entry === undefined) continue;
          bytes = bounded(
            bytes + (count++ ? 1 : 0) + this.stringBytes(key) + 1 + size(entry),
          );
        }
      }
      ancestors.delete(item);
      sizes.set(item, bounded(bytes));
      if (immutable) this.immutableSizes.set(item, bytes);
      return bytes;
    };
    return bounded(size(value));
  }
  diagnostics() {
    return {
      strings: this.strings.size,
      retainedBytes: this.retained,
      hits: this.hits,
      misses: this.misses,
      immutableHits: this.immutableHits,
      immutableMisses: this.immutableMisses,
    };
  }
  close() {
    this.strings.clear();
    this.retained = 0;
    this.immutableSizes = new WeakMap();
    this.encodingScratch = undefined;
  }
}
