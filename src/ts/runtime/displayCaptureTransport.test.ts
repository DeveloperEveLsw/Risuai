// @vitest-environment node
import { expect, test, vi } from "vitest";
import fc from "fast-check";
import {
  DisplayCaptureEncoder,
  DisplayCaptureDecoder,
  type CapturePacket,
} from "./displayCaptureTransport";
import { DisplayWireBudget } from "./displayWireBudget";
import { freezeDisplayJson } from "./displayScopeIdentity";

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const transmit = (
  value: unknown,
  sender: DisplayCaptureEncoder,
  receiver: DisplayCaptureDecoder,
) => receiver.decode(structuredClone(sender.encode(value)));

class PacketOracleBudget extends DisplayWireBudget {
  checks: { kind: "tree" | "serialized"; bytes: number }[] = [];
  override measure(value: unknown) {
    const bytes = super.measure(value);
    this.checks.push({ kind: "tree", bytes });
    return bytes;
  }
  override measureSerializedJson(value: string) {
    const bytes = super.measureSerializedJson(value);
    expect(bytes).toBe(new TextEncoder().encode(value).length);
    expect(bytes).toBe(new DisplayWireBudget().measure(JSON.parse(value)));
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    this.checks.push({ kind: "serialized", bytes });
    return bytes;
  }
}
const senderWithPacketBudget = (budget: DisplayWireBudget) =>
  new DisplayCaptureEncoder(
    new DisplayWireBudget(),
    16 * 1024 * 1024,
    512,
    4096,
    budget,
  );

test("bounded owned packets match native JSON and the independent tree-size oracle with fresh getters, aliases, prototype keys, sparse arrays and Unicode", () => {
  const budget = new PacketOracleBudget(),
    sender = senderWithPacketBudget(budget),
    receiver = new DisplayCaptureDecoder();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const packet = sender.encode(value);
      expect(receiver.decode(structuredClone(packet))).toEqual(json(value));
      expect(budget.checks.at(-1)).toEqual({
        kind: "serialized",
        bytes: new TextEncoder().encode(JSON.stringify(packet)).length,
      });
    }),
    { numRuns: 1000, seed: 419 },
  );
  const shared = { text: '한글😀\u0000"\\\ud800\udfff' };
  let reads = 0;
  const value = {
    ...JSON.parse('{"__proto__":{"owned":true}}'),
    left: shared,
    right: shared,
    array: [undefined, , NaN, Infinity, -0],
    missing: undefined,
    get fresh() {
      return ++reads;
    },
  };
  const packet = sender.encode(value);
  const decoded = receiver.decode(structuredClone(packet)) as typeof value;
  expect(reads).toBe(2); // Logical input check, then actual fresh capture visit.
  expect(decoded.fresh).toBe(2);
  expect(decoded.left).not.toBe(decoded.right);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  expect(decoded.array).toEqual([null, null, null, null, 0]);
  expect(decoded.left.text).toBe(shared.text);
  expect(budget.checks.at(-1)?.kind).toBe("serialized");
});

test("cold/changed definitions and large generated packets retain the full tree check; warm references remain private and exact", () => {
  const budget = new PacketOracleBudget(),
    sender = senderWithPacketBudget(budget),
    receiver = new DisplayCaptureDecoder();
  const body = { text: "Synthetic".repeat(1000) };
  freezeDisplayJson(body);
  const first = sender.encode({ body, fresh: 1 });
  expect(first.definitions).toHaveLength(1);
  expect(budget.checks.at(-1)?.kind).toBe("tree");
  receiver.decode(structuredClone(first));
  const next = sender.encode({ body, fresh: 2 });
  expect(next.definitions).toEqual([]);
  expect(budget.checks.at(-1)?.kind).toBe("serialized");
  const decoded = receiver.decode(structuredClone(next)) as {
    body: typeof body;
    fresh: number;
  };
  decoded.body.text = "private";
  expect(transmit({ body, fresh: 3 }, sender, receiver)).toEqual({
    body,
    fresh: 3,
  });
  const replacement = { text: "changed".repeat(1000) };
  freezeDisplayJson(replacement);
  const changed = sender.encode({ body: replacement });
  expect(changed.definitions).toHaveLength(1);
  expect(budget.checks.at(-1)?.kind).toBe("tree");
  receiver.decode(structuredClone(changed));
  // Over1MiB of escaped output still fits the existing logical/packet limits.
  const large = sender.encode({ text: "\u0000".repeat(200000) });
  expect(
    new TextEncoder().encode(JSON.stringify(large)).length,
  ).toBeGreaterThan(1024 * 1024);
  expect(budget.checks.at(-1)?.kind).toBe("tree");
  expect(receiver.decode(structuredClone(large))).toEqual({
    text: "\u0000".repeat(200000),
  });
});

