// @vitest-environment node
import { expect, test } from "vitest";
import fc from "fast-check";
import { pinDisplayValue } from "./displayWorkerExecutor";
import {
  freezeDisplayJson,
  isImmutableDisplayJson,
} from "./displayScopeIdentity";
import {
  DisplayCaptureEncoder,
  DisplayCaptureDecoder,
} from "./displayCaptureTransport";
import { DisplayWireBudget } from "./displayWireBudget";

function frozen<T>(value: T) {
  const pinned = pinDisplayValue(value);
  freezeDisplayJson(pinned);
  return pinned;
}

test("fresh arbitrary JSON is preserved while exact registered copies reuse their previous body", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.jsonValue(), (old, fresh) => {
      const prior = frozen(old);
      const pinned = pinDisplayValue(fresh, prior);
      expect(JSON.stringify(pinned)).toBe(JSON.stringify(fresh));
      const equal = pinDisplayValue(structuredClone(old), prior);
      expect(equal).toBe(prior);
    }),
    { numRuns: 1000, seed: 108 },
  );
});

test("changed/deleted/added unknown metadata and key ordering stay fresh while the identical history keeps its identity", () => {
  const raw = {
    revision: 1,
    history: [{ text: "Synthetic".repeat(1000) }],
    unknown: { a: 1, b: 2 },
  };
  const prior = frozen(raw);
  for (const unknown of [
    { a: 3, b: 2 },
    { a: 1 },
    { a: 1, b: 2, c: 3 },
    { b: 2, a: 1 },
  ]) {
    const fresh = { ...structuredClone(raw), revision: 2, unknown };
    const pinned = pinDisplayValue(fresh, prior);
    expect(pinned.history).toBe(prior.history);
    expect(pinned.unknown).not.toBe(prior.unknown);
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(fresh));
    expect(pinned.revision).toBe(2);
  }
  const reordered = {
    unknown: structuredClone(raw.unknown),
    history: structuredClone(raw.history),
    revision: 1,
  };
  expect(JSON.stringify(pinDisplayValue(reordered, prior))).toBe(
    JSON.stringify(reordered),
  );
});

test("changed/deleted/reordered/extended array rows and sparse lengths do not borrow an older history", () => {
  const raw = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ],
    prior = frozen(raw);
  for (const fresh of [
    [{ id: "a", value: 3 }, raw[1]],
    [raw[1]],
    [raw[1], raw[0]],
    [...raw, { id: "c", value: 3 }],
  ]) {
    const pinned = pinDisplayValue(fresh, prior);
    expect(pinned).not.toBe(prior);
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(fresh));
  }
  const sparse = [undefined, , NaN, Infinity, -0];
  sparse.length = 8;
  const base = frozen(sparse),
    fresh = pinDisplayValue(sparse, base);
  expect(fresh).toBe(base);
  expect(fresh.length).toBe(8);
  expect(Object.keys(fresh)).toEqual(Object.keys(sparse));
  expect(JSON.stringify(fresh)).toBe(JSON.stringify(sparse));
  expect(Object.is(fresh[4], -0)).toBe(true);
});

test("alias splits/merges and nested diamonds preserve fresh container identity relations", () => {
  const shared = { nested: { text: "same" } };
  const merged = frozen({ left: shared, right: shared });
  const splitSource = {
    left: structuredClone(shared),
    right: structuredClone(shared),
  };
  const split = pinDisplayValue(splitSource, merged);
  expect(split.left).not.toBe(split.right);
  expect(split.left.nested).not.toBe(split.right.nested);
  const prior = frozen(splitSource),
    fresh = pinDisplayValue({ left: shared, right: shared }, prior);
  expect(fresh.left).toBe(fresh.right);
  const diamond = { left: { child: shared }, right: { child: shared } };
  const pinned = pinDisplayValue(
    diamond,
    frozen({
      left: { child: structuredClone(shared) },
      right: { child: structuredClone(shared) },
    }),
  );
  expect(pinned.left.child).toBe(pinned.right.child);
  expect(pinned.left).not.toBe(pinned.right);
});

test("cycles remain privately copied, never qualify for immutable reuse or bypass later rejection", () => {
  const raw: { text: string; self?: unknown } = { text: "same" };
  raw.self = raw;
  const prior = frozen(raw),
    pinned = pinDisplayValue(raw, prior);
  expect(pinned).not.toBe(raw);
  expect(pinned).not.toBe(prior);
  expect(pinned.self).toBe(pinned);
  expect(isImmutableDisplayJson(pinned)).toBe(false);
  expect(() => new DisplayWireBudget().measure(pinned)).toThrow("circular");
});

