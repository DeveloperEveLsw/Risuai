// @vitest-environment node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writable } from "svelte/store";
import { expect, test } from "vitest";
import {
  createScriptingRuntime,
  type ScriptingRuntimeHost,
} from "./scriptingRuntime";

function context(name: string) {
  const variables: Record<string, string> = { name };
  const chat = {
    message: [{ role: "char", data: "synthetic", chatId: name }],
    scriptstate: {},
    localLore: [],
  };
  const character = {
    type: "character",
    name,
    chaId: name,
    chats: [chat],
    chatPage: 0,
    triggerscript: [],
  };
  const runtime = createScriptingRuntime({
    getCurrentCharacter: () => character,
    getCurrentChat: () => chat,
    getDatabase: () => ({ characters: [character] }),
    getChatVar: (key) => variables[key] ?? "null",
    getGlobalChatVar: () => "null",
    setChatVar: (key, value) => {
      const changed = variables[key] !== value;
      variables[key] = value;
      return changed;
    },
    getModuleTriggers: () => [],
    ReloadGUIPointer: writable(0),
    ReloadChatPointer: writable(0),
    v4: randomUUID,
    fetch: async (path) => {
      if (path !== "/lua/json.lua") throw Error("Unexpected fixture resource");
      return new Response(
        await readFile(
          new URL("../../../public/lua/json.lua", import.meta.url),
          "utf8",
        ),
      );
    },
  } as unknown as ScriptingRuntimeHost);
  return { runtime, variables, chat, character };
}

test("the original Lua APIs execute in Node and keep identical script caches and globals isolated per context", async () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const a = context("Alpha"),
    b = context("Beta");
  const code = `
local calls = 0
function onButtonClick(id, data)
    calls = calls + 1
    setChatVar(id, 'choice', getChatVar(id, 'name') .. ':' .. data .. ':' .. calls)
    setChat(id, 0, data)
    return getChatVar(id, 'choice')
end`;
  try {
    const [ar, br] = await Promise.all([
      a.runtime.runScripted(code, { mode: "onButtonClick", data: "one" }),
      b.runtime.runScripted(code, { mode: "onButtonClick", data: "two" }),
    ]);
    expect(ar.res).toBe("Alpha:one:1");
    expect(br.res).toBe("Beta:two:1");
    expect(a.chat.message[0].data).toBe("one");
    expect(b.chat.message[0].data).toBe("two");
    const again = await a.runtime.runScripted(code, {
      mode: "onButtonClick",
      data: "three",
    });
    expect(again.res).toBe("Alpha:three:2");
    expect(b.variables.choice).toBe("Beta:two:1");
  } finally {
    a.runtime.close();
    b.runtime.close();
  }
});

test("actual Lua edit listeners participate in output and request processing", async () => {
  const a = context("A");
  const code = `
listenEdit('editOutput', function(id, text, meta)
    setState(id, 'turn', { index = meta.index, text = text })
    return text .. ':' .. getChatVar(id, 'name')
end)
listenEdit('editRequest', function(id, messages, meta)
    messages[1].content = messages[1].content .. ':edited'
    return messages
end)`;
  a.character.triggerscript = [
    { effect: [{ type: "triggerlua", code }] },
  ] as never;
  try {
    expect(
      await a.runtime.runLuaEditTrigger(
        a.character as never,
        "editoutput",
        "reply",
        { index: 9 },
      ),
    ).toBe("reply:A");
    expect(JSON.parse(a.variables.__turn)).toEqual({ index: 9, text: "reply" });
    const result = await a.runtime.runLuaEditTrigger(
      a.character as never,
      "editRequest",
      [{ role: "user", content: "request" }] as never,
      {},
    );
    expect(result).toEqual([{ role: "user", content: "request:edited" }]);
  } finally {
    a.runtime.close();
  }
});

test("display access tokens are revoked after every actual Lua invocation, including caught failures", async () => {
  const a = context("Synthetic lifecycle");
  const code = `local previous = nil
listenEdit('editDisplay', function(id, data)
  if previous then setChatVar(previous, 'escaped', 'unexpected') end
  previous = id
  setChatVar(id, 'live', data)
  if data == 'fail' then error('Synthetic caught failure') end
  return data
end)`;
  try {
    for (let i = 0; i < 24; i++) {
      await a.runtime.runScripted(code, {
        mode: "editDisplay",
        data: i === 12 ? "fail" : String(i),
      });
      expect(a.runtime.diagnostics()).toEqual({
        engines: 1,
        safeTokens: 0,
        displayTokens: 0,
        lowLevelTokens: 0,
      });
    }
    expect(a.variables.escaped).toBeUndefined();
    expect(a.variables.live).toBe("23");
  } finally {
    a.runtime.close();
  }
});
