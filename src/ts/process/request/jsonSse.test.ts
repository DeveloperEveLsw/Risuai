// @vitest-environment node
import { expect, test } from "vitest";
import { createJsonSseTransform } from "./jsonSse";

async function decode(text: string, bytesPerChunk = 1) {
  const calls: unknown[] = [];
  const bytes = new TextEncoder().encode(text);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += bytesPerChunk)
        controller.enqueue(bytes.slice(i, i + bytesPerChunk));
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      createJsonSseTransform((value) => {
        calls.push(value);
        return value;
      }),
    )
    .getReader();
  const values: unknown[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    values.push(next.value);
  }
  return { calls, values };
}

test("fragmented SSE preserves Unicode, optional spaces, CR/LF, comments and multiline JSON exactly once", async () => {
  const result = await decode(
    ': heartbeat\r\nevent: message\r\ndata:{"text":"한글 🙂"}\r\n\r\n' +
      'data: {\rdata: "text":"second"\rdata: }\r\r' +
      'data: {"text":"third"}\n\n' +
      'data: [DONE]\n\ndata: {"text":"ignored"}\n\n',
  );
  expect(result.calls).toEqual([
    { text: "한글 🙂" },
    { text: "second" },
    { text: "third" },
  ]);
  expect(result.values).toEqual(result.calls);
});

test("one network chunk parses all events once and coalesces its visible update", async () => {
  const result = await decode("data: 1\n\ndata: 2\n\ndata: 3\n\n", 100);
  expect(result.calls).toEqual([1, 2, 3]);
  expect(result.values).toEqual([3]);
});

test("a valid unterminated final event is retained at EOF", async () => {
  expect((await decode('data: {"text":"마지막"}')).values).toEqual([
    { text: "마지막" },
  ]);
});

test("malformed complete or truncated JSON fails rather than silently accepting a partial result", async () => {
  await expect(decode('data: {"text":}\n\n')).rejects.toThrow(
    "Malformed JSON in provider event stream",
  );
  await expect(decode('data: {"text":')).rejects.toThrow(
    "Malformed JSON in provider event stream",
  );
});
