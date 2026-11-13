export type ReplyChoiceTarget = {
  chatId: string;
  messageId: string;
  expectedRevision: number;
  expectedChatEpoch: number;
  setId: string;
  expectedChoiceRevision: number;
  expectedContentRevision: number;
  expectedBatchSetId: string | null;
  expectedBatchRevision: number;
};
export type ReplyBatchHeader = {
  setId: string | null;
  revision: number;
  selectedPosition: number;
  count: number;
  available: boolean;
  unavailable: string | null;
};
export type ReplyChoiceHeader = {
  target: ReplyChoiceTarget;
  batch: ReplyBatchHeader;
  selectedPosition: number;
  count: number;
  busy: boolean;
  pendingJobId: string | null;
};
