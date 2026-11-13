import type { Message } from "../storage/database.svelte";

export type MemorySourceRequest = {
  expectedEpoch: number;
  mode: "membership" | "message" | "next";
  memo?: string | null;
  memos?: (string | null)[];
};
export type MemorySourceResponse = {
  chatId: string;
  epoch: number;
  cursor: number;
  contentRevision: number;
  characterRevision: number;
  present?: boolean[];
  source?: { message: Message; index: number; revision: number } | null;
};
