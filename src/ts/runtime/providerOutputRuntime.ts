import type { requestChatData } from "../process/request/request";

export interface ProviderOutput {
  request: number;
  mode: string;
  type: "success" | "multiline" | "streaming";
  complete: boolean;
  candidates: { key: string; role: "user" | "char"; data: string }[];
}

/** Parsed model output only; never HTTP bodies, prompts, headers or script state. */
export function createProviderOutputRuntime(
  request: typeof requestChatData,
  retain?: (output: ProviderOutput) => Promise<void>,
) {
  let sequence = 0;
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  function tracked<T>(action: () => Promise<T>) {
    const operation = action();
    pending.add(operation);
    operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  const streams = new Set<(reason: unknown) => Promise<void>>();
  const wrapped: typeof requestChatData = async (...args) => {
    if (closing) throw new Error("Provider output runtime is closed");
    if (!retain) return request(...args);
    const id = ++sequence;
    if (id > 64)
      throw new Error(
        "Provider output retention supports at most 64 requests per job",
      );
    const response = await request(...args);
    const mode = String(args[1]).slice(0, 80);
    if (response.type === "fail") return response;
    if (response.type === "success" || response.type === "multiline") {
      await retain({
        request: id,
        mode,
        type: response.type,
        complete: true,
        candidates: (response.type === "multiline"
          ? response.result
          : [["char", response.result] as const]
        ).map(([role, data], index) => ({ key: String(index), role, data })),
      });
      return response;
    }
    if (response.type !== "streaming") return response;
    const reader = response.result.getReader();
    let latest: Record<string, string> = {},
      lastSave = -Infinity,
      finished = false,
      abandoned = false,
      released = false;
    const save = async (complete: boolean) => {
      await retain({
        request: id,
        mode,
        type: "streaming",
        complete,
        candidates: Object.entries(latest).map(([key, data]) => ({
          key,
          role: "char",
          data,
        })),
      });
      lastSave = performance.now();
    };
    const release = () => {
      streams.delete(stop);
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    const stop = (reason: unknown) =>
      tracked(async () => {
        abandoned = true;
        try {
          if (!finished && Object.keys(latest).length) await save(false);
        } finally {
          await reader.cancel(reason).catch(() => {});
          release();
        }
      });
    streams.add(stop);
    const stream = new ReadableStream<Record<string, string>>(
      {
        pull: (controller) =>
          tracked(async () => {
            try {
              const item = await reader.read();
              if (item.value) {
                latest = { ...item.value };
                // Persist the first parsed chunk before Lua can fail on it, then
                // coalesce writes. Preserve the single original stream consumer.
                if (performance.now() - lastSave >= 250) await save(false);
              }
              if (item.done) {
                await save(!abandoned && !closing);
                finished = true;
                release();
                controller.close();
              } else controller.enqueue(item.value);
            } catch (error) {
              try {
                if (Object.keys(latest).length) await save(false);
              } catch {
              } finally {
                await reader.cancel(error).catch(() => {});
                release();
                controller.error(error);
              }
            }
          }),
        cancel: stop,
      },
      { highWaterMark: 0 },
    );
    return { ...response, result: stream };
  };
  return {
    requestChatData: wrapped,
    async close() {
      closing = true;
      await Promise.allSettled(
        [...streams].map((stop) => stop("Native generation closed")),
      );
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
