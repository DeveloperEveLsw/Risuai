import type { Message } from "src/ts/storage/database.svelte";
export interface CapturedMemoryEdit {
  values: any;
  headers: Record<string, { revision: number; epoch: number }>;
  commit(values: Record<string, unknown>, guardAll?: boolean): void;
}
export interface HypaModalContext {
  capture(names?: string[]): CapturedMemoryEdit;
  summarize(mode: "single" | "bulk", indices: number[]): Promise<string>;
  sourceClock(): string;
  contains(memos: (string | null)[]): Promise<boolean>;
  message(memo: string | null, next?: boolean): Promise<Message | null>;
  firstMessage(): string | null;
}
