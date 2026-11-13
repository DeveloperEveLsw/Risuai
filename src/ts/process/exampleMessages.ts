let browserRuntime: ReturnType<typeof createExampleMessageRuntime>;
import type { OpenAIChat } from "./index.svelte";

import type { character } from "../storage/database.svelte";

import { risuChatParser } from "./scripts";

export function exampleMessage(
  char: character,
  userName: string,
): OpenAIChat[] {
  return getBrowserRuntime().exampleMessage(char, userName);
}
import { createExampleMessageRuntime } from "./exampleMessageRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createExampleMessageRuntime({
    get risuChatParser() {
      return risuChatParser;
    },
  }));
}
