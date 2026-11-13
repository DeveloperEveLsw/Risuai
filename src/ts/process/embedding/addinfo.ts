let browserRuntime: ReturnType<typeof createAddinfoRuntime>;
import {
  getDatabase,
  type Chat,
  type character,
} from "src/ts/storage/database.svelte";

import { HypaProcesser } from "../memory/hypamemory";

import { getUserName } from "src/ts/util";

export async function additionalInformations(char: character, chats: Chat) {
  return getBrowserRuntime().additionalInformations(char, chats);
}
import { createAddinfoRuntime } from "./addinfoRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createAddinfoRuntime({
    get HypaProcesser(): typeof HypaProcesser {
      return HypaProcesser;
    },
    get getDatabase(): typeof getDatabase {
      return getDatabase;
    },
    get getUserName(): typeof getUserName {
      return getUserName;
    },
  }));
}
