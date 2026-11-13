import type { createExecutionContext } from "./executionContext";

/** Server transport for the original request handlers; browser proxy/session state is unnecessary here. */
export function createNativeTransport(
  context: ReturnType<typeof createExecutionContext>,
  options: {
    providerFetch?: typeof fetch;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (event: any) => void;
    checkBeforeExternalEffect?: () => void;
    /** A separately owned plugin host observes failure without poisoning chat effects. */
    isolateProviderFailure?: boolean;
  },
) {
  let providerCalls = 0;
  function signal(input?: AbortSignal, timeout?: number) {
    const signals = [input, options.signal].filter(Boolean) as AbortSignal[];
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout <= 0)
        context.fail("Invalid provider timeout");
      signals.push(AbortSignal.timeout(Math.ceil(timeout)));
    }
    return signals.length ? AbortSignal.any(signals) : undefined;
  }
  async function request(
    url: string | URL,
    arg: RequestInit & { requestTimeoutMs?: number } = {},
  ) {
    context.ensureHealthy();
    try {
      options.checkBeforeExternalEffect?.();
    } catch (error) {
      return context.fail(
        "Interactive execution is incomplete: " + String(error),
      );
    }
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol))
      context.fail("Provider URL must use HTTP or HTTPS");
    const abortSignal = signal(arg.signal, arg.requestTimeoutMs);
    abortSignal?.throwIfAborted();
    providerCalls++;
    options.onProgress?.({ type: "provider-started", call: providerCalls });
    try {
      const response = await (options.providerFetch ?? fetch)(target, {
        ...arg,
        signal: abortSignal,
      });
      if (response.body) {
        // Upstream stream parsers start pipeTo without awaiting it. Observe its rejection
        // here while preserving the original stream's error propagation to the parser.
        const pipeTo = response.body.pipeTo.bind(response.body);
        response.body.pipeTo = (...args: Parameters<typeof pipeTo>) => {
          const promise = pipeTo(...args);
          promise.catch((error) => {
            if (options.isolateProviderFailure) return;
            try {
              context.fail(`Provider stream was interrupted: ${error.message}`);
            } catch {}
          });
          return promise;
        };
      }
      return response;
    } catch (error) {
      if (options.isolateProviderFailure) throw error;
      // A lost response does not establish whether the provider executed the request.
      context.fail(
        `Provider outcome is uncertain; automatic replay is disabled: ${(error as Error).message}`,
      );
    }
  }
  async function fetchNative(url: string, arg: any = {}) {
    return request(url, { ...arg, method: arg.method ?? "POST" });
  }
  async function globalFetch(url: string, arg: any = {}) {
    const headers = new Headers(arg.headers),
      body = arg.body;
    const json =
      body !== undefined &&
      typeof body !== "string" &&
      !(body instanceof Uint8Array) &&
      !(body instanceof ArrayBuffer);
    if (json && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const response = await request(url, {
      headers,
      body: json ? JSON.stringify(body) : body,
      method: arg.method ?? "POST",
      signal: arg.abortSignal,
      requestTimeoutMs: arg.requestTimeoutMs,
    });
    const raw = await response.text();
    let data: unknown = raw;
    if (!arg.rawResponse) {
      try {
        data = JSON.parse(raw);
      } catch {
        if (response.ok) context.fail("Provider returned invalid JSON");
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      headers: Object.fromEntries(response.headers),
    };
  }
  return {
    fetchNative,
    globalFetch,
    fetch: ((url: any, init: any) =>
      typeof url === "string" && url.startsWith("/")
        ? options.fetch
          ? options.fetch(url, init)
          : context.fail("Public runtime resource loader is required")
        : request(url, init)) as typeof fetch,
    textifyReadableStream: (stream: ReadableStream<Uint8Array>) =>
      new Response(stream).text(),
    // Do not put provider keys, prompts or responses in progress messages.
    addFetchLog: (entry: any) => {
      options.onProgress?.({
        type: "provider-response",
        status: entry.status,
        success: entry.success,
      });
      return 0;
    },
    calls: () => providerCalls,
  };
}
