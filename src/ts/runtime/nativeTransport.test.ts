// @vitest-environment node
import { expect, test, vi } from "vitest";
import { createExecutionContext } from "./executionContext";
import { createNativeTransport } from "./nativeTransport";
import { claim, fixture } from "./testFixtures";

test("a pending or failed interaction blocks transport before any provider call and poisons later final writes", async () => {
  const store = fixture();
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const fetch = vi.fn(async () => new Response("Synthetic"));
  let pending = true;
  const transport = createNativeTransport(context, {
    providerFetch: fetch as typeof globalThis.fetch,
    checkBeforeExternalEffect: () => {
      if (pending) throw new Error("Synthetic unanswered input");
    },
  });
  try {
    await expect(
      transport.fetchNative("http://127.0.0.1:1/synthetic"),
    ).rejects.toThrow("unanswered input");
    pending = false;
    await expect(
      transport.fetchNative("http://127.0.0.1:1/synthetic"),
    ).rejects.toThrow("Execution capability errors");
    expect(fetch).not.toHaveBeenCalled();
    expect(transport.calls()).toBe(0);
    expect(() => context.writeSet()).toThrow("unanswered input");
  } finally {
    store.close();
  }
});
test("settled interaction admission preserves the ordinary transport response and call count", async () => {
  const store = fixture();
  const { job, snapshot } = claim(store);
  const context = createExecutionContext(snapshot, { jobId: job.id });
  const fetch = vi.fn(async () => new Response("Synthetic response"));
  const transport = createNativeTransport(context, {
    providerFetch: fetch as typeof globalThis.fetch,
    checkBeforeExternalEffect: () => {},
  });
  try {
    expect(
      await (
        await transport.fetchNative("http://127.0.0.1:1/synthetic")
      ).text(),
    ).toBe("Synthetic response");
    expect(transport.calls()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
  }
});

for (const isolated of [false, true]) {
  test(`a failed external request ${isolated ? "keeps its original error in a separately owned plugin" : "still poisons ordinary generation"} without replay`, async () => {
    const store = fixture();
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const failure = new TypeError("synthetic fetch failed", {
      cause: Object.assign(new Error("synthetic connection"), {
        code: "ECONNRESET",
      }),
    });
    const fetch = vi.fn(async () => {
      throw failure;
    });
    const transport = createNativeTransport(context, {
      providerFetch: fetch as typeof globalThis.fetch,
      isolateProviderFailure: isolated,
    });
    try {
      if (isolated) {
        await expect(
          transport.fetchNative("https://synthetic.invalid/request"),
        ).rejects.toBe(failure);
        expect(() => context.writeSet()).not.toThrow();
      } else {
        await expect(
          transport.fetchNative("https://synthetic.invalid/request"),
        ).rejects.toThrow("Provider outcome is uncertain");
        expect(() => context.writeSet()).toThrow("Execution capability errors");
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  test(`an errored response pipe ${isolated ? "remains owned by the plugin" : "still invalidates main execution"}`, async () => {
    const store = fixture();
    const { job, snapshot } = claim(store);
    const context = createExecutionContext(snapshot, { jobId: job.id });
    const failure = new Error("synthetic response stream failure");
    const transport = createNativeTransport(context, {
      isolateProviderFailure: isolated,
      providerFetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
          ),
      ) as typeof globalThis.fetch,
    });
    try {
      const response = await transport.fetchNative(
        "https://synthetic.invalid/request",
      );
      await expect(response.body!.pipeTo(new WritableStream())).rejects.toBe(
        failure,
      );
      if (isolated) expect(() => context.writeSet()).not.toThrow();
      else
        expect(() => context.writeSet()).toThrow(
          "Provider stream was interrupted",
        );
    } finally {
      store.close();
    }
  });
}
