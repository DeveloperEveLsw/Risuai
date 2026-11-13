let browserRuntime: ReturnType<typeof createModelStringRuntime>;
import { getDatabase } from "src/ts/storage/database.svelte";

export function getGenerationModelString(name?: string) {
  return getBrowserRuntime().getGenerationModelString(name);
}
import { createModelStringRuntime } from "./modelStringRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createModelStringRuntime({
    get getDatabase() {
      return getDatabase;
    },
  }));
}
