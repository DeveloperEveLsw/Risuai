// @vitest-environment node

import { get, writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import {
  createGenerationRuntime,
  type GenerationRuntimeHost,
} from "./generationRuntime";

test("the upstream orchestration imports without browser globals and uses only its own busy state", async () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const busy = writable(true);
  const stage = writable(99);
  const runtime = createGenerationRuntime({
    doingChat: busy,
    chatProcessStage: stage,
  } as GenerationRuntimeHost);
  expect(await runtime.sendChat()).toBe(false);
  expect(get(stage)).toBe(0);
  expect(get(busy)).toBe(true);
});

test("independent runtimes do not share busy or progress stores, including the upstream peer rejection path", async () => {
  const aBusy = writable(true);
  const aStage = writable(9);
  const bBusy = writable(false);
  const bStage = writable(8);
  const rejection = vi.fn();
  const a = createGenerationRuntime({
    doingChat: aBusy,
    chatProcessStage: aStage,
  } as GenerationRuntimeHost);
  const b = createGenerationRuntime({
    doingChat: bBusy,
    chatProcessStage: bStage,
    DBState: { db: {} },
    connectionOpen: true,
    peerSafeCheck: async () => false,
    peerRevertChat: () => {},
    selectedCharID: writable(0),
    language: { otherUserRequesting: "synthetic peer rejection" },
    alertError: rejection,
  } as unknown as GenerationRuntimeHost);
  expect(await b.sendChat()).toBe(false);
  expect(get(bBusy)).toBe(false);
  expect(rejection).toHaveBeenCalledWith("synthetic peer rejection");
  expect(get(aBusy)).toBe(true);
  expect(get(aStage)).toBe(9);
  expect(await a.sendChat()).toBe(false);
  expect(get(aStage)).toBe(0);
});
