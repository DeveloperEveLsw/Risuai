import type { memoryVector, HypaProcesser, similarity } from "./hypamemory";
import type { isContextModel, getContextProvider } from "./contextualEmbedding";
import type { TaskRateLimiter } from "./taskRateLimiter";
import type {
  EmbeddingText,
  EmbeddingResult,
  HypaProcessorV2,
} from "./hypamemoryv2";
import type { DisplayMode as ModalDisplayMode } from "src/lib/Others/HypaV3Modal/types";
import type { parseChatML } from "src/ts/parser/chatML";
import type {
  Chat,
  character,
  groupChat,
  getDatabase,
} from "src/ts/storage/database.svelte";
import type { OpenAIChat } from "../index.svelte";
import type { requestChatData } from "../request/request";
import type { chatCompletion, unloadEngine } from "../webllm";
import type { hypaV3ProgressStore } from "src/ts/stores.svelte";
import type { ChatTokenizer } from "src/ts/tokenizer";
import type { inlayTokenRegex } from "src/ts/util/inlayTokens";
import type {
  HypaV3Preset,
  HypaV3Settings,
  SerializableHypaV3Data,
  SerializableSummary,
  HypaV3Result,
} from "./hypav3";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface HypaPresetRuntimeHost {}
export function createHypaPresetRuntime(host: HypaPresetRuntimeHost) {
  function createHypaV3Preset(
    name = "New Preset",
    existingSettings = {},
  ): HypaV3Preset {
    const settings: HypaV3Settings = {
      summarizationModel: "subModel",
      summarizationPrompt: "",
      reSummarizationPrompt: "",
      memoryTokensRatio: 0.2,
      extraSummarizationRatio: 0,
      maxChatsPerSummary: 6,
      recentMemoryRatio: 0.4,
      similarMemoryRatio: 0.4,
      enableSimilarityCorrection: false,
      preserveOrphanedMemory: false,
      processRegexScript: false,
      doNotSummarizeUserMessage: false,
      summaryChunkSeparator: "\\n\\n",
      // Experimental
      useExperimentalImpl: false,
      summarizationRequestsPerMinute: 20,
      summarizationMaxConcurrent: 1,
      embeddingRequestsPerMinute: 100,
      embeddingMaxConcurrent: 1,
      alwaysToggleOn: false,
      queryChatCount: 3,
    };
    if (
      existingSettings &&
      typeof existingSettings === "object" &&
      !Array.isArray(existingSettings)
    ) {
      for (const [key, value] of Object.entries(existingSettings)) {
        if (key in settings && typeof value === typeof settings[key]) {
          settings[key] = value;
        }
      }
    }
    return {
      name,
      settings,
    };
  }
  return { createHypaV3Preset };
}
