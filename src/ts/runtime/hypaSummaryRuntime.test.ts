// @vitest-environment node
import { expect, test } from "vitest";
import { createHypaSummaryRuntime } from "../process/memory/hypaSummaryRuntime";
import { inlayTokenRegex } from "../util/inlayTokens";
function fixture(
  settings = {},
  response: any = {
    type: "success",
    result: "<Thoughts>hidden</Thoughts>Summary",
  },
) {
  const calls: any[] = [];
  const db = {
    subModel: "synthetic",
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        settings: {
          summarizationModel: "subModel",
          summarizationPrompt: "",
          reSummarizationPrompt: "",
          ...settings,
        },
      },
    ],
  };
  const runtime = createHypaSummaryRuntime({
    getDatabase: () => db,
    parseChatML: () => null,
    requestChatData: async (...args: any[]) => {
      calls.push(args);
      return response;
    },
    chatCompletion: async (...args: any[]) => {
      calls.push(args);
      return "<think>hidden</think>Local";
    },
    inlayTokenRegex,
    logPrefix: "Synthetic",
  } as any);
  return { runtime, calls, db };
}
test("upstream summary sanitizes every inlay kind, requests the memory model without streaming and strips thoughts", async () => {
  const f = fixture();
  expect(
    await f.runtime.summarize([
      {
        role: "user",
        content: "{{inlay::a}} {{inlayed::b}} {{inlayeddata::c}}",
      },
    ]),
  ).toBe("Summary");
  expect(f.calls[0][0]).toMatchObject({
    useStreaming: false,
    noMultiGen: true,
    formated: [
      { role: "user", content: "user: [Image] [Image] [Image]" },
      { role: "system" },
    ],
  });
  expect(f.calls[0][1]).toBe("memory");
});
test("bulk uses original re-summary slot prompt independently from normal summary prompt", async () => {
  const f = fixture({
    summarizationPrompt: "Single",
    reSummarizationPrompt: "Bulk {{slot}}",
  });
  await f.runtime.summarize(
    [
      { role: "user", content: "One" },
      { role: "user", content: "Two" },
    ],
    true,
  );
  expect(f.calls[0][0].formated[1].content).toBe("Bulk {{slot}}");
  expect(f.calls[0][0].formated[0].content).toBe("user: One\nuser: Two");
});
for (const response of [
  { type: "streaming" },
  { type: "multiline" },
  { type: "fail", result: "Synthetic refused" },
  { type: "success", result: " " },
  { type: "success", result: "<Thoughts>Only thoughts</Thoughts>" },
])
  test(`upstream summary rejects ${JSON.stringify(response)}`, async () => {
    const f = fixture({}, response);
    await expect(
      f.runtime.summarize([{ role: "user", content: "Synthetic" }]),
    ).rejects.toThrow();
  });
test("original local-model ordering places system first and removes think blocks", async () => {
  const f = fixture({ summarizationModel: "local" });
  expect(
    await f.runtime.summarize([{ role: "user", content: "Synthetic" }]),
  ).toBe("Local");
  expect(f.calls[0][0][0].role).toBe("system");
  expect(f.calls[0][2]).toMatchObject({
    max_tokens: 8192,
    temperature: 0,
    extra_body: { enable_thinking: false },
  });
});
test("a missing preset remains an error and does not call a provider", async () => {
  const f = fixture();
  f.db.hypaV3PresetId = 99;
  await expect(f.runtime.summarize([])).rejects.toThrow("Preset not found");
  expect(f.calls).toEqual([]);
});
