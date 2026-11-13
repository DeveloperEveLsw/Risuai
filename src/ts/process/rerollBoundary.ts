import type { Message } from "../storage/database.svelte";

/** The first reroll's upstream speaker quota, before its local variant cache. */
export function rerollBoundary(
  messages: readonly Pick<Message, "role" | "saying">[],
): number {
  if (!messages.length) throw new Error("There is no reply to reroll");
  const saying = messages.at(-1).saying;
  let sayingQuota = 2;
  let index = messages.length - 1;
  while (messages[index].role !== "user") {
    if (messages[index].saying === saying) {
      sayingQuota--;
      if (sayingQuota === 0) break;
    }
    index--;
    // Upstream also fails after exhausting a history without a user/previous
    // speaker boundary. Fail explicitly before contacting the provider.
    if (index < 0)
      throw new Error("Reroll has no earlier user or speaker boundary");
  }
  return index + 1;
}
