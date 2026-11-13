// @vitest-environment node
import { expect, test } from "vitest";
import fc from "fast-check";
import {
  bindDisplayShell,
  displayScopeJson,
  freezeDisplayJson,
} from "./displayScopeIdentity";
import { DisplayWireBudget } from "./displayWireBudget";
import type { DisplayCapture } from "./displayEffects";
import {
  displayPresentationIdentity,
  recordDisplayRead,
  noteDisplayProvisionalRead,
} from "./displayReadDependencies";

const text = "Synthetic 한글😀".repeat(2000);
function fixture(source = text, registered = true) {
  const message = [{ chatId: "m", role: "char", data: source }];
  if (registered) freezeDisplayJson(message);
  const chat = {
    id: "a",
    message,
    scriptstate: { $counter: "0" },
    GLGlobalVariables: {},
  };
  const character = {
    type: "character",
    chaId: "c",
    chats: [chat],
    triggerscript: [],
  };
  return {
    serverId: "server",
    state: {
      cursor: 1,
      inputClock: 1,
      chatId: "a",
      characterId: "c",
      chatEpoch: 1,
      characterEpoch: 1,
      applied: [],
      next: null,
    },
    projectedCursor: 1,
    database: {
      characters: [character],
      globalChatVariables: {},
      modules: [],
      presets: [],
      personas: [],
    },
    character,
    chat,
    triggers: [],
    sourceContent: source,
    message: { id: "m", revision: 1 },
    versions: {
      chat: new Map([["$counter", 1]]),
      localGlobal: new Map(),
      global: new Map(),
    },
    hasEarlier: false,
    persistent: true,
  } as unknown as DisplayCapture;
}
const key = (capture: DisplayCapture) =>
  displayScopeJson(capture, new DisplayWireBudget(undefined, 0, 0));

test("delivery cursor progress retains a UI owner only with the same complete input and admission, while execution keys remain distinct", () => {
  const capture = fixture();
  const identity = displayPresentationIdentity(capture);
  const delivered = { ...capture, projectedCursor: 20 };
  expect(displayPresentationIdentity(delivered)).toBe(identity);
  expect(key(delivered)).not.toBe(key(capture));
  expect(capture.projectedCursor).toBe(1);
  expect(delivered.projectedCursor).toBe(20);
  for (const changed of [
    { ...delivered, state: { ...capture.state, inputClock: 20 } },
    { ...delivered, state: { ...capture.state, cursor: 20 } },
    { ...delivered, state: { ...capture.state, chatEpoch: 20 } },
    { ...delivered, state: { ...capture.state, characterEpoch: 20 } },
    { ...delivered, history: { count: 2, cursor: 20 } },
    { ...delivered, chat: { ...capture.chat, isStreaming: true } },
    { ...delivered, sourceContent: "Changed" },
    { ...delivered, message: { ...capture.message, revision: 20 } },
    {
      ...delivered,
      versions: { ...capture.versions, global: new Map([["choice", 20]]) },
    },
    { ...delivered, hasEarlier: true },
    { ...delivered, persistent: false },
    { ...delivered, cbsModules: [{ id: "other", trigger: [] }] as never },
    { ...delivered, synthetic: "unknown changed metadata" } as DisplayCapture,
  ])
    expect(displayPresentationIdentity(changed)).not.toBe(identity);
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const changed = { ...delivered, synthetic: value } as DisplayCapture;
      expect(displayPresentationIdentity(changed)).not.toBe(identity);
    }),
    { numRuns: 300, seed: 105 },
  );
  recordDisplayRead(delivered, { scope: "global", key: "choice" });
  expect(displayPresentationIdentity(delivered)).not.toBe(identity);
});

