// @vitest-environment node
import { expect, test, vi } from "vitest";
import fc from "fast-check";
import { DisplayWireBudget } from "./displayWireBudget";
import { freezeDisplayJson } from "./displayScopeIdentity";

const encodedSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

test("scalar and trusted root sizing keeps exact bytes without allocating traversal collections; fresh containers still read getters", () => {
  const budget = new DisplayWireBudget();
  const body = { text: "Synthetic😀", nested: { retained: true } };
  freezeDisplayJson(body);
  const bodyBytes = budget.measure(body);
  const inputs = [
    null,
    true,
    false,
    0,
    -0,
    NaN,
    Infinity,
    -Infinity,
    '한글😀\u0000"\\',
    body,
    body,
  ];
  const expected = inputs.map(encodedSize);
  const NativeMap = Map,
    NativeSet = Set;
  let maps = 0,
    sets = 0,
    reads = 0;
  const measured: number[] = [];
  const fresh = {
    get text() {
      reads++;
      return "fresh:" + reads;
    },
  };
  vi.stubGlobal(
    "Map",
    class extends NativeMap {
      constructor() {
        super();
        maps++;
      }
    },
  );
  vi.stubGlobal(
    "Set",
    class extends NativeSet {
      constructor() {
        super();
        sets++;
      }
    },
  );
  let directAllocations: { maps: number; sets: number }, freshBytes: number[];
  try {
    for (const value of inputs) measured.push(budget.measure(value));
    directAllocations = { maps, sets };
    freshBytes = [budget.measure(fresh), budget.measure(fresh)];
  } finally {
    vi.unstubAllGlobals();
  }
  expect(measured).toEqual(expected);
  expect(measured.at(-1)).toBe(bodyBytes);
  expect(directAllocations).toEqual({ maps: 0, sets: 0 });
  expect(freshBytes).toEqual([
    encodedSize({ text: "fresh:1" }),
    encodedSize({ text: "fresh:2" }),
  ]);
  expect(reads).toBe(2);
  expect(maps).toBe(2);
  expect(sets).toBe(2);
});

test("owned serialized projections have exact UTF-8 bytes without retaining strings", () => {
  const budget = new DisplayWireBudget();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const json = JSON.stringify(value);
      expect(budget.measureSerializedJson(json)).toBe(encodedSize(value));
    }),
    { numRuns: 1000, seed: 217 },
  );
  for (const value of [
    '한글😀\u0000\n"\\\ud800\udfff\ud800\udfff',
    "a".repeat(16382) + "😀" + "한글".repeat(20000),
    "😀".repeat(20000),
    "\u0000".repeat(20000),
    { missing: undefined, sparse: [undefined, , NaN, Infinity, -0] },
  ]) {
    const json = JSON.stringify(value),
      bytes = encodedSize(value);
    expect(budget.measureSerializedJson(json)).toBe(bytes);
    expect(new DisplayWireBudget(bytes).measureSerializedJson(json)).toBe(
      bytes,
    );
    expect(() =>
      new DisplayWireBudget(bytes - 1).measureSerializedJson(json),
    ).toThrow("scope exceeds");
  }
  expect(budget.diagnostics()).toMatchObject({
    strings: 0,
    retainedBytes: 0,
    hits: 0,
    misses: 0,
  });
  budget.close();
  expect(budget.measureSerializedJson(JSON.stringify("after close 😀"))).toBe(
    encodedSize("after close 😀"),
  );
});

