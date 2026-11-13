// @vitest-environment node
import { expect, test } from "vitest";
import { createHypaV3Runtime } from "../process/memory/hypaV3Runtime";
import { createHypaPresetRuntime } from "../process/memory/hypaPresetRuntime";
import { createEmbeddingRuntime } from "../process/memory/embeddingRuntime";
import { createEmbeddingV2Runtime } from "../process/memory/embeddingV2Runtime";
import { createContextualEmbeddingRuntime } from "../process/memory/contextualEmbeddingRuntime";
import { TaskRateLimiter } from "../process/memory/taskRateLimiter";

function fixture(experimental: boolean, overrides = {}) {
  const calls: any[] = [],
    summaries: any[] = [],
    progress: any[] = [],
    cache = new Map();
  const settings = createHypaPresetRuntime({}).createHypaV3Preset("Synthetic", {
    useExperimentalImpl: experimental,
    maxChatsPerSummary: 2,
    recentMemoryRatio: 0,
    similarMemoryRatio: 1,
    queryChatCount: 3,
    ...overrides,
  }).settings;
  const db: any = {
    maxResponse: 10,
    hypaModel: "custom",
    hypaCustomSettings: { url: "http://synthetic.invalid" },
    voyageApiKey: "synthetic-key",
  };
  const embed = (text: string) => (text.includes("needle") ? [1, 0] : [0, 1]);
  const ports: any = {
    getDatabase: () => db,
    localforage: {
      createInstance: () => ({
        getItem: async (key: string) => structuredClone(cache.get(key) ?? null),
        setItem: async (key: string, value: any) => {
          cache.set(key, structuredClone(value));
          return value;
        },
      }),
    },
    globalFetch: async (url: string, args: any) => {
      calls.push({ url, ...structuredClone(args) });
      const inputs =
        typeof args.body.input === "string"
          ? [args.body.input]
          : args.body.input;
      return {
        ok: true,
        data: {
          data: inputs
            ? inputs.map((text: string) => ({ embedding: embed(text) }))
            : args.body.inputs.map((group: string[]) => ({
                data: group.map((text) => ({ embedding: embed(text) })),
              })),
        },
      };
    },
    runEmbedding: async () => {
      throw Error("Synthetic missing local embedding capability");
    },
    appendLastPath: (url: string, path: string) => url + "/" + path,
    isContextModel: (model: string) => model === "voyageContext3",
    getContextProvider: (model: string) => contextual.getContextProvider(model),
    TaskRateLimiter,
    navigator: { hardwareConcurrency: 1 },
    isMobile: false,
  };
  Object.assign(ports, createEmbeddingRuntime(ports));
  const contextual = createContextualEmbeddingRuntime(ports);
  Object.assign(ports, contextual, createEmbeddingV2Runtime(ports));
  const runtime = createHypaV3Runtime({
    ...ports,
    getCurrentHypaV3Preset: () => ({ name: "Synthetic", settings }),
    summarize: async (chats: any[]) => {
      summaries.push(structuredClone(chats));
      return "Synthetic compressed needle";
    },
    unloadEngine: async () => {},
    hypaV3ProgressStore: { set: (value: any) => progress.push(value) },
  });
  const tokenizer = {
    tokenizeChat: async (chat: any) => Math.ceil(chat.content.length / 4),
  };
  const run = (chats: any[], tokens = 50, max = 400, room: any = {}) =>
    runtime.hypaMemoryV3(
      chats,
      tokens,
      max,
      room,
      { type: "character" } as any,
      tokenizer as any,
    );
  return { runtime, db, calls, summaries, progress, run };
}
const chats = (long = false) =>
  Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    memo: "m" + i,
    content: long
      ? ("history " + i + " ").repeat(40)
      : i > 4
        ? "needle"
        : "hay",
  }));

