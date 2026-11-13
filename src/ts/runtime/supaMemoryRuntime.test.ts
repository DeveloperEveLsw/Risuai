// @vitest-environment node
import { expect, test } from "vitest";
import { createSupaMemoryRuntime } from "../process/memory/supaMemoryRuntime";

const chats = () =>
  [0, 1, 2, 3].map((i) => ({
    role: "user" as const,
    content: "Synthetic text " + i,
    memo: "m" + i,
  }));
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const db = {
    supaModelType: "subModel",
    supaMemoryPrompt: "Synthetic summarize",
    maxSupaChunkSize: 1000,
    ...overrides,
  };
  const runtime = createSupaMemoryRuntime({
    getDatabase: () => db,
    tokenize: async () => 5,
    requestChatData: async (...args: unknown[]) => {
      calls.push(args);
      return { type: "success", result: "Synthetic summary" };
    },
    parseChatML: () => null,
    getUserName: () => "Synthetic user",
    safeStructuredClone: structuredClone,
    globalFetch: async () => ({
      ok: false,
      data: { error: "Synthetic refusal" },
    }),
  } as any);
  return { runtime, calls };
}

test("original SupaMemory under budget adds its token allowance without summary calls or chat replacement", async () => {
  const f = fixture(),
    input = chats();
  const result = await f.runtime.supaMemory(
    input,
    50,
    300,
    {} as any,
    {} as any,
    {} as any,
  );
  expect(result.currentTokens).toBe(60);
  expect(result.chats).toBe(input);
  expect(f.calls).toEqual([]);
});

test("original SupaMemory over budget calls the memory model and returns its next-message marker and summary", async () => {
  const f = fixture();
  const result = await f.runtime.supaMemory(
    chats(),
    350,
    300,
    {} as any,
    { type: "character", name: "Synthetic" } as any,
    { tokenizeChat: async () => 80 } as any,
  );
  expect(f.calls).toHaveLength(1);
  expect((f.calls[0] as any[])[1]).toBe("memory");
  expect((f.calls[0] as any[])[0]).toMatchObject({
    useStreaming: false,
    noMultiGen: true,
  });
  expect(result).toMatchObject({
    currentTokens: 285,
    memory: "m1\nSynthetic summary",
    lastId: "m1",
  });
  expect(result.chats[0]).toMatchObject({
    role: "system",
    content: "Synthetic summary",
    memo: "supaMemory",
  });
});

test("original legacy SupaMemory completion errors remain errors and do not become successful summaries", async () => {
  const f = fixture({
    supaModelType: "instruct35",
    supaMemoryKey: "synthetic",
  });
  const result = await f.runtime.supaMemory(
    chats(),
    350,
    300,
    {} as any,
    { type: "character", name: "Synthetic" } as any,
    { tokenizeChat: async () => 80 } as any,
  );
  expect(result.error).toContain("Synthetic refusal");
  expect(result.memory).toBeUndefined();
  expect(f.calls).toEqual([]);
});
