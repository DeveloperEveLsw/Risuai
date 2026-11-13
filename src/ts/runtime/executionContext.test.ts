// @vitest-environment node
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "svelte/store";
import { expect, test, vi } from "vitest";
import {
  createExecutionContext,
  type ExecutionSnapshot,
} from "./executionContext";
import { createExtensionRuntime } from "./extensionRuntime";
import { seed, fixture, claim } from "./testFixtures";
const { EntityStore } = createRequire(import.meta.url)(
  "../../../server/entity/store.cjs",
);

function runtime(context: ReturnType<typeof createExecutionContext>) {
  return createExtensionRuntime(context, {
    appVer: "2026.8.250",
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
  });
}

test("actual Lua buttons in two private contexts commit edits and state independently and survive reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "risu-runtime-"));
  const file = join(directory, "state.sqlite");
  let store = new EntityStore(file);
  seed(store);
  const a = claim(store),
    b = claim(store, "job-b", "b");
  const original = structuredClone([a.snapshot, b.snapshot]);
  const ac = createExecutionContext(a.snapshot, { jobId: a.job.id });
  const bc = createExecutionContext(b.snapshot, { jobId: b.job.id });
  const ar = runtime(ac),
    br = runtime(bc);
  try {
    expect(typeof document).toBe("undefined");
    expect(get(ac.selectedCharID)).toBe(1);
    const [av, bv] = await Promise.all([
      ar.runLuaButtonTrigger(ac.getCurrentCharacter(), "one"),
      br.runLuaButtonTrigger(bc.getCurrentCharacter(), "two"),
    ]);
    expect(av.res).toBe("Alpha:one:1");
    expect(bv.res).toBe("Beta:two:1");
    const aw = ac.writeSet(),
      bw = bc.writeSet();
    expect(ac.writeSet()).toEqual(aw); // IDs assigned once, not changed by another diff/read.
    expect(aw.characters).toEqual([]);
    expect(aw.resources).toEqual([]);
    expect(aw.metadata).toBeUndefined();
    store.finishJob(a.job.id, "worker", a.job.fence, {
      state: "completed",
      writeSet: aw,
    });
    store.finishJob(b.job.id, "worker", b.job.fence, {
      state: "completed",
      writeSet: bw,
    });
    expect([a.snapshot, b.snapshot]).toEqual(original);
    store.close();
    store = new EntityStore(file);
    for (const [chatId, value, name] of [
      ["a", "one", "Alpha"],
      ["b", "two", "Beta"],
    ]) {
      const saved = store.snapshot(chatId);
      expect(saved.messages.map((m: any) => m.message.data)).toEqual([
        `inserted:${value}`,
        value,
        `appended:${value}`,
      ]);
      expect(saved.messages[1].id).toBe(`m-${chatId}`);
      expect(saved.messages[1].message.extension).toEqual({ retained: true });
      expect(saved.variables.find((v: any) => v.key === "$choice").value).toBe(
        `${name}:${value}:1`,
      );
      expect(
        JSON.parse(
          saved.variables.find((v: any) => v.key === "$__lastButton").value,
        ),
      ).toEqual({ data: value, calls: 1 });
    }
  } finally {
    ar.close();
    br.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upstream default variables, bound persona and locally scoped global variables use only the job context", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    expect(context.variables.getChatVar("shared")).toBe("character");
    expect(context.variables.getChatVar("template")).toBe("template");
    expect(context.variables.getChatVar("missing")).toBe("null");
    expect(context.util.getUserName()).toBe("Bound");
    expect(context.util.getUserIcon()).toBe("synthetic.png");
    expect(context.util.getPersonaPrompt()).toBe("synthetic persona");
    expect(context.util.getUserIconProtrait()).toBe(true);
    expect(context.util.getAuthorNoteDefaultText()).toBe("synthetic note");
    expect(context.writeSet().resources).toEqual([]);
    context.getCurrentChat().useLocallySetGlobalVariables = true;
    context.variables.setGlobalChatVar("shared", "local");
    expect(context.variables.getGlobalChatVar("shared")).toBe("local");
    const writes = context.writeSet();
    expect(writes.resources).toEqual([]);
    expect(writes.metadata?.GLGlobalVariables).toBeUndefined();
    expect(writes.chatGlobalVariables).toEqual([
      { key: "shared", value: "local", expectedRevision: 0 },
    ]);
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: writes,
    });
    expect(store.snapshot("b").chat.metadata.GLGlobalVariables).toBeUndefined();
    expect(store.getResource("global-variable", "shared").payload).toBe(
      "server-global",
    );
  } finally {
    store.close();
  }
});

