import { getChatVar, getGlobalChatVar } from "../parser/chatVar.svelte";
import { createExpressionEvaluator } from "./expressionRuntime";

let evaluator: ReturnType<typeof createExpressionEvaluator>;

export function calcString(text: string) {
  evaluator ??= createExpressionEvaluator({ getChatVar, getGlobalChatVar });
  return evaluator(text);
}
