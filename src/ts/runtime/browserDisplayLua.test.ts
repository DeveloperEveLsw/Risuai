// @vitest-environment node
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import { BrowserDisplayLua } from "./browserDisplayLua";
import {
  DisplayLedger,
  DisplayProposal,
  displayIdentity,
  type DisplayCapture,
} from "./displayEffects";
import {
  commandJson,
  type RuntimeChange,
  type RuntimeCommand,
} from "./clientProtocol";
import type { ScriptingRuntimeHost } from "../process/scriptingRuntime";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { pickHashRand } from "../utilText";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import { pinDisplayCapture } from "./displayWorkerExecutor";
import { freezeDisplayJson, displayScopeJson } from "./displayScopeIdentity";
import {
  createDisplayScopeCache,
  forkDisplayScope,
} from "./displayScopeCache.svelte";
import { DisplayWireBudget } from "./displayWireBudget";
import { variableIdentity } from "./variableCommands";
import { provisionalDisplayScope } from "./provisionalDisplayScope";
import {
  displayPresentationIdentity,
  recordDisplayRead,
  noteDisplayProvisionalRead,
} from "./displayReadDependencies";

const script = `listenEdit('editDisplay', function(id, data)
  local n = tonumber(getChatVar(id, 'counter')) + 1
  setChatVar(id, 'counter', tostring(n))
  setState(id, 'cache', {name=getName(id), count=n})
  return data .. ':' .. getChatVar(id, 'counter') .. ':' .. cbs('{{getvar::counter}}')
end)`;

test("a deferred original Lua result remains provisional until the entire presentation accepts it", async () => {
  const h = harness();
  try {
    const draft = await h.runtime.defer("Synthetic");
    expect(draft.output).toBe("Synthetic:1:1");
    expect(h.commands).toEqual([]);
    await draft.commit();
    await draft.commit();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].edits).toContainEqual({
      scope: "chat",
      chatId: "a",
      key: "$counter",
      expectedRevision: 7,
      value: "1",
    });
  } finally {
    h.runtime.close();
  }
});

