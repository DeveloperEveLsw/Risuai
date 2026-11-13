/** Start a separate browser task, so a queue of synchronous Lua invocations cannot monopolize one microtask checkpoint. */
export function yieldDisplayTurn(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
