import type {
  MemorySourceRequest,
  MemorySourceResponse,
} from "./memorySources";

/** Modal-owned read cache; membership requests share bounded batches, bodies use a 2 MiB/16 entry LRU. */
export function createMemorySourceReader(host: {
  clock(): string;
  read(
    request: Omit<MemorySourceRequest, "expectedEpoch">,
  ): Promise<MemorySourceResponse>;
}) {
  let closed = false,
    version = "";
  const memberships = new Map<string, Promise<boolean>>();
  const bodies = new Map<
    string,
    { promise: Promise<MemorySourceResponse>; bytes: number }
  >();
  let bodyBytes = 0;
  let queued: {
    memo: string | null;
    version: string;
    resolve(value: boolean): void;
    reject(error: unknown): void;
  }[] = [];
  let scheduled = false;
  function clock() {
    if (closed) throw new Error("The memory view is closed");
    const next = host.clock();
    if (next !== version) {
      memberships.clear();
      bodies.clear();
      bodyBytes = 0;
      version = next;
    }
    return next;
  }
  function current(captured: string) {
    if (clock() !== captured)
      throw new Error("Memory sources changed while loading; try again");
  }
  async function drain() {
    scheduled = false;
    const pending = queued;
    queued = [];
    const groups = new Map<string, typeof pending>();
    for (const entry of pending) {
      const group = groups.get(entry.version) ?? [];
      group.push(entry);
      groups.set(entry.version, group);
    }
    for (const group of groups.values())
      for (let i = 0; i < group.length; i += 256) {
        const batch = group.slice(i, i + 256);
        try {
          current(batch[0].version);
          const response = await host.read({
            mode: "membership",
            memos: batch.map((entry) => entry.memo),
          });
          current(batch[0].version);
          if (!response.present || response.present.length !== batch.length)
            throw new Error("Invalid memory source membership response");
          batch.forEach((entry, index) =>
            entry.resolve(response.present[index]),
          );
        } catch (error) {
          batch.forEach((entry) => entry.reject(error));
        }
      }
  }
  function member(memo: string | null) {
    const captured = clock(),
      key = JSON.stringify(memo);
    const cached = memberships.get(key);
    if (cached) {
      memberships.delete(key);
      memberships.set(key, cached);
      return cached;
    }
    const promise = new Promise<boolean>((resolve, reject) =>
      queued.push({ memo, version: captured, resolve, reject }),
    );
    memberships.set(key, promise);
    if (memberships.size > 1024)
      memberships.delete(memberships.keys().next().value);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => void drain());
    }
    promise.catch(() => {
      if (memberships.get(key) === promise) memberships.delete(key);
    });
    return promise;
  }
  async function source(mode: "message" | "next", memo: string | null) {
    const captured = clock(),
      key = JSON.stringify([mode, memo]);
    const cached = bodies.get(key);
    if (cached) {
      bodies.delete(key);
      bodies.set(key, cached);
      return cached.promise;
    }
    const entry = { promise: null as Promise<MemorySourceResponse>, bytes: 0 };
    entry.promise = host
      .read({ mode, memo })
      .then((response) => {
        current(captured);
        if (bodies.get(key) !== entry) return response;
        entry.bytes = new TextEncoder().encode(
          JSON.stringify(response),
        ).byteLength;
        bodyBytes += entry.bytes;
        while (bodies.size > 16 || bodyBytes > 2 * 1024 * 1024) {
          const first = bodies.keys().next().value,
            removed = bodies.get(first);
          bodies.delete(first);
          bodyBytes -= removed.bytes;
        }
        return response;
      })
      .catch((error) => {
        if (bodies.get(key) === entry) {
          bodies.delete(key);
          bodyBytes -= entry.bytes;
        }
        throw error;
      });
    bodies.set(key, entry);
    while (bodies.size > 16) {
      const first = bodies.keys().next().value;
      bodyBytes -= bodies.get(first).bytes;
      bodies.delete(first);
    }
    return entry.promise;
  }
  return {
    async contains(memos: (string | null)[]) {
      return (await Promise.all(memos.map(member))).every(Boolean);
    },
    source,
    close() {
      closed = true;
      const error = new Error("The memory view is closed");
      queued.forEach((entry) => entry.reject(error));
      queued = [];
      memberships.clear();
      bodies.clear();
      bodyBytes = 0;
    },
  };
}
