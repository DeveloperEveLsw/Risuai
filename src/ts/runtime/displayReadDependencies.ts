import type { DisplayCapture } from "./displayEffects";
import type { RuntimeCommand } from "./clientProtocol";
import { commandJson } from "./clientProtocol";
import { variableIdentity, type VariableTarget } from "./variableCommands";
import { displayScopeJson } from "./displayScopeIdentity";
import { DisplayWireBudget } from "./displayWireBudget";

export type DisplayRead = VariableTarget & { expectedRevision: number };
export type DisplayMessageEdit = {
  messageId: string;
  expectedRevision: number;
  text: string;
};
export type DisplayReadAdmission = {
  reads: readonly DisplayRead[];
  messageEdits?: readonly DisplayMessageEdit[];
  provisional?: boolean;
  unsupported?: string;
};
type Ledger = {
  reads: Map<string, DisplayRead>;
  messageEdit?: DisplayMessageEdit;
  provisional: boolean;
  unsupported?: string;
};
// Per-owner metadata is never part of DBState, the worker wire or the cache key.
const ledgers = new WeakMap<DisplayCapture, Ledger>();
function ledger(capture: DisplayCapture): Ledger {
  let value = ledgers.get(capture);
  if (!value) {
    value = { reads: new Map(), provisional: false };
    ledgers.set(capture, value);
  }
  return value;
}
export function recordDisplayRead(
  capture: DisplayCapture,
  target: VariableTarget,
) {
  const value = ledger(capture);
  const key = variableIdentity(target);
  if (value.reads.has(key)) return;
  if (value.reads.size >= 128) {
    value.unsupported ??= "Display script reads more than 128 variables";
    return;
  }
  const revisions =
    target.scope === "chat"
      ? capture.versions?.chat
      : target.scope === "chat-global"
        ? capture.versions?.localGlobal
        : capture.versions?.global;
  value.reads.set(key, {
    ...target,
    expectedRevision: revisions?.get(target.key) ?? 0,
  });
}
export function noteDisplayProvisionalRead(capture: DisplayCapture) {
  ledger(capture).provisional = true;
}
export function noteDisplayVariableEnumeration(capture: DisplayCapture) {
  ledger(capture).unsupported ??=
    "Display variable enumeration requires collection revision admission";
}
export function recordDisplayMessageWrite(
  capture: DisplayCapture,
  messageId: string,
  text: unknown,
) {
  if (
    !capture.message ||
    capture.message.id !== messageId ||
    typeof text !== "string"
  )
    throw Error(
      "Display message write requires its own captured stable source",
    );
  ledger(capture).messageEdit = {
    messageId,
    expectedRevision: capture.message.revision,
    text,
  };
}
export function inheritDisplayReads(
  parent: DisplayCapture,
  child: DisplayCapture,
) {
  const value = ledgers.get(parent);
  if (value) ledgers.set(child, { ...value, reads: new Map(value.reads) });
}
export function displayMessageText(capture: DisplayCapture, messageId: string) {
  const edit = ledgers.get(capture)?.messageEdit;
  return edit?.messageId === messageId ? edit.text : undefined;
}
export function displayReadAdmission(
  capture: DisplayCapture,
): DisplayReadAdmission {
  const value = ledgers.get(capture);
  return {
    reads: value ? [...value.reads.values()].map((read) => ({ ...read })) : [],
    provisional: value?.provisional,
    unsupported: value?.unsupported,
    ...(value?.messageEdit ? { messageEdits: [{ ...value.messageEdit }] } : {}),
  };
}
/** Retain an existing UI owner only when its inputs and admission still match.
 * Delivery progress is not an original scripting input: a freshly fenced scope
 * can advance its projected cursor while every value/version remains equal.
 * Execution keys, cache preparation and durable admission keep that cursor.
 * An equal confirmed overlay may disappear without starting stateful Lua again.
 */
export function displayPresentationIdentity(
  capture: DisplayCapture,
  budget = new DisplayWireBudget(undefined, 0, 0),
) {
  const overlays = (capture.presentationVariables ?? []).filter(
    ([id, value]) => {
      const [scope, chatId, key] = JSON.parse(id);
      const variables =
        scope === "global"
          ? capture.database.globalChatVariables
          : chatId === capture.state.chatId && scope === "chat-global"
            ? capture.chat.GLGlobalVariables
            : chatId === capture.state.chatId && scope === "chat"
              ? capture.chat.scriptstate
              : undefined;
      // Keep differing overlays even before the later CSS/regex pass reads them.
      return (
        !variables ||
        value.exists !== Object.hasOwn(variables, key) ||
        (value.exists && !Object.is(value.value, variables[key]))
      );
    },
  );
  const admission = displayReadAdmission(capture);
  const identity = {
    scope: displayScopeJson({ ...capture, projectedCursor: undefined }, budget),
    overlays: overlays.map(([id, value]) => [
      id,
      value.exists,
      Object.hasOwn(value, "value"),
      value.value ?? null,
    ]),
    admission: {
      reads: admission.reads,
      messageEdits: admission.messageEdits ?? [],
      provisional: Boolean(admission.provisional),
      unsupported: admission.unsupported ?? null,
    },
  };
  budget.measure(identity);
  return commandJson(identity);
}
export function mergeDisplayReads(
  command: RuntimeCommand,
  admission?: DisplayReadAdmission,
): RuntimeCommand {
  if (admission?.unsupported) throw Error(admission.unsupported);
  const reads = new Map<string, DisplayRead>();
  for (const read of [
    ...((command.reads as unknown as DisplayRead[]) ?? []),
    ...(admission?.reads ?? []),
  ]) {
    const key = variableIdentity(read),
      previous = reads.get(key);
    if (previous && previous.expectedRevision !== read.expectedRevision)
      throw Error("Display read versions differ within one presentation");
    reads.set(key, { ...read });
  }
  if (reads.size > 128)
    throw Error("Display script reads more than 128 variables");
  const ordered = [...reads.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, read]) => read);
  const merged = { ...command, reads: ordered } as RuntimeCommand;
  if (admission?.messageEdits?.length)
    merged.messageEdits = admission.messageEdits.map((edit) => ({ ...edit }));
  if (
    new TextEncoder().encode(
      commandJson({
        reads: merged.reads,
        edits: merged.edits,
        ...(merged.messageEdits ? { messageEdits: merged.messageEdits } : {}),
      }),
    ).length >
    256 * 1024
  )
    throw Error("Display effect exceeds 256 KiB");
  return merged;
}
