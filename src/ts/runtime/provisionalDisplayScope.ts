import type { Message } from "../storage/database.svelte";
import type { DisplayCapture } from "./displayEffects";
import { pinDisplayValue } from "./displayWorkerExecutor";
import { freezeDisplayJson } from "./displayScopeIdentity";
import { noteDisplayProvisionalRead } from "./displayReadDependencies";

type Prepared = {
  rows: Message[];
  window: DisplayCapture["historyWindow"];
  count: number;
  messages: Message[];
  extendedWindow: DisplayCapture["historyWindow"];
};
const prepared = new WeakMap<readonly Message[], Prepared>();

/** Extend a fresh private cache fork with controller-owned presentation rows.
 * Canonical ordinals/gaps stay intact; preview effects can never be admitted.
 */
export function provisionalDisplayScope(
  base: DisplayCapture,
  supplied: readonly Message[],
  sourceId: string,
): DisplayCapture {
  if (!base.history || !base.historyWindow)
    throw Error("Provisional display requires canonical history metadata");
  const canonical = base.chat.message;
  const confirmed = new Set(canonical.map((row) => row.chatId));
  const ids = new Set<string>();
  const rows = supplied.filter((row) => {
    if (!row.chatId || confirmed.has(row.chatId) || ids.has(row.chatId))
      return false;
    ids.add(row.chatId);
    return true;
  });
  const sourceIndex = rows.findIndex((row) => row.chatId === sourceId);
  if (sourceIndex < 0)
    throw Error("Provisional display requires its owned message source");
  const previous = prepared.get(canonical);
  const pinned = pinDisplayValue(rows, previous?.rows);
  freezeDisplayJson(pinned);
  const count = base.history.count;
  if (!Number.isSafeInteger(count + pinned.length))
    throw Error("Provisional display exceeds its history count limit");
  let value = previous;
  if (
    !value ||
    value.rows !== pinned ||
    value.window !== base.historyWindow ||
    value.count !== count
  ) {
    const messages = [...canonical, ...pinned];
    const extendedWindow = [
      ...base.historyWindow,
      ...pinned.map((row, index) => [row.chatId, count + index] as const),
    ];
    freezeDisplayJson(messages);
    freezeDisplayJson(extendedWindow);
    value = {
      rows: pinned,
      window: base.historyWindow,
      count,
      messages,
      extendedWindow,
    };
    prepared.set(canonical, value);
  }
  // The cache fork owns this shell and its variable maps. Keep its existing
  // shell bindings/aliases; never append to the shared frozen canonical array.
  base.chat.message = value.messages;
  const capture: DisplayCapture = {
    ...base,
    history: {
      ...base.history,
      count: count + pinned.length,
      ordinal: count + sourceIndex,
    },
    historyWindow: value.extendedWindow,
    sourceContent: pinned[sourceIndex].data,
    message: { id: sourceId, revision: 0 },
    persistent: false,
  };
  noteDisplayProvisionalRead(capture);
  return capture;
}
