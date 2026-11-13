// @vitest-environment node
import { expect, test } from "vitest";
import { runtimeEvents } from "./runtimeEventStream";
import { commandJson } from "./clientProtocol";

test("SSE parsing retains UTF-8, multiline data and IDs across split CRLF boundaries", async () => {
  const encoded = new TextEncoder().encode(
    "\uFEFF: heartbeat\r\nid: 9\r\nevent: change\r\ndata: 한글\r\ndata: second\r\n\r\ndata: third\r\n\r\nid: 10\ndata: unfinished",
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const values = [];
  for await (const event of runtimeEvents(body, new AbortController().signal))
    values.push(event);
  expect(values).toEqual([
    { event: "change", id: "9", data: "한글\nsecond" },
    { event: "message", id: "9", data: "third" },
  ]);
});

test("closing observation cancels a pending reader and completes without waiting for server output", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const iterator = runtimeEvents(body, abort.signal);
  const next = iterator.next();
  abort.abort();
  await expect(next).resolves.toMatchObject({ done: true });
  expect(cancelled).toBe(true);
});

test("an unfinished oversized SSE frame fails rather than accumulating unbounded client state", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1).fill(65));
      controller.close();
    },
  });
  await expect(
    runtimeEvents(body, new AbortController().signal).next(),
  ).rejects.toMatchObject({ code: "STREAM_TOO_LARGE" });
});

test("command canonicalization matches stable server identity and rejects lossy non-JSON values", () => {
  expect(commandJson({ b: [true, null], a: 1 })).toBe(
    commandJson({ a: 1, b: [true, null] }),
  );
  for (const value of [
    undefined,
    NaN,
    new Date(),
    { x: undefined },
    [Infinity],
  ])
    expect(() => commandJson(value)).toThrow("only JSON");
});
