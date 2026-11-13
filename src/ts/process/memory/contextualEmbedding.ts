import { globalFetch } from "../../globalApi.svelte";
import { getDatabase } from "../../storage/database.svelte";
import { contextHash, type VectorArray } from "./hypamemory";
import { createContextualEmbeddingRuntime } from "./contextualEmbeddingRuntime";
export interface ContextualEmbeddingProvider {
  readonly modelId: string;
  embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]>;
  embedQueries(queries: string[]): Promise<VectorArray[]>;
  getCacheKeySuffix(contextTexts?: string[]): string;
}
let runtime: ReturnType<typeof createContextualEmbeddingRuntime>;
function getBrowserRuntime() {
  return (runtime ??= createContextualEmbeddingRuntime({
    globalFetch,
    getDatabase,
    contextHash,
  }));
}
export function isContextModel(model: string): boolean {
  return getBrowserRuntime().isContextModel(model);
}
export function getContextProvider(
  model: string,
): ContextualEmbeddingProvider | null {
  return getBrowserRuntime().getContextProvider(model);
}