test("deleting and moving messages or variables and editing shared definitions produces a complete atomic write set", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const chat = context.getCurrentChat();
    chat.message.shift();
    chat.message.push({ role: "char", data: "replacement" });
    delete chat.scriptstate.$name;
    chat.note = "updated";
    context.getCurrentCharacter().name = "Renamed";
    context.getDatabase().modules[0].name = "Revised module";
    context.variables.setGlobalChatVar("shared", "revised global");
    const writes = context.writeSet();
    expect(writes.deleteMessages).toEqual([{ id: "m-a", expectedRevision: 1 }]);
    expect(writes.deleteVariables).toEqual([
      { key: "$name", expectedRevision: 1 },
    ]);
    expect(writes.characters[0].definition).toBeUndefined();
    expect(writes.characters[0].fields).toContainEqual({
      key: "name",
      value: "Renamed",
      expectedRevision: 1,
    });
    expect(
      writes.resources.find((v) => v.kind === "module").payload,
    ).toBeUndefined();
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: writes,
    });
    expect(store.snapshot("a").messages[0].message.data).toBe("replacement");
    expect(store.snapshot("a").deletedMessages[0].revision).toBe(2);
    expect(store.snapshot("a").variables).toEqual([]);
    expect(store.snapshot("b").variables[0].value).toBe("Beta");
    expect(store.getResource("module", "module").revision).toBe(2);
    expect(store.snapshot("a").character.definition.unknownExtension).toEqual({
      retained: true,
    });
    expect(
      store.getResource("module", "module").payload.unknownExtension,
    ).toEqual({ retained: true });
  } finally {
    store.close();
  }
});

test("lazy character resolution retains the global index and verifies the pinned revision", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const resolver = vi.fn(() => ({
      id: "other",
      revision: 1,
      definition: { name: "Other", type: "character" },
    }));
    const context = createExecutionContext(snapshot, {
      jobId: job.id,
      resolveCharacter: resolver,
    });
    expect(Object.keys(context.getDatabase().characters)).toEqual(["0", "1"]);
    expect(resolver).not.toHaveBeenCalled();
    expect(context.util.getCharacterIndexObject()).toEqual({ other: 0, c: 1 });
    expect(context.getDatabase().characters.map((c) => c.name)).toEqual([
      "Other",
      "Synthetic",
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(context.writeSet().characters).toEqual([]);
    context.resolveCharacter("other").name = "Changed";
    expect(context.writeSet().characters[0]).toMatchObject({
      id: "other",
      expectedRevision: 1,
      definition: { name: "Changed" },
    });
    const stale = createExecutionContext(snapshot, {
      jobId: job.id,
      resolveCharacter: () => ({ id: "other", revision: 2, definition: {} }),
    });
    expect(() => stale.resolveCharacter("other")).toThrow(
      "Character changed after admission",
    );
    expect(() => stale.writeSet()).toThrow("Execution capability errors");
  } finally {
    store.close();
  }
});

test("swallowed capability failures cannot silently commit earlier script effects", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, {
      jobId: job.id,
      resolveCharacter: () => ({ id: "other", revision: 1, definition: {} }),
    });
    context.variables.setChatVar("choice", "before-error");
    expect(() => context.resolveCharacter("other").chats).toThrow(
      "Cross-chat history capability",
    );
    // Some upstream parsers catch host errors; retaining the issue prevents partial success.
    expect(() => context.writeSet()).toThrow("Execution capability errors");
    expect(
      store.snapshot("a").variables.some((v: any) => v.key === "$choice"),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("display state is private and has no persistent commit path", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, {
      jobId: job.id,
      mode: "display",
    });
    context.variables.setChatVar("choice", "temporary");
    expect(() => context.writeSet()).toThrow("Display contexts cannot commit");
    expect(snapshot.variables.some((v: any) => v.key === "$choice")).toBe(
      false,
    );
    expect(
      store.snapshot("a").variables.some((v: any) => v.key === "$choice"),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("generation rejects a paged snapshot and rejects changing the execution identity", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    expect(() =>
      createExecutionContext(
        { ...snapshot, hasEarlier: true } as ExecutionSnapshot,
        { jobId: job.id },
      ),
    ).toThrow("complete server snapshot");
    const context = createExecutionContext(snapshot, { jobId: job.id });
    context.selectedCharID.set(0);
    expect(() => context.writeSet()).toThrow("execution target");
  } finally {
    store.close();
  }
});

