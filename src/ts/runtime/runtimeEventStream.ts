import { RuntimeClientError } from "./clientProtocol";

export interface RuntimeStreamEvent {
  event: string;
  id: string;
  data: string;
}

/** Pull-based consumption lets projection complete before reading/acknowledging the next event. */
export async function* runtimeEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<RuntimeStreamEvent> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    event = "",
    id = "",
    first = true,
    frameSize = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let text = decoder.decode(chunk.value, { stream: true });
      if (first && text.length) {
        first = false;
        if (text[0] === "\uFEFF") text = text.slice(1);
      }
      buffer += text;
      // The API bounds JSON payloads at 16 MiB. Bound malformed/unfinished frames as well.
      if (buffer.length + frameSize > 20 * 1024 * 1024)
        throw new RuntimeClientError(
          "STREAM_TOO_LARGE",
          "Runtime event exceeds the frame limit",
        );
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const line = buffer.slice(0, end),
          width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        frameSize += line.length;
        if (!line) {
          if (data.length)
            yield { event: event || "message", id, data: data.join("\n") };
          data = [];
          event = "";
          frameSize = 0;
        } else if (line[0] !== ":") {
          const colon = line.indexOf(":"),
            field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") data.push(value);
          else if (field === "event") event = value;
          else if (field === "id" && !value.includes("\0")) id = value;
        }
      }
    }
    // An unfinished event at EOF has not been dispatched and must be replayed.
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