test("coalesced deferred presentations execute original stateful Lua once and share one admission", async () => {
  const h = harness(
    fixture(
      "listenEdit('editDisplay',function(id,data) n=(n or 0)+1;setChatVar(id,'counter','9');return data..':'..tostring(n) end)",
    ),
  );
  try {
    const [a, b] = await Promise.all([
      h.runtime.defer("Synthetic"),
      h.runtime.defer("Synthetic"),
    ]);
    expect([a.output, b.output]).toEqual(["Synthetic:1", "Synthetic:1"]);
    expect(h.commands).toEqual([]);
    await Promise.all([a.commit(), b.commit()]);
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("optimistic CBS overlays share identical canonical Lua work while provisional admission remains separate", async () => {
  const f = fixture(
      "listenEdit('editDisplay',function(id,data) n=(n or 0)+1;setChatVar(id,'counter','9');return data..':'..tostring(n)..':'..cbs('{{getvar::counter}}') end)",
    ),
    h = harness(f);
  const canonical = f.capture();
  const pending = pinDisplayCapture(canonical);
  pending.presentationVariables = [
    ["synthetic", { exists: true, value: "pending" }],
  ];
  try {
    const [a, b] = await Promise.all([
      h.runtime.defer("Synthetic", -1, false, undefined, undefined, pending),
      h.runtime.defer("Synthetic", -1, false, undefined, undefined, canonical),
    ]);
    expect([a.output, b.output]).toEqual(["Synthetic:1:9", "Synthetic:1:9"]);
    expect(a).toBe(b);
    await a.commit({ reads: [], provisional: true });
    expect(h.commands).toHaveLength(0);
    await b.commit({ reads: [] });
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("read-only original Lua retains its variable read CAS when a later regex proposes a source rewrite", async () => {
  const f = fixture(
      "listenEdit('editDisplay',function(id,data) return data..':'..getChatVar(id,'counter') end)",
    ),
    h = harness(f);
  h.select(() => {
    const capture = f.capture();
    capture.message = { id: "m", revision: 1 };
    capture.sourceContent = "Synthetic";
    return capture;
  });
  try {
    const draft = await h.runtime.defer("Synthetic");
    expect(draft.output).toBe("Synthetic:0");
    expect(draft.command).toBeUndefined();
    await draft.commit({
      reads: [],
      messageEdits: [
        { messageId: "m", expectedRevision: 1, text: "Synthetic:0 MARKER" },
      ],
    });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].reads).toContainEqual({
      scope: "chat",
      chatId: "a",
      key: "$counter",
      expectedRevision: 7,
    });
    expect(h.commands[0].messageEdits).toEqual([
      { messageId: "m", expectedRevision: 1, text: "Synthetic:0 MARKER" },
    ]);
  } finally {
    h.runtime.close();
  }
});

test("closing the display owner prevents a late provisional result from reaching durable admission", async () => {
  const h = harness();
  const draft = await h.runtime.defer("Synthetic");
  h.runtime.close();
  await expect(draft.commit()).rejects.toThrow(/owner closed/);
  expect(h.commands).toEqual([]);
});

test("durable source origins suppress original Lua setters after reload and admit a new external input", async () => {
  const f = fixture(),
    h = harness(f);
  const capture = f.capture();
  capture.message = { id: "m", revision: 2 };
  const identity = await displayIdentity(capture, "Synthetic");
  capture.message.origin = {
    messageRevision: 2,
    chatEpoch: capture.state.chatEpoch,
    characterEpoch: capture.state.characterEpoch,
    inputClock: capture.state.inputClock,
    codeHash: identity.codeHash,
    displayKey: "a".repeat(64),
  };
  h.select(() => pinDisplayCapture(capture));
  try {
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:0:0");
    expect(h.commands).toEqual([]);
    capture.state.inputClock++;
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1:1");
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("the actual browser owner reuses only scalar byte sizes and releases them on close", () => {
  const h = harness();
  const capture = fixture().capture();
  const encoder = vi.spyOn(TextEncoder.prototype, "encode");
  const close = vi.spyOn(DisplayWireBudget.prototype, "close");
  try {
    const first = h.runtime.presentationIdentity(capture);
    expect(encoder).toHaveBeenCalled();
    encoder.mockClear();
    expect(h.runtime.presentationIdentity(capture)).toBe(first);
    expect(encoder).not.toHaveBeenCalled();
    capture.chat.scriptstate.$counter = "9";
    expect(h.runtime.presentationIdentity(capture)).not.toBe(first);
    expect(encoder).toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
    h.runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => h.runtime.presentationIdentity(capture)).toThrow(
      "owner closed before presentation",
    );
  } finally {
    encoder.mockRestore();
    close.mockRestore();
    h.runtime.close();
  }
});

test("an unchanged UI owner can survive confirmed overlay removal but cannot hide new reads or pending admission", () => {
  const confirmed = fixture().capture();
  confirmed.database.globalChatVariables.synthetic = "confirmed";
  confirmed.presentationVariables = [
    [
      variableIdentity({ scope: "global", key: "synthetic" }),
      { exists: true, value: "confirmed" },
    ],
  ];
  const cleared = pinDisplayCapture(confirmed);
  cleared.presentationVariables = [];
  expect(displayPresentationIdentity(cleared)).toBe(
    displayPresentationIdentity(confirmed),
  );
  recordDisplayRead(cleared, { scope: "global", key: "outside" });
  expect(displayPresentationIdentity(cleared)).not.toBe(
    displayPresentationIdentity(confirmed),
  );
  recordDisplayRead(confirmed, { scope: "global", key: "outside" });
  expect(displayPresentationIdentity(cleared)).toBe(
    displayPresentationIdentity(confirmed),
  );
  noteDisplayProvisionalRead(cleared);
  expect(displayPresentationIdentity(cleared)).not.toBe(
    displayPresentationIdentity(confirmed),
  );
  const pendingUnread = pinDisplayCapture(confirmed);
  pendingUnread.presentationVariables = [
    [
      variableIdentity({ scope: "global", key: "synthetic" }),
      { exists: true, value: "pending" },
    ],
  ];
  expect(displayPresentationIdentity(pendingUnread)).not.toBe(
    displayPresentationIdentity(confirmed),
  );
});

test("a pending presentation shows original Lua output without persisting, then confirmed extra reads admit once without changing the shared worker command", async () => {
  const h = harness();
  try {
    const draft = await h.runtime.defer("Synthetic");
    const original = commandJson(draft.command);
    const reads = [
      {
        scope: "chat" as const,
        chatId: "a",
        key: "$outer_source",
        expectedRevision: 2,
      },
    ];
    await draft.commit({ reads, provisional: true });
    expect(draft.output).toBe("Synthetic:1:1");
    expect(h.commands).toHaveLength(0);
    await draft.commit({ reads });
    await draft.commit({ reads });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].reads).toContainEqual(reads[0]);
    expect(commandJson(draft.command)).toBe(original);
  } finally {
    h.runtime.close();
  }
});

test("coalesced original Lua callers cannot inherit an admission justified by different outside reads", async () => {
  const h = harness();
  try {
    const [a, b] = await Promise.all([
      h.runtime.defer("Synthetic"),
      h.runtime.defer("Synthetic"),
    ]);
    expect(a.output).toBe(b.output);
    await a.commit({
      reads: [{ scope: "global", key: "outside", expectedRevision: 3 }],
    });
    await expect(b.commit({ reads: [] })).rejects.toThrow(
      /different read provenance/,
    );
    expect(h.commands).toHaveLength(1);
    expect(b.command.reads).not.toContainEqual({
      scope: "global",
      key: "outside",
      expectedRevision: 3,
    });
  } finally {
    h.runtime.close();
  }
});

test("equivalent outside read sets share one original Lua admission regardless of discovery order", async () => {
  const h = harness();
  try {
    const [a, b] = await Promise.all([
      h.runtime.defer("Synthetic"),
      h.runtime.defer("Synthetic"),
    ]);
    const reads = [
      { scope: "global" as const, key: "first", expectedRevision: 3 },
      { scope: "global" as const, key: "second", expectedRevision: 4 },
    ];
    await Promise.all([
      a.commit({ reads }),
      b.commit({ reads: [...reads].reverse() }),
    ]);
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("worker snapshot pins nested values and revision maps while retaining the original private chat aliases", () => {
  const source = fixture().capture();
  source.cbsModules = [
    { id: "synthetic", nested: { value: "before" } },
  ] as never;
  const json = JSON.parse(
    '{"__proto__":{"synthetic":"before"},"toString":"Synthetic"}',
  ) as { __proto__: { synthetic: string }; toString: string };
  const extra = source.database as unknown as { syntheticJson: typeof json };
  extra.syntheticJson = json;
  const pinned = pinDisplayCapture(source);
  source.chat.message[0].data = "later";
  source.versions.chat.set("$counter", 99);
  (
    source.cbsModules[0] as unknown as { nested: { value: string } }
  ).nested.value = "later";
  expect(pinned.chat.message[0].data).toBe("Synthetic");
  expect(pinned.versions.chat.get("$counter")).toBe(7);
  expect(pinned.cbsModules[0]).toMatchObject({ nested: { value: "before" } });
  expect(pinned.character).toBe(pinned.database.characters[0]);
  expect(pinned.chat).toBe(pinned.character.chats[0]);
  expect(pinned.chat).not.toBe(source.chat);
  const pinnedJson = (pinned.database as unknown as typeof extra).syntheticJson;
  expect(Object.getPrototypeOf(pinnedJson)).toBe(Object.prototype);
  expect(Object.hasOwn(pinnedJson, "__proto__")).toBe(true);
  json.__proto__.synthetic = "later";
  expect(pinnedJson.__proto__.synthetic).toBe("before");
});
function fixture(code = script, chatId = "a") {
  const original = {
    message: [{ chatId: "m-" + chatId, role: "char", data: "Synthetic" }],
    scriptstate: { $counter: "0" },
    GLGlobalVariables: {},
    localLore: [],
  };
  const char = {
    type: "character",
    chaId: "c-" + chatId,
    name: "Synthetic " + chatId,
    chatPage: 0,
    chats: [original],
    defaultVariables: "default=synthetic",
    triggerscript: [
      {
        type: "manual",
        conditions: [],
        effect: [{ type: "triggerlua", code }],
      },
    ],
  };
  const database = {
    characters: [char],
    templateDefaultVariables: "",
    globalChatVariables: { shared: "global" },
    personas: [],
  };
  const capture = (): DisplayCapture => {
    const chat = {
      ...original,
      message: original.message.map((m) => ({ ...m })),
      scriptstate: { ...original.scriptstate },
      GLGlobalVariables: { ...original.GLGlobalVariables },
    };
    const character = {
      ...char,
      chats: [chat],
      triggerscript: char.triggerscript.map((t) => ({ ...t })),
    };
    return {
      serverId: "server",
      state: {
        cursor: 5,
        inputClock: 5,
        chatId,
        characterId: char.chaId,
        chatEpoch: 2,
        characterEpoch: 1,
        applied: [],
        next: null,
      },
      database: { ...database, characters: [character] },
      chat,
      character,
      triggers: character.triggerscript,
      versions: {
        chat: new Map([["$counter", 7]]),
        localGlobal: new Map(),
        global: new Map([["shared", 3]]),
      },
      persistent: true,
      hasEarlier: false,
    } as unknown as DisplayCapture;
  };
  return { capture, original, char };
}
function host(): ScriptingRuntimeHost {
  return {
    v4: randomUUID,
    ReloadGUIPointer: writable(0),
    ReloadChatPointer: writable(0),
    fetch: async (path) => {
      if (path !== "/lua/json.lua")
        throw new Error("Unexpected fixture resource");
      return new Response(
        await readFile(
          new URL("../../../public/lua/json.lua", import.meta.url),
          "utf8",
        ),
      );
    },
  } as unknown as ScriptingRuntimeHost;
}
function harness(f = fixture(), maxContexts = 8) {
  let current = f.capture,
    applied = new Set<string>();
  const pending = new Map<string, RuntimeCommand>(),
    commands: RuntimeCommand[] = [],
    errors: unknown[] = [];
  const runtime = new BrowserDisplayLua(
    host,
    {
      capture: () => current(),
      seen: (key) => applied.has(key),
      pending: (key) => pending.get(key),
      submit: async (command) => {
        commands.push(command);
        pending.set(String(command.displayKey), command);
      },
      error: (error) => errors.push(error),
      parser: (scope) =>
        createCbsRuntime({
          ...scope.variables,
          ...scope.util,
          getDatabase: () => scope.capture.database,
          getSelectedCharID: () => 0,
          getCurrentTriggerId: () =>
            scope.capture.cbsEnvironment?.triggerId ?? null,
          getModules: () => [],
          getModuleLorebooks: () => [],
          calcString: createExpressionEvaluator(scope.variables),
          pickHashRand,
          safeStructuredClone: structuredClone,
          getModelInfo: () => ({ id: "synthetic" }),
          callInternalFunction: () => "",
          findCharacterbyId: () => scope.capture.character,
          isTauri: false,
          isNodeServer: false,
          isMobile: false,
          appVer: "synthetic",
        } as never).parse,
    },
    maxContexts,
  );
  return {
    runtime,
    commands,
    errors,
    pending,
    applied,
    select: (next: () => DisplayCapture) => {
      current = next;
    },
  };
}

test("a blocked worker constructor reports a display error without rejecting the renderer or submitting effects", async () => {
  const errors: unknown[] = [],
    commands: RuntimeCommand[] = [];
  const runtime = new BrowserDisplayLua(
    host,
    {
      capture: fixture().capture,
      seen: () => false,
      pending: () => undefined,
      submit: async (command) => {
        commands.push(command);
      },
      error: (error) => errors.push(error),
      parser: () => {
        throw new Error("must not execute");
      },
    },
    8,
    () => {
      throw new Error("Synthetic worker unavailable");
    },
  );
  try {
    expect(await runtime.run("Synthetic")).toBe("Synthetic");
    expect(String(errors[0])).toContain("Synthetic worker unavailable");
    expect(commands).toEqual([]);
    expect(runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
  } finally {
    runtime.close();
  }
});

test("actual Lua counter, JSON state and CBS use private values; simultaneous renders coalesce and pending renders do not repeat effects", async () => {
  const f = fixture(),
    h = harness(f);
  try {
    expect(
      await Promise.all([
        h.runtime.run("Synthetic"),
        h.runtime.run("Synthetic"),
      ]),
    ).toEqual(["Synthetic:1:1", "Synthetic:1:1"]);
    expect(h.commands).toHaveLength(1);
    expect(h.errors).toEqual([]);
    const command = h.commands[0];
    expect(command.edits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "$counter",
          value: "1",
          expectedRevision: 7,
        }),
        expect.objectContaining({ key: "$__cache", expectedRevision: 0 }),
      ]),
    );
    const state = (command.edits as { key: string; value: string }[]).find(
      (e) => e.key === "$__cache",
    );
    expect(JSON.parse(state.value)).toEqual({ name: "Synthetic a", count: 1 });
    expect(f.original.scriptstate).toEqual({ $counter: "0" });
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1:1");
    expect(h.commands).toHaveLength(1);
    expect(f.char.triggerscript[0]).not.toHaveProperty("lowLevelAccess");
  } finally {
    h.runtime.close();
  }
});

test("captured variable revisions remain paired with their old values while Lua is asynchronous; navigation cannot retarget a proposal", async () => {
  const a = fixture(),
    b = fixture(script, "b"),
    h = harness(a);
  try {
    const work = h.runtime.run("Synthetic");
    a.original.scriptstate["$counter"] = "99";
    h.select(b.capture);
    await work;
    expect(h.commands[0]).toMatchObject({ chatId: "a" });
    expect(h.commands[0].edits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "$counter",
          value: "1",
          expectedRevision: 7,
        }),
      ]),
    );
    await h.runtime.run("Synthetic");
    expect(h.commands[1]).toMatchObject({ chatId: "b" });
    expect(b.original.scriptstate).toEqual({ $counter: "0" });
  } finally {
    h.runtime.close();
  }
});