test("native variable diffs preserve concurrent local/global keys even when another chat metadata field changes", () => {
  const store = fixture();
  try {
    store.applyCommand("local-before", {
      type: "change-variables",
      edits: [
        {
          scope: "chat-global",
          chatId: "a",
          key: "pinned",
          expectedRevision: 0,
          value: "before",
        },
      ],
    });
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    context.getCurrentChat().note = "engine note";
    context.variables.setGLChatVar("engine", "engine");
    store.applyCommand("local-during", {
      type: "change-variables",
      edits: [
        {
          scope: "chat-global",
          chatId: "a",
          key: "pinned",
          expectedRevision: 1,
          value: "user",
        },
        {
          scope: "chat-global",
          chatId: "a",
          key: "new",
          expectedRevision: 0,
          value: "new",
        },
      ],
    });
    const writes = context.writeSet();
    expect(writes.metadata).toBeUndefined();
    expect(writes.metadataFields).toContainEqual({
      key: "note",
      value: "engine note",
      expectedRevision: 0,
    });
    expect(writes.chatGlobalVariables).toEqual([
      { key: "engine", value: "engine", expectedRevision: 0 },
    ]);
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: writes,
    });
    expect(store.snapshot("a").chat.metadata.GLGlobalVariables).toEqual({
      pinned: "user",
      new: "new",
      engine: "engine",
    });
    expect(store.snapshot("a").chat.metadata.note).toBe("engine note");
  } finally {
    store.close();
  }
});

test("explicit removal of the local-global map includes a range guard instead of hiding newly confirmed keys", () => {
  const store = fixture();
  try {
    store.applyCommand("local-before", {
      type: "change-variables",
      edits: [
        {
          scope: "chat-global",
          chatId: "a",
          key: "existing",
          expectedRevision: 0,
          value: "before",
        },
      ],
    });
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    delete context.getCurrentChat().GLGlobalVariables;
    const writes = context.writeSet();
    expect(writes.deleteChatGlobalVariables).toEqual([
      { key: "existing", expectedRevision: 1 },
    ]);
    expect(writes.chatGlobalShape).toEqual({
      type: "absent",
      expectedRevision: snapshot.chat.chatGlobalRevision,
    });
    store.applyCommand("new-during", {
      type: "change-variables",
      edits: [
        {
          scope: "chat-global",
          chatId: "a",
          key: "new",
          expectedRevision: 0,
          value: "user",
        },
      ],
    });
    expect(() =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: writes,
      }),
    ).toThrow("The entity has changed");
    expect(store.snapshot("a").chat.metadata.GLGlobalVariables).toEqual({
      existing: "before",
      new: "user",
    });
  } finally {
    store.close();
  }
});

test("native field diffs preserve concurrent settings, character and metadata values without serializing their full objects", () => {
  const store = fixture({
    settings: { jailbreakToggle: false, temperature: 80 },
  });
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    context.getDatabase().temperature = 65;
    context.getCurrentCharacter().name = "Engine name";
    context.getCurrentChat().note = "Engine note";
    const edits = [
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "jailbreakToggle",
        expectedRevision: 1,
        expectedEpoch: 0,
        value: true,
      },
      {
        scope: "character",
        entityId: "c",
        key: "supaMemory",
        expectedRevision: snapshot.character.fieldRevisions.supaMemory ?? 0,
        expectedEpoch: 0,
        value: true,
      },
      {
        scope: "chat",
        entityId: "a",
        key: "useLocallySetGlobalVariables",
        expectedRevision: 0,
        expectedEpoch: 0,
        value: true,
      },
    ];
    store.applyCommand("device-fields", { type: "change-fields", edits });
    const writes = context.writeSet();
    expect(writes.metadata).toBeUndefined();
    expect(writes.characters[0].definition).toBeUndefined();
    expect(
      writes.resources.find((row) => row.kind === "settings").payload,
    ).toBeUndefined();
    expect(
      writes.resources.find((row) => row.kind === "settings").fields,
    ).toEqual([{ key: "temperature", expectedRevision: 1, value: 65 }]);
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: writes,
    });
    expect(store.getResource("settings", "global").payload).toMatchObject({
      temperature: 65,
      jailbreakToggle: true,
    });
    expect(store.snapshot("a").character.definition).toMatchObject({
      name: "Engine name",
      supaMemory: true,
      unknownExtension: { retained: true },
    });
    expect(store.snapshot("a").chat.metadata).toMatchObject({
      note: "Engine note",
      useLocallySetGlobalVariables: true,
    });
  } finally {
    store.close();
  }
});
