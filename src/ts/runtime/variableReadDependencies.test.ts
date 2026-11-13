// @vitest-environment node
import { expect, test } from "vitest";
import { createVariableReadDependencies } from "./variableReadDependencies";
import { createExecutionContext } from "./executionContext";
import { fixture, claim } from "./testFixtures";

test("point-read records retain live/null/absent/tombstone revisions and never expose values", () => {
  const store = fixture();
  try {
    const source = claim(store).snapshot;
    source.deletedVariables = [{ key: "$deleted", revision: 8 }];
    source.chatGlobalVariables = [
      { key: "nullable", revision: 4, value: null },
    ];
    const tracker = createVariableReadDependencies(source, (message) => {
      throw new Error(message);
    });
    tracker.observe("chat", "$name");
    tracker.observe("chat", "$missing");
    tracker.observe("chat", "$deleted");
    tracker.observe("chat-global", "nullable");
    tracker.observe("global", "shared");
    tracker.observe("chat", "$name");
    const reads = tracker.snapshot();
    expect(reads).toEqual([
      {
        scope: "chat",
        key: "$name",
        expectedRevision: 1,
        expectedExists: true,
      },
      {
        scope: "chat",
        key: "$missing",
        expectedRevision: 0,
        expectedExists: false,
      },
      {
        scope: "chat",
        key: "$deleted",
        expectedRevision: 8,
        expectedExists: false,
      },
      {
        scope: "chat-global",
        key: "nullable",
        expectedRevision: 4,
        expectedExists: true,
      },
      {
        scope: "global",
        key: "shared",
        expectedRevision: 1,
        expectedExists: true,
      },
    ]);
    reads[0].expectedRevision = 99;
    expect(tracker.snapshot()[0].expectedRevision).toBe(1);
    expect(JSON.stringify(reads)).not.toContain("Alpha");
  } finally {
    store.close();
  }
});
test("original global precedence records only the actual pin/fallback and distinct namespaces", () => {
  const store = fixture();
  try {
    const source = claim(store).snapshot;
    source.chat.metadata.GLGlobalVariables = { shared: "pinned" };
    source.chatGlobalVariables = [
      { key: "shared", value: "pinned", revision: 3 },
    ];
    const context = createExecutionContext(source, { jobId: "fixture" });
    expect(context.variables.getGlobalChatVar("shared")).toBe("pinned");
    expect(context.writeSet().variableReads).toEqual([
      {
        scope: "chat-global",
        key: "shared",
        expectedRevision: 3,
        expectedExists: true,
      },
    ]);
    context.getCurrentChat().GLGlobalVariables.shared = "null";
    expect(context.variables.getGlobalChatVar("shared")).toBe("server-global");
    expect(context.variables.getChatVar("shared")).toBe("character");
    expect(
      context.writeSet().variableReads?.map((read) => [read.scope, read.key]),
    ).toEqual([
      ["chat-global", "shared"],
      ["global", "shared"],
      ["chat", "$shared"],
    ]);
  } finally {
    store.close();
  }
});
test("read-your-own-writes keep admission guards, while serialization and write-set comparison add no unrelated reads", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    expect(context.writeSet().variableReads).toEqual([]);
    context.variables.setChatVar("new", "own");
    expect(context.variables.getChatVar("new")).toBe("own");
    const writes = context.writeSet();
    expect(writes.variableReads).toEqual([
      {
        scope: "chat",
        key: "$new",
        expectedRevision: 0,
        expectedExists: false,
      },
    ]);
    expect(context.writeSet()).toEqual(writes);
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: writes,
    });
    expect(
      store.snapshot("a").variables.find((row: any) => row.key === "$new")
        .value,
    ).toBe("own");
  } finally {
    store.close();
  }
});
test("key and distinct-read limits fail explicitly without silently truncating the dependency set", () => {
  const store = fixture();
  try {
    const tracker = createVariableReadDependencies(
      claim(store).snapshot,
      (message) => {
        throw new Error(message);
      },
    );
    expect(() => tracker.observe("global", "")).toThrow("nonempty");
    expect(() => tracker.observe("global", "x".repeat(257))).toThrow("256");
    for (let i = 0; i < 4096; i++) tracker.observe("global", String(i));
    tracker.observe("global", "0");
    expect(() => tracker.observe("global", "overflow")).toThrow("4096");
    expect(tracker.snapshot()).toHaveLength(4096);
  } finally {
    store.close();
  }
});
test("a caught invalid API read poisons final persistence", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    expect(() => context.variables.getGlobalChatVar("x".repeat(257))).toThrow(
      "256",
    );
    expect(() => context.writeSet()).toThrow("Execution capability errors");
  } finally {
    store.close();
  }
});

