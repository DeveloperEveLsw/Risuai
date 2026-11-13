// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemorySourceReader } from "./memorySourceReader";
import type {
  MemorySourceRequest,
  MemorySourceResponse,
} from "./memorySources";

const response = (
  extra: Partial<MemorySourceResponse> = {},
): MemorySourceResponse => ({
  chatId: "synthetic-chat",
  epoch: 0,
  cursor: 1,
  contentRevision: 1,
  characterRevision: 1,
  ...extra,
});
const message = (data = "Authored message") =>
  response({
    source: {
      message: { role: "user", data, chatId: "synthetic-message" },
      index: 0,
      revision: 1,
    },
  });
function deferred<T>() {
  let resolve: (value: T) => void, reject: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (error: unknown) => reject(error),
  };
}

describe("modal memory source reader", () => {
  it("coalesces repeated references across summaries and splits bounded membership batches", async () => {
    const calls: Omit<MemorySourceRequest, "expectedEpoch">[] = [];
    const reader = createMemorySourceReader({
      clock: () => "a",
      read: async (request) => {
        calls.push(request);
        return response({
          present: request.memos.map((memo) => memo !== "missing"),
        });
      },
    });
    const first = reader.contains([null, "same", "missing"]);
    const second = reader.contains(["same", null]);
    const many = reader.contains(
      Array.from({ length: 300 }, (_, i) => "m" + i),
    );
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(await many).toBe(true);
    expect(calls.map((call) => call.memos.length)).toEqual([256, 47]);
    expect(
      calls.flatMap((call) => call.memos).filter((memo) => memo === "same"),
    ).toHaveLength(1);
    expect(await reader.contains(["same", null])).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not let old queued references share the new conversation's answer", async () => {
    let clock = "a";
    const calls: (string | null)[][] = [];
    const reader = createMemorySourceReader({
      clock: () => clock,
      read: async (request) => {
        calls.push(request.memos);
        return response({ present: request.memos.map(() => true) });
      },
    });
    const old = reader.contains(["same"]);
    const rejected = expect(old).rejects.toThrow("changed");
    clock = "b";
    const fresh = reader.contains(["same"]);
    await rejected;
    expect(await fresh).toBe(true);
    expect(calls).toEqual([["same"]]);
  });

  it("rejects a stale in-flight answer while retaining the new view's cached promise", async () => {
    let clock = "a";
    const pending = deferred<MemorySourceResponse>();
    let calls = 0;
    const reader = createMemorySourceReader({
      clock: () => clock,
      read: async () => {
        calls++;
        return calls === 1 ? pending.promise : response({ present: [true] });
      },
    });
    const old = reader.contains(["same"]);
    const rejected = expect(old).rejects.toThrow("changed");
    await Promise.resolve();
    clock = "b";
    expect(await reader.contains(["same"])).toBe(true);
    pending.resolve(response({ present: [false] }));
    await rejected;
    expect(await reader.contains(["same"])).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries failed membership and rejects an incomplete membership response", async () => {
    let calls = 0;
    const reader = createMemorySourceReader({
      clock: () => "a",
      read: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return response({ present: calls === 2 ? [] : [true] });
      },
    });
    await expect(reader.contains(["m"])).rejects.toThrow("offline");
    await expect(reader.contains(["m"])).rejects.toThrow("Invalid");
    expect(await reader.contains(["m"])).toBe(true);
    expect(calls).toBe(3);
  });

  it("reuses raw bodies, invalidates them on source clock changes and retries failures", async () => {
    let clock = "a",
      calls = 0;
    const reader = createMemorySourceReader({
      clock: () => clock,
      read: async () => {
        calls++;
        if (calls === 3) throw new Error("offline");
        return message();
      },
    });
    await reader.source("message", "m");
    await reader.source("message", "m");
    expect(calls).toBe(1);
    clock = "b";
    await reader.source("message", "m");
    expect(calls).toBe(2);
    await expect(reader.source("next", "m")).rejects.toThrow("offline");
    await reader.source("next", "m");
    expect(calls).toBe(4);
  });

  it("evicts raw bodies by entry count and bytes instead of hydrating an archive", async () => {
    let calls = 0;
    let huge = false;
    const reader = createMemorySourceReader({
      clock: () => "a",
      read: async () => {
        calls++;
        return message(huge ? "x".repeat(2 * 1024 * 1024) : "small");
      },
    });
    for (let i = 0; i < 17; i++) await reader.source("message", "m" + i);
    await reader.source("message", "m0");
    expect(calls).toBe(18);
    huge = true;
    await reader.source("message", "huge");
    await reader.source("message", "huge");
    expect(calls).toBe(20);
  });

  it("rejects pending and future reads after the modal closes", async () => {
    const pending = deferred<MemorySourceResponse>();
    let calls = 0;
    const reader = createMemorySourceReader({
      clock: () => "a",
      read: () => {
        calls++;
        return pending.promise;
      },
    });
    const body = reader.source("message", "m");
    const bodyRejected = expect(body).rejects.toThrow("closed");
    const membership = reader.contains(["m"]);
    const memberRejected = expect(membership).rejects.toThrow("closed");
    reader.close();
    pending.resolve(message());
    await bodyRejected;
    await memberRejected;
    await expect(reader.contains(["new"])).rejects.toThrow("closed");
    await expect(reader.source("next", null)).rejects.toThrow("closed");
    expect(calls).toBe(1);
  });
});