test("every fresh getter is read in order once per pin and a reused source reference cannot hide a mutation", () => {
  let text = "before";
  const reads: string[] = [];
  const raw = {
    get first() {
      reads.push("first");
      return { text };
    },
    get second() {
      reads.push("second");
      return text;
    },
  };
  const prior = frozen(raw);
  reads.length = 0;
  expect(pinDisplayValue(raw, prior)).toBe(prior);
  expect(reads).toEqual(["first", "second"]);
  reads.length = 0;
  text = "after";
  const pinned = pinDisplayValue(raw, prior);
  expect(reads).toEqual(["first", "second"]);
  expect(pinned).toEqual({ first: { text: "after" }, second: "after" });
  expect(prior.first.text).toBe("before");
});

test("shallow frozen/accessor priors cannot be reused or execute an old getter; Maps remain fresh", () => {
  let oldReads = 0;
  const prior = Object.freeze({
    get nested() {
      oldReads++;
      return { text: "same" };
    },
  });
  const pinned = pinDisplayValue({ nested: { text: "same" } }, prior);
  expect(oldReads).toBe(0);
  expect(pinned).not.toBe(prior);
  const shallow = Object.freeze({ nested: { text: "same" } });
  expect(pinDisplayValue({ nested: { text: "same" } }, shallow)).not.toBe(
    shallow,
  );
  const map = new Map([["value", 1]]),
    base = frozen({ map });
  map.set("value", 2);
  const fresh = pinDisplayValue({ map }, base);
  expect(fresh.map).not.toBe(base.map);
  expect(fresh.map.get("value")).toBe(2);
});

test("Unicode/undefined/nonfinite values and own prototype keys preserve original JSON projection without prototype injection", () => {
  const raw = JSON.parse('{"__proto__":{"text":"same"},"a":1}');
  raw.text = '한글😀\u0000"\\';
  raw.missing = undefined;
  raw.nan = NaN;
  const prior = frozen(raw),
    pinned = pinDisplayValue(raw, prior);
  expect(pinned).toBe(prior);
  expect(Object.getPrototypeOf(pinned)).toBe(Object.prototype);
  expect(Object.hasOwn(pinned, "__proto__")).toBe(true);
  expect(JSON.stringify(pinned)).toBe(JSON.stringify(raw));
});

test("reuse traverses fresh structure and still rejects structural/JSON/wire budget violations", () => {
  const oversized = Array(200001).fill(0);
  freezeDisplayJson(oversized);
  expect(() => pinDisplayValue(oversized, oversized)).toThrow(
    "structural budget",
  );
  let deep: unknown = 0;
  for (let i = 0; i < 130; i++) deep = { child: deep };
  freezeDisplayJson(deep);
  expect(() => pinDisplayValue(deep, deep)).toThrow("structural budget");
  expect(() => pinDisplayValue({ bad: () => 1 })).toThrow("JSON values");
  const huge = frozen({ text: "a".repeat(16 * 1024 * 1024) });
  const reused = pinDisplayValue({ text: huge.text }, huge);
  expect(reused).toBe(huge);
  expect(() => new DisplayWireBudget().measure(reused)).toThrow("16 MiB");
});

test("unchanged history is defined once across fresh revisions, changed history is sent, and worker JSON remains private", () => {
  const sender = new DisplayCaptureEncoder(),
    receiver = new DisplayCaptureDecoder();
  const prior = frozen({
    revision: 1,
    history: [{ text: "Synthetic".repeat(1000) }],
  });
  const next = pinDisplayValue(
    { revision: 2, history: structuredClone(prior.history) },
    prior,
  );
  freezeDisplayJson(next);
  const firstShell = { revision: 1, history: prior.history };
  const start = sender.encode(firstShell);
  expect(start.definitions).toHaveLength(1);
  const decoded = receiver.decode(structuredClone(start)) as typeof firstShell;
  decoded.history[0].text = "private mutation";
  const packet = sender.encode({ revision: 2, history: next.history });
  expect(packet.definitions).toEqual([]);
  expect(receiver.decode(structuredClone(packet))).toEqual({
    revision: 2,
    history: prior.history,
  });
  const changed = pinDisplayValue(
    { revision: 3, history: [{ text: "changed".repeat(2000) }] },
    next,
  );
  freezeDisplayJson(changed);
  const updated = sender.encode({ revision: 3, history: changed.history });
  expect(updated.definitions).toHaveLength(1);
  expect(receiver.decode(structuredClone(updated))).toEqual({
    revision: 3,
    history: changed.history,
  });
  sender.close();
  receiver.close();
});