for (const experimental of [false, true]) {
  const mode = experimental ? "experimental" : "default";
  test(`${mode} V3 under budget preserves its original empty-memory behavior without external requests`, async () => {
    const f = fixture(experimental),
      input = chats();
    const r = await f.run(input);
    expect(r.error).toBeUndefined();
    if (experimental) expect(r.chats).toEqual(input);
    else {
      expect(r.chats.slice(1)).toEqual(input);
      expect(r.chats[0]).toMatchObject({
        role: "system",
        memo: "supaMemory",
        content: expect.stringContaining("Past Events Summary"),
      });
    }
    expect(r.memory.summaries).toEqual([]);
    expect(f.summaries).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  test(`${mode} V3 summarizes overflow, preserves stable memos and the recent query history`, async () => {
    const f = fixture(experimental),
      input = chats(true),
      room: any = { hypaV3Data: { summaries: [], extension: { keep: true } } };
    const r = await f.run(input, 820, 400, room);
    expect(r.error).toBeUndefined();
    expect(f.summaries.length).toBeGreaterThan(0);
    expect(r.currentTokens).toBeLessThanOrEqual(400);
    expect((r.memory as any).extension).toEqual({ keep: true });
    expect(r.memory.summaries.flatMap((x) => x.chatMemos)).toEqual(
      input.slice(0, 5).map((x) => x.memo),
    );
    expect(r.chats.slice(-3)).toEqual(input.slice(-3));
    expect(room.hypaV3Data.summaries).toEqual([]);
    expect(f.summaries.every((x) => x.length <= 2)).toBe(true);
  });
  test(`${mode} V3 uses actual embeddings to rank unused memory and preserves authored metadata`, async () => {
    const f = fixture(experimental),
      room: any = {
        hypaV3Data: {
          categories: [{ id: "cat", name: "Synthetic" }],
          summaries: [
            {
              text: "hay ".repeat(8),
              chatMemos: ["m0"],
              isImportant: false,
              tags: ["retained"],
              extra: 17,
            },
            {
              text: "needle ".repeat(8),
              chatMemos: ["m1"],
              isImportant: false,
              categoryId: "cat",
            },
          ],
        },
      };
    const r = await f.run(chats(), 90, 400, room);
    expect(r.error).toBeUndefined();
    expect(f.calls.length).toBeGreaterThan(0);
    expect(r.memory.metrics.lastSimilarSummaries[0]).toBe(1);
    expect(r.memory.summaries[0]).toMatchObject({
      tags: ["retained"],
      extra: 17,
      chatMemos: ["m0"],
    });
    expect(r.memory.categories).toEqual(room.hypaV3Data.categories);
    expect(r.chats[0].content).toContain("needle");
  });
  test(`${mode} V3 removes orphaned summaries and respects the imported preservation option`, async () => {
    const room: any = {
      hypaV3Data: {
        summaries: [
          { text: "needle", chatMemos: ["missing"], isImportant: true },
        ],
      },
    };
    const clean = fixture(experimental),
      kept = fixture(experimental, { preserveOrphanedMemory: true });
    expect((await clean.run(chats(), 50, 400, room)).memory.summaries).toEqual(
      [],
    );
    expect(
      (await kept.run(chats(), 50, 400, room)).memory.summaries,
    ).toHaveLength(1);
  });
  test(`${mode} V3 contextual embeddings preserve summary groups and separate document/query requests`, async () => {
    const f = fixture(experimental);
    f.db.hypaModel = "voyageContext3";
    const r = await f.run(chats(), 90, 400, {
      hypaV3Data: {
        summaries: [
          {
            text: "hay first\n\nhay second",
            chatMemos: ["m0"],
            isImportant: false,
          },
          {
            text: "needle first\n\nneedle second",
            chatMemos: ["m1"],
            isImportant: false,
          },
        ],
      },
    } as any);
    expect(r.error).toBeUndefined();
    const documents = f.calls.filter((x) => x.body.input_type === "document");
    expect(documents[0].body.inputs).toEqual([
      ["hay first", "hay second"],
      ["needle first", "needle second"],
    ]);
    expect(f.calls.some((x) => x.body.input_type === "query")).toBe(true);
    expect(r.memory.metrics.lastSimilarSummaries[0]).toBe(1);
  });
  test(`${mode} V3 explicitly fails missing local embeddings without issuing a provider request`, async () => {
    const f = fixture(experimental);
    f.db.hypaModel = "MiniLM";
    const r = await f.run(chats(), 90, 400, {
      hypaV3Data: {
        summaries: [{ text: "needle", chatMemos: ["m0"], isImportant: false }],
      },
    } as any);
    expect(r.error).toContain("missing local embedding capability");
    expect(f.calls).toEqual([]);
  });
}

test("independent V3 hosts never reuse embeddings from a different custom model or key", async () => {
  const a = fixture(true),
    b = fixture(true);
  a.db.hypaCustomSettings = {
    url: "http://a.invalid",
    key: "synthetic-a",
    model: "a",
  };
  b.db.hypaCustomSettings = {
    url: "http://b.invalid",
    key: "synthetic-b",
    model: "b",
  };
  const room: any = {
    hypaV3Data: {
      summaries: [{ text: "needle", chatMemos: ["m0"], isImportant: false }],
    },
  };
  await Promise.all([
    a.run(chats(), 90, 400, room),
    b.run(chats(), 90, 400, room),
  ]);
  expect(a.calls.length).toBeGreaterThan(0);
  expect(b.calls.length).toBeGreaterThan(0);
  expect(
    a.calls.every(
      (x) =>
        x.url === "http://a.invalid/embeddings" &&
        x.headers.Authorization === "Bearer synthetic-a" &&
        x.body.model === "a",
    ),
  ).toBe(true);
  expect(
    b.calls.every(
      (x) =>
        x.url === "http://b.invalid/embeddings" &&
        x.headers.Authorization === "Bearer synthetic-b" &&
        x.body.model === "b",
    ),
  ).toBe(true);
});
