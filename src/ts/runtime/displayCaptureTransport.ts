import { isImmutableDisplayJson } from "./displayScopeIdentity";
import { DisplayWireBudget } from "./displayWireBudget";

type Node =
  | null
  | string
  | number
  | boolean
  | ["r", number]
  | ["a", Node[]]
  | ["o", [string, Node][]];
export type CapturePacket = {
  version: 1;
  value: Node;
  definitions: [number, number, unknown][];
  drop: number[];
};
const SCOPE_BYTES = 16 * 1024 * 1024;
const PACKET_BYTES = 32 * 1024 * 1024;
const stringifyPacket = JSON.stringify;
const fail = (text: string): never => {
  throw new Error("Display capture transport: " + text);
};
const validId = (id: unknown): id is number =>
  Number.isSafeInteger(id) && Number(id) > 0;

/** Cache only private registered immutable containers. No script result or
 * mutable invocation is retained; the dictionary stores IDs/sizes, not bodies.
 */
export class DisplayCaptureEncoder {
  private ids = new WeakMap<object, number>();
  private entries = new Map<number, number>();
  private bytes = 0;
  private sequence = 0;
  private definitionsSent = 0;
  private definitionBytesSent = 0;
  private reusedReferences = 0;
  constructor(
    private size = new DisplayWireBudget(),
    private maxBytes = SCOPE_BYTES,
    private maxEntries = 512,
    private minBytes = 4096,
    private packetBudget = new DisplayWireBudget(PACKET_BYTES),
  ) {}
  encode(
    value: unknown,
    envelope?: Readonly<Record<string, unknown>>,
  ): CapturePacket {
    // The executor's fresh input envelope owns this capture as an enumerable data field.
    // Validate the complete logical invocation once, including content/identity,
    // instead of scanning that envelope and its capture in separate passes.
    if (envelope !== undefined) {
      const field = Object.getOwnPropertyDescriptor(envelope, "capture");
      if (
        !field?.enumerable ||
        !("value" in field) ||
        field.value !== value ||
        value === undefined
      )
        fail("input envelope must own this capture");
    }
    this.size.measure(envelope ?? value);
    const entries = new Map(this.entries);
    let bytes = this.bytes,
      nodes = 0,
      inlineStringUnits = 0,
      reused = 0;
    const used = new Set<number>(),
      ancestors = new Set<object>();
    const definitions: CapturePacket["definitions"] = [],
      drop: number[] = [];
    const visit = (item: unknown, depth = 0): Node => {
      if (++nodes > 200000 || depth > 128)
        return fail("structure exceeds its budget");
      if (item == null) return null;
      if (typeof item === "string") {
        inlineStringUnits += item.length;
        return item;
      }
      if (typeof item === "boolean") return item;
      if (typeof item === "number")
        return Number.isFinite(item) ? (item === 0 ? 0 : item) : null;
      if (typeof item !== "object") return fail("JSON values are required");
      if (ancestors.has(item)) return fail("circular capture");
      if (isImmutableDisplayJson(item)) {
        let id = this.ids.get(item);
        if (id && entries.has(id)) {
          const length = entries.get(id);
          entries.delete(id);
          entries.set(id, length);
          used.add(id);
          reused++;
          return ["r", id];
        }
        const length = this.size.measure(item);
        if (
          length >= this.minBytes &&
          length <= this.maxBytes &&
          this.maxEntries > 0
        ) {
          while (
            entries.size &&
            (entries.size >= this.maxEntries || bytes + length > this.maxBytes)
          ) {
            const evict = [...entries.keys()].find((key) => !used.has(key));
            if (evict === undefined) break;
            bytes -= entries.get(evict);
            entries.delete(evict);
            drop.push(evict);
          }
          // A valid scope may need more current roots than the cache permits.
          // Inline that root rather than rejecting or sharing mutable state.
          if (
            entries.size < this.maxEntries &&
            bytes + length <= this.maxBytes
          ) {
            if (!id) {
              if (!validId(this.sequence + 1))
                return fail("ID space exhausted");
              id = ++this.sequence;
              this.ids.set(item, id);
            }
            entries.set(id, length);
            bytes += length;
            used.add(id);
            definitions.push([id, length, item]);
            return ["r", id];
          }
        }
      }
      ancestors.add(item);
      let result: Node;
      if (Array.isArray(item))
        result = ["a", Array.from(item, (entry) => visit(entry, depth + 1))];
      else {
        const prototype = Object.getPrototypeOf(item);
        if (
          !(item instanceof Map) &&
          prototype !== Object.prototype &&
          prototype !== null
        )
          return fail("JSON containers are required");
        const fields: [string, Node][] = [];
        for (const key of Object.keys(item)) {
          const entry = item[key];
          if (entry !== undefined) {
            inlineStringUnits += key.length;
            fields.push([key, visit(entry, depth + 1)]);
          }
        }
        result = ["o", fields];
      }
      ancestors.delete(item);
      return result;
    };
    const packet: CapturePacket = {
      version: 1,
      value: visit(value),
      definitions,
      drop,
    };
    // With no new raw definitions, this packet consists entirely of freshly
    // constructed tag arrays, plain fields and JSON scalars. Native stringify
    // can avoid a second generated-tree walk. Bound its transient UTF-8 output
    // to1MiB: each source UTF-16 unit needs at most6 escaped bytes;64 bytes per
    // visited node cover tags, finite numbers, field punctuation and commas;
    //32 per eviction ID and128 for the fixed outer fields are conservative.
    // Cold/changed definitions and large packets retain the original walker.
    // A prototype toJSON hook or replaced serializer must never run here.
    const nativePacket =
      definitions.length === 0 &&
      inlineStringUnits * 6 + nodes * 64 + (drop.length + 1) * 32 + 128 <=
        1024 * 1024 &&
      JSON.stringify === stringifyPacket &&
      !("toJSON" in Object.prototype) &&
      !("toJSON" in Array.prototype);
    if (nativePacket)
      this.packetBudget.measureSerializedJson(stringifyPacket(packet));
    else this.packetBudget.measure(packet);
    // Commit only after all checks. A failed encode cannot desynchronize a live worker.
    this.entries = entries;
    this.bytes = bytes;
    this.reusedReferences += reused;
    this.definitionsSent += definitions.length;
    this.definitionBytesSent += definitions.reduce(
      (sum, row) => sum + row[1],
      0,
    );
    return packet;
  }
  diagnostics() {
    return {
      entries: this.entries.size,
      cachedBytes: this.bytes,
      definitionsSent: this.definitionsSent,
      definitionBytesSent: this.definitionBytesSent,
      reusedReferences: this.reusedReferences,
    };
  }
  close() {
    this.entries.clear();
    this.ids = new WeakMap();
    this.bytes = 0;
    this.packetBudget.close();
    this.size.close();
  }
}

