let browserRuntime: ReturnType<typeof createEmbeddingRuntime>;
import localforage from "localforage";

import { globalFetch } from "src/ts/globalApi.svelte";

import { runEmbedding } from "../transformers";

import { appendLastPath } from "src/ts/util";

import { getDatabase } from "src/ts/storage/database.svelte";

import { isContextModel, getContextProvider } from "./contextualEmbedding";

export type HypaModel =
  | "custom"
  | "ada"
  | "openai3small"
  | "openai3large"
  | "MiniLM"
  | "MiniLMGPU"
  | "nomic"
  | "nomicGPU"
  | "bgeSmallEn"
  | "bgeSmallEnGPU"
  | "bgem3"
  | "bgem3GPU"
  | "multiMiniLM"
  | "multiMiniLMGPU"
  | "bgeM3Ko"
  | "bgeM3KoGPU"
  | "voyageContext3"; // In a typical environment, bge-m3 is a heavy model.
// If your GPU can't handle this model, you'll see errror below.
// Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost
export const localModels = getBrowserRuntime().localModels;

export const HypaProcesser = getBrowserRuntime().HypaProcesser;
export type HypaProcesser = InstanceType<typeof HypaProcesser>;

export function similarity(a: VectorArray, b: VectorArray) {
  return getBrowserRuntime().similarity(a, b);
}

export function cosineSimilarity(a: VectorArray, b: VectorArray): number {
  return getBrowserRuntime().cosineSimilarity(a, b);
}

export function contextHash(texts: string[]): string {
  return getBrowserRuntime().contextHash(texts);
}

export type VectorArray = number[] | Float32Array;

export type memoryVector = {
  embedding: number[] | Float32Array;
  content: string;
  alreadySaved?: boolean;
};
import { createEmbeddingRuntime } from "./embeddingRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createEmbeddingRuntime({
    get localforage(): typeof localforage {
      return localforage;
    },
    get getDatabase(): typeof getDatabase {
      return getDatabase;
    },
    get isContextModel(): typeof isContextModel {
      return isContextModel;
    },
    get getContextProvider(): typeof getContextProvider {
      return getContextProvider;
    },
    get runEmbedding(): typeof runEmbedding {
      return runEmbedding;
    },
    get appendLastPath(): typeof appendLastPath {
      return appendLastPath;
    },
    get globalFetch(): typeof globalFetch {
      return globalFetch;
    },
  }));
}
