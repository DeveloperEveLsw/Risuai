import type { loreBook } from "../storage/database.svelte";

/** Original lore controls read and mutate one captured owner's private drafts. */
export interface LoreEditorContext {
  characterLore: () => loreBook[];
  chatLore: () => loreBook[];
  setChatLore: (value: loreBook[]) => void;
  isCharacterLore: boolean;
  captureRemoval: () => () => void;
}
