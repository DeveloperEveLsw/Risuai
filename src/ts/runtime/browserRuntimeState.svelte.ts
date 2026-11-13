import type { Message } from "../storage/database.svelte";
import type { OutboxEntry } from "./browserOutbox";
import {
  RuntimeClientError,
  type RuntimeCommand,
  type Json,
} from "./clientProtocol";
import { recordRuntimeDiagnostic } from "./runtimeDiagnostics";
import { SvelteMap } from "svelte/reactivity";
import type { VariableScalar } from "./variableCommands";
import type {
  FieldIntent,
  FieldTarget,
  FieldValue,
  DerivedFieldOptions,
  GroupImageSourceGuard,
  GroupImageSourcePage,
} from "./fieldCommands";

export const FieldOverlays = new SvelteMap<
  string,
  { exists: boolean; value?: Json; entityEpoch: number }
>();
export const GroupOverlays = new SvelteMap<
  string,
  import("./groupMembers").GroupView
>();

export const VariableOverlays = new SvelteMap<
  string,
  { exists: boolean; value?: VariableScalar }
>();

export const BookmarkPreparations = new SvelteMap<
  string,
  { token: string; epoch: number; action: BookmarkAction; name?: string }
>();

export const BranchPreparations = new SvelteMap<
  string,
  { token: string; epoch: number }
>();

export type BookmarkAction = "add" | "rename" | "remove";
export interface BookmarkTarget {
  chatId: string;
  messageId: string;
  expectedRevision: number;
  expectedMessageRevision: number;
  expectedChatEpoch: number;
  action: BookmarkAction;
  token: string;
  name?: Json;
}
export interface BookmarkPending {
  action: BookmarkAction;
  present: boolean;
  name?: string;
}

export const entityRuntimeEnabled =
  import.meta.env.VITE_RISU_ENTITY_RUNTIME === "TRUE";
export type RuntimeJob = {
  id: string;
  chatId: string;
  chatEpoch?: number;
  type: string;
  state: string;
  fence: number;
  progressRevision: number;
  progress: {
    messages?: Message[];
    streaming?: boolean;
    stage?: number;
    [key: string]: unknown;
  };
  result: Json;
  disposition?: {
    action: string;
    requestId: string;
    resultJobId?: string | null;
  } | null;
};
export const RuntimeUIState = $state({
  libraries: {} as Record<
    string,
    import("./clientProtocol").RuntimeLibraryItem[]
  >,
  libraryNext: {} as Record<string, string | null>,
  displayRevision: 0,
  displayScopeRevision: 0,
  ready: false,
  scopeReady: false,
  replyChoice: null as
    import("./replyChoiceActivity").ReplyChoiceActivity | null,
  connection: "connecting",
  error: "",
  pending: [] as OutboxEntry[],
  jobs: [] as RuntimeJob[],
  historyResultJob: null as RuntimeJob | null,
  notices: {
    count: 0,
    current: null,
    loading: false,
    error: "",
  } as import("./runtimeNotices").RuntimeNoticeState,
  interactions: {
    count: 0,
    current: null,
    loading: false,
    error: "",
  } as import("./runtimeInteractions").RuntimeInteractionState,
  messages: [] as Message[],
  hasEarlier: false,
  hasLater: false,
  historicalWindow: false,
  newerMessageCount: 0,
  loadingHistory: false,
  historyViewGeneration: 0,
  loadingEarlier: false,
  bookmarkList: {
    session: "",
    presentationToken: "",
    items: [],
    count: 0,
    next: null,
    first: true,
    loading: false,
    ready: false,
  } as import("./bookmarkPreviews").BookmarkPreviewState,
});

