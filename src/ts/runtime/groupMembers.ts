import type { Json, RuntimeCommand } from "./clientProtocol";
export interface GroupMemberHeader {
  memberId: string;
  revision: number;
  slots: { position: number; talkness?: Json; active?: Json }[];
}
export interface GroupTarget {
  groupId: string;
  expectedEpoch: number;
  expectedOrderRevision: number;
  chatId?: string;
  expectedChatEpoch?: number;
  expectedChatRevision?: number;
}
export interface GroupMemberTarget extends GroupTarget {
  memberId: string;
  expectedMemberRevision: number;
  position: number;
}
export type GroupAction = "add" | "remove" | "set-active" | "set-talkness";
export interface GroupView {
  characters: string[];
  characterTalks: number[];
  characterActive: boolean[];
}
export function groupCommands(command: RuntimeCommand) {
  return command.type === "change-group-member";
}
export function projectGroup(
  view: GroupView,
  commands: RuntimeCommand[],
  target: GroupTarget,
): GroupView {
  const result = {
    characters: [...view.characters],
    characterTalks: [...view.characterTalks],
    characterActive: [...view.characterActive],
  };
  for (const command of commands) {
    if (
      !groupCommands(command) ||
      command.groupId !== target.groupId ||
      command.expectedEpoch !== target.expectedEpoch ||
      command.expectedOrderRevision !== target.expectedOrderRevision
    )
      continue;
    const memberId = String(command.memberId);
    if (command.action === "add") {
      if (result.characters.includes(memberId)) continue;
      result.characters.push(memberId);
      result.characterTalks.push((1 / 6) * 4);
      result.characterActive.push(true);
    } else {
      const position = Number(command.position);
      if (result.characters[position] !== memberId) continue;
      if (command.action === "remove") {
        result.characters.splice(position, 1);
        result.characterTalks.splice(position, 1);
        result.characterActive.splice(position, 1);
      } else if (command.action === "set-active")
        result.characterActive[position] = Boolean(command.value);
      else if (command.action === "set-talkness")
        result.characterTalks[position] = Number(command.value);
    }
  }
  return result;
}
