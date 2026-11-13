import type { Message } from "../storage/database.svelte";

export type DisplayHistoryWindow = readonly (readonly [string, number])[];

type HistoryIndex = { rows: Map<number, Message>; last: number };
const frozenIndices = new WeakMap<
  readonly Message[],
  WeakMap<DisplayHistoryWindow, HistoryIndex>
>();

function historyIndex(
  messages: readonly Message[],
  window: DisplayHistoryWindow,
  fail: (error: string) => never,
): HistoryIndex {
  const cached = frozenIndices.get(messages)?.get(window);
  if (cached) return cached;
  const frozen =
    Object.isFrozen(messages) &&
    Object.isFrozen(window) &&
    messages.every(Object.isFrozen) &&
    window.every(Object.isFrozen);
  const bodies = new Map(
    messages.map((message) => [
      message.chatId,
      frozen ? message : { ...message },
    ]),
  );
  const rows = new Map<number, Message>();
  const ids = new Set<string>();
  let last = -1;
  for (const [id, ordinal] of window) {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      rows.has(ordinal) ||
      ids.has(id) ||
      !bodies.has(id)
    )
      return fail("Invalid canonical display history window");
    rows.set(ordinal, bodies.get(id));
    ids.add(id);
    last = Math.max(last, ordinal);
  }
  const result = { rows, last };
  if (frozen) {
    let indices = frozenIndices.get(messages);
    if (!indices) frozenIndices.set(messages, (indices = new WeakMap()));
    indices.set(window, result);
  }
  return result;
}

/** Original array indices are canonical ordinals, never positions or UI rows.
 * Missing bodies fail instead of behaving like holes, including map/JSON reads.
 */
export function canonicalDisplayHistory(
  messages: readonly Message[],
  count: number,
  window: DisplayHistoryWindow,
  fail: (error: string) => never,
  write?: (message: Message, text: unknown, ordinal: number) => void,
  readData?: (message: Message) => string | undefined,
): Message[] {
  if (!Number.isSafeInteger(count) || count < 0)
    return fail("Invalid canonical display history count");
  // Only immutable bodies/indexes are shared. Proxies and failure ownership
  // stay private, and rows are wrapped only when an original callback reads one.
  const indexed = historyIndex(messages, window, fail);
  if (indexed.last >= count)
    return fail("Invalid canonical display history window");
  const rows = new Map<number, Message>();
  const index = (key: PropertyKey) =>
    typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
      ? Number(key)
      : undefined;
  const read = (ordinal: number) => {
    if (ordinal >= count) return undefined;
    if (!indexed.rows.has(ordinal))
      return fail(
        "Display processing requires unloaded history; persistent effects were not submitted",
      );
    if (!rows.has(ordinal))
      rows.set(
        ordinal,
        new Proxy(
          write || readData
            ? { ...indexed.rows.get(ordinal) }
            : indexed.rows.get(ordinal),
          {
            get: (message, key, receiver) =>
              key === "data"
                ? (readData?.(message) ?? Reflect.get(message, key, receiver))
                : Reflect.get(message, key, receiver),
            set: (message, key, value) => {
              if (!write || key !== "data")
                return fail(
                  "Persistent display message writes require a server intent",
                );
              write(message, value, ordinal);
              return Reflect.set(message, key, value);
            },
            deleteProperty: () =>
              fail("Persistent display message writes require a server intent"),
            defineProperty: () =>
              fail("Persistent display message writes require a server intent"),
          },
        ),
      );
    return rows.get(ordinal);
  };
  return new Proxy([] as Message[], {
    get: (target, key, receiver) => {
      if (key === "length") return count;
      const ordinal = index(key);
      if (ordinal !== undefined) return read(ordinal);
      return Reflect.get(target, key, receiver);
    },
    has: (target, key) => {
      const ordinal = index(key);
      return ordinal === undefined ? Reflect.has(target, key) : ordinal < count;
    },
    ownKeys: () => {
      if (indexed.rows.size !== count)
        return fail(
          "Display processing requires unloaded history; persistent effects were not submitted",
        );
      return [...indexed.rows.keys()]
        .sort((a, b) => a - b)
        .map(String)
        .concat("length");
    },
    getOwnPropertyDescriptor: (target, key) => {
      const ordinal = index(key);
      return ordinal === undefined
        ? Reflect.getOwnPropertyDescriptor(target, key)
        : ordinal >= count
          ? undefined
          : {
              configurable: true,
              enumerable: true,
              writable: false,
              value: read(ordinal),
            };
    },
    set: () =>
      fail("Persistent display history writes require a server intent"),
    deleteProperty: () =>
      fail("Persistent display history writes require a server intent"),
    defineProperty: () =>
      fail("Persistent display history writes require a server intent"),
  });
}
