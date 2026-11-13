import { getDatabase } from "../storage/database.svelte";
import { getUserName } from "../util";
import { createStringlizeRuntime } from "./stringlizeRuntime";
let runtime: ReturnType<typeof createStringlizeRuntime>;
const getRuntime = () =>
  (runtime ??= createStringlizeRuntime({ getDatabase, getUserName }));
export function multiChatReplacer(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["multiChatReplacer"]
  >
) {
  return getRuntime().multiChatReplacer(...args);
}
export function stringlizeChat(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["stringlizeChat"]
  >
) {
  return getRuntime().stringlizeChat(...args);
}
export function stringlizeChatOba(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["stringlizeChatOba"]
  >
) {
  return getRuntime().stringlizeChatOba(...args);
}
export function getStopStrings(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["getStopStrings"]
  >
) {
  return getRuntime().getStopStrings(...args);
}
export function unstringlizeChat(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["unstringlizeChat"]
  >
) {
  return getRuntime().unstringlizeChat(...args);
}
export function getUnstringlizerChunks(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["getUnstringlizerChunks"]
  >
) {
  return getRuntime().getUnstringlizerChunks(...args);
}
export function stringlizeAINChat(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["stringlizeAINChat"]
  >
) {
  return getRuntime().stringlizeAINChat(...args);
}
export function unstringlizeAIN(
  ...args: Parameters<
    ReturnType<typeof createStringlizeRuntime>["unstringlizeAIN"]
  >
) {
  return getRuntime().unstringlizeAIN(...args);
}
