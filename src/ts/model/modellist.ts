import { getDatabase } from "../storage/database.svelte";

import {
  LLMFlags,
  LLMProvider,
  LLMFormat,
  LLMTokenizer,
  ProviderNames,
  OpenAIParameters,
  ClaudeParameters,
  type LLMModel,
  GPT5XHighParameters,
} from "./types";

import { OpenAIModels } from "./providers/openai";

import { AnthropicModels } from "./providers/anthropic";

import { GoogleModels } from "./providers/google";

import { fetchNative } from "../globalApi.svelte";

import { DBState } from "../stores.svelte";

import { customProviderStore, pluginV2 } from "../plugins/plugins.svelte";

import { get } from "svelte/store";

import { customV3ProviderMetaStore } from "../plugins/apiV3/v3.svelte";

export {
  LLMFlags,
  LLMProvider,
  LLMFormat,
  LLMTokenizer,
  ProviderNames,
  OpenAIParameters,
  ClaudeParameters,
};

export type { LLMModel };

export async function registerModelDynamic() {
  if (!DBState.db.dynamicModelRegistry) {
    return;
  }
  //google
  try {
    if (DBState.db.google.accessToken) {
      const res = await fetchNative(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${DBState.db.google.accessToken}`,
        {
          method: "GET",
        },
      );
      const json = await res.json();
      console.log("Google models response", json);
      const models = json?.models || [];
      for (let model of models) {
        if (
          !model.supportedGenerationMethods ||
          !model.supportedGenerationMethods.includes("generateContent")
        ) {
          continue;
        }

        const id = model.name.startsWith("models/")
          ? model.name.replace("models/", "")
          : model.name;
        const exists = LLMModels.find(
          (m) => m.id === id || m.internalID === id,
        );

        if (!exists) {
          LLMModels.push({
            id: "dynamic_google_" + id,
            name: model.displayName || id,
            shortName: model.displayName || id,
            fullName: model.displayName || id,
            internalID: model.name,
            provider: LLMProvider.GoogleCloud,
            format: LLMFormat.GoogleCloud,
            flags: [
              LLMFlags.hasImageInput,
              LLMFlags.poolSupported,
              LLMFlags.hasAudioInput,
              LLMFlags.hasVideoInput,
              LLMFlags.hasStreaming,
              LLMFlags.requiresAlternateRole,
              LLMFlags.geminiThinking,
            ],
            parameters: [
              "thinking_tokens",
              "temperature",
              "top_k",
              "top_p",
              "presence_penalty",
              "frequency_penalty",
            ],
            tokenizer: LLMTokenizer.GoogleCloud,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error fetching Google models", error);
  }

  //Anthropic
  try {
    if (DBState.db.claudeAPIKey) {
      const res = await fetchNative("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": DBState.db.claudeAPIKey,
        },
      });

      const json = await res.json();
      console.log("Anthropic models response", json);
      const models: {
        id: string;
        display_name: string;
      }[] = json?.data || [];

      for (let model of models) {
        const exists = LLMModels.find(
          (m) => m.id === model.id || m.internalID === model.id,
        );
        if (!exists) {
          LLMModels.push({
            name: model.display_name || model.id,
            id: `dynamic_anthropic_${model.id}`,
            shortName: model.display_name || model.id,
            fullName: model.display_name || model.id,
            internalID: model.id,
            provider: LLMProvider.Anthropic,
            format: LLMFormat.Anthropic,
            flags: [
              LLMFlags.hasImageInput,
              LLMFlags.hasFirstSystemPrompt,
              LLMFlags.hasStreaming,
              LLMFlags.claudeThinking,
              LLMFlags.claudeAdaptiveThinking,
            ],
            parameters: [...ClaudeParameters, "thinking_tokens"],
            tokenizer: LLMTokenizer.Claude,
            recommended: true,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error fetching Anthropic models", error);
  }

  try {
    if (DBState.db.openAIKey) {
      const res = await fetchNative(`https://api.openai.com/v1/models`, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + DBState.db.openAIKey,
        },
      });
      const json = await res.json();
      console.log(json);
      if (!json.data) {
        throw "Invaild Openai Model Response";
      }
      let i = 0;
      for (const model of json.data) {
        const exists = LLMModels.find(
          (m) => m.id === model.id || m.internalID === model.id,
        );

        if (exists) {
          continue;
        }

        if (!model.id.startsWith("gpt-")) {
          continue;
        }
        i++;

        const a: LLMModel = {
          id: model.id,
          internalID: model.id,
          name: model.id,
          shortName: model.id,
          fullName: model.id,
          provider: LLMProvider.OpenAI,
          format: LLMFormat.OpenAICompatible,
          flags: [
            LLMFlags.hasStreaming,
            LLMFlags.OAICompletionTokens,
            LLMFlags.hasFullSystemPrompt,
            LLMFlags.hasImageInput,
            LLMFlags.DeveloperRole,
          ],
          parameters: GPT5XHighParameters,
          tokenizer: LLMTokenizer.tiktokenO200Base,
          recommended: i < 8,
        };

        LLMModels.push(a, {
          ...a,
          format: LLMFormat.OpenAIResponseAPI,
          flags: [...a.flags, LLMFlags.hasPrefill],
          id: `${a.id}-response-api`,
          name: `${a.name} (Response API)`,
          fullName: `${a.fullName ?? a.name} (Response API)`,
          recommended: false,
        });
      }
    }
  } catch (error) {}
}

globalThis.registerModelDynamic = registerModelDynamic;

export function getModelInfo(id?: string | null): LLMModel {
  return getBrowserRuntime().getModelInfo(id);
}

interface GetModelListGroup {
  providerName: string;
  models: LLMModel[];
}

export function getModelList<T extends boolean>(
  arg: {
    recommendedOnly?: boolean;
    groupedByProvider?: T;
  } = {},
): T extends true ? GetModelListGroup[] : LLMModel[] {
  let models = LLMModels;
  if (arg.recommendedOnly) {
    models = models.filter((model) => model.recommended);
  }
  const pluginGroup: GetModelListGroup = {
    providerName: "Plugins",
    models: customV3ProviderMetaStore,
  };

  if (arg.groupedByProvider) {
    let group: GetModelListGroup[] = [];
    for (let model of models) {
      if (
        model.provider === LLMProvider.AsIs ||
        model.provider === LLMProvider.NanoGPT
      ) {
        group.push({
          providerName: "@as-is",
          models: [model],
        });
        continue;
      }

      let providerName = ProviderNames.get(model.provider) || "Unknown";
      let groupIndex = group.findIndex((g) => g.providerName === providerName);
      if (groupIndex === -1) {
        group.push({
          providerName,
          models: [model],
        });
      } else {
        group[groupIndex].models.push(model);
      }
    }

    if (pluginGroup.models.length > 0) {
      group.push(pluginGroup);
    }
    return group as any;
  } else {
    for (const model of pluginGroup.models) {
      models.push(model);
    }
  }

  return models as any;
}

import { LLMModels } from "./modelCatalog";

export { LLMModels } from "./modelCatalog";

import { createModelRuntime } from "./modelRuntime";

let browserRuntime: ReturnType<typeof createModelRuntime>;

function getBrowserRuntime() {
  return (browserRuntime ??= createModelRuntime({
    getDatabase,
    LLMProvider,
    LLMFormat,
    OpenAIParameters,
    LLMTokenizer,
    LLMModels,
    get customV3ProviderMetaStore() {
      return customV3ProviderMetaStore;
    },
    safeStructuredClone: (value) => safeStructuredClone(value),
  }));
}
