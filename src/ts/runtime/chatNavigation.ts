export type ChatFolderTarget = {
  characterId: string;
  folderId: string;
  expectedCharacterEpoch: number;
  expectedFolderRevision: number;
};
export type ChatNavigationTarget = Omit<ChatFolderTarget, "folderId"> & {
  expectedNavigationRevision: number;
  members: {
    chatId: string;
    expectedRevision: number;
    expectedEpoch: number;
  }[];
};