test("all original falsy and literal-null pins fall back, while truthy strings use only the pin", () => {
  const store = fixture();
  try {
    const admitted = claim(store).snapshot;
    for (const value of [null, false, 0, "", "null", "0", "false", "pinned"]) {
      const source = structuredClone(admitted);
      source.chat.metadata.GLGlobalVariables = { shared: value };
      source.chatGlobalVariables = [{ key: "shared", value, revision: 1 }];
      const context = createExecutionContext(source, { jobId: "fixture" });
      const fallback = value === "null" || !value;
      expect(context.variables.getGlobalChatVar("shared")).toBe(
        fallback ? "server-global" : value,
      );
      expect(
        context.writeSet().variableReads?.map((read) => read.scope),
      ).toEqual(fallback ? ["chat-global", "global"] : ["chat-global"]);
    }
  } finally {
    store.close();
  }
});

test("raw global reads bypass chat pins and retain undefined instead of API fallback", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    snapshot.chat.metadata.GLGlobalVariables = { shared: "pinned" };
    snapshot.chatGlobalVariables = [
      { key: "shared", value: "pinned", revision: 1 },
    ];
    const context = createExecutionContext(snapshot, { jobId: job.id });
    expect(context.readGlobalVariable("shared")).toBe("server-global");
    expect(context.readGlobalVariable("missing")).toBeUndefined();
    const writes = context.writeSet();
    expect(writes.variableReads?.map((read) => [read.scope, read.key])).toEqual(
      [
        ["global", "shared"],
        ["global", "missing"],
      ],
    );
    store.applyCommand("peer-raw-global", {
      type: "change-variables",
      edits: [
        { scope: "global", key: "shared", expectedRevision: 1, value: "peer" },
      ],
    });
    expect(() =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: writes,
      }),
    ).toThrow("changed");
    expect(store.snapshot("a").messages.at(-1).message.data).toBe("before");
  } finally {
    store.close();
  }
});

test("cloned trigger state keeps its own scalar values while reads fence the admitted chat revisions", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const privateState = structuredClone(context.getCurrentChat().scriptstate)!;
    privateState.$name = false;
    expect(context.readOptionalScriptState(privateState, "$name")).toBe(false);
    privateState.$name = 0;
    expect(context.readScriptState(privateState, "$name")).toBe(0);
    expect(
      context.readOptionalScriptState(undefined, "$missing"),
    ).toBeUndefined();
    expect(context.getCurrentChat().scriptstate?.$name).toBe("Alpha");
    const writes = context.writeSet();
    expect(writes.variableReads).toEqual([
      {
        scope: "chat",
        key: "$name",
        expectedRevision: 1,
        expectedExists: true,
      },
      {
        scope: "chat",
        key: "$missing",
        expectedRevision: 0,
        expectedExists: false,
      },
    ]);
    expect(writes.variables).toEqual([]);
    store.applyCommand("peer-raw-chat", {
      type: "change-variables",
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$name",
          expectedRevision: 1,
          value: "peer",
        },
      ],
    });
    expect(() =>
      store.finishJob(job.id, "worker", job.fence, {
        state: "completed",
        writeSet: writes,
      }),
    ).toThrow("changed");
    expect(
      store.snapshot("a").variables.find((row: any) => row.key === "$name")
        .value,
    ).toBe("peer");
  } finally {
    store.close();
  }
});

test("display state readers preserve clone semantics without admitting persistent dependencies", () => {
  const store = fixture();
  try {
    const context = createExecutionContext(claim(store).snapshot, {
      jobId: "display",
      mode: "display",
    });
    const privateState = structuredClone(context.getCurrentChat().scriptstate)!;
    expect(context.readOptionalScriptState(privateState, "$name")).toBe(
      "Alpha",
    );
    expect(context.readScriptState(privateState, "$name")).toBe("Alpha");
    expect(context.readGlobalVariable("shared")).toBe("server-global");
    expect(context.readGlobalVariable("x".repeat(257))).toBeUndefined();
    context.ensureHealthy();
    expect(() => context.writeSet()).toThrow("Display contexts cannot commit");
    expect(
      store.snapshot("a").variables.find((row: any) => row.key === "$name")
        .value,
    ).toBe("Alpha");
  } finally {
    store.close();
  }
});