test("native packet byte boundaries are exact and failures cannot commit the dictionary", () => {
  const value = { text: '한글😀\u0000"\\', extension: { retained: true } };
  const packet = new DisplayCaptureEncoder().encode(value);
  const bytes = new TextEncoder().encode(JSON.stringify(packet)).length;
  const budget = new PacketOracleBudget(bytes),
    sender = senderWithPacketBudget(budget);
  expect(sender.encode(value)).toEqual(packet);
  expect(budget.checks).toEqual([{ kind: "serialized", bytes }]);
  const limited = senderWithPacketBudget(new DisplayWireBudget(bytes - 1));
  const before = limited.diagnostics();
  expect(() => limited.encode(value)).toThrow("scope exceeds");
  expect(limited.diagnostics()).toEqual(before);
  class RejectNextSerialized extends PacketOracleBudget {
    reject = false;
    override measureSerializedJson(value: string) {
      if (this.reject)
        return new DisplayWireBudget(
          new TextEncoder().encode(value).length - 1,
        ).measureSerializedJson(value);
      return super.measureSerializedJson(value);
    }
  }
  const retainedBudget = new RejectNextSerialized(),
    retained = senderWithPacketBudget(retainedBudget),
    receiver = new DisplayCaptureDecoder();
  const body = { text: "Synthetic".repeat(1000) };
  freezeDisplayJson(body);
  expect(transmit({ body, revision: 1 }, retained, receiver)).toEqual({
    body,
    revision: 1,
  });
  const live = retained.diagnostics();
  retainedBudget.reject = true;
  expect(() => retained.encode({ body, revision: 2 })).toThrow("scope exceeds");
  expect(retained.diagnostics()).toEqual(live);
  retainedBudget.reject = false;
  expect(transmit({ body, revision: 3 }, retained, receiver)).toEqual({
    body,
    revision: 3,
  });
});

test("prototype toJSON hooks and a replaced serializer fall back without invoking raw container hooks", () => {
  const value = { text: "Synthetic", nested: [1, { value: true }] };
  const packet = new DisplayCaptureEncoder().encode(value);
  for (const prototype of [Object.prototype, Array.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "toJSON");
    const budget = new DisplayWireBudget(),
      seen: string[] = [];
    const measure = budget.measure.bind(budget),
      serialized = budget.measureSerializedJson.bind(budget);
    budget.measure = (value) => {
      seen.push("tree");
      return measure(value);
    };
    budget.measureSerializedJson = (value) => {
      seen.push("serialized");
      return serialized(value);
    };
    const sender = senderWithPacketBudget(budget);
    let hooks = 0,
      result: CapturePacket;
    Object.defineProperty(prototype, "toJSON", {
      configurable: true,
      get() {
        hooks++;
        throw Error("must not run prototype toJSON");
      },
    });
    try {
      result = sender.encode(value);
    } finally {
      if (descriptor) Object.defineProperty(prototype, "toJSON", descriptor);
      else Reflect.deleteProperty(prototype, "toJSON");
    }
    expect(result).toEqual(packet);
    expect(hooks).toBe(0);
    expect(seen).toEqual(["tree"]);
  }
  const original = JSON.stringify,
    budget = new PacketOracleBudget(),
    sender = senderWithPacketBudget(budget);
  let result: CapturePacket;
  vi.spyOn(JSON, "stringify").mockImplementation(
    (...args: Parameters<typeof JSON.stringify>) => original(...args),
  );
  try {
    result = sender.encode(value);
  } finally {
    vi.restoreAllMocks();
  }
  expect(result).toEqual(packet);
  expect(budget.checks.at(-1)?.kind).toBe("tree");
});

