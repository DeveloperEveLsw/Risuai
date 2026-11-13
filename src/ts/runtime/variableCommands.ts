import type { RuntimeCommand } from "./clientProtocol";

export type VariableScalar = string | number | boolean | null;
export type VariableTarget =
  | { scope: "global"; key: string }
  | { scope: "chat" | "chat-global"; chatId: string; key: string };
export type VariableEdit = VariableTarget & { expectedRevision: number } & (
    | { value: VariableScalar; remove?: false }
    | { remove: true; value?: never }
  );
export type VariableValue = VariableTarget & {
  revision: number;
  exists: boolean;
  value?: VariableScalar;
};
export function variableIdentity(target: VariableTarget) {
  return JSON.stringify([
    target.scope,
    "chatId" in target ? target.chatId : null,
    target.key,
  ]);
}
export function variableEdits(command: RuntimeCommand): VariableEdit[] {
  return command.type === "change-variables" && Array.isArray(command.edits)
    ? (command.edits as unknown as VariableEdit[])
    : [];
}
