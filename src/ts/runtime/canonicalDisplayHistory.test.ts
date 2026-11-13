import { expect, test } from "vitest";
import { canonicalDisplayHistory } from "./canonicalDisplayHistory";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { defaultCBSRegisterArg } from "../cbs";
import type { Database, Message } from "../storage/database.svelte";

function fixture() {
  let failure: Error;
  const fail = (message: string): never => {
    failure ??= new Error(message);
    throw failure;
  };
  const messages = Array.from(
    { length: 100 },
    (_, i) =>
      ({
        chatId: "m-" + (i + 25),
        data: "Synthetic " + (i + 25),
        role: i === 0 ? "user" : "char",
      }) as Message,
  );
  const window = messages.map((m, i) => [m.chatId, i + 20] as const);
  const history = canonicalDisplayHistory(messages, 120, window, fail);
  const character = {
    type: "character",
    chaId: "c",
    name: "Synthetic",
    chats: [{ id: "a", fmIndex: -1, message: history, scriptstate: {} }],
    chatPage: 0,
  };
  const database = { characters: [character] } as unknown as Database;
  const cbs = createCbsRuntime({
    ...defaultCBSRegisterArg,
    getDatabase: () => database,
    findCharacterbyId: () => character as any,
  });
  return { history, messages, cbs, failure: () => failure };
}

test("original CBS uses canonical indices, actual selected body and complete length in a partial window", () => {
  const f = fixture();
  expect(
    f.cbs.parse("{{chat_index}}:{{role}}:{{lastmessageid}}:{{lastmessage}}", {
      chatID: 20,
    }),
  ).toBe("20:user:119:Synthetic 124");
  expect(f.history.at(-1).chatId).toBe("m-124");
  expect(f.history[20].chatId).toBe("m-25");
  expect(f.history.length).toBe(120);
  expect(f.failure()).toBeUndefined();
});

test("unloaded records cannot masquerade as absent rows during original iteration and JSON serialization", () => {
  for (const read of [
    (f: ReturnType<typeof fixture>) => f.history[19],
    (f) => f.history.map((m) => m.data),
    (f) => JSON.stringify(f.history),
    (f) => Object.keys(f.history),
  ]) {
    const f = fixture();
    expect(() => read(f)).toThrow(/unloaded history/);
    expect(f.failure()).toBeDefined();
  }
});

test("persistent row and order mutations fail without changing the pinned loaded bodies", () => {
  for (const write of [
    (f: ReturnType<typeof fixture>) => (f.history[20].data = "Changed"),
    (f) => f.history.push({} as Message),
    (f) => delete f.history[20],
  ]) {
    const f = fixture();
    expect(() => write(f)).toThrow(/server intent/);
    expect(f.messages[0].data).toBe("Synthetic 25");
    expect(f.failure()).toBeDefined();
  }
});

test("a complete canonical window retains actual array enumeration and projection semantics", () => {
  const messages = [
    { chatId: "m-a", data: "Synthetic A" },
    { chatId: "m-b", data: "Synthetic B" },
  ] as Message[];
  const history = canonicalDisplayHistory(
    messages,
    2,
    [
      ["m-a", 0],
      ["m-b", 1],
    ],
    (message) => {
      throw new Error(message);
    },
  );
  expect(history.map((m) => m.data)).toEqual(["Synthetic A", "Synthetic B"]);
  expect(JSON.parse(JSON.stringify(history))).toEqual(messages);
  expect(Object.keys(history)).toEqual(["0", "1"]);
});

test("mutable input changes after capture cannot retarget canonical message bodies", () => {
  const f = fixture();
  f.messages[0].data = "Synthetic changed source";
  f.messages.reverse();
  expect(f.history[20].data).toBe("Synthetic 25");
  expect(f.history.at(-1).data).toBe("Synthetic 124");
});

test("shared frozen bodies preserve separate failure owners and reject invalid canonical counts", () => {
  const messages = Object.freeze([
    Object.freeze({ chatId: "m-a", data: "Synthetic A" } as Message),
  ]);
  const window = Object.freeze([Object.freeze(["m-a", 20] as const)]);
  const failures: string[] = [];
  const first = canonicalDisplayHistory(messages, 21, window, (error) => {
    failures.push(error);
    throw new Error(error);
  });
  const second = canonicalDisplayHistory(messages, 21, window, (error) => {
    throw new Error("Second owner: " + error);
  });
  expect(() => (first[20].data = "Changed")).toThrow(/server intent/);
  expect(second[20].data).toBe("Synthetic A");
  expect(() => second[19]).toThrow(/Second owner:.*unloaded history/);
  expect(failures).toHaveLength(1);
  expect(() =>
    canonicalDisplayHistory(messages, 20, window, (error) => {
      throw new Error(error);
    }),
  ).toThrow(/Invalid canonical/);
});
