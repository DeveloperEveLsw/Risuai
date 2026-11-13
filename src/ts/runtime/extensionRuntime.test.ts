// @vitest-environment node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { get } from "svelte/store";
import { expect, test, vi } from "vitest";
import { createExecutionContext } from "./executionContext";
import {
  createExtensionRuntime,
  type ExtensionCapabilities,
} from "./extensionRuntime";
import { claim, fixture } from "./testFixtures";
import { LLMFormat } from "../model/types";

const { get_encoding } = createRequire(import.meta.url)("@dqbd/tiktoken");
function host(
  context: ReturnType<typeof createExecutionContext>,
  extra: Partial<ExtensionCapabilities> = {},
) {
  const tokenizer = get_encoding("cl100k_base");
  const runtime = createExtensionRuntime(context, {
    appVer: "2026.8.250",
    tokenize: async (text) => tokenizer.encode(text, "all").length,
    fetch: async (path) => {
      if (path !== "/lua/json.lua")
        throw new Error("Unexpected fixture resource");
      return new Response(
        readFileSync(
          new URL("../../../public/lua/json.lua", import.meta.url),
          "utf8",
        ),
      );
    },
    ...extra,
  });
  return {
    ...runtime,
    close: () => {
      runtime.close();
      tokenizer.free();
    },
  };
}

