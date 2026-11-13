// @vitest-environment node
import { expect, test } from "vitest";
import { decode, encode } from "msgpackr/index-no-eval";
import { commandJson } from "../runtime/clientProtocol";
import { createSettingsRuntime } from "./settingsRuntime";
import {
  normalizePresetImportJson,
  PresetImportError,
  presetImportNumber,
} from "./presetImportJson";

test("packed optional undefined values do not replace preset defaults or break strict JSON admission", () => {
  const decoded = decode(
    encode({
      name: "Synthetic packed preset",
      temperature: undefined,
      custom: { absent: undefined, preserved: null },
      bias: [["synthetic-token", undefined]],
    }),
  );
  expect(Object.hasOwn(decoded, "temperature")).toBe(true);
  expect(() => commandJson(decoded)).toThrow(
    "Command must contain only JSON values",
  );
  const preset = normalizePresetImportJson({
    temperature: 80,
    ...normalizePresetImportJson(decoded),
  });
  expect(preset).toEqual({
    name: "Synthetic packed preset",
    temperature: 80,
    custom: { preserved: null },
    bias: [["synthetic-token", null]],
  });
  expect(() => commandJson(preset)).not.toThrow();
  expect(decoded.custom).toHaveProperty("absent", undefined);
});

test("valid native JSON and unknown extension fields are preserved exactly", () => {
  const value = JSON.parse(
    '{"name":"","temperature":0,"enabled":false,"custom":{"nullable":null,"zero":0,"false":false,"empty":"","list":[0,false,"",null]},"__proto__":{"custom":true}}',
  );
  const result = normalizePresetImportJson(value);
  expect(result).toEqual(value);
  expect(commandJson(result)).toBe(commandJson(value));
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  expect(result).not.toBe(value);
  expect(result.custom).not.toBe(value.custom);
});

test("undefined array entries and holes become null without shifting indexes", () => {
  const array = [undefined, , false, 0, "", null];
  const result = normalizePresetImportJson({ array });
  expect(result.array).toEqual([null, null, false, 0, "", null]);
  expect(array).toHaveLength(6);
  expect(1 in array).toBe(false);
});

test("valid null-prototype objects and shared JSON children remain supported", () => {
  const child = { keep: false, omit: undefined };
  const value = Object.assign(Object.create(null), {
    first: child,
    second: child,
  });
  expect(normalizePresetImportJson(value)).toEqual({
    first: { keep: false },
    second: { keep: false },
  });
});

test.each([
  NaN,
  Infinity,
  -Infinity,
  1n,
  Symbol("synthetic"),
  () => "synthetic",
  new Date(0),
  new Map(),
  new Uint8Array([1]),
])(
  "non-JSON packed/custom values fail clearly before admission (%s)",
  (value) => {
    expect(() =>
      normalizePresetImportJson({ custom: { invalid: value } }),
    ).toThrow(PresetImportError);
    expect(() =>
      normalizePresetImportJson({ custom: { invalid: value } }),
    ).toThrow('$["custom"]["invalid"]');
  },
);

test("cycles and accessors fail without invoking caller code", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => normalizePresetImportJson(cycle)).toThrow("cyclic values");
  let reads = 0;
  const accessor = {
    get custom() {
      reads++;
      return "synthetic";
    },
  };
  expect(() => normalizePresetImportJson(accessor)).toThrow(
    "accessors are not JSON values",
  );
  expect(reads).toBe(0);
});

test.each([undefined, null, [], "synthetic", 0])(
  "a preset must be an object (%s)",
  (value) => {
    expect(() => normalizePresetImportJson(value)).toThrow(
      "expected a preset object",
    );
  },
);

test("ST missing presence keeps the original template default and explicit values retain the original scale", () => {
  // Missing ST presence previously evaluated as undefined * 0.7 * 100 => NaN.
  expect(Number.isNaN((undefined as unknown as number) * 0.7 * 100)).toBe(true);
  expect(presetImportNumber(undefined, 70, "$.presence_penalty", 70)).toBe(70);
  expect(presetImportNumber(null, 70, "$.presence_penalty", 70)).toBe(70);
  expect(presetImportNumber(0, 70, "$.presence_penalty", 70)).toBe(0);
  expect(presetImportNumber(0.5, 70, "$.presence_penalty", 70)).toBe(35);
  expect(presetImportNumber(-1, 70, "$.presence_penalty", 70)).toBe(-70);
});

test("ST numeric conversion uses raw wire units instead of re-scaling inherited defaults", () => {
  const defaults = {
    temperature: 80,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    top_p: 1,
  };
  for (const value of [undefined, null]) {
    const raw = normalizePresetImportJson({
      temperature: value,
      frequency_penalty: value,
      presence_penalty: value,
      top_p: value,
    });
    expect({
      temperature: presetImportNumber(
        raw.temperature,
        defaults.temperature,
        "$.temperature",
        100,
      ),
      frequencyPenalty: presetImportNumber(
        raw.frequency_penalty,
        defaults.frequencyPenalty,
        "$.frequency_penalty",
        100,
      ),
      PresensePenalty: presetImportNumber(
        raw.presence_penalty,
        defaults.PresensePenalty,
        "$.presence_penalty",
        70,
      ),
      top_p: presetImportNumber(raw.top_p, defaults.top_p, "$.top_p"),
    }).toEqual(defaults);
  }
  expect(
    presetImportNumber(0, defaults.temperature, "$.temperature", 100),
  ).toBe(0);
  expect(
    presetImportNumber(0.43, defaults.temperature, "$.temperature", 100),
  ).toBe(43);
});

test("NAI omitted optional numbers preserve defaults, including zero and unavailable optional fields", () => {
  expect(
    presetImportNumber(undefined, 135, "$.parameters.temperature", 100),
  ).toBe(135);
  expect(presetImportNumber(0, 135, "$.parameters.temperature", 100)).toBe(0);
  expect(presetImportNumber(0.75, 135, "$.parameters.temperature", 100)).toBe(
    75,
  );
  expect(
    presetImportNumber(undefined, undefined, "$.parameters.cfg_scale"),
  ).toBeUndefined();
  expect(
    normalizePresetImportJson({
      cfg_scale: presetImportNumber(
        undefined,
        undefined,
        "$.parameters.cfg_scale",
      ),
    }),
  ).toEqual({});
  for (const value of ["0.5", false, NaN, Infinity])
    expect(() =>
      presetImportNumber(value, 70, "$.parameters.temperature", 100),
    ).toThrow("finite number");
  expect(() =>
    presetImportNumber(Number.MAX_VALUE, 70, "$.parameters.temperature", 100),
  ).toThrow("supported range");
});

test("the public preset template has no unsupported defaults with a complete host", () => {
  const runtime = createSettingsRuntime({
    defaultMainPrompt: "Synthetic main",
    defaultJailbreak: "Synthetic jailbreak",
    safeStructuredClone: structuredClone,
  } as Parameters<typeof createSettingsRuntime>[0]);
  expect(() => commandJson(runtime.presetTemplate)).not.toThrow();
  expect(normalizePresetImportJson(runtime.presetTemplate)).toEqual(
    runtime.presetTemplate,
  );
});