test("caught Lua runtime/compile errors reject the entire proposal, including changes made before an error", async () => {
  for (const code of [
    "listenEdit('editDisplay', function(id, data) setChatVar(id,'counter','9'); error('Synthetic failure') end)",
    "invalid synthetic lua ???",
  ]) {
    const f = fixture(code),
      h = harness(f);
    try {
      expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
      expect(h.commands).toEqual([]);
      expect(h.errors.length).toBeGreaterThan(0);
      expect(f.original.scriptstate["$counter"]).toBe("0");
      const draft = await h.runtime.defer("Synthetic retry");
      expect(draft.failed).toBe(true);
      expect(draft.error).toBeTruthy();
      expect(draft.error.length).toBeLessThanOrEqual(512);
      await draft.commit();
      expect(h.commands).toEqual([]);
    } finally {
      h.runtime.close();
    }
  }
});

test("partial history is an explicit capability error; provisional streaming may transform privately but does not submit persistent effects", async () => {
  const h = harness(
    fixture(
      "listenEdit('editDisplay', function(id,data) setChatVar(id,'counter','2'); return getChat(id,0) end)",
    ),
  );
  try {
    const f = fixture(
      "listenEdit('editDisplay', function(id,data) setChatVar(id,'counter','2'); return getChat(id,0) end)",
    );
    h.select(() => ({ ...f.capture(), hasEarlier: true }));
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
    expect(h.commands).toEqual([]);
    expect(h.errors.length).toBeGreaterThan(0);
    const streaming = fixture();
    h.select(() => ({ ...streaming.capture(), persistent: false }));
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1:1");
    expect(h.commands).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("owned preview history runs original Lua setters and CBS privately; later canonical capture can admit its own source once", async () => {
  const f = fixture(script),
    h = harness(f);
  const raw = f.capture();
  raw.history = { count: 1, cursor: 5 };
  raw.historyWindow = [["m-a", 0]];
  const pinned = pinDisplayCapture(raw);
  freezeDisplayJson(pinned);
  const preview = () =>
    provisionalDisplayScope(
      forkDisplayScope(pinned, pinned, undefined),
      [{ chatId: "new", role: "char", data: "Progress" }],
      "new",
    );
  try {
    h.select(preview);
    expect(await h.runtime.run("Progress")).toBe("Progress:1:1");
    expect(h.commands).toEqual([]);
    expect(f.original.scriptstate.$counter).toBe("0");
    h.select(() => {
      const canonical = f.capture();
      canonical.chat.message.push({
        chatId: "new",
        role: "char",
        data: "Progress",
      });
      canonical.history = { count: 2, cursor: 5, ordinal: 1 };
      canonical.historyWindow = [
        ["m-a", 0],
        ["new", 1],
      ];
      canonical.message = { id: "new", revision: 1 };
      canonical.sourceContent = "Progress";
      return canonical;
    });
    expect(await h.runtime.run("Progress")).toBe("Progress:1:1");
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].source).toMatchObject({
      messageId: "new",
      expectedRevision: 1,
    });
    await h.runtime.run("Progress");
    expect(h.commands).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("digest reuse preserves every sequential original Lua callback, fresh variables and changed code leases", async () => {
  const code =
      "local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1; return getChatVar(id,'counter')..':'..calls end)",
    f = fixture(code),
    h = harness(f);
  const original = crypto.subtle.digest.bind(crypto.subtle),
    inputs: string[] = [];
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation((algorithm, bytes) => {
      inputs.push(new TextDecoder().decode(bytes as ArrayBuffer));
      return original(algorithm, bytes);
    });
  try {
    expect(await h.runtime.run("Synthetic")).toBe("0:1");
    expect(await h.runtime.run("Synthetic")).toBe("0:2");
    f.original.scriptstate.$counter = "9";
    expect(await h.runtime.run("Synthetic")).toBe("9:3");
    Object.assign(f.char.triggerscript[0], {
      comment: "Fresh trigger metadata",
    });
    expect(await h.runtime.run("Synthetic")).toBe("9:4");
    expect(inputs.filter((s) => s === commandJson([code]))).toHaveLength(1);
    f.char.triggerscript[0].effect[0].code = code.replace(
      "..':'..calls",
      "..':changed:'..calls",
    );
    expect(await h.runtime.run("Synthetic")).toBe("9:changed:1");
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
    spy.mockRestore();
  }
});

test("original Lua globals persist within a chat/code lease while the number of idle contexts remains bounded", async () => {
  const code =
      "local calls=0; listenEdit('editDisplay', function(id,data) calls=calls+1; return data .. ':' .. calls end)",
    h = harness(fixture(code), 2);
  try {
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1");
    expect(await h.runtime.run("Another")).toBe("Another:2");
    for (const id of ["b", "c", "d"]) {
      h.select(fixture(code, id).capture);
      expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1");
    }
    expect(h.runtime.diagnostics()).toEqual({ contexts: 2, invocations: 0 });
    expect(h.commands).toEqual([]);
  } finally {
    h.runtime.close();
  }
  expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
});

test("browser logical hashes match server canonical SHA-256; device identities do not enter the occurrence", async () => {
  const capture = fixture().capture(),
    identity = await displayIdentity(capture, "Synthetic");
  const expected = createHash("sha256")
    .update(
      commandJson({
        chatId: "a",
        characterId: "c-a",
        chatEpoch: 2,
        characterEpoch: 1,
        inputClock: 5,
        codeHash: identity.codeHash,
        source: identity.source,
      }),
    )
    .digest("hex");
  expect(identity.displayKey).toBe(expected);
  expect(
    (
      await displayIdentity(
        { ...capture, serverId: "other-client-transport" },
        "Synthetic",
      )
    ).displayKey,
  ).toBe(expected);
});

test("proposal tracks local/global fallback and rejects oversized/non-scalar effects without touching canonical values", () => {
  const capture = fixture().capture(),
    p = new DisplayProposal(capture, false);
  p.record({ scope: "chat-global", chatId: "a", key: "shared" });
  p.record({ scope: "global", key: "shared" });
  expect([...p.reads.values()]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: "global", expectedRevision: 3 }),
    ]),
  );
  expect(() => p.write("invalid", {}, () => true)).toThrow("finite JSON");
  const huge = new DisplayProposal(capture, false);
  expect(() => huge.write("large", "x".repeat(256 * 1024), () => true)).toThrow(
    "256 KiB",
  );
  expect(capture.chat.scriptstate).toEqual({ $counter: "0" });
});

