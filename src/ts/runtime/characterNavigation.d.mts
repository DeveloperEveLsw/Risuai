import type { Json } from "./clientProtocol";
import type { FieldValue } from "./fieldCommands";
export type CharacterNavigationItem = {
  kind: "character" | "folder";
  id: string;
};
export type CharacterNavigationAction =
  | {
      type: "move";
      source: CharacterNavigationItem;
      destination: {
        folderId: string | null;
        before: CharacterNavigationItem | null;
      };
    }
  | {
      type: "group";
      sourceId: string;
      target: CharacterNavigationItem;
      folder?: { id: string; name: string; color: string };
    }
  | {
      type: "edit-folder";
      folderId: string;
      updates: {
        name?: string;
        color?: string;
        img?: string;
        imgFile?: string | null;
      };
    };
export type CharacterNavigationHeader = {
  revision: number;
  cursor: number;
  order: FieldValue | null;
};
export type CharacterNavigationTarget = {
  expectedNavigationRevision: number;
  expectedOrderRevision: number;
  expectedSettingsEpoch: number;
};
export class CharacterNavigationError extends Error {}
export function removeCharacterOrderReferences(
  raw: unknown,
  characterId: string,
): unknown;
export function applyCharacterNavigation(
  raw: Json[],
  action: CharacterNavigationAction,
  visibleIds: Iterable<string>,
): Json[];
export function projectCharacterOrder(
  raw: unknown,
  visibleIds: Iterable<string>,
): import("../storage/database.svelte").Database["characterOrder"];