/** Receiver retains canonical JSON strings, never the Lua-mutable decoded
 * objects. Parsing every reference separately preserves JSON alias separation.
 */
export class DisplayCaptureDecoder {
  private entries = new Map<number, { json: string; bytes: number }>();
  private bytes = 0;
  private packetBudget = new DisplayWireBudget(PACKET_BYTES);
  private size = new DisplayWireBudget();
  constructor(
    private maxBytes = SCOPE_BYTES,
    private maxEntries = 512,
  ) {}
  decode(packet: CapturePacket): unknown {
    this.packetBudget.measure(packet);
    if (
      packet?.version !== 1 ||
      !Array.isArray(packet.definitions) ||
      !Array.isArray(packet.drop)
    )
      return fail("invalid packet");
    const entries = new Map(this.entries),
      dropped = new Set<number>(),
      added = new Set<number>();
    let bytes = this.bytes,
      nodes = 0;
    for (const id of packet.drop) {
      if (!validId(id) || dropped.has(id) || !entries.has(id))
        return fail("invalid eviction");
      dropped.add(id);
      bytes -= entries.get(id).bytes;
      entries.delete(id);
    }
    for (const row of packet.definitions) {
      if (!Array.isArray(row) || row.length !== 3)
        return fail("invalid definition");
      const [id, expected, value] = row;
      if (
        !validId(id) ||
        added.has(id) ||
        entries.has(id) ||
        !Number.isSafeInteger(expected) ||
        expected < 0
      )
        return fail("invalid definition ID/size");
      const json = JSON.stringify(value);
      if (typeof json !== "string") return fail("definition is not JSON");
      const length = new TextEncoder().encode(json).length;
      if (length !== expected) return fail("definition size mismatch");
      bytes += length;
      added.add(id);
      entries.set(id, { json, bytes: length });
      if (bytes > this.maxBytes || entries.size > this.maxEntries)
        return fail("dictionary exceeds its budget");
    }
    const sized = (value: unknown) => this.size.measure(value);
    const bound = (length: number) => {
      if (length > SCOPE_BYTES) return fail("expanded capture exceeds 16 MiB");
      return length;
    };
    const visit = (
      item: Node,
      depth = 0,
    ): { value: unknown; bytes: number } => {
      if (++nodes > 200000 || depth > 128)
        return fail("structure exceeds its budget");
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
      )
        return { value: item === 0 ? 0 : item, bytes: bound(sized(item)) };
      if (!Array.isArray(item) || item.length !== 2)
        return fail("invalid encoded value");
      if (item[0] === "r") {
        const entry = validId(item[1]) && entries.get(item[1]);
        if (!entry) return fail("missing reference");
        return { value: JSON.parse(entry.json), bytes: bound(entry.bytes) };
      }
      if (!Array.isArray(item[1])) return fail("invalid container");
      if (item[0] === "a") {
        const value = [];
        let bytes = 2;
        for (const child of item[1]) {
          const decoded = visit(child, depth + 1);
          bytes = bound(bytes + (value.length ? 1 : 0) + decoded.bytes);
          value.push(decoded.value);
        }
        return { value, bytes };
      }
      if (item[0] !== "o") return fail("invalid tag");
      const value = {};
      let bytes = 2,
        count = 0;
      for (const field of item[1]) {
        if (
          !Array.isArray(field) ||
          field.length !== 2 ||
          typeof field[0] !== "string" ||
          Object.hasOwn(value, field[0])
        )
          return fail("invalid object field");
        const decoded = visit(field[1], depth + 1);
        bytes = bound(
          bytes + (count++ ? 1 : 0) + sized(field[0]) + 1 + decoded.bytes,
        );
        Object.defineProperty(value, field[0], {
          value: decoded.value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      return { value, bytes };
    };
    const decoded = visit(packet.value);
    this.entries = entries;
    this.bytes = bytes;
    return decoded.value;
  }
  diagnostics() {
    return { entries: this.entries.size, cachedBytes: this.bytes };
  }
  close() {
    this.entries.clear();
    this.bytes = 0;
    this.packetBudget.close();
    this.size.close();
  }
}
