export interface MemorySummaryPreview {
  jobId: string;
  chatId: string;
  expectedChatEpoch: number;
  text: string;
  appliedText?: string;
  mode: "single" | "bulk";
  indices: number[];
  chatMemos: (string | null)[];
  canApply: boolean;
  blocked: { code: string; message: string } | null;
  source: { memoryRevision: number; chatEpoch: number; [key: string]: unknown };
  disposition?: {
    action: "apply" | "dismiss";
    requestId: string;
    appliedAt: number;
    edited?: boolean;
  };
}