test("serialized key checking preserves the previous tree-size oracle and fresh getter reads", () => {
  class ReferenceBudget extends DisplayWireBudget {
    override measureSerializedJson(json: string) {
      return this.measure(JSON.parse(json));
    }
  }
  const capture = fixture();
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const input = { ...capture, synthetic: value } as DisplayCapture;
      const actual = displayScopeJson(input, new DisplayWireBudget());
      expect(displayScopeJson(input, new ReferenceBudget())).toBe(actual);
      const bytes = new TextEncoder().encode(actual).length;
      expect(displayScopeJson(input, new DisplayWireBudget(bytes))).toBe(
        actual,
      );
      expect(() =>
        displayScopeJson(input, new DisplayWireBudget(bytes - 1)),
      ).toThrow("scope exceeds");
      expect(() =>
        displayScopeJson(input, new ReferenceBudget(bytes - 1)),
      ).toThrow("scope exceeds");
    }),
    { numRuns: 1000, seed: 852 },
  );
  let calls = 0;
  const reads: string[] = [];
  const input = {
    ...capture,
    synthetic: {
      get value() {
        reads.push("value:" + ++calls);
        return "value:" + calls;
      },
      get other() {
        reads.push("other:" + ++calls);
        return { nested: "한글😀:" + calls };
      },
    },
  } as DisplayCapture;
  const expected = displayScopeJson(input, new ReferenceBudget());
  const expectedReads = [...reads];
  calls = 0;
  reads.length = 0;
  expect(displayScopeJson(input, new DisplayWireBudget())).toBe(expected);
  expect(reads).toEqual(expectedReads);
});

test("matching registered history fields produce bounded local keys without changing the actual source or ordinary scalar comparison", () => {
  const capture = fixture(),
    before = capture.sourceContent;
  const result = key(capture);
  expect(JSON.parse(result)[0]).toBe("source-field");
  expect(result.length).toBeLessThan(3000);
  expect(key({ ...capture })).toBe(result);
  expect(capture.sourceContent).toBe(before);
  expect(capture.chat.message[0].data).toBe(before);
  const changed = { ...capture, sourceContent: before + " changed" };
  expect(key(changed)).not.toBe(result);
  expect(key(changed)).toContain(" changed");
  expect(key({ ...capture, sourceContent: undefined })).not.toBe(result);
  expect(
    key({ ...capture, sourceContent: ["source-field", result] as never }),
  ).not.toBe(result);
});

test("greetings use only registered owned immutable fields through their private mutable shell", () => {
  const capture = fixture();
  delete capture.message;
  const base = { ...capture.character, firstMessage: text };
  freezeDisplayJson(base);
  const character = { ...base };
  bindDisplayShell(character, base);
  capture.character = character as never;
  capture.database.characters = [character] as never;
  const result = key(capture);
  expect(JSON.parse(result)[0]).toBe("source-field");
  expect(result.length).toBeLessThan(3000);
  expect(key({ ...capture, sourceContent: text + " changed" })).not.toBe(
    result,
  );
  character.firstMessage = "new greeting";
  expect(key(capture)).not.toBe(result);
});

test("unregistered, shallow-frozen, accessor, inherited, absent and mismatching message values stay fully represented and fresh", () => {
  for (const kind of [
    "mutable",
    "shallow",
    "accessor",
    "inherited",
    "missing",
    "mismatch",
  ]) {
    const capture = fixture(text, false);
    let current = text;
    if (kind === "shallow") Object.freeze(capture.chat.message[0]);
    if (kind === "accessor") {
      Object.defineProperty(capture.chat.message[0], "data", {
        enumerable: true,
        configurable: true,
        get: () => current,
      });
      freezeDisplayJson(capture.chat.message);
    }
    if (kind === "inherited") {
      capture.chat.message[0] = Object.assign(Object.create({ data: text }), {
        chatId: "m",
        role: "char",
      });
      freezeDisplayJson(capture.chat.message);
    }
    if (kind === "missing") {
      capture.message.id = "absent";
      freezeDisplayJson(capture.chat.message);
    }
    if (kind === "mismatch") {
      freezeDisplayJson(capture.chat.message);
      capture.sourceContent = text + " other";
    }
    if (kind === "inherited") {
      expect(() => key(capture)).toThrow("JSON containers");
      continue;
    }
    const result = key(capture);
    expect(JSON.parse(result)[0]).not.toBe("source-field");
    expect(result.length).toBeGreaterThan(text.length);
    if (kind === "mutable") capture.chat.message[0].data = "replacement";
    else if (kind === "accessor") current = "replacement";
    else capture.sourceContent += " replacement";
    expect(key(capture)).not.toBe(result);
  }
});