const change = (
  sequence: number,
  overrides: Partial<RuntimeChange> = {},
): RuntimeChange => ({
  sequence,
  type: "variable",
  id: "$counter",
  chatId: "a",
  revision: 1,
  payload: {},
  ...overrides,
});
test("receipt paging merges journal handoff; external input clears prior receipts and old derived effects cannot revive them", () => {
  const ledger = new DisplayLedger();
  ledger.begin("a", "c-a");
  ledger.observe(
    change(6, { payload: { displayEffectId: "key", displayInputClock: 5 } }),
  );
  expect(ledger.install(fixture().capture().state)).toBe(true);
  expect(ledger.seen("key", 5)).toBe(true);
  ledger.observe(change(7, { chatId: "b" }));
  expect(ledger.state.inputClock).toBe(5);
  ledger.observe(change(8, { type: "job" }));
  expect(ledger.state.inputClock).toBe(5);
  ledger.observe(change(9));
  expect(ledger.state.inputClock).toBe(9);
  expect(ledger.seen("key", 9)).toBe(false);
  ledger.observe(
    change(10, { payload: { displayEffectId: "key", displayInputClock: 5 } }),
  );
  expect(ledger.seen("key", 9)).toBe(false);
  ledger.observe(change(11, { type: "resource", chatId: null }));
  expect(ledger.state.inputClock).toBe(11);
});

