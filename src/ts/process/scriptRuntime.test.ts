// @vitest-environment node
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import { defaultCBSRegisterArg } from "../cbs";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { createScriptRuntime, type ScriptRuntimeHost } from "./scriptRuntime";
import type { customscript } from "../storage/database.svelte";

function context(
  name: string,
  scripts: customscript[],
  moduleScripts: customscript[] = [],
) {
  const chat = {
    message: [{ role: "char", data: "synthetic", chatId: name }],
    scriptstate: { $choice: name },
    localLore: [],
  };
  const character = {
    type: "character",
    chaId: name,
    name,
    chatPage: 0,
    chats: [chat],
    customscript: scripts,
    additionalAssets: [],
    emotionImages: [],
  };
  const db = {
    characters: [character],
    presetRegex: [] as customscript[],
    dynamicAssets: false,
  };
  const cbs = createCbsRuntime({
    ...defaultCBSRegisterArg,
    getDatabase: () => db as never,
    getUserName: () => name + " user",
    getChatVar: (key) => chat.scriptstate["$" + key] ?? "null",
    findCharacterbyId: () => character as never,
  });
  const lua = vi.fn(async (_char, _mode, data) => data);
  const trigger = vi.fn(async (_char, _mode, args) => ({
    displayData: args.displayData,
  }));
  const pluginV2 = {
    editinput: new Set(),
    editoutput: new Set(),
    editprocess: new Set(),
    editdisplay: new Set(),
  };
  const runtime = createScriptRuntime({
    getDatabase: () => db,
    getCurrentCharacter: () => character,
    getCurrentChat: () => chat,
    runLuaEditTrigger: lua,
    runTrigger: trigger,
    pluginV2,
    getModuleRegexScripts: () => moduleScripts,
    getModuleAssets: () => [],
    CharEmotion: writable({}),
    selectedCharID: writable(0),
    risuChatParserOrg: cbs.parse,
    safeStructuredClone: structuredClone,
  } as unknown as ScriptRuntimeHost);
  return { runtime, chat, character, db, lua, trigger, pluginV2 };
}

test("the actual regex engine applies only the selected processing stage without a DOM", async () => {
  expect(typeof window).toBe("undefined");
  const a = context("A", [
    { comment: "synthetic", in: "TOKEN", out: "INPUT", type: "editinput" },
    { comment: "synthetic", in: "TOKEN", out: "OUTPUT", type: "editoutput" },
    { comment: "synthetic", in: "TOKEN", out: "REQUEST", type: "editprocess" },
    { comment: "synthetic", in: "TOKEN", out: "DISPLAY", type: "editdisplay" },
  ]);
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editinput"),
  ).toBe("INPUT");
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editoutput"),
  ).toBe("OUTPUT");
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editprocess"),
  ).toBe("REQUEST");
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editdisplay"),
  ).toBe("DISPLAY");
  expect(a.trigger).toHaveBeenCalledTimes(1);
});

test("original @@inject stores processed text before removing its matched display marker", async () => {
  const a = context("Alpha", [
    {
      comment: "Synthetic inject reference",
      in: "MARKER",
      out: "@@inject",
      type: "editdisplay",
    },
  ]);
  const displayed = await a.runtime.processScriptFull(
    a.character as never,
    "Synthetic {{getvar::choice}} MARKER",
    "editdisplay",
    0,
  );
  expect(a.chat.message[0].data).toBe("Synthetic Alpha MARKER");
  expect(displayed.data).toBe("Synthetic Alpha ");
});

test("original inject action retains the same pre-removal storage behavior", async () => {
  const a = context("Beta", [
    {
      comment: "Synthetic inject action reference",
      in: "MARKER",
      out: "unused replacement",
      type: "editdisplay",
      ableFlag: true,
      flag: "g<inject>",
    },
  ]);
  const displayed = await a.runtime.processScriptFull(
    a.character as never,
    "Synthetic {{getvar::choice}} MARKER",
    "editdisplay",
    0,
  );
  expect(a.chat.message[0].data).toBe("Synthetic Beta MARKER");
  expect(displayed.data).toBe("Synthetic Beta ");
});

test("identical script cache keys do not leak another job's CBS or variable results", async () => {
  const scripts: customscript[] = [
    {
      comment: "synthetic",
      in: "TOKEN",
      out: "{{char}}/{{getvar::choice}}",
      type: "editoutput",
    },
  ];
  const a = context("Alpha", scripts),
    b = context("Beta", scripts);
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editoutput"),
  ).toBe("Alpha/Alpha");
  expect(
    await b.runtime.processScript(b.character as never, "TOKEN", "editoutput"),
  ).toBe("Beta/Beta");
  a.chat.scriptstate.$choice = "changed";
  a.runtime.resetScriptCache();
  expect(
    await a.runtime.processScript(a.character as never, "TOKEN", "editoutput"),
  ).toBe("Alpha/changed");
  expect(
    await b.runtime.processScript(b.character as never, "TOKEN", "editoutput"),
  ).toBe("Beta/Beta");
});

test("preset, character and module replacements retain upstream execution order and metadata actions", async () => {
  const a = context(
    "A",
    [{ comment: "synthetic", in: "middle", out: "later", type: "editoutput" }],
    [{ comment: "synthetic", in: "later", out: "final", type: "editoutput" }],
  );
  a.db.presetRegex = [
    { comment: "synthetic", in: "start", out: "middle", type: "editoutput" },
  ];
  expect(
    await a.runtime.processScript(a.character as never, "start", "editoutput"),
  ).toBe("final");
  a.character.customscript = [
    {
      comment: "synthetic",
      in: "A",
      out: "B",
      type: "editoutput",
      ableFlag: true,
      flag: "g<order 20>",
    },
    {
      comment: "synthetic",
      in: "B",
      out: "C",
      type: "editoutput",
      ableFlag: true,
      flag: "g<order 10>",
    },
  ];
  expect(
    await a.runtime.processScript(a.character as never, "A", "editoutput"),
  ).toBe("C");
});
