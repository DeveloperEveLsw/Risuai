// @vitest-environment node
import { describe, expect, test } from "vitest";
import { LLMModels, supportsModelStreaming } from "./modelCatalog";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from "./types";
import {
  allowsMinimalReasoningEffort,
  modelSpecificParameterItems,
} from "../setting/botSettingsParamsData";
import type { SettingContext } from "../setting/types";

describe("Gemini 4 catalog and thinking controls", () => {
  test.each(["gemini-4-argon", "gemini-4-carbon"])(
    "%s Google and Vertex entries use the official model ID and supported capabilities",
    (id) => {
      const google = LLMModels.find((model) => model.id === id)!;
      const vertex = LLMModels.find((model) => model.id === `${id}-vertex`)!;
      expect(google).toBeDefined();
      expect(vertex).toBeDefined();
      expect(google.provider).toBe(LLMProvider.GoogleCloud);
      expect(google.format).toBe(LLMFormat.GoogleCloud);
      expect(vertex.provider).toBe(LLMProvider.VertexAI);
      expect(vertex.format).toBe(LLMFormat.VertexAIGemini);
      for (const model of [google, vertex]) {
        expect(model.internalID).toBe(id);
        expect(model.parameters).toEqual(["reasoning_effort"]);
        expect(model.tokenizer).toBe(LLMTokenizer.GoogleCloud);
        expect(model.flags).toEqual(
          expect.arrayContaining([
            LLMFlags.hasImageInput,
            LLMFlags.hasAudioInput,
            LLMFlags.hasVideoInput,
            LLMFlags.hasStreaming,
            LLMFlags.requiresAlternateRole,
            LLMFlags.geminiThinking,
            LLMFlags.geminiThinkingNoMinimal,
            LLMFlags.hasFirstSystemPrompt,
          ]),
        );
        expect(model.flags).not.toContain(LLMFlags.hasCache);
        expect(model.flags).not.toContain(LLMFlags.hasPrefill);
        expect(model.flags).not.toContain(LLMFlags.hasImageOutput);
      }
      expect(vertex.flags).not.toBe(google.flags);
    },
  );

  test.each(["gemini-4-argon", "gemini-4-carbon"])(
    "%s remains selectable for streaming when a preset omits the flag",
    (id) => {
      const flags = [
        LLMFlags.hasFirstSystemPrompt,
        LLMFlags.hasImageInput,
        LLMFlags.hasAudioInput,
      ];
      expect(supportsModelStreaming({ id, flags })).toBe(true);
      expect(supportsModelStreaming({ id: `${id}-vertex`, flags })).toBe(true);
    },
  );

  test("a non-catalog model can declare its own streaming support", () => {
    const id = "xcustom:::synthetic";
    expect(supportsModelStreaming({ id, flags: [] })).toBe(false);
    expect(
      supportsModelStreaming({ id, flags: [LLMFlags.hasStreaming] }),
    ).toBe(true);
    expect(supportsModelStreaming({ id: "echo_model", flags: [] })).toBe(false);
  });

  test.each([
    ["gemini-4-argon", ["Low", "Medium", "High"]],
    ["gemini-4-argon-vertex", ["Low", "Medium", "High"]],
    ["gemini-4-carbon", ["Low", "Medium", "High"]],
    ["gemini-4-carbon-vertex", ["Low", "Medium", "High"]],
    ["gemini-3.1-pro-preview", ["Low", "Medium", "High"]],
    ["gemini-3.8-flash", ["Low", "Medium", "High"]],
    ["gemini-3-flash-preview", ["Minimal", "Low", "Medium", "High"]],
  ])(
    "%s only presents reasoning levels supported by its catalog",
    (id, labels) => {
      const model = LLMModels.find((entry) => entry.id === id)!;
      const context = { modelInfo: model } as SettingContext;
      const item = modelSpecificParameterItems.find(
        (entry) => entry.id === "params.reasoningEffort",
      )!;
      expect(item.condition!(context)).toBe(true);
      expect(
        item
          .options!.segmentOptions!.filter(
            (option) => !option.condition || option.condition(context),
          )
          .map((option) => option.label),
      ).toEqual(labels);
      expect(allowsMinimalReasoningEffort(model)).toBe(
        labels.includes("Minimal"),
      );
    },
  );
});
