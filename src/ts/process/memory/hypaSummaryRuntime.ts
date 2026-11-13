import type { getDatabase } from "../../storage/database.svelte";
import type { parseChatML } from "../../parser/chatML";
import type { requestChatData } from "../request/request";
import type { chatCompletion } from "../webllm";
import type { OpenAIChat } from "../index.svelte";
import type { HypaV3Preset } from "./hypav3";

/** Original summary algorithm; the host supplies state, providers and local-model capability. */
export interface HypaSummaryRuntimeHost {
  getDatabase: typeof getDatabase;
  parseChatML: typeof parseChatML;
  requestChatData: typeof requestChatData;
  chatCompletion: typeof chatCompletion;
  inlayTokenRegex: RegExp;
  logPrefix: string;
}
export function createHypaSummaryRuntime(host: HypaSummaryRuntimeHost) {
  const {
    getDatabase,
    parseChatML,
    requestChatData,
    chatCompletion,
    inlayTokenRegex,
    logPrefix,
  } = host;
  function sanitizeSummaryContent(content: string): string {
    return content.replace(inlayTokenRegex, "[Image]");
  }

  async function summarize(
    oaiMessages: OpenAIChat[],
    isResummarize: boolean = false,
  ): Promise<string> {
    const db = getDatabase();
    const settings = getCurrentHypaV3Preset().settings;

    const strMessages = oaiMessages
      .map((chat) => `${chat.role}: ${sanitizeSummaryContent(chat.content)}`)
      .join("\n");

    const summarizationPrompt = isResummarize
      ? settings.reSummarizationPrompt.trim() === ""
        ? "Re-summarize this summaries."
        : settings.reSummarizationPrompt
      : settings.summarizationPrompt.trim() === ""
        ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]"
        : settings.summarizationPrompt;

    const formated: OpenAIChat[] = parseChatML(
      summarizationPrompt.replaceAll("{{slot}}", strMessages),
    ) ?? [
      {
        role: "user",
        content: strMessages,
      },
      {
        role: "system",
        content: summarizationPrompt,
      },
    ];

    // API
    if (settings.summarizationModel === "subModel") {
      console.log(
        logPrefix,
        `Using ax model ${db.subModel} for summarization.`,
      );

      const response = await requestChatData(
        {
          formated,
          bias: {},
          useStreaming: false,
          noMultiGen: true,
        },
        "memory",
      );

      if (response.type === "streaming" || response.type === "multiline") {
        throw new Error("Unexpected response type");
      }

      if (response.type === "fail") {
        throw new Error(response.result);
      }

      if (!response.result || response.result.trim().length === 0) {
        throw new Error("Empty summary returned");
      }

      // Remove thoughts content for API
      const thoughtsRegex = /<Thoughts>[\s\S]*?<\/Thoughts>/g;
      const result = response.result.replace(thoughtsRegex, "").trim();

      if (result.length === 0) {
        throw new Error("Empty summary after removing thoughts content");
      }

      return result;
    }

    // Local — ensure system message comes first for WebLLM models
    const firstSystemIndex = formated.findIndex((m) => m.role === "system");
    if (firstSystemIndex > 0) {
      const [system] = formated.splice(firstSystemIndex, 1);
      formated.unshift(system);
    }

    const content = await chatCompletion(
      formated,
      settings.summarizationModel,
      {
        max_tokens: 8192,
        temperature: 0,
        extra_body: {
          enable_thinking: false,
        },
      },
    );

    if (!content || content.trim().length === 0) {
      throw new Error("Empty summary returned");
    }

    // Remove think content
    const thinkRegex = /<think>[\s\S]*?<\/think>/g;
    const result = content.replace(thinkRegex, "").trim();

    if (result.length === 0) {
      throw new Error("Empty summary after removing think content");
    }

    return result;
  }

  function getCurrentHypaV3Preset(): HypaV3Preset {
    const db = getDatabase();
    const preset = db.hypaV3Presets?.[db.hypaV3PresetId];

    if (!preset) {
      throw new Error("Preset not found. Please select a valid preset.");
    }

    return preset;
  }

  return { summarize, getCurrentHypaV3Preset };
}
