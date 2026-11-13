import localforage from "localforage";
import { type HypaModel, localModels } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter, TaskCanceledError } from "./taskRateLimiter";
import { runEmbedding } from "../transformers";
import { globalFetch } from "src/ts/globalApi.svelte";
import { getDatabase } from "src/ts/storage/database.svelte";
import { appendLastPath } from "src/ts/util";
import { isMobile } from "src/ts/platform";
import { createEmbeddingV2Runtime } from "./embeddingV2Runtime";
export interface HypaProcessorV2Options {
  model?: HypaModel;
  customEmbeddingUrl?: string;
  oaiKey?: string;
  rateLimiter?: TaskRateLimiter;
}
export interface EmbeddingText<TMetadata> {
  id: string;
  content: string;
  metadata?: TMetadata;
}
export interface EmbeddingResult<TMetadata> extends EmbeddingText<TMetadata> {
  embedding: EmbeddingVector;
}
export type EmbeddingVector = number[] | Float32Array;
const runtime = createEmbeddingV2Runtime({
  get localforage() {
    return localforage;
  },
  get localModels() {
    return localModels;
  },
  get isContextModel() {
    return isContextModel;
  },
  get getContextProvider() {
    return getContextProvider;
  },
  get TaskRateLimiter() {
    return TaskRateLimiter;
  },
  get runEmbedding() {
    return runEmbedding;
  },
  get globalFetch() {
    return globalFetch;
  },
  get getDatabase() {
    return getDatabase;
  },
  get appendLastPath() {
    return appendLastPath;
  },
  get isMobile() {
    return isMobile;
  },
  get navigator() {
    return navigator;
  },
});
export const HypaProcessorV2 = runtime.HypaProcessorV2;
export type HypaProcessorV2<TMetadata> = InstanceType<
  typeof HypaProcessorV2<TMetadata>
>;
