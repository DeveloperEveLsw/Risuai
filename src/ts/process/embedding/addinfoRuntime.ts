import type {
  getDatabase,
  Chat,
  character,
} from "src/ts/storage/database.svelte";
import type { HypaProcesser } from "../memory/hypamemory";
import type { getUserName } from "src/ts/util";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface AddinfoRuntimeHost {
  HypaProcesser: (typeof import("../memory/hypamemory"))["HypaProcesser"];
  getDatabase: (typeof import("src/ts/storage/database.svelte"))["getDatabase"];
  getUserName: (typeof import("src/ts/util"))["getUserName"];
}
export function createAddinfoRuntime(host: AddinfoRuntimeHost) {
  async function additionalInformations(char: character, chats: Chat) {
    const processer = new host.HypaProcesser();
    const db = host.getDatabase();
    const info = char.additionalText;
    if (info) {
      const infos = info.split("\n\n");
      await processer.addText(infos);
      const filteredChat = chats.message
        .slice(0, 4)
        .map((chat) => {
          let name = chat.saying ?? "";
          if (!name) {
            if (chat.role === "user") {
              name = host.getUserName();
            } else {
              name = char.name;
            }
          }
          return `${name}: ${chat.data}`;
        })
        .join("\n\n");
      const searched = await processer.similaritySearch(filteredChat);
      const result = searched.slice(0, 3).join("\n\n");
      return result;
    }
    return "";
  }
  return { additionalInformations };
}
