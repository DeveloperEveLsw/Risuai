// @vitest-environment node
import { expect, test, vi } from "vitest";
import {
  createProviderOutputRuntime,
  type ProviderOutput,
} from "./providerOutputRuntime";
import type {
  requestChatData,
  requestDataResponse,
} from "../process/request/request";

function fixture(response: requestDataResponse) {
  const saved: ProviderOutput[] = [];
  const request = vi.fn(
    async () => response,
  ) as unknown as typeof requestChatData;
  const runtime = createProviderOutputRuntime(request, async (output) => {
    saved.push(structuredClone(output));
  });
  const start = () => runtime.requestChatData({} as never, "model");
  return { ...runtime, saved, request, start };
}

test("parsed single and multiline results are durably offered before returning unchanged data", async () => {
  for (const response of [
    { type: "success", result: "original" },
    {
      type: "multiline",
      result: [
        ["user", "one"],
        ["char", "two"],
      ],
    },
  ] as requestDataResponse[]) {
    const f = fixture(response);
    expect(await f.start()).toBe(response);
    expect(f.saved[0]).toMatchObject({
      request: 1,
      mode: "model",
      type: response.type,
      complete: true,
    });
    expect(f.saved[0].candidates.map((row) => row.data)).toEqual(
      response.type === "success" ? ["original"] : ["one", "two"],
    );
    await f.close();
  }
});

test("stream observation preserves one reader, exact chunks, variants and completed EOF", async () => {
  const chunks = [
    { "0": "first", "1": "other" },
    { "0": "final", "1": "other final" },
  ];
  let reads = 0,
    cancelled = 0;
  const f = fixture({
    type: "streaming",
    result: new ReadableStream(
      {
        pull(controller) {
          if (reads < chunks.length) controller.enqueue(chunks[reads++]);
          else controller.close();
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  const response = await f.start();
  if (response.type !== "streaming")
    throw new Error("Expected synthetic stream");
  expect(reads).toBe(0);
  const reader = response.result.getReader();
  expect((await reader.read()).value).toBe(chunks[0]);
  expect(f.saved[0].complete).toBe(false);
  expect((await reader.read()).value).toBe(chunks[1]);
  expect((await reader.read()).done).toBe(true);
  expect(f.saved).toHaveLength(2);
  expect(f.saved.at(-1)).toMatchObject({
    complete: true,
    candidates: [
      { key: "0", role: "char", data: "final" },
      { key: "1", role: "char", data: "other final" },
    ],
  });
  await f.close();
  expect(cancelled).toBe(0);
});

test("an interrupted parsed stream retains partial text and exposes the original failure", async () => {
  const failure = new Error("Synthetic stream failure");
  let reads = 0;
  const f = fixture({
    type: "streaming",
    result: new ReadableStream(
      {
        pull(controller) {
          if (reads++ === 0) controller.enqueue({ "0": "partial" });
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    ),
  });
  const response = await f.start();
  if (response.type !== "streaming") throw new Error("Expected stream");
  const reader = response.result.getReader();
  await reader.read();
  await expect(reader.read()).rejects.toBe(failure);
  await f.close();
  expect(f.saved.at(-1)).toMatchObject({
    complete: false,
    candidates: [{ data: "partial" }],
  });
});

test("consumer cancellation and native shutdown never mark a partial response complete", async () => {
  for (const close of [false, true]) {
    let reads = 0,
      cancelled = 0;
    const f = fixture({
      type: "streaming",
      result: new ReadableStream(
        {
          pull(controller) {
            if (reads++ === 0) controller.enqueue({ "0": "partial" });
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    const response = await f.start();
    if (response.type !== "streaming") throw new Error("Expected stream");
    const reader = response.result.getReader();
    await reader.read();
    if (close) {
      const reading = reader.read();
      await f.close();
      await reading;
    } else {
      await reader.cancel();
      await f.close();
    }
    expect(f.saved.every((output) => !output.complete)).toBe(true);
    expect(cancelled).toBe(1);
  }
});

test("native shutdown flushes a consumed chunk coalesced since the last checkpoint", async () => {
  let reads = 0;
  const f = fixture({
    type: "streaming",
    result: new ReadableStream(
      {
        pull(controller) {
          controller.enqueue({ "0": reads++ === 0 ? "first" : "newer" });
        },
      },
      { highWaterMark: 0 },
    ),
  });
  const response = await f.start();
  if (response.type !== "streaming") throw new Error("Expected stream");
  const reader = response.result.getReader();
  await reader.read();
  await reader.read();
  expect(f.saved).toHaveLength(1);
  await f.close();
  expect(f.saved.at(-1)).toMatchObject({
    complete: false,
    candidates: [{ data: "newer" }],
  });
});

test("a failed retention blocks downstream processing and request65 before its provider call", async () => {
  const base = vi.fn(
    async () => ({ type: "success", result: "received" }) as const,
  );
  const failure = new Error("Synthetic storage failure");
  const failed = createProviderOutputRuntime(base, async () => {
    throw failure;
  });
  await expect(failed.requestChatData({} as never, "model")).rejects.toBe(
    failure,
  );
  expect(base).toHaveBeenCalledTimes(1);
  await failed.close();
  const f = fixture({ type: "success", result: "x" });
  for (let i = 0; i < 64; i++) await f.start();
  await expect(f.start()).rejects.toThrow("64 requests");
  expect(f.request).toHaveBeenCalledTimes(64);
  await f.close();
});

test("failure responses and callers without a retention host retain the original contract", async () => {
  const response = { type: "fail", result: "synthetic error" } as const;
  const f = fixture(response);
  expect(await f.start()).toBe(response);
  expect(f.saved).toEqual([]);
  await f.close();
  const plain = createProviderOutputRuntime(async () => response);
  expect(await plain.requestChatData({} as never, "model")).toBe(response);
  await plain.close();
});
