// @vitest-environment node
import { describe, expect, test } from "vitest";
import { LLMModels } from "./modelCatalog";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from "./types";
import {
  allowsMinimalReasoningEffort,
  modelSpecificParameterItems,
} from "../setting/botSettingsParamsData";
import type { SettingContext } from "../setting/types";

describe("Gemini 4 Argon catalog and thinking controls", () => {
  test("Google and the automatically cloned Vertex entry use the official model ID and supported capabilities", () => {
    const google = LLMModels.find((model) => model.id === "gemini-4-argon")!;
    const vertex = LLMModels.find(
      (model) => model.id === "gemini-4-argon-vertex",
    )!;
    expect(google).toBeDefined();
    expect(vertex).toBeDefined();
    expect(google.provider).toBe(LLMProvider.GoogleCloud);
    expect(google.format).toBe(LLMFormat.GoogleCloud);
    expect(vertex.provider).toBe(LLMProvider.VertexAI);
    expect(vertex.format).toBe(LLMFormat.VertexAIGemini);
    for (const model of [google, vertex]) {
      expect(model.internalID).toBe("gemini-4-argon");
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
  });

  test.each([
    ["gemini-4-argon", ["Low", "Medium", "High"]],
    ["gemini-4-argon-vertex", ["Low", "Medium", "High"]],
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