test("the composed upstream CBS, Lua listeners and regex layers use one isolated context and save the resulting state", async () => {
  const store = fixture({
    character: {
      customscript: [
        {
          comment: "synthetic",
          in: "middle",
          out: "{{getvar::choice}}",
          type: "editoutput",
        },
      ],
      triggerscript: [
        {
          type: "manual",
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'choice', getChatVar(id, 'name') .. ':' .. meta.index)
  return text .. ':middle'
end)`,
            },
          ],
        },
      ],
    },
  });
  store.applyCommand("module-regex", {
    type: "put-resource",
    kind: "module",
    resourceId: "module",
    expectedRevision: 1,
    payload: {
      ...store.getResource("module", "module").payload,
      regex: [
        { comment: "synthetic", in: "Alpha", out: "A", type: "editoutput" },
      ],
    },
  });
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const engine = host(context);
  try {
    expect(typeof window).toBe("undefined");
    expect(engine.risuChatParser("{{char}}/{{user}}/{{? 2+3*4}}")).toBe(
      "Synthetic/Bound/14",
    );
    expect(
      await engine.processScriptFull(
        context.getCurrentCharacter(),
        "TOKEN",
        "editoutput",
        7,
      ),
    ).toMatchObject({ data: "TOKEN:A:7" });
    expect(context.variables.getChatVar("choice")).toBe("Alpha:7");
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: context.writeSet(),
    });
    expect(
      store.snapshot("a").variables.find((v: any) => v.key === "$choice").value,
    ).toBe("Alpha:7");
    expect(
      store.snapshot("b").variables.some((v: any) => v.key === "$choice"),
    ).toBe(false);
  } finally {
    engine.close();
    store.close();
  }
});

for (const scenario of [
  "saved-fallback",
  "current-override",
  "null-current",
  "missing-selection",
  "missing-saved-prompt",
  "browser-identity",
] as const)
  test(`original v2GetPersonaDesc preserves evaluation and selected identity: ${scenario}`, async () => {
    const store = fixture({
      settings: { enabledModules: [], personaPrompt: "" },
      character: {
        triggerscript: [
          {
            type: "input",
            conditions: [],
            effect: [
              { type: "v2GetPersonaDesc", indent: 0, outputVar: "derived" },
            ],
          },
        ],
      },
    });
    store.applyCommand("selected-persona", {
      type: "put-resource",
      kind: "persona",
      resourceId: "selected",
      expectedRevision: 0,
      payload: {
        id: "selected",
        name: "Selected",
        personaPrompt: "selected prompt",
      },
    });
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const observed: unknown[] = [];
    const engine = host({
      ...context,
      readResourceValue: <T>(value: T): T => {
        observed.push(value);
        return scenario === "browser-identity"
          ? value
          : context.readResourceValue(value);
      },
    });
    try {
      const db = context.getDatabase();
      const selected = db.personas.find((row) => row.id === "selected")!;
      const index =
        scenario === "missing-selection" ? 99 : db.personas.indexOf(selected);
      const events: string[] = [];
      const current =
        scenario === "current-override"
          ? "current prompt"
          : scenario === "null-current"
            ? null
            : "";
      const saved =
        scenario === "missing-saved-prompt" ? undefined : "selected prompt";
      Object.defineProperty(db, "personaPrompt", {
        configurable: true,
        enumerable: true,
        get: () => {
          events.push("current");
          return current;
        },
      });
      Object.defineProperty(db, "selectedPersona", {
        configurable: true,
        enumerable: true,
        get: () => {
          events.push("index");
          return index;
        },
      });
      Object.defineProperty(selected, "personaPrompt", {
        configurable: true,
        enumerable: true,
        get: () => {
          events.push("saved");
          return saved;
        },
      });
      const result = await engine.runTrigger(
        context.getCurrentCharacter() as never,
        "input",
        { chat: context.getCurrentChat() },
      );
      const expected = current || (index === 99 ? "" : (saved ?? ""));
      expect(result.chat.scriptstate!.$derived).toBe(expected);
      expect(events).toEqual(
        index === 99 ? ["current", "index"] : ["current", "index", "saved"],
      );
      expect(observed.filter((row) => row === selected)).toHaveLength(
        index === 99 ? 0 : 1,
      );
      if (index === 99) expect(observed).toContain(undefined);
      Object.defineProperty(db, "personaPrompt", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: current,
      });
      Object.defineProperty(db, "selectedPersona", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: index,
      });
      Object.defineProperty(selected, "personaPrompt", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: saved,
      });
      context.setCurrentChat(result.chat);
      const reads = context.writeSet().resourceReads!;
      const selectedReads = reads.filter(
        (row) => row.kind === "persona" && row.id === "selected",
      );
      expect(selectedReads).toEqual(
        index === 99 || scenario === "browser-identity"
          ? []
          : [{ kind: "persona", id: "selected", expectedEpoch: 0 }],
      );
      // Original CBS initialization also selects the chat's bound persona.
      expect(
        reads.filter((row) => row.kind === "persona" && row.id === "persona"),
      ).toEqual([{ kind: "persona", id: "persona", expectedEpoch: 0 }]);
      expect(reads.filter((row) => row.kind === "persona")).toHaveLength(
        1 + selectedReads.length,
      );
    } finally {
      engine.close();
      store.close();
    }
  });

test("original v1/v2 triggers edit the private chat, construct system additions and keep manual IDs context-local", async () => {
  const store = fixture({
    character: {
      triggerscript: [
        {
          comment: "input",
          type: "input",
          conditions: [],
          effect: [
            { type: "setvar", var: "count", operator: "=", value: "4" },
            {
              type: "v2SetVar",
              indent: 0,
              var: "count",
              operator: "+=",
              value: "3",
              valueType: "value",
            },
            {
              type: "modifychat",
              index: "0",
              value: "edited {{getvar::count}}",
            },
            {
              type: "systemprompt",
              location: "start",
              value: "addition {{getvar::count}}",
            },
          ],
        },
        {
          comment: "click",
          type: "manual",
          conditions: [],
          effect: [
            {
              type: "setvar",
              var: "id",
              operator: "=",
              value: "{{trigger_id}}",
            },
          ],
        },
      ],
    },
  });
  const a = claim(store),
    b = claim(store, "job-b", "b");
  const ac = createExecutionContext(a.snapshot, { jobId: a.job.id }),
    bc = createExecutionContext(b.snapshot, { jobId: b.job.id });
  const ae = host(ac),
    be = host(bc);
  try {
    const result = await ae.runTrigger(
      ac.getCurrentCharacter() as never,
      "input",
      { chat: ac.getCurrentChat(), triggerId: "input-a" },
    );
    expect(result.chat.message[0].data).toBe("edited 7");
    expect(result.additonalSysPrompt.start).toBe("addition 7\n\n");
    expect(result.tokens).toBeGreaterThan(0);
    expect(get(ae.CurrentTriggerIdStore)).toBe(null);
    ac.setCurrentChat(result.chat);
    await Promise.all([
      ae.runTrigger(ac.getCurrentCharacter() as never, "manual", {
        chat: ac.getCurrentChat(),
        manualName: "click",
        triggerId: "button-a",
      }),
      be.runTrigger(bc.getCurrentCharacter() as never, "manual", {
        chat: bc.getCurrentChat(),
        manualName: "click",
        triggerId: "button-b",
      }),
    ]);
    expect(ac.variables.getChatVar("id")).toBe("button-a");
    expect(bc.variables.getChatVar("id")).toBe("button-b");
    expect(get(ae.CurrentTriggerIdStore)).toBe("button-a");
    expect(get(be.CurrentTriggerIdStore)).toBe("button-b");
    store.finishJob(a.job.id, "worker", a.job.fence, {
      state: "completed",
      writeSet: ac.writeSet(),
    });
    store.finishJob(b.job.id, "worker", b.job.fence, {
      state: "completed",
      writeSet: bc.writeSet(),
    });
    expect(store.snapshot("a").messages[0].message.data).toBe("edited 7");
    expect(store.snapshot("b").messages[0].message.data).toBe("before");
  } finally {
    ae.close();
    be.close();
    store.close();
  }
});

test("actual recursive lorebook selection uses the server history, module lore and token budget", async () => {
  const lore = (
    comment: string,
    key: string,
    content: string,
    insertorder: number,
  ) => ({
    comment,
    key,
    content,
    mode: "normal",
    insertorder,
    alwaysActive: false,
    secondkey: "",
    selective: false,
  });
  const store = fixture({
    character: {
      globalLore: [
        lore("first", "before", "linked word", 100),
        lore("recursive", "linked", "recursive {{getvar::name}}", 90),
        lore("inactive", "missing", "must not activate", 80),
      ],
    },
    settings: { loreBookDepth: 5, loreBookToken: 1000 },
  });
  store.applyCommand("module-lore", {
    type: "put-resource",
    kind: "module",
    resourceId: "module",
    expectedRevision: 1,
    payload: {
      ...store.getResource("module", "module").payload,
      lorebook: [lore("module", "before", "module content", 70)],
    },
  });
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const engine = host(context);
  try {
    const result = await engine.loadLoreBookV3Prompt();
    expect(result.actives.map((a) => a.source)).toEqual([
      "module",
      "recursive",
      "first",
    ]);
    // Upstream selection retains the source; generation applies CBS when inserting it.
    const recursive = result.actives.find((a) => a.source === "recursive");
    expect(recursive.prompt).toBe("recursive {{getvar::name}}");
    expect(engine.risuChatParser(recursive.prompt)).toBe("recursive Alpha");
    expect(result.matchLog.some((m) => m.source.includes("lorebook"))).toBe(
      true,
    );
    expect(context.writeSet().characters).toEqual([]);
    expect(context.writeSet().resources).toEqual([]);
    context.getDatabase().loreBookToken = 1;
    expect((await engine.loadLoreBookV3Prompt()).actives).toEqual([]);
  } finally {
    engine.close();
    store.close();
  }
});

test("model lookup and ChatML parsing preserve built-in derived formats and per-context overrides", () => {
  const store = fixture({
    settings: { enableCustomFlags: true, customFlags: ["synthetic flag"] },
  });
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const engine = host(context);
  try {
    expect(engine.getModelInfo("gpt-5.5-response-api").format).toBe(
      LLMFormat.OpenAIResponseAPI,
    );
    const model = engine.getModelInfo("gpt-5.5");
    expect(model.flags).toEqual(["synthetic flag"]);
    model.name = "changed returned copy";
    expect(engine.getModelInfo("gpt-5.5").name).not.toBe(model.name);
    expect(
      engine.parseChatML(
        "<|im_start|>user<|im_sep|>{{char}}<|im_end|><|im_start|>assistant\n<Thoughts>think</Thoughts>{{user}}<|im_end|>",
      ),
    ).toEqual([
      { role: "user", content: "Synthetic", thoughts: [] },
      { role: "assistant", content: "Bound", thoughts: ["think"] },
    ]);
  } finally {
    engine.close();
    store.close();
  }
});

test("a missing server capability caught by upstream Lua still blocks persistence and a subsequent provider call", async () => {
  const store = fixture({
    character: {
      triggerscript: [
        {
          effect: [
            {
              type: "triggerlua",
              code: `
listenEdit('editOutput', function(id, text, meta)
  setChatVar(id, 'choice', 'before-error')
  alertNormal(id, 'synthetic interaction')
  return text
end)`,
            },
          ],
        },
      ],
    },
  });
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const request = vi.fn(async () => ({
    type: "success",
    result: "should not run",
  }));
  const engine = host(context, { requestChatData: request as never });
  try {
    await expect(
      engine.runLuaEditTrigger(
        context.getCurrentCharacter(),
        "editoutput",
        "text",
        {},
      ),
    ).rejects.toThrow("Execution capability errors");
    expect(() => context.writeSet()).toThrow("alertNormal");
    await expect(
      engine.runScripted("function onButtonClick(id, data) return data end", {
        mode: "onButtonClick",
      }),
    ).rejects.toThrow("Execution capability errors");
    expect(request).not.toHaveBeenCalled();
    expect(
      store.snapshot("a").variables.some((v: any) => v.key === "$choice"),
    ).toBe(false);
  } finally {
    engine.close();
    store.close();
  }
});

test("a caught ordinary Lua error blocks earlier effects and later provider calls without requiring an unavailable capability", async () => {
  const store = fixture({
    character: {
      triggerscript: [
        {
          effect: [
            {
              type: "triggerlua",
              code: `listenEdit('editOutput', function(id,text) setChatVar(id,'choice','before-error'); error('Synthetic Lua failure'); return text end)`,
            },
          ],
        },
      ],
    },
  });
  const { job, snapshot } = claim(store),
    context = createExecutionContext(snapshot, { jobId: job.id });
  const request = vi.fn(async () => ({
    type: "success",
    result: "unexpected",
  }));
  const engine = host(context, { requestChatData: request as never });
  try {
    await expect(
      engine.runLuaEditTrigger(
        context.getCurrentCharacter(),
        "editoutput",
        "Synthetic",
      ),
    ).rejects.toThrow("Execution capability errors");
    expect(() => context.writeSet()).toThrow("Synthetic Lua failure");
    await expect(
      engine.runScripted("function onStart(id) return true end", {
        mode: "start",
      }),
    ).rejects.toThrow("Execution capability errors");
    expect(request).not.toHaveBeenCalled();
    expect(
      store.snapshot("a").variables.some((v: any) => v.key === "$choice"),
    ).toBe(false);
  } finally {
    engine.close();
    store.close();
  }
});

test.each(["alertNormal", "alertError"] as const)(
  "a provided %s host failure caught by Lua poisons subsequent effects",
  async (api) => {
    const store = fixture({
      character: {
        triggerscript: [
          {
            effect: [
              {
                type: "triggerlua",
                code: `
listenEdit('editOutput', function(id,text)
  pcall(function() ${api}(id,'synthetic') end)
  setChatVar(id,'choice','temporary')
  return text
end)`,
              },
            ],
          },
        ],
      },
    });
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const engine = host(context, {
      [api]: () => {
        throw new Error("synthetic enqueue failure");
      },
    });
    try {
      await expect(
        engine.runLuaEditTrigger(
          context.getCurrentCharacter(),
          "editoutput",
          "text",
          {},
        ),
      ).rejects.toThrow("Notification delivery failed");
      expect(() => context.writeSet()).toThrow("Notification delivery failed");
      expect(
        store.snapshot("a").variables.some((v: any) => v.key === "$choice"),
      ).toBe(false);
    } finally {
      engine.close();
      store.close();
    }
  },
);