test("enveloped capture validates the complete logical invocation once while preserving exact bytes, Unicode, repeated aliases and unknown input fields", () => {
  const capture = { body: { text: '한글😀\u0000"\\' }, revision: 1 };
  freezeDisplayJson(capture.body);
  const envelope = {
    capture,
    content: "Synthetic😀",
    raw: capture.body,
    unknown: { retained: true },
    undefinedField: undefined,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  class CountingBudget extends DisplayWireBudget {
    observed: unknown[] = [];
    override measure(value: unknown) {
      this.observed.push(value);
      return super.measure(value);
    }
  }
  const budget = new CountingBudget(bytes),
    sender = new DisplayCaptureEncoder(budget),
    receiver = new DisplayCaptureDecoder();
  const packet = sender.encode(capture, envelope);
  expect(receiver.decode(structuredClone(packet))).toEqual(json(capture));
  // Dictionary admission still inspects registered immutable roots. It must
  // not revalidate the full capture after the complete envelope was checked.
  expect(budget.observed).toEqual([envelope, capture.body]);
  expect(packet).toEqual(new DisplayCaptureEncoder().encode(capture));
  expect(() =>
    new DisplayCaptureEncoder(new DisplayWireBudget(bytes - 1)).encode(
      capture,
      envelope,
    ),
  ).toThrow("scope exceeds");
  const before = sender.diagnostics();
  expect(() =>
    sender.encode(capture, { ...envelope, content: envelope.content + "X" }),
  ).toThrow("scope exceeds");
  expect(sender.diagnostics()).toEqual(before);
  capture.revision++;
  expect(
    receiver.decode(structuredClone(sender.encode(capture, envelope))),
  ).toEqual(json(capture));
  expect(() =>
    sender.encode(capture, { capture, invalid: () => true }),
  ).toThrow("JSON values");
  expect(() => sender.encode(capture, { capture: {} })).toThrow(
    "must own this capture",
  );
  let reads = 0;
  expect(() =>
    sender.encode(capture, {
      get capture() {
        reads++;
        return capture;
      },
    }),
  ).toThrow("must own this capture");
  expect(reads).toBe(0);
  expect(() =>
    sender.encode(
      capture,
      Object.defineProperty({}, "capture", { value: capture }),
    ),
  ).toThrow("must own this capture");
  expect(() => sender.encode(undefined, { capture: undefined })).toThrow(
    "must own this capture",
  );
});

test("full invocation bytes and packets match the original two-pass validation for synthetic arbitrary data", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.jsonValue(), (body, extension) => {
      const capture = { body: structuredClone(body), revision: 1 };
      freezeDisplayJson(capture.body);
      const envelope = {
        capture,
        content: "Synthetic😀\u0000",
        extension,
        raw: capture.body,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
      const oldBudget = new DisplayWireBudget(bytes);
      oldBudget.measure(envelope);
      const original = new DisplayCaptureEncoder(oldBudget).encode(capture);
      const candidate = new DisplayCaptureEncoder(
        new DisplayWireBudget(bytes),
      ).encode(capture, envelope);
      expect(candidate).toEqual(original);
      expect(
        new DisplayCaptureDecoder().decode(structuredClone(candidate)),
      ).toEqual(json(capture));
      expect(() =>
        new DisplayCaptureEncoder(new DisplayWireBudget(bytes - 1)).encode(
          capture,
          envelope,
        ),
      ).toThrow("scope exceeds");
    }),
    { numRuns: 300, seed: 107 },
  );
});

test("transport is differentially identical to original JSON projection for arbitrary trees, tokens, sparse/Unicode/prototype keys and aliases", () => {
  const sender = new DisplayCaptureEncoder(
      new DisplayWireBudget(),
      16 * 1024 * 1024,
      512,
      1,
    ),
    receiver = new DisplayCaptureDecoder();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const pinned = structuredClone(value);
      freezeDisplayJson(pinned);
      expect(transmit(pinned, sender, receiver)).toEqual(json(value));
      expect(transmit(pinned, sender, receiver)).toEqual(json(value));
    }),
    { numRuns: 1000, seed: 107 },
  );
  const shared = {
    text: '한글😀\u0000"\\',
    sparse: [undefined, , NaN, Infinity, -0],
    token: ["r", 1],
  };
  freezeDisplayJson(shared);
  const value = {
    ...JSON.parse('{"__proto__":{"value":"owned"}}'),
    left: shared,
    right: shared,
    missing: undefined,
    inlineNegativeZero: -0,
    map: new Map([["ignored", 1]]),
  };
  const decoded = transmit(value, sender, receiver) as typeof value;
  expect(decoded).toEqual(json(value));
  expect(decoded.left).not.toBe(decoded.right);
  expect(Object.is(decoded.inlineNegativeZero, -0)).toBe(false);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  decoded.left.text = "private";
  expect(decoded.right.text).toBe(shared.text);
  expect(transmit(value, sender, receiver)).toEqual(json(value));
});

