import { resolveClaudeThinkingType, type LLMFlags } from "../model/types";
import type { Database } from "../storage/database.svelte";
import { settingValues, type SettingChange } from "./settingIntents";

/** User-initiated model changes include their dependent resets in one immutable command. */
export function botSettingValues(
  database: Database,
  changes: readonly SettingChange[],
  flags: (id: string) => LLMFlags[],
) {
  const values = settingValues(database, changes);
  const read = (key: keyof Database): any =>
    values.has(key) ? values.get(key) : database[key];
  const changed = (key: keyof Database) =>
    values.has(key) && values.get(key) !== database[key];
  const subscriptionChanged = changed("nanogptUseSubscriptionEndpoint");
  const clearedKey = changed("nanogptKey") && !read("nanogptKey");
  if (clearedKey) {
    values.set("nanogptUseSubscriptionEndpoint", false);
    values.set("nanogptSubscriptionState", "");
  }
  if (subscriptionChanged || clearedKey) {
    values.set("nanogptRequestModel", "");
    values.set("nanogptRequestModelName", "");
  }
  if (changed("nanogptRequestModel") || subscriptionChanged || clearedKey) {
    values.set("nanogptProvider", "");
    if (!values.has("nanogptRequestModelName"))
      values.set("nanogptRequestModelName", "");
  }
  if (changed("ollamaModel")) {
    values.set("ollamaModelSource", "local");
    if (!values.has("ollamaModelName")) values.set("ollamaModelName", "");
  }
  if (changed("ollamaCloudModel")) {
    values.set("ollamaModelSource", "cloud");
    if (!values.has("ollamaCloudModelName"))
      values.set("ollamaCloudModelName", "");
  }
  if (
    changes.some(
      ({ path }) =>
        (path[0] === "google" && path[1] === "projectId") ||
        path[0] === "vertexRegion" ||
        path[0] === "vertexClientEmail" ||
        path[0] === "vertexPrivateKey",
    )
  ) {
    values.set("vertexAccessToken", "");
    values.set("vertexAccessTokenExpires", 0);
  }
  if (
    (changed("aiModel") ||
      changed("subModel") ||
      changed("textgenWebUIStreamURL")) &&
    (read("aiModel") === "textgen_webui" || read("subModel") === "mancer")
  )
    values.set(
      "useStreaming",
      String(read("textgenWebUIStreamURL") ?? "").startsWith("wss://"),
    );
  if (changed("aiModel") || changed("thinkingType")) {
    const current = read("thinkingType") as Database["thinkingType"];
    const resolved = resolveClaudeThinkingType(flags(read("aiModel")), current);
    if (resolved !== current) values.set("thinkingType", resolved);
  }
  return values;
}
