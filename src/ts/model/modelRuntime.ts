import type { LLMModel } from "./types";
/** Actual upstream execution, with job-local state and explicit capabilities. */
export interface ModelRuntimeHost {
  getDatabase: (typeof import("../storage/database.svelte"))["getDatabase"];
  LLMProvider: (typeof import("./types"))["LLMProvider"];
  LLMFormat: (typeof import("./types"))["LLMFormat"];
  OpenAIParameters: (typeof import("./types"))["OpenAIParameters"];
  LLMTokenizer: (typeof import("./types"))["LLMTokenizer"];
  LLMModels: (typeof import("./modelCatalog"))["LLMModels"];
  customV3ProviderMetaStore: (typeof import("../plugins/apiV3/v3.svelte"))["customV3ProviderMetaStore"];
  safeStructuredClone: <T>(value: T) => T;
}
export function createModelRuntime(host: ModelRuntimeHost) {
  function getModelInfo(id?: string | null): LLMModel {
    const db = host.getDatabase();
    if (!id) {
      return {
        id: "",
        name: "Unknown",
        shortName: "Unknown",
        fullName: "Unknown",
        internalID: "",
        provider: host.LLMProvider.AsIs,
        format: host.LLMFormat.OpenAICompatible,
        flags: [],
        parameters: host.OpenAIParameters,
        tokenizer: host.LLMTokenizer.Unknown,
      };
    }
    const found: LLMModel = host.safeStructuredClone(
      host.LLMModels.find((model) => model.id === id),
    );
    if (found) {
      if (db.enableCustomFlags) {
        found.flags = db.customFlags;
      }
      return found;
    }
    if (id.startsWith("hf:::")) {
      const withoutPrefix = id.replace("hf:::", "");
      return {
        id,
        name: withoutPrefix,
        shortName: withoutPrefix,
        fullName: withoutPrefix,
        internalID: withoutPrefix,
        provider: host.LLMProvider.WebLLM,
        format: host.LLMFormat.WebLLM,
        flags: [],
        parameters: host.OpenAIParameters,
        tokenizer: host.LLMTokenizer.Local,
      };
    }
    if (id.startsWith("horde:::")) {
      const withoutPrefix = id.replace("horde:::", "");
      return {
        id,
        name: withoutPrefix,
        shortName: withoutPrefix,
        fullName: withoutPrefix,
        internalID: withoutPrefix,
        provider: host.LLMProvider.Horde,
        format: host.LLMFormat.Horde,
        flags: [],
        parameters: host.OpenAIParameters,
        tokenizer: host.LLMTokenizer.Unknown,
      };
    }
    if (id.startsWith("xcustom:::")) {
      const customModels = db?.customModels || [];
      const found = customModels.find((model) => model.id === id);
      if (found) {
        return {
          id: found.id,
          name: found.name,
          shortName: found.name,
          fullName: found.name,
          internalID: found.internalId,
          provider: host.LLMProvider.AsIs,
          format: found.format,
          flags: found.flags,
          parameters: [
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "repetition_penalty",
            "min_p",
            "top_a",
            "top_k",
            "thinking_tokens",
          ],
          tokenizer: found.tokenizer,
        };
      }
    }
    if (id.startsWith("pluginmodel:::")) {
      const pluginModel = host.customV3ProviderMetaStore.find(
        (model) => model.id === id,
      );
      if (pluginModel) {
        return pluginModel;
      }
    }
    return {
      id,
      name: id,
      shortName: id,
      fullName: id,
      internalID: id,
      provider: host.LLMProvider.AsIs,
      format: host.LLMFormat.OpenAICompatible,
      flags: [],
      parameters: host.OpenAIParameters,
      tokenizer: host.LLMTokenizer.Unknown,
    };
  }
  return { getModelInfo };
}
