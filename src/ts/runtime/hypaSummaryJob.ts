import type {
  createExecutionContext,
  ExecutionSnapshot,
} from "./executionContext";
import type { createNativeGenerationRuntime } from "./nativeGenerationRuntime";
import type { OpenAIChat } from "../process/index.svelte";

export interface HypaSummaryCommand {
  mode: "single" | "bulk";
  indices: number[];
  expectedChatEpoch: number;
  expectedMemoryRevision: number;
}

/** Capture original modal inputs from the owned execution snapshot, never live UI selection. */
export async function executeHypaSummary(
  context: ReturnType<typeof createExecutionContext>,
  engine: ReturnType<typeof createNativeGenerationRuntime>,
  command: HypaSummaryCommand,
  snapshot: ExecutionSnapshot,
) {
  const indices = command.indices;
  if (
    !Array.isArray(indices) ||
    !indices.length ||
    indices.length > 128 ||
    indices.some(
      (index, i) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        (i > 0 && index <= indices[i - 1]),
    ) ||
    !["single", "bulk"].includes(command.mode) ||
    (command.mode === "single" ? indices.length !== 1 : indices.length < 2)
  )
    context.fail("Invalid memory summary selection");
  if (
    snapshot.chat.entityEpoch !== command.expectedChatEpoch ||
    (snapshot.chat.fieldRevisions?.hypaV3Data ?? 0) !==
      command.expectedMemoryRevision
  )
    context.fail("Memory summary source revision has changed");
  const character = context.getCurrentCharacter();
  if (character.type === "group")
    context.fail("Memory summary requires an explicit character context");
  const chat = context.getCurrentChat();
  const data = chat.hypaV3Data;
  if (
    !data ||
    !Array.isArray(data.summaries) ||
    indices.some((index) => !data.summaries[index])
  )
    context.fail("Selected memory summaries no longer exist");
  const selected = indices.map((index) =>
    structuredClone(data.summaries[index]),
  );
  const chatMemos = [
    ...new Set(selected.flatMap((summary) => summary.chatMemos)),
  ];
  let messages: OpenAIChat[];
  if (command.mode === "bulk") {
    messages = selected.map((summary) => ({
      role: "user",
      content: summary.text,
    }));
  } else {
    const processRegex = engine.memoryPreset().settings.processRegexScript;
    messages = [];
    for (const memo of selected[0].chatMemos) {
      const index =
        memo === null
          ? -1
          : chat.message.findIndex((message) => message.chatId === memo);
      const message =
        memo === null
          ? {
              role: "char" as const,
              data:
                chat.fmIndex === -1
                  ? character.firstMessage
                  : character.alternateGreetings?.[chat.fmIndex],
            }
          : chat.message[index];
      if (!message || typeof message.data !== "string")
        context.fail("Selected memory contains an orphaned message");
      let content = message.data;
      if (processRegex) {
        const parsed = engine.parseMemoryMessage(content, {
          chara: character,
          role: message.role,
        });
        content = (
          await engine.processMemoryMessage(
            character,
            parsed,
            "editprocess",
            index,
            { chatRole: message.role },
          )
        ).data;
      }
      messages.push({
        role: (message.role === "char"
          ? "assistant"
          : message.role) as OpenAIChat["role"],
        content,
      });
    }
  }
  const text = await engine.summarizeMemory(messages, command.mode === "bulk");
  context.ensureHealthy();
  return {
    memoryPreview: {
      text,
      mode: command.mode,
      indices: [...indices],
      chatMemos,
      source: {
        chatEpoch: snapshot.chat.entityEpoch,
        memoryRevision: command.expectedMemoryRevision,
        contentRevision: snapshot.chat.contentRevision,
        characterId: snapshot.character.id,
        characterEpoch: snapshot.character.entityEpoch,
        characterRevision: snapshot.character.revision,
        resources: (snapshot.resources ?? [])
          .filter((row) => row.kind !== "global-variable")
          .map((row) => ({
            kind: row.kind,
            id: row.id,
            epoch: row.entityEpoch,
            revision: row.revision,
          })),
      },
    },
  };
}