test("CBS-expanded render text cannot change a raw source occurrence after its own effects are projected", async () => {
  const f = fixture(),
    h = harness(f);
  try {
    await h.runtime.run(
      "Expanded zero",
      -1,
      false,
      undefined,
      "Raw {{getvar::counter}}",
    );
    const command = h.commands[0];
    f.original.scriptstate["$counter"] = "1";
    h.pending.clear();
    h.applied.add(String(command.displayKey));
    expect(
      await h.runtime.run(
        "Expanded one",
        -1,
        false,
        undefined,
        "Raw {{getvar::counter}}",
      ),
    ).toBe("Expanded one:1:1");
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("a failed initializer cannot install a listener that persists effects on a later render", async () => {
  const h = harness(
    fixture(
      "listenEdit('editDisplay', function(id,data) setChatVar(id,'counter','9'); return data end); error('Synthetic failed initializer')",
    ),
  );
  try {
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
    expect(h.commands).toEqual([]);
    expect(h.errors).toHaveLength(2);
    expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
  } finally {
    h.runtime.close();
  }
});

test("one effect occurrence can render different CBS-expanded text without reusing the wrong presentation result", async () => {
  const h = harness();
  try {
    expect(
      await Promise.all([
        h.runtime.run(
          "Expanded zero",
          -1,
          false,
          undefined,
          "Raw {{getvar::counter}}",
        ),
        h.runtime.run(
          "Expanded one",
          -1,
          false,
          undefined,
          "Raw {{getvar::counter}}",
        ),
      ]),
    ).toEqual(["Expanded zero:1:1", "Expanded one:1:1"]);
    expect(h.commands).toHaveLength(1);
  } finally {
    h.runtime.close();
  }
});

test("partial original Lua receives canonical ordinal and count without accessing unloaded bodies", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data,meta) setChatVar(id,'ordinal',tostring(meta.index));return data .. ':' .. meta.index .. ':' .. getChatLength(id) end)",
    ),
    h = harness(f);
  h.select(() => ({
    ...f.capture(),
    hasEarlier: true,
    history: { count: 120, cursor: 5, ordinal: 20 },
  }));
  try {
    expect(await h.runtime.run("Synthetic", 0)).toBe("Synthetic:20:120");
    expect(h.errors).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].edits).toContainEqual({
      scope: "chat",
      chatId: "a",
      key: "$ordinal",
      value: "20",
      expectedRevision: 0,
    });
  } finally {
    h.runtime.close();
  }
});

