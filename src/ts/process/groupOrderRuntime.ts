import type { character, groupChat } from "../storage/database.svelte";

export type GroupOrder = {
  id: string;
  talkness: number;
  index: number;
};

/** Original upstream speaker selection, shared by browser and native jobs. */
export interface GroupOrderRuntimeHost {
  findCharacterbyId: (id: string) => character | groupChat;
  shuffle: <T>(values: T[]) => T[];
}
export function createGroupOrderRuntime(host: GroupOrderRuntimeHost) {
  function groupOrder(chars: GroupOrder[], input: string): GroupOrder[] {
    let order: GroupOrder[] = [];
    let ids: string[] = [];
    if (input) {
      const words = getWords(input);

      for (const word of words) {
        for (let char of chars) {
          const charNameChunks = getWords(host.findCharacterbyId(char.id).name);

          if (charNameChunks.includes(word)) {
            order.push(char);
            ids.push(char.id);
            break;
          }
        }
      }
    }

    const shuffled = host.shuffle(chars);
    for (const char of shuffled) {
      if (ids.includes(char.id)) {
        continue;
      }

      const chance = char.talkness ?? 0.5;

      if (chance >= Math.random()) {
        order.push(char);
        ids.push(char.id);
      }
    }

    while (order.length === 0) {
      order.push(chars[Math.floor(Math.random() * chars.length)]);
    }

    return order;
  }

  function getWords(data: string) {
    const matches = data.split(/\n| /g);
    let words: string[] = [];
    if (!matches) {
      return [data];
    }
    for (const match of matches) {
      words.push(match.toLocaleLowerCase());
    }
    return words;
  }
  return { groupOrder };
}
