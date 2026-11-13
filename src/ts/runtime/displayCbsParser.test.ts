// @vitest-environment node
import { expect, test } from "vitest";
import { defaultCBSRegisterArg } from "../cbs";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import { createDisplayCbsParser } from "./displayCbsParser";

function context(fast: boolean) {
  const calls: string[] = [];
  const variables: Record<string, string> = {};
  const globals = { toggle: "1" };
  const chat = {
    message: [],
    scriptstate: variables,
    localLore: [],
    modules: [],
  };
  const character = {
    type: "character",
    name: "Synthetic",
    chaId: "c",
    chatPage: 0,
    chats: [chat],
    firstMessage: "",
    alternateGreetings: [],
    defaultVariables: "",
  };
  const db = {
    characters: [character],
    globalChatVariables: globals,
    templateDefaultVariables: "",
    username: "Synthetic user",
  };
  const getChatVar = (key: string) => {
    calls.push("local:" + key);
    return variables["$" + key] ?? "null";
  };
  const getGlobalChatVar = (key: string) => {
    calls.push("global:" + key);
    return globals[key] ?? "null";
  };
  const original = createCbsRuntime({
    ...defaultCBSRegisterArg,
    getDatabase: () => {
      calls.push("database");
      return db as never;
    },
    getSelectedCharID: () => {
      calls.push("selected");
      return 0;
    },
    getUserName: () => {
      calls.push("username");
      return db.username;
    },
    getChatVar,
    getGlobalChatVar,
    setChatVar: (key, value) => {
      calls.push("set:" + key + ":" + value);
      variables["$" + key] = value;
    },
    calcString: createExpressionEvaluator({ getChatVar, getGlobalChatVar }),
    findCharacterbyId: (id) => {
      calls.push("character:" + id);
      return character as never;
    },
  }).parse;
  return {
    parse: fast ? createDisplayCbsParser(original) : original,
    calls,
    variables,
    character,
  };
}

test("plain display input retains upstream initialization, argument mutation, context lookup and call-stack errors", () => {
  for (const stack of [undefined, 0, 19, 20, 21])
    for (const group of [false, true]) {
      const slow = context(false),
        fast = context(true);
      const functions = new Map();
      const argument = (c: ReturnType<typeof context>) => ({
        callStack: stack,
        tokenizeAccurate: true,
        functions,
        chara: group
          ? ({
              type: "group",
              name: "Synthetic group",
              chatPage: 0,
              chats: [{ message: [{ saying: "c" }] }],
            } as never)
          : undefined,
      });
      const a = argument(slow),
        b = argument(fast),
        text =
          "<section>Unicode 😀한글, isolated } and #}, literal &amp; text</section>";
      expect(fast.parse(text, b)).toBe(slow.parse(text, a));
      expect(b.callStack).toBe(a.callStack);
      expect(b.functions).toBe(functions);
      expect(fast.calls).toEqual(slow.calls);
    }
  const failure = new Error("Synthetic lookup unavailable");
  const parse = createCbsRuntime({
    ...defaultCBSRegisterArg,
    findCharacterbyId: () => {
      throw failure;
    },
    getDatabase: () => {
      throw failure;
    },
  }).parse;
  expect(() => createDisplayCbsParser(parse)("plain")).toThrow(failure);
});

test("CBS, legacy aliases, malformed braces, loops and persistent setters preserve actual parser output and host effects", () => {
  const corpus = [
    "<CHAR> / <UsEr> / <BoT>",
    "{{char}} / {{getglobalvar::toggle}}",
    "{",
    "{{",
    "{#if 1#}yes{#endif#}",
    "{{#if 1}}yes{{/}}{{#if 0}}no{{/}}",
    '{{#each ["one","two"] as item}}{{slot::item}}{{/}}',
    "{{setvar::turn::3}}{{getvar::turn}}",
    "{{#func greet x}}Hi {{arg::1}}{{/}}{{call::greet::there}}",
    "{{unknown::value}} text {{unterminated",
    "literal <char attr=x>, <character>, }</p>",
  ];
  for (const text of corpus) {
    const slow = context(false),
      fast = context(true),
      a = { runVar: true },
      b = { runVar: true };
    expect(fast.parse(text, b)).toBe(slow.parse(text, a));
    expect(fast.variables).toEqual(slow.variables);
    expect(fast.calls).toEqual(slow.calls);
    expect(b).toEqual(a);
  }
});

test("authored markup and deterministic mixed UTF-16 corpus agree with the upstream parser without caching callbacks", () => {
  const slow = context(false),
    fast = context(true);
  const plain =
    "<section><strong>Neutral</strong> &amp; 😀한글\u0000\ud800\udfff</section>".repeat(
      1000,
    );
  expect(fast.parse(plain)).toBe(slow.parse(plain));
  fast.parse(plain);
  slow.parse(plain);
  expect(fast.calls).toEqual(slow.calls);
  expect(fast.calls).toHaveLength(2);
  let seed = 937;
  const pool = [
    "{",
    "}",
    "#",
    "<",
    ">",
    "char",
    "user",
    "::",
    " ",
    "\n",
    "\u0000",
    "\ud800",
    "\udfff",
    "한",
    "x",
  ];
  for (let i = 0; i < 200; i++) {
    let text = "";
    for (let j = 0; j < 64; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += pool[seed % pool.length];
    }
    expect(fast.parse(text, { visualize: true })).toBe(
      slow.parse(text, { visualize: true }),
    );
  }
  expect(fast.calls).toEqual(slow.calls);
});
