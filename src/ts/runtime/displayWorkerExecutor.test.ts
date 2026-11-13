// @vitest-environment node
import { expect, test } from "vitest";
import { DisplayWorkerExecutor } from "./displayWorkerExecutor";
import {
  DisplayCaptureDecoder,
  type CapturePacket,
} from "./displayCaptureTransport";
import type { DisplayExecution } from "./displayLuaContext";
import { freezeDisplayJson } from "./displayScopeIdentity";

test("executor rejects oversized outer content before transport and preserves fresh unknown fields after rejection", async () => {
  const decoder = new DisplayCaptureDecoder();
  const sent: { input: Record<string, unknown>; capture: unknown }[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    onmessageerror: null,
    postMessage(message: {
      id: number;
      input: Record<string, unknown>;
      captureWire: CapturePacket;
    }) {
      const wire = structuredClone(message);
      sent.push({
        input: wire.input,
        capture: decoder.decode(wire.captureWire),
      });
      queueMicrotask(() =>
        worker.onmessage?.({
          data: {
            type: "result",
            id: message.id,
            result: { output: message.input.content },
          },
        }),
      );
    },
    terminate() {},
  };
  const executor = new DisplayWorkerExecutor(
    () => {
      throw Error("No DOM port expected");
    },
    2000,
    worker as unknown as Worker,
  );
  worker.onmessage?.({ data: { type: "ready" } });
  const body = { text: "Synthetic😀".repeat(800) };
  freezeDisplayJson(body);
  const input = {
    capture: {
      body,
      revision: 1,
      versions: {
        chat: new Map([["$test", 1]]),
        localGlobal: new Map(),
        global: new Map(),
      },
    },
    content: "\u0000".repeat(3 * 1024 * 1024),
    index: 0,
    identity: { synthetic: true },
    suppressed: false,
    syntheticExtension: { retained: "before" },
  } as unknown as DisplayExecution & {
    syntheticExtension: { retained: string };
  };
  try {
    const before = executor.transportDiagnostics();
    await expect(executor.execute(input)).rejects.toThrow(
      "scope exceeds 16 MiB",
    );
    expect(sent).toEqual([]);
    expect(executor.transportDiagnostics()).toEqual(before);
    input.content = "Synthetic normal";
    expect(await executor.execute(input)).toEqual({
      output: "Synthetic normal",
    });
    expect(sent[0].input.syntheticExtension).toEqual({ retained: "before" });
    expect(sent[0].capture).toEqual({
      body,
      revision: 1,
      versions: { chat: [["$test", 1]], localGlobal: [], global: [] },
    });
    input.syntheticExtension.retained = "later";
    (input.capture as unknown as { revision: number }).revision++;
    expect(await executor.execute(input)).toEqual({
      output: "Synthetic normal",
    });
    expect(sent[1].input.syntheticExtension).toEqual({ retained: "later" });
    expect(sent[1].capture).toEqual({
      body,
      revision: 2,
      versions: { chat: [["$test", 1]], localGlobal: [], global: [] },
    });
    expect(executor.transportDiagnostics().definitionsSent).toBe(1);
    expect(executor.transportDiagnostics().reusedReferences).toBe(1);
  } finally {
    executor.close();
    decoder.close();
  }
});