test("a canonical partial count does not permit full-history Lua access or its earlier effects", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) setChatVar(id,'counter','9'); local n=getChatLength(id); local all=getFullChat(id);return data .. ':' .. n end)",
    ),
    h = harness(f);
  h.select(() => ({
    ...f.capture(),
    hasEarlier: true,
    history: { count: 120, cursor: 5 },
  }));
  try {
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
    expect(h.errors).toHaveLength(1);
    expect(h.commands).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("the same display occurrence at a different loaded row keeps its original Lua metadata index", async () => {
  const h = harness(
    fixture(
      "listenEdit('editDisplay', function(id,data,meta) return data .. ':' .. meta.index end)",
    ),
  );
  try {
    expect(
      await Promise.all([
        h.runtime.run("Synthetic", 0),
        h.runtime.run("Synthetic", 1),
      ]),
    ).toEqual(["Synthetic:0", "Synthetic:1"]);
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("a partial-history invocation cannot borrow a concurrent complete-history result", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) return data .. ':' .. getChatLength(id) end)",
    ),
    h = harness(f);
  try {
    const complete = h.runtime.run("Synthetic");
    h.select(() => ({ ...f.capture(), hasEarlier: true }));
    const partial = h.runtime.run("Synthetic");
    expect(await Promise.all([complete, partial])).toEqual([
      "Synthetic:1",
      "Synthetic",
    ]);
    expect(h.errors).toHaveLength(1);
    expect(h.commands).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("a durable display invocation cannot borrow a concurrent provisional invocation's admission policy", async () => {
  const f = fixture(),
    h = harness(f);
  try {
    h.select(() => ({ ...f.capture(), persistent: false }));
    const provisional = h.runtime.run("Synthetic");
    h.select(f.capture);
    const durable = h.runtime.run("Synthetic");
    expect(await Promise.all([provisional, durable])).toEqual([
      "Synthetic:1:1",
      "Synthetic:1:1",
    ]);
    expect(h.commands).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("a later projected read scope is not coalesced with an older asynchronous display invocation", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) return getChatVar(id,'counter') end)",
    ),
    h = harness(f);
  try {
    const first = h.runtime.run("Synthetic");
    f.original.scriptstate["$counter"] = "9";
    h.select(() => ({ ...f.capture(), projectedCursor: 6 }));
    const second = h.runtime.run("Synthetic");
    expect(await Promise.all([first, second])).toEqual(["0", "9"]);
    expect(h.commands).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("actual Lua keeps concurrent local values distinct even when their durable occurrence and projected cursor match", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) return getChatVar(id,'counter') end)",
    ),
    h = harness(f);
  try {
    const first = h.runtime.run("Synthetic");
    f.original.scriptstate.$counter = "9";
    const second = h.runtime.run("Synthetic");
    expect(await Promise.all([first, second])).toEqual(["0", "9"]);
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("actual Lua and CBS keep a fresh trigger environment distinct within the same durable occurrence", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) return cbs('{{trigger_id}}') end)",
    ),
    h = harness(f);
  let triggerId = "before";
  h.select(() => ({
    ...f.capture(),
    cbsEnvironment: { triggerId } as DisplayCapture["cbsEnvironment"],
  }));
  try {
    const first = h.runtime.run("Synthetic");
    triggerId = "after";
    const second = h.runtime.run("Synthetic");
    expect(await Promise.all([first, second])).toEqual(["before", "after"]);
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("shared frozen bodies coalesce exact duplicates while private values, revision maps and changed bodies stay distinct", async () => {
  const code =
      "local calls=0; listenEdit('editDisplay', function(id,data) calls=calls+1; return getName(id) .. ':' .. getChatVar(id,'counter') .. ':' .. calls end)",
    f = fixture(code),
    h = harness(f);
  const base = pinDisplayCapture(f.capture());
  freezeDisplayJson(base);
  let body = base;
  let revision = 7;
  let counter = "0";
  h.select(() => {
    const capture = forkDisplayScope(body, f.capture(), undefined);
    capture.chat.scriptstate.$counter = counter;
    capture.versions.chat.set("$counter", revision);
    return capture;
  });
  try {
    expect(
      await Promise.all([
        h.runtime.run("Synthetic"),
        h.runtime.run("Synthetic"),
      ]),
    ).toEqual(["Synthetic a:0:1", "Synthetic a:0:1"]);
    const before = h.runtime.run("Synthetic");
    counter = "9";
    const changedValue = h.runtime.run("Synthetic");
    revision++;
    const changedRevision = h.runtime.run("Synthetic");
    f.char.name = "Synthetic new";
    body = pinDisplayCapture(f.capture());
    freezeDisplayJson(body);
    const changedBody = h.runtime.run("Synthetic");
    expect(
      await Promise.all([before, changedValue, changedRevision, changedBody]),
    ).toEqual([
      "Synthetic a:0:2",
      "Synthetic a:9:3",
      "Synthetic a:9:4",
      "Synthetic new:9:5",
    ]);
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("cached fresh snapshots retain equal history across clocks while actual Lua values/order and owner cleanup remain fresh", async () => {
  const f = fixture(
      "local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1; return getChatVar(id,'counter') .. ':' .. calls end)",
    ),
    h = harness(f);
  let clock = 1;
  const raw = () => {
    const value = f.capture();
    value.state.inputClock = clock;
    return value;
  };
  const cache = createDisplayScopeCache(raw, () => {});
  h.select(() => cache.capture(raw(), undefined));
  try {
    const before = cache.capture(raw(), undefined);
    expect(await h.runtime.run("Synthetic")).toBe("0:1");
    f.original.scriptstate.$counter = "9";
    clock++;
    const changed = cache.capture(raw(), undefined);
    expect(changed.chat.message).toBe(before.chat.message);
    expect(changed.chat.scriptstate.$counter).toBe("9");
    expect(changed.state.inputClock).toBe(2);
    expect(changed.versions.chat).not.toBe(before.versions.chat);
    expect(await h.runtime.run("Synthetic")).toBe("9:2");
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
    cache.close();
    expect(cache.capture(raw(), undefined)).toBeUndefined();
    const other = createDisplayScopeCache(raw, () => {});
    try {
      expect(other.capture(raw(), undefined).chat.message).not.toBe(
        changed.chat.message,
      );
    } finally {
      other.close();
    }
  } finally {
    cache.close();
    h.runtime.close();
  }
});

test("local scope identity includes all three revision maps without changing the durable display occurrence", async () => {
  const capture = fixture().capture();
  const budget = new DisplayWireBudget();
  try {
    const before = displayScopeJson(capture, budget);
    const durable = await displayIdentity(capture, "Synthetic");
    for (const key of ["chat", "localGlobal", "global"] as const) {
      const changed = pinDisplayCapture(capture);
      changed.versions[key].set("synthetic", 8);
      expect(displayScopeJson(changed, budget)).not.toBe(before);
      expect((await displayIdentity(changed, "Synthetic")).displayKey).toBe(
        durable.displayKey,
      );
    }
  } finally {
    budget.close();
  }
});

test("a private fork can change scalar character fields without borrowing the same body's earlier Lua result", async () => {
  const f = fixture(
      "listenEdit('editDisplay', function(id,data) return getName(id) end)",
    ),
    h = harness(f);
  const base = pinDisplayCapture(f.capture());
  freezeDisplayJson(base);
  let name = "Synthetic before";
  h.select(() => {
    const capture = forkDisplayScope(base, f.capture(), undefined);
    capture.character.name = name;
    return capture;
  });
  try {
    const first = h.runtime.run("Synthetic");
    name = "Synthetic after";
    const second = h.runtime.run("Synthetic");
    expect(await Promise.all([first, second])).toEqual([
      "Synthetic before",
      "Synthetic after",
    ]);
    expect(h.commands).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    h.runtime.close();
  }
});

test("only recursively frozen JSON is reusable; shallow freezing cannot hide mutable children or Maps", () => {
  const capture = fixture().capture();
  const nested = { value: "before" };
  const extras = capture.database as unknown as Record<string, unknown>;
  extras.synthetic = Object.freeze({ nested });
  const budget = new DisplayWireBudget();
  try {
    const before = displayScopeJson(capture, budget);
    nested.value = "after";
    expect(displayScopeJson(capture, budget)).not.toBe(before);
    extras.synthetic = { nested: new Map([["value", "before"]]) };
    freezeDisplayJson(extras.synthetic);
    expect(() => displayScopeJson(capture, budget)).toThrow("JSON containers");
  } finally {
    budget.close();
  }
});

test("malformed or oversized presentation scope fails visibly without rejecting the renderer or starting a VM", async () => {
  for (const invalid of ["cycle", "budget"] as const) {
    const f = fixture(),
      h = harness(f);
    h.select(() => {
      const capture = f.capture();
      const database = capture.database as unknown as Record<string, unknown>;
      database.synthetic =
        invalid === "cycle" ? database : "x".repeat(16 * 1024 * 1024);
      return capture;
    });
    try {
      expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
      expect(h.errors).toHaveLength(1);
      expect(h.commands).toEqual([]);
      expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
    } finally {
      h.runtime.close();
    }
  }
});

test("a delayed presentation digest preserves capture order and Lua globals in its chat while another chat remains independent", async () => {
  const code =
      "local calls=0; listenEdit('editDisplay', function(id,data) calls=calls+1; return getChatVar(id,'counter') .. ':' .. calls end)",
    f = fixture(code),
    h = harness(f),
    other = fixture(code, "b");
  f.original.scriptstate.$counter = "Synthetic slow digest";
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let begin: () => void, release: () => void;
  const started = new Promise<void>((resolve) => (begin = resolve)),
    blocked = new Promise<void>((resolve) => (release = resolve));
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, bytes) => {
      if (
        new TextDecoder()
          .decode(bytes as ArrayBuffer)
          .includes("Synthetic slow digest")
      ) {
        begin();
        await blocked;
      }
      return digest(algorithm, bytes);
    });
  try {
    const first = h.runtime.run("Synthetic");
    await started;
    f.original.scriptstate.$counter = "9";
    const second = h.runtime.run("Synthetic");
    h.select(other.capture);
    expect(await h.runtime.run("Synthetic")).toBe("0:1");
    release();
    expect(await Promise.all([first, second])).toEqual([
      "Synthetic slow digest:1",
      "9:2",
    ]);
    expect(h.errors).toEqual([]);
  } finally {
    release();
    h.runtime.close();
    spy.mockRestore();
  }
});

test("a failed digest reports the error and releases preparation so the next render can execute", async () => {
  const h = harness();
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockRejectedValueOnce(new Error("Synthetic digest failure"));
  try {
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic");
    expect(h.commands).toEqual([]);
    expect(String(h.errors[0])).toContain("Synthetic digest failure");
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:1:1");
    expect(h.commands).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
  } finally {
    h.runtime.close();
    spy.mockRestore();
  }
});

test("closing the display owner while it yields cannot start Lua or submit a late effect", async () => {
  const h = harness();
  let release: () => void;
  let started: () => void;
  const turnStarted = new Promise<void>((resolve) => (started = resolve));
  const turn = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal("scheduler", {
    yield: () => {
      started();
      return turn;
    },
  });
  try {
    const output = h.runtime.run("Synthetic closed owner");
    await turnStarted;
    h.runtime.close();
    release();
    expect(await output).toBe("Synthetic closed owner");
    expect(h.commands).toEqual([]);
    expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});

test("a burst of exact concurrent presentations shares preparation and original stateful Lua without exhausting the admission queue", async () => {
  const h = harness(
    fixture(
      "local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1; setChatVar(id,'counter',tostring(calls)); return data..':'..calls end)",
    ),
  );
  try {
    const drafts = await Promise.all(
      Array.from({ length: 300 }, () => h.runtime.defer("Synthetic")),
    );
    expect(drafts.map((draft) => draft.output)).toEqual(
      Array(300).fill("Synthetic:1"),
    );
    expect(h.errors).toEqual([]);
    expect(h.commands).toEqual([]);
    await Promise.all(drafts.map((draft) => draft.commit()));
    expect(h.commands).toHaveLength(1);
    expect(await h.runtime.run("Synthetic")).toBe("Synthetic:2");
  } finally {
    h.runtime.close();
  }
});

test("two overlapping 120-row waves wait for bounded Lua capacity without skipping distinct stateful calls or blocking another chat", async () => {
  const code =
      "local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1;return data..':'..calls end)",
    f = fixture(code),
    h = harness(f),
    other = fixture(code, "b");
  let release: () => void;
  const firstTurn = new Promise<void>((resolve) => (release = resolve));
  let turns = 0;
  vi.stubGlobal("scheduler", {
    yield: () => (++turns === 1 ? firstTurn : Promise.resolve()),
  });
  try {
    const first = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer("Synthetic row " + i),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(120),
    );
    const second = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer("Synthetic updated row " + i),
    );
    h.select(other.capture);
    const otherOutput = await h.runtime.run("Synthetic other chat");
    expect(otherOutput).toBe("Synthetic other chat:1");
    const beforeRelease = h.runtime.diagnostics();
    release();
    const drafts = await Promise.all([...first, ...second]);
    if (process.env.RISU_DISPLAY_BACKPRESSURE_OUTPUT) {
      const outputs = drafts.map((draft) => draft.output);
      await writeFile(
        process.env.RISU_DISPLAY_BACKPRESSURE_OUTPUT,
        JSON.stringify(
          {
            actualOriginalLua: true,
            realWorker: false,
            syntheticOnly: true,
            controlledFirstYield: true,
            submittedCalculations: 240,
            transformedCalculations: outputs.filter((output) =>
              /:\d+$/.test(output),
            ).length,
            beforeRelease,
            outputs,
            otherOutput,
            errors: h.errors.map(String),
            sourceHashes: Object.fromEntries(
              await Promise.all(
                ["browserDisplayLua.ts", "browserDisplayLua.test.ts"].map(
                  async (path) => [
                    path,
                    createHash("sha256")
                      .update(await readFile(new URL(path, import.meta.url)))
                      .digest("hex"),
                  ],
                ),
              ),
            ),
          },
          null,
          2,
        ) + "\n",
      );
    }
    expect(drafts.map((draft) => draft.output)).toEqual([
      ...Array.from(
        { length: 120 },
        (_, i) => "Synthetic row " + i + ":" + (i + 1),
      ),
      ...Array.from(
        { length: 120 },
        (_, i) => "Synthetic updated row " + i + ":" + (i + 121),
      ),
    ]);
    expect(h.errors).toEqual([]);
    expect(h.commands).toEqual([]);
    h.select(f.capture);
    expect(await h.runtime.run("Synthetic after both waves")).toBe(
      "Synthetic after both waves:241",
    );
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});

test("retired queued presentations release capacity while every live original Lua call retains its order", async () => {
  const h = harness(
    fixture(
      "local calls=0;listenEdit('editDisplay',function(id,data) calls=calls+1;return data..':'..calls end)",
    ),
  );
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let turns = 0,
    retired = false;
  vi.stubGlobal("scheduler", {
    yield: () => (++turns === 1 ? gate : Promise.resolve()),
  });
  const oldOwner = () => !retired;
  try {
    const first = h.runtime.defer("Synthetic active");
    await vi.waitFor(() => expect(turns).toBe(1));
    const abandoned = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer(
        "Synthetic retired " + i,
        -1,
        false,
        undefined,
        undefined,
        undefined,
        oldOwner,
      ),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(121),
    );
    retired = true;
    const live = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer("Synthetic live " + i),
    );
    release();
    expect((await first).output).toBe("Synthetic active:1");
    expect((await Promise.all(abandoned)).map((d) => d.output)).toEqual(
      Array.from({ length: 120 }, (_, i) => "Synthetic retired " + i),
    );
    expect((await Promise.all(live)).map((d) => d.output)).toEqual(
      Array.from(
        { length: 120 },
        (_, i) => "Synthetic live " + i + ":" + (i + 2),
      ),
    );
    expect(h.errors).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(await h.runtime.run("Synthetic after retirement")).toBe(
      "Synthetic after retirement:122",
    );
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});

test("identical guarded presentations have independent retirement and cannot share an abandoned owner's result", async () => {
  const h = harness(
    fixture(
      "local calls=0;listenEdit('editDisplay',function(id,data) calls=calls+1;return data..':'..calls end)",
    ),
  );
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let turns = 0,
    retired = false;
  vi.stubGlobal("scheduler", {
    yield: () => (++turns === 1 ? gate : Promise.resolve()),
  });
  try {
    const old = h.runtime.defer(
      "Synthetic shared",
      -1,
      false,
      undefined,
      undefined,
      undefined,
      () => !retired,
    );
    await vi.waitFor(() => expect(turns).toBe(1));
    const live = h.runtime.defer(
      "Synthetic shared",
      -1,
      false,
      undefined,
      undefined,
      undefined,
      () => true,
    );
    retired = true;
    release();
    expect((await old).output).toBe("Synthetic shared");
    expect((await live).output).toBe("Synthetic shared:1");
    expect(h.errors).toEqual([]);
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});

test("closing an owner releases display capacity waiters without executing or admitting their captured effects", async () => {
  const h = harness();
  let release: () => void;
  const firstTurn = new Promise<void>((resolve) => (release = resolve));
  let turns = 0;
  vi.stubGlobal("scheduler", {
    yield: () => (++turns === 1 ? firstTurn : Promise.resolve()),
  });
  try {
    const first = Array.from({ length: 120 }, (_, i) =>
      h.runtime.run("Synthetic closing row " + i),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(120),
    );
    const second = Array.from({ length: 120 }, (_, i) =>
      h.runtime.run("Synthetic closing update " + i),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(129),
    );
    h.runtime.close();
    release();
    expect(await Promise.all([...first, ...second])).toEqual([
      ...Array.from({ length: 120 }, (_, i) => "Synthetic closing row " + i),
      ...Array.from({ length: 120 }, (_, i) => "Synthetic closing update " + i),
    ]);
    expect(h.errors).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(h.runtime.diagnostics()).toEqual({ contexts: 0, invocations: 0 });
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});

test("display backpressure retains the existing preparation limit for an oversized distinct burst", async () => {
  const h = harness(
    fixture(
      "local calls=0; listenEdit('editDisplay',function(id,data) calls=calls+1;return data..':'..calls end)",
    ),
  );
  let release: () => void;
  const firstTurn = new Promise<void>((resolve) => (release = resolve));
  let turns = 0;
  vi.stubGlobal("scheduler", {
    yield: () => (++turns === 1 ? firstTurn : Promise.resolve()),
  });
  try {
    const first = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer("Synthetic bounded row " + i),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(120),
    );
    const second = Array.from({ length: 120 }, (_, i) =>
      h.runtime.defer("Synthetic bounded update " + i),
    );
    await vi.waitFor(() =>
      expect(h.runtime.diagnostics().invocations).toBe(129),
    );
    const excess = Array.from({ length: 40 }, (_, i) =>
      h.runtime.defer("Synthetic excess update " + i),
    );
    await vi.waitFor(() => expect(h.errors).toHaveLength(24));
    expect(
      h.errors.every((error) =>
        String(error).includes("Display scope preparation queue limit reached"),
      ),
    ).toBe(true);
    release();
    const drafts = await Promise.all([...first, ...second, ...excess]);
    expect(drafts.filter((draft) => !draft.failed)).toHaveLength(256);
    expect(drafts.slice(256).every((draft) => draft.failed)).toBe(true);
    expect(drafts[255].output).toBe("Synthetic excess update 15:256");
    expect(h.commands).toEqual([]);
  } finally {
    release();
    h.runtime.close();
    vi.unstubAllGlobals();
  }
});