test("serialized checking retains the existing encode-only browser capability", () => {
  const encoder = new TextEncoder();
  const json = JSON.stringify("한글😀\u0000\ud800");
  const bytes = encoder.encode(json).length;
  vi.stubGlobal(
    "TextEncoder",
    class {
      encode(value: string) {
        return encoder.encode(value);
      }
    },
  );
  try {
    expect(new DisplayWireBudget(bytes).measureSerializedJson(json)).toBe(
      bytes,
    );
    expect(() =>
      new DisplayWireBudget(bytes - 1).measureSerializedJson(json),
    ).toThrow("scope exceeds");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("registered frozen JSON has exact reusable bytes, aliases, fresh shells and limits", () => {
  const body = {
    history: [
      { text: "한글😀\u0000" },
      { missing: undefined, sparse: [undefined, , NaN] },
    ],
  };
  freezeDisplayJson(body);
  const budget = new DisplayWireBudget();
  const shell = { body, alias: body, variable: "0", revision: 1 };
  expect(budget.measure(shell)).toBe(encodedSize(shell));
  const before = budget.diagnostics();
  expect(budget.measure(shell)).toBe(encodedSize(shell));
  expect(budget.diagnostics().immutableHits).toBeGreaterThan(
    before.immutableHits,
  );
  expect(budget.diagnostics().immutableMisses).toBe(before.immutableMisses);
  shell.variable = "changed 😀";
  shell.revision++;
  expect(budget.measure(shell)).toBe(encodedSize(shell));
  const bytes = encodedSize(shell);
  const exact = new DisplayWireBudget(bytes);
  expect(exact.measure(shell)).toBe(bytes);
  expect(exact.measure(shell)).toBe(bytes);
  expect(() => new DisplayWireBudget(bytes - 1).measure(shell)).toThrow(
    "scope exceeds",
  );
  budget.close();
  const closed = budget.diagnostics();
  expect(budget.measure(shell)).toBe(bytes);
  expect(budget.diagnostics().immutableMisses).toBeGreaterThan(
    closed.immutableMisses,
  );
});

test("shallow freeze, accessor results, Maps and cyclic containers cannot masquerade as reusable JSON", () => {
  const budget = new DisplayWireBudget();
  const shallow = Object.freeze({ child: { text: "before" } });
  expect(budget.measure(shallow)).toBe(encodedSize(shallow));
  shallow.child.text = "longer after";
  expect(budget.measure(shallow)).toBe(encodedSize(shallow));
  let text = "old";
  const accessor = {
    get text() {
      return text;
    },
  };
  freezeDisplayJson(accessor);
  expect(budget.measure(accessor)).toBe(encodedSize(accessor));
  text = "new getter result";
  expect(budget.measure(accessor)).toBe(encodedSize(accessor));
  const map = new Map([["ignored", "before"]]);
  freezeDisplayJson(map);
  expect(budget.measure(map)).toBe(encodedSize(map));
  map.set("ignored", "after");
  expect(budget.measure(map)).toBe(encodedSize(map));
  expect(budget.diagnostics().immutableHits).toBe(0);
  expect(budget.diagnostics().immutableMisses).toBe(0);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  freezeDisplayJson(circular);
  expect(() => budget.measure(circular)).toThrow("circular");
});

test("wire budget matches native UTF-8 JSON for arbitrary JSON trees and Unicode escaping", () => {
  const budget = new DisplayWireBudget();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      expect(budget.measure(value)).toBe(encodedSize(value));
      const pinned = structuredClone(value);
      freezeDisplayJson(pinned);
      expect(budget.measure(pinned)).toBe(encodedSize(value));
      expect(budget.measure(pinned)).toBe(encodedSize(value));
    }),
    { numRuns: 1000, seed: 107 },
  );
  for (const value of [
    '한글😀\u0000\n"\\',
    "\ud800\udfff",
    "\ud800",
    "\udfff",
    -0,
    NaN,
    Infinity,
    -Infinity,
    {
      missing: undefined,
      nullValue: null,
      nested: [undefined, , NaN, Infinity, "🧪"],
    },
  ]) {
    expect(budget.measure(value)).toBe(encodedSize(value));
  }
});
test("wire byte boundary includes escapes, keys and repeated aliases exactly", () => {
  const child = { text: "한국어😀\u0000" };
  const value = {
    a: child,
    b: child,
    versions: [["$value", 7]],
    extra: new Map([["ignored", 1]]),
  };
  const bytes = encodedSize(value);
  expect(new DisplayWireBudget(bytes).measure(value)).toBe(bytes);
  expect(() => new DisplayWireBudget(bytes - 1).measure(value)).toThrow(
    "scope exceeds",
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => new DisplayWireBudget().measure(cyclic)).toThrow("circular");
});
test("cached immutable string lengths never cache mutable containers or alias revisions", () => {
  const budget = new DisplayWireBudget(),
    value = { text: "Synthetic", nested: { variable: "0" }, revision: 1 };
  expect(budget.measure(value)).toBe(encodedSize(value));
  const previous = budget.diagnostics();
  expect(budget.measure(value)).toBe(encodedSize(value));
  expect(budget.diagnostics().misses).toBe(previous.misses);
  expect(budget.diagnostics().hits).toBeGreaterThan(previous.hits);
  value.nested.variable = "99";
  value.revision = 2;
  expect(budget.measure(value)).toBe(encodedSize(value));
});
test("wire string cache obeys entry and retained-character budgets and releases on close", () => {
  const budget = new DisplayWireBudget(1024, 3, 16);
  for (const value of [
    "aa",
    "bbb",
    "cc",
    "dddd",
    "oversized-synthetic-string",
  ]) {
    expect(budget.measure(value)).toBe(encodedSize(value));
    expect(budget.diagnostics().strings).toBeLessThanOrEqual(3);
    expect(budget.diagnostics().retainedBytes).toBeLessThanOrEqual(16);
  }
  budget.close();
  expect(budget.diagnostics()).toMatchObject({ strings: 0, retainedBytes: 0 });
});