test("large registered body is sent once, mutable shells/replacement bodies stay fresh and shallow/accessor values cannot be reused", () => {
  const sender = new DisplayCaptureEncoder(),
    receiver = new DisplayCaptureDecoder();
  const body = { history: [{ text: "Synthetic".repeat(3000) }] };
  freezeDisplayJson(body);
  const shell = { body, variable: "before", revision: 1 };
  const first = sender.encode(shell);
  expect(first.definitions.length).toBe(1);
  const decoded = receiver.decode(structuredClone(first)) as typeof shell;
  decoded.body.history[0].text = "private mutation";
  shell.variable = "later";
  shell.revision++;
  const second = sender.encode(shell);
  expect(second.definitions).toEqual([]);
  expect(receiver.decode(structuredClone(second))).toEqual(json(shell));
  expect(new TextEncoder().encode(JSON.stringify(second)).length).toBeLessThan(
    500,
  );
  const replacement = { history: [{ text: "New Synthetic".repeat(3000) }] };
  freezeDisplayJson(replacement);
  expect(transmit({ ...shell, body: replacement }, sender, receiver)).toEqual(
    json({ ...shell, body: replacement }),
  );
  let text = "a".repeat(5000);
  const shallow = Object.freeze({ nested: { text } }),
    accessor = {
      get text() {
        return text;
      },
    };
  freezeDisplayJson(accessor);
  expect(transmit({ shallow, accessor }, sender, receiver)).toEqual(
    json({ shallow, accessor }),
  );
  text = "b".repeat(6000);
  shallow.nested.text = text;
  expect(transmit({ shallow, accessor }, sender, receiver)).toEqual(
    json({ shallow, accessor }),
  );
  sender.close();
  receiver.close();
  expect(sender.diagnostics()).toMatchObject({ entries: 0, cachedBytes: 0 });
  expect(receiver.diagnostics()).toEqual({ entries: 0, cachedBytes: 0 });
});

test("bounded dictionary evicts/resends and inlines excess current roots without losing valid scope data", () => {
  const sender = new DisplayCaptureEncoder(new DisplayWireBudget(), 128, 1, 1),
    receiver = new DisplayCaptureDecoder(128, 1);
  const a = { text: "a".repeat(40) },
    b = { text: "b".repeat(40) };
  freezeDisplayJson(a);
  freezeDisplayJson(b);
  expect(transmit({ a, b }, sender, receiver)).toEqual(json({ a, b }));
  expect(sender.diagnostics().entries).toBe(1);
  const packet = sender.encode(b);
  expect(packet.drop.length).toBe(1);
  expect(receiver.decode(structuredClone(packet))).toEqual(b);
  expect(transmit(a, sender, receiver)).toEqual(a);
  for (const owner of [sender, receiver])
    expect(owner.diagnostics().cachedBytes).toBeLessThanOrEqual(128);
});

test("malformed/missing/duplicate references, dictionary overflow and expanded aliases fail without committing cache state", () => {
  const receiver = new DisplayCaptureDecoder();
  const base: CapturePacket = {
    version: 1,
    value: ["r", 1],
    definitions: [[1, 2, {}]],
    drop: [],
  };
  expect(receiver.decode(base)).toEqual({});
  const before = receiver.diagnostics();
  for (const packet of [
    { ...base, definitions: [], value: ["r", 2] },
    { ...base, definitions: [[1, 2, {}]] },
    { ...base, definitions: [], drop: [1, 1] },
    { ...base, definitions: [], value: ["r", -1] },
    {
      ...base,
      definitions: [],
      value: [
        "o",
        [
          ["x", null],
          ["x", null],
        ],
      ],
    },
    { ...base, definitions: [[2, 4, {}]], value: ["r", 2] },
    { ...base, definitions: [], version: 2 },
  ]) {
    expect(() => receiver.decode(packet as CapturePacket)).toThrow();
    expect(receiver.diagnostics()).toEqual(before);
  }
  const large = { text: "x".repeat(9 * 1024 * 1024) };
  const bytes = new TextEncoder().encode(JSON.stringify(large)).length;
  const expanded: CapturePacket = {
    version: 1,
    value: [
      "a",
      [
        ["r", 2],
        ["r", 2],
      ],
    ],
    definitions: [[2, bytes, large]],
    drop: [],
  };
  expect(() => receiver.decode(expanded)).toThrow("expanded capture exceeds");
  expect(receiver.diagnostics()).toEqual(before);
  expect(() => new DisplayCaptureDecoder(1, 1).decode(base)).toThrow(
    "dictionary exceeds",
  );
});

test("failed encoding preserves the live dictionary and original logical scope limit", () => {
  const sender = new DisplayCaptureEncoder(new DisplayWireBudget(), 128, 1, 1),
    receiver = new DisplayCaptureDecoder(128, 1);
  const body = { text: "x".repeat(50) };
  freezeDisplayJson(body);
  expect(transmit(body, sender, receiver)).toEqual(body);
  const before = sender.diagnostics();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => sender.encode(cyclic)).toThrow("circular");
  expect(sender.diagnostics()).toEqual(before);
  expect(transmit(body, sender, receiver)).toEqual(body);
  expect(() =>
    new DisplayCaptureEncoder(new DisplayWireBudget(8)).encode({
      long: "123456789",
    }),
  ).toThrow("scope exceeds");
});
