// @vitest-environment node

import { expect, test } from "vitest";
import { defaultCBSRegisterArg } from "../cbs";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import { createCbsRuntime } from "./cbsRuntime";

function context(name: string, triggerId: string) {
  const variables: Record<string, string> = {};
  const globals: Record<string, string> = { toggle_visible: "1" };
  const chat = {
    message: [],
    scriptstate: variables,
    localLore: [],
    modules: [],
  };
  const character = {
    name,
    chaId: name,
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
    username: name + "-user",
  };
  const getChatVar = (key: string) => variables["$" + key] ?? "null";
  const getGlobalChatVar = (key: string) => globals[key] ?? "null";
  const runtime = createCbsRuntime({
    ...defaultCBSRegisterArg,
    getDatabase: () => db as never,
    getUserName: () => db.username,
    getChatVar,
    setChatVar: (key, value) => {
      variables["$" + key] = value;
    },
    getGlobalChatVar,
    calcString: createExpressionEvaluator({ getChatVar, getGlobalChatVar }),
    getCurrentTriggerId: () => triggerId,
    findCharacterbyId: () => character as never,
  });
  return { runtime, variables, chat, db };
}

test("the real CBS runtime imports and executes without a DOM or browser stores", () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const { runtime } = context("Alpha", "trigger-a");
  expect(
    runtime.parse("{{char}} / {{user}} / {{trigger_id}} / {{? 2+3*4}}"),
  ).toBe("Alpha / Alpha-user / trigger-a / 14");
  expect(runtime.parse("{{#if 1}}yes{{/}}{{#if 0}}no{{/}}")).toBe("yes");
});

test("interleaved runtimes retain independent characters, variables and trigger IDs", () => {
  const a = context("Alpha", "trigger-a");
  const b = context("Beta", "trigger-b");
  a.runtime.parse("{{setvar::turn::1}}", { runVar: true });
  b.runtime.parse("{{setvar::turn::2}}", { runVar: true });
  expect(a.runtime.parse("{{char}}:{{getvar::turn}}:{{trigger_id}}")).toBe(
    "Alpha:1:trigger-a",
  );
  expect(b.runtime.parse("{{char}}:{{getvar::turn}}:{{trigger_id}}")).toBe(
    "Beta:2:trigger-b",
  );
  a.runtime.parse("{{setvar::turn::3}}", { runVar: true });
  expect(b.runtime.parse("{{getvar::turn}}")).toBe("2");
  expect(a.variables.$turn).toBe("3");
  expect(b.variables.$turn).toBe("2");
});

test("display parsing follows the original runVar guard and does not apply a persistent setvar", () => {
  const { runtime, variables } = context("Display", "display-trigger");
  runtime.parse("{{setvar::selected::yes}}", {
    runVar: false,
    visualize: true,
  });
  expect(variables.$selected).toBeUndefined();
  runtime.parse("{{setvar::selected::yes}}", { runVar: true });
  expect(variables.$selected).toBe("yes");
});

test("nested conditions, loops and expression readers use the injected context", () => {
  const a = context("Alpha", "a");
  const b = context("Beta", "b");
  a.variables.$count = "7";
  b.variables.$count = "11";
  expect(
    a.runtime.parse("{{#when::count::vis::7}}{{char}}{{:else}}wrong{{/}}"),
  ).toBe("Alpha");
  expect(
    b.runtime.parse("{{#when::count::vis::7}}wrong{{:else}}{{char}}{{/}}"),
  ).toBe("Beta");
  expect(
    a.runtime.parse('{{#each ["one","two"] as item}}{{slot::item}}{{/}}'),
  ).toBe("onetwo");
});