test("source anchoring retains arbitrary fresh JSON fields, versions, owners, identity and outside read admission", () => {
  const capture = fixture(),
    initial = key(capture);
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const changed = { ...capture, synthetic: value } as DisplayCapture;
      expect(key(changed)).not.toBe(initial);
      expect(key({ ...changed })).toBe(key(changed));
    }),
    { numRuns: 500, seed: 107 },
  );
  for (const changed of [
    { ...capture, serverId: "other" },
    { ...capture, state: { ...capture.state, chatEpoch: 2 } },
    { ...capture, message: { ...capture.message, revision: 2 } },
    { ...capture, message: { ...capture.message, id: "other" } },
    { ...capture, hasEarlier: true },
    { ...capture, persistent: false },
    {
      ...capture,
      versions: { ...capture.versions, chat: new Map([["$counter", 2]]) },
    },
    { ...capture, chat: { ...capture.chat, scriptstate: { $counter: "9" } } },
  ])
    expect(key(changed)).not.toBe(initial);
  const first = displayPresentationIdentity(capture);
  recordDisplayRead(capture, { scope: "chat", chatId: "a", key: "$counter" });
  expect(displayPresentationIdentity(capture)).not.toBe(first);
});

test("small keys cannot bypass the complete logical16MiB execution-scope limit", () => {
  const capture = fixture("x".repeat(9 * 1024 * 1024));
  expect(key(capture).length).toBeLessThan(3000);
  const wire = {
    ...capture,
    character: undefined,
    chat: undefined,
    versions: { chat: [...capture.versions.chat], localGlobal: [], global: [] },
  };
  expect(() => new DisplayWireBudget().measure(wire)).toThrow(
    "Display Lua scope exceeds 16 MiB",
  );
  expect(capture.sourceContent.length).toBe(9 * 1024 * 1024);
});

test("a shared bounded size cache preserves uncached presentation keys, fresh mutable values and admission", () => {
  const budget = new DisplayWireBudget(16 * 1024 * 1024, 256, 2 * 1024 * 1024);
  const capture = fixture();
  const compare = (value: DisplayCapture) => {
    const actual = displayPresentationIdentity(value, budget);
    expect(actual).toBe(displayPresentationIdentity(value));
    expect(budget.diagnostics().strings).toBeLessThanOrEqual(256);
    expect(budget.diagnostics().retainedBytes).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    return actual;
  };
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const mutable = { ...capture, synthetic: { value } } as DisplayCapture;
      compare(mutable);
      (
        mutable as unknown as { synthetic: { value: unknown } }
      ).synthetic.value = { changed: value };
      compare(mutable);
    }),
    { numRuns: 500, seed: 107 },
  );
  const initial = compare(capture);
  capture.versions.chat.set("$counter", 2);
  expect(compare(capture)).not.toBe(initial);
  const changedVersion = compare(capture);
  recordDisplayRead(capture, { scope: "global", key: "missing" });
  expect(compare(capture)).not.toBe(changedVersion);
  const read = compare(capture);
  noteDisplayProvisionalRead(capture);
  expect(compare(capture)).not.toBe(read);
  let current = "before";
  const getter = {
    ...capture,
    synthetic: {
      get current() {
        return current;
      },
    },
  } as DisplayCapture;
  const beforeGetter = compare(getter);
  current = "changed 한글😀";
  expect(compare(getter)).not.toBe(beforeGetter);
  expect(() =>
    displayPresentationIdentity(capture, new DisplayWireBudget(32)),
  ).toThrow("scope exceeds");
  budget.close();
  expect(budget.diagnostics()).toMatchObject({ strings: 0, retainedBytes: 0 });
  expect(compare(capture)).toBe(displayPresentationIdentity(capture));
});
