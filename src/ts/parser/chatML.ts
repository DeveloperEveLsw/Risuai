import { risuChatParser } from "./parser.svelte";

export function parseChatML(data: string): OpenAIChat[] | null {
  return getBrowserRuntime().parseChatML(data);
}
import { createChatMLRuntime } from "./chatMLRuntime";
let browserRuntime: ReturnType<typeof createChatMLRuntime>;
function getBrowserRuntime() {
  return (browserRuntime ??= createChatMLRuntime({
    risuChatParser,
  }));
}
