import { getDatabase } from "../../storage/database.svelte";
import { tokenize } from "../../tokenizer";
import { requestChatData } from "../request/request";
import { HypaProcesser } from "./hypamemory";
import { stringlizeChat } from "../stringlize";
import { globalFetch } from "src/ts/globalApi.svelte";
import { runSummarizer } from "../transformers";
import { parseChatML } from "src/ts/parser/chatML";
import { getUserName } from "src/ts/util";
import { createSupaMemoryRuntime } from "./supaMemoryRuntime";
let runtime: ReturnType<typeof createSupaMemoryRuntime>;
const getRuntime = () =>
  (runtime ??= createSupaMemoryRuntime({
    getDatabase,
    tokenize,
    requestChatData,
    HypaProcesser,
    stringlizeChat,
    globalFetch,
    runSummarizer,
    parseChatML,
    getUserName,
    safeStructuredClone,
  }));
export function supaMemory(
  ...args: Parameters<ReturnType<typeof createSupaMemoryRuntime>["supaMemory"]>
) {
  return getRuntime().supaMemory(...args);
}
