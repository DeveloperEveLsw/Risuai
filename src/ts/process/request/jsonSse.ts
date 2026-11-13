/** Decode complete JSON SSE events once, retaining only the unfinished event. */
export function createJsonSseTransform<T>(receive: (value: unknown) => T) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let ended = false;
  let changed = false;
  let latest: T;

  function dispatch() {
    const payload = data.join("\n");
    data = [];
    if (ended || !payload) return;
    if (payload.trim() === "[DONE]") {
      ended = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw new Error("Malformed JSON in provider event stream");
    }
    latest = receive(value);
    changed = true;
  }

  function line(value: string) {
    if (!value) return dispatch();
    if (ended || value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
  }

  function consume(final = false) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== "\r" && buffer[i] !== "\n") continue;
      if (!final && buffer[i] === "\r" && i === buffer.length - 1) break;
      line(buffer.slice(start, i));
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer) line(buffer);
      buffer = "";
      // Accept a valid final data event even when the peer omits its blank line.
      dispatch();
    }
  }

  function emit(control: TransformStreamDefaultController<T>) {
    if (changed) {
      control.enqueue(latest);
      changed = false;
    }
  }

  return new TransformStream<Uint8Array, T>({
    transform(chunk, control) {
      buffer += decoder.decode(chunk, { stream: true });
      consume();
      emit(control);
    },
    flush(control) {
      buffer += decoder.decode();
      consume(true);
      emit(control);
    },
  });
}