export interface BrowserRuntimeBridge {
  jobHistoryOwner(): import("./jobHistory").JobHistoryOwner | null;
  readJobHistory(
    owner: import("./jobHistory").JobHistoryOwner,
    filter: import("./jobHistory").JobHistoryFilter,
    after?: string,
    signal?: AbortSignal,
  ): Promise<import("./jobHistory").JobHistoryPage>;
  observeJob(jobId: string): Promise<RuntimeJob>;
  previewMemorySummary(
    jobId: string,
  ): Promise<import("./memorySummaries").MemorySummaryPreview>;
  cancelMemorySummary(jobId: string): Promise<void>;
  applyMemorySummary(
    preview: import("./memorySummaries").MemorySummaryPreview,
    dismiss?: boolean,
    editedText?: string,
  ): Promise<void>;
  summarizeMemory(
    mode: "single" | "bulk",
    indices: number[],
    chatId?: string,
    expectedSource?: { revision: number; epoch: number },
  ): Promise<string>;
  memorySourceClock(chatId: string): string;
  readMemorySource(
    chatId: string,
    request: import("./memorySources").MemorySourceRequest,
  ): Promise<import("./memorySources").MemorySourceResponse>;
  exportArchive(): Promise<import("./originalArchive").OriginalArchive>;
  exportServerSnapshot(
    write: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void>;
  answerInteraction(
    id: string,
    revision: number,
    answer: string | boolean,
  ): Promise<void>;
  refreshInteractions(): void;
  cancelInteraction(id: string, revision: number): Promise<void>;
  acknowledgeNotice(id: string, revision: number): Promise<void>;
  refreshNotices(): void;
  moveReplyChoice(direction: "previous" | "next"): Promise<void>;
  retryJobResult(target: import("./jobResults").JobResultTarget): Promise<void>;
  previewJobResult(
    jobId: string,
  ): Promise<import("./jobResults").JobResultPreview>;
  recoverJobResult(
    target: import("./jobResults").JobResultTarget,
  ): Promise<void>;
  groupView(groupId: string): import("./groupMembers").GroupView;
  groupPending(groupId: string, memberId?: string): boolean;
  captureGroup(groupId: string): Readonly<import("./groupMembers").GroupTarget>;
  captureGroupMember(
    groupId: string,
    memberId: string,
    position: number,
  ): Readonly<import("./groupMembers").GroupMemberTarget>;
  addGroupMember(
    target: Readonly<import("./groupMembers").GroupTarget>,
    memberId: string,
    greeting: boolean,
  ): Promise<void>;
  changeGroupMember(
    target: Readonly<import("./groupMembers").GroupMemberTarget>,
    action: "remove" | "set-active" | "set-talkness",
    value?: number | boolean,
  ): Promise<void>;
  captureCharacterNavigation(): import("./characterNavigation.mjs").CharacterNavigationTarget;
  characterNavigationOrder(): import("../storage/database.svelte").Database["characterOrder"];
  changeCharacterNavigation(
    target: import("./characterNavigation.mjs").CharacterNavigationTarget,
    action: import("./characterNavigation.mjs").CharacterNavigationAction,
  ): Promise<void>;
  captureChatFolder(
    characterId: string,
    folderId: string,
  ): import("./chatNavigation").ChatFolderTarget;
  setChatFolders(
    target: import("./chatNavigation").ChatFolderTarget,
    value: Json,
  ): void;
  captureChatNavigation(
    characterId: string,
  ): import("./chatNavigation").ChatNavigationTarget;
  chatNavigationOverlay(characterId: string): RuntimeCommand | undefined;
  removeChatFolder(
    target: import("./chatNavigation").ChatFolderTarget,
  ): Promise<void>;
  reorderChatNavigation(
    target: import("./chatNavigation").ChatNavigationTarget,
    folderIds: string[],
    chatIds: string[],
    moved?: { chatId: string; folderId: string | null },
  ): Promise<void>;
  captureDisplayHeader(
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
  ): import("./displayEffects").BrowserDisplayHeader | undefined;
  captureProvisionalDisplayHeader(
    messageId: string,
    expectedCharacterId?: string,
  ):
    | {
        header: import("./displayEffects").BrowserDisplayHeader;
        rows: Message[];
      }
    | undefined;
  captureBookmarkDisplayHeader(
    session: string,
    id?: string,
  ): import("./displayEffects").BrowserDisplayHeader | undefined;
  openBookmarkList(): string;
  loadBookmarkPage(session: string, after?: string): Promise<void>;
  closeBookmarkList(session?: string): void;
  captureBookmarkDisplay(
    session: string,
    id?: string,
  ): import("./displayEffects").DisplayCapture | undefined;
  bookmarkPreviewCurrent(
    session: string,
    id: string,
    revision: number,
  ): boolean;
  captureDisplay(
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
  ): import("./displayEffects").DisplayCapture | undefined;
  displaySeen(
    key: string,
    capture: import("./displayEffects").DisplayCapture,
  ): boolean;
  pendingDisplay(key: string): RuntimeCommand | undefined;
  submitDisplay(
    command: RuntimeCommand,
    capture: import("./displayEffects").DisplayCapture,
  ): Promise<void>;

  recordImport(): Promise<void>;
  personaImageHeader(): PersonaImageHeader;
  setPersonaImage(path: string, header: PersonaImageHeader): Promise<void>;
  uploadAsset(data: Uint8Array, fileName?: string): Promise<string>;
  readAsset(path: string): Promise<Uint8Array>;
  assetUrl(path: string): string;
  activateLibrary(
    kind: "preset" | "persona",
    id: string,
    saveCurrent?: boolean,
  ): Promise<void>;
  saveActiveLibrary(kind: "preset" | "persona"): Promise<void>;
  loadLibrary(kind: string, search?: string): Promise<void>;
  loadLibraryMore(kind: string): Promise<void>;
  closeLibrary(kind: string): void;
  getLibraryResource(
    kind: string,
    id: string,
  ): Promise<{
    payload: Record<string, unknown>;
    header: { revision: number; epoch: number };
  }>;
  libraryHeader(kind: string, id: string): { revision: number; epoch: number };
  saveLibraryResource(
    kind: string,
    payload: Record<string, unknown>,
    expected?: { revision: number; epoch: number },
  ): Promise<string>;
  deleteLibraryResource(
    kind: string,
    id: string,
    expected: { revision: number; epoch: number },
  ): Promise<void>;
  libraryOrderHeader(kind: string): { revision: number; epoch: number };
  reorderLibrary(
    kind: string,
    order: string[],
    expected?: { revision: number; epoch: number },
  ): Promise<void>;
  selectCharacter(id: string, chatId?: string): Promise<boolean>;
  loadEarlier(): Promise<void>;
  loadLater(): Promise<void>;
  loadLatest(): Promise<boolean>;
  jumpToMessage(id: string): Promise<number>;
  send(input: string, type?: "send" | "continue" | "reroll"): Promise<string>;
  button(
    data: string | null,
    manualName: string | null,
    triggerId: string | null,
  ): Promise<string>;
  cancel(): Promise<void>;
  waitForJob(id: string): Promise<void>;
  enqueue(command: RuntimeCommand): Promise<string>;
  createCharacter(
    value: Record<string, Json>,
    metadata: Record<string, Json>,
  ): Promise<string>;
  createChat(
    characterId: string,
    metadata: Record<string, Json>,
  ): Promise<string>;
  cloneChat(chatId: string, name: string): Promise<string>;
  branchMessage(id: string): Promise<string>;
  pendingBranch(id: string): boolean;
  deleteChat(chatId: string): Promise<void>;
  removeCharacter(id: string, permanent: boolean): Promise<void>;
  restoreCharacter(id: string): Promise<void>;
  discardCommand(requestId: string): Promise<void>;
  editMessage(id: string, text: string): Promise<string>;
  captureBookmark(
    id: string,
    action: "toggle" | "rename" | "remove",
  ): Promise<Readonly<BookmarkTarget>>;
  pendingBookmark(id: string): BookmarkPending | undefined;
  releaseBookmark(target: Readonly<BookmarkTarget>): void;
  setBookmark(target: Readonly<BookmarkTarget>, name?: string): Promise<void>;
  captureMessageRemoval(id: string): Readonly<MessageRemovalTarget>;
  captureMessageDisabled(id: string): Readonly<MessageDisabledTarget>;
  pendingMessageDisabled(id: string): false | true | "allBefore" | undefined;
  setMessageDisabled(
    target: Readonly<MessageDisabledTarget>,
    disabled: false | true | "allBefore",
  ): Promise<void>;
  removeMessage(
    target: Readonly<MessageRemovalTarget>,
    mode: "one" | "from",
  ): Promise<void>;
  setGlobalVariable(key: string, value: string): void;
  unpinGlobalVariable(key: string): void;
  resolveVariableConflict(requestId: string, keepLocal: boolean): Promise<void>;
  fieldHeader(target: FieldTarget): { revision: number; epoch: number };
  setField(
    target: FieldTarget,
    value: Json | undefined,
    expected?: { revision: number; epoch: number },
  ): void;
  setFields(
    changes: readonly FieldIntent[],
    expected?: readonly { revision: number; epoch: number }[],
    dependencies?: DerivedFieldOptions,
  ): void;
  commitFields(
    changes: readonly FieldIntent[],
    expected: readonly { revision: number; epoch: number }[],
    dependencies?: DerivedFieldOptions,
  ): Promise<void>;
  readFields(targets: FieldTarget[]): Promise<FieldValue[]>;
  groupImageSources(
    groupId: string,
    offset?: number,
    expected?: GroupImageSourceGuard,
  ): Promise<GroupImageSourcePage>;
  resolveFieldConflict(requestId: string, keepLocal: boolean): Promise<void>;
}

export interface PersonaImageHeader {
  id: string;
  revision: number;
  epoch: number;
  selectionRevision: number;
  selectionEpoch: number;
  iconRevision: number;
  iconEpoch: number;
}
export interface MessageRemovalTarget {
  chatId: string;
  messageId: string;
  expectedRevision: number;
  expectedChatRevision: number;
  expectedChatEpoch: number;
}
export interface MessageDisabledTarget extends MessageRemovalTarget {
  disabled: false | true | "allBefore";
}
let bridge: BrowserRuntimeBridge;
export function installBrowserRuntime(value: BrowserRuntimeBridge) {
  bridge = value;
}
export function browserRuntime(): BrowserRuntimeBridge {
  if (!bridge) throw new Error("Server runtime is not ready");
  return bridge;
}
export function reportRuntimeError(error: unknown) {
  if (!(error instanceof RuntimeClientError && error.requestId))
    recordRuntimeDiagnostic({
      kind: "client-error",
      code: error instanceof RuntimeClientError ? error.code : "CLIENT_ERROR",
    });
  RuntimeUIState.error = error instanceof Error ? error.message : String(error);
  const requestId =
    error && typeof error === "object" && "requestId" in error
      ? error.requestId
      : undefined;
  if (
    typeof requestId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      requestId,
    )
  )
    RuntimeUIState.error += ` (request ${requestId})`;
}
