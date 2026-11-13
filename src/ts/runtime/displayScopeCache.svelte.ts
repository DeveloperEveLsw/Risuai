import { untrack } from "svelte";
import type { DisplayCapture, DisplayScopeHeader } from "./displayEffects";
import { pinDisplayCapture, pinDisplayValue } from "./displayWorkerExecutor";
import { bindDisplayShell, freezeDisplayJson } from "./displayScopeIdentity";
function sameScope(base: DisplayCapture, fresh: DisplayScopeHeader) {
  return (
    base.serverId === fresh.serverId &&
    base.state.chatId === fresh.state.chatId &&
    base.state.characterId === fresh.state.characterId &&
    base.state.chatEpoch === fresh.state.chatEpoch &&
    base.state.characterEpoch === fresh.state.characterEpoch &&
    base.state.inputClock === fresh.state.inputClock &&
    base.projectedCursor === fresh.projectedCursor &&
    base.history?.cursor === fresh.history?.cursor &&
    base.history?.count === fresh.history?.count &&
    base.hasEarlier === fresh.hasEarlier
  );
}

/** Private mutable fields for the owner; the worker normalizes all JSON privately.
 * Shared history/definitions remain frozen, rather than becoming a second DBState.
 */
export function forkDisplayScope(
  base: DisplayCapture,
  fresh: DisplayScopeHeader,
  environment: DisplayCapture["cbsEnvironment"],
): DisplayCapture {
  const chat = {
    ...base.chat,
    scriptstate: { ...base.chat.scriptstate },
    GLGlobalVariables: { ...base.chat.GLGlobalVariables },
  };
  const character = {
    ...base.character,
    chats: [chat],
    triggerscript:
      base.character.type === "group"
        ? []
        : base.character.triggerscript.map((trigger) => ({ ...trigger })),
  };
  const database = {
    ...base.database,
    characters: [character],
    globalChatVariables: { ...base.database.globalChatVariables },
  };
  bindDisplayShell(chat, base.chat);
  bindDisplayShell(character, base.character);
  bindDisplayShell(database, base.database);
  return {
    ...base,
    projectedCursor: fresh.projectedCursor,
    state: { ...fresh.state, applied: [...fresh.state.applied] },
    database,
    character,
    chat,
    cbsEnvironment: pinDisplayValue(environment),
    versions: {
      chat: new Map(fresh.versions.chat),
      localGlobal: new Map(fresh.versions.localGlobal),
      global: new Map(fresh.versions.global),
    },
    sourceContent: fresh.sourceContent,
    history: fresh.history && { ...fresh.history },
    historyWindow: base.historyWindow,
    message: fresh.message && {
      ...fresh.message,
      origin: fresh.message.origin && { ...fresh.message.origin },
    },
    hasEarlier: fresh.hasEarlier,
    persistent: fresh.persistent,
  };
}

/** One lazy Svelte-derived body, with deep source reads and explicit plain-state
 * invalidation. Headers and revision maps are captured anew for every invocation.
 */
export function createDisplayScopeCache(
  build: (fresh?: DisplayCapture) => DisplayCapture | undefined,
  invalidate: () => void,
) {
  let active = $state(true);
  let refresh = $state(0);
  let preparations = 0;
  let previous: DisplayCapture | undefined;
  let fallback: { derived: DisplayCapture; pinned: DisplayCapture };
  function prepare(raw: DisplayCapture) {
    const pinned = pinDisplayCapture(raw, previous);
    freezeDisplayJson(pinned);
    previous = pinned;
    preparations++;
    return pinned;
  }
  const body = $derived.by(() => {
    if (!active) return undefined;
    invalidate();
    refresh;
    const raw = build();
    if (!raw) return undefined;
    return prepare(raw);
  });
  return {
    capture(
      fresh: DisplayScopeHeader,
      environment: DisplayCapture["cbsEnvironment"],
      readBody?: () => DisplayCapture | undefined,
    ) {
      if (!active) return undefined;
      const current = body;
      let pinned =
        fallback && fallback.derived === current ? fallback.pinned : current;
      if (fallback?.derived !== current) fallback = undefined;
      // Guard plain metadata even if a caller failed to notify its revision.
      // This is a rebuild, never a cursor-only assumption that values match.
      if (!pinned || !sameScope(pinned, fresh)) {
        untrack(() => refresh++);
        pinned = body;
        if (!pinned || !sameScope(pinned, fresh)) {
          // The lazy derived value can remain on the current Svelte evaluation
          // version. Pin the already fenced fresh body; never retag an old one.
          // The UI supplies only a fresh header for ordinary cached rows. Read
          // its full projected body only when this guarded fallback needs it.
          const full = readBody ? readBody() : (fresh as DisplayCapture);
          const raw = full && build(full);
          if (raw && sameScope(raw, fresh)) {
            pinned = prepare(raw);
            fallback = { derived: body, pinned };
          }
        }
      }
      if (!pinned || !sameScope(pinned, fresh))
        throw new Error("Display scope changed while preparing its snapshot");
      return forkDisplayScope(pinned, fresh, environment);
    },
    close() {
      active = false;
      fallback = undefined;
      previous = undefined;
      void body; // Release the retained body immediately, without a next render.
    },
    diagnostics() {
      return { active, preparations };
    },
  };
}
