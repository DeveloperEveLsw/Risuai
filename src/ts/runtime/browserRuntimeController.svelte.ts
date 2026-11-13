import type { Database, Message } from "../storage/database.svelte";
import { SvelteMap } from "svelte/reactivity";
import { RisuReadModel, reconcileValue } from "./risuReadModel";
import { RuntimeSyncClient } from "./runtimeSyncClient";
import { IndexedDbOutbox } from "./browserOutbox";
import { runtimeFetch, runtimeHttpFailure } from "./runtimeDiagnostics";
import { jobFailureMessage } from "./jobResults";
import {
  validateOriginalArchive,
  type OriginalArchive,
} from "./originalArchive";
import { RuntimeNotices } from "./runtimeNotices";
import { RuntimeInteractions } from "./runtimeInteractions";
import {
  replyChoiceActivity,
  type ReplyChoicePreparation,
} from "./replyChoiceActivity";
import {
  RuntimeClientError,
  type RuntimeBootstrap,
  type RuntimeCommand,
} from "./clientProtocol";
import {
  RuntimeUIState,
  VariableOverlays,
  FieldOverlays,
  GroupOverlays,
  BookmarkPreparations,
  BranchPreparations,
  reportRuntimeError,
  type RuntimeJob,
  type BrowserRuntimeBridge,
  type PersonaImageHeader,
  type BookmarkAction,
  type BookmarkPending,
  type BookmarkTarget,
} from "./browserRuntimeState.svelte";
import { createCharacterFactory } from "../characterFactory";
import { normalizeNativeSettings } from "./nativeSettings";
import { v4 } from "uuid";
import {
  projectGroup,
  groupCommands,
  type GroupTarget,
  type GroupMemberTarget,
  type GroupView,
  type GroupMemberHeader,
} from "./groupMembers";
import {
  variableEdits,
  variableIdentity,
  type VariableEdit,
  type VariableTarget,
  type VariableValue,
} from "./variableCommands";

import {
  fieldEdits,
  fieldIdentity,
  fieldTarget,
  type FieldEdit,
  type FieldTarget,
  type FieldValue,
  type FieldIntent,
  type DerivedFieldOptions,
  type GroupImageSourceGuard,
  type GroupImageSourcePage,
} from "./fieldCommands";
import {
  DisplayLedger,
  type DisplayCapture,
  type BrowserDisplayHeader,
  type DisplayState,
} from "./displayEffects";
import type { triggerscript } from "../storage/database.svelte";
import { getFieldValue } from "./fieldControls";
import { commandJson, type Json } from "./clientProtocol";
import { BookmarkPreviews } from "./bookmarkPreviews";
import type { ChatFolderTarget, ChatNavigationTarget } from "./chatNavigation";
import {
  applyCharacterNavigation,
  projectCharacterOrder,
  type CharacterNavigationTarget,
  type CharacterNavigationAction,
} from "./characterNavigation.mjs";

const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
type Host = {
  DBState: { db: Database };
  selected: (index: number) => void;
  busy: (busy: boolean, stage: number) => void;
  onSettings: () => void;
  onResources?: () => void;
};

/** Real Risu projection. Navigation and progress never become whole-save writes. */
export class BrowserRuntimeController implements BrowserRuntimeBridge {
  readonly model: RisuReadModel;
  readonly client: RuntimeSyncClient;
  private outbox: IndexedDbOutbox;
  private commands = new Map<string, RuntimeCommand>();
  private jobs = new Map<string, RuntimeJob>();
  private presentation = new Map<string, Message>();
  private waiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }[]
  >();
  private display = new DisplayLedger();
  private displayProjectedCursor = 0;
  private displayPendingSignature = "";
  private rejectedDisplay = new Map<string, number>();
  private displayDrafts = new Map<string, RuntimeCommand>();
  private selectedId: string | null = null;
  private selection = 0;
  private fieldDrafts = new Map<string, FieldEdit[]>();
  private groupDrafts = new SvelteMap<string, RuntimeCommand>();
  private variableDrafts = new Map<string, VariableEdit[]>();
  private navigationDrafts = $state(new Map<string, RuntimeCommand>());
  private characterNavigationDrafts = $state(new Map<string, RuntimeCommand>());
  private bookmarks: BookmarkPreviews;
  private notices: RuntimeNotices;
  private interactions: RuntimeInteractions;
  private fieldReadChecksVersion = 0;
  private groupImageSourcesVersion = 0;
  private bookmarkRefresh?: ReturnType<typeof setTimeout>;
  private commandWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  constructor(
    private host: Host,
    private readonly serverId: string,
    private readonly baseUrl = "/api/runtime",
  ) {
    this.outbox = new IndexedDbOutbox(serverId);
    this.model = new RisuReadModel({
      DBState: host.DBState,
      read: (path, options) => this.client.read(path, options),
      characterDefaults: createCharacterFactory({
        uuidv4: v4,
        defaultSdDataFunc: () => [],
      }).createBlankChar,
      normalizeSettings: normalizeNativeSettings,
      onScope: (ready) => {
        // The read model can finish before job hydration and presentation.
        // Keep controls unavailable until the controller has finished all three.
        if (!ready) RuntimeUIState.scopeReady = false;
      },
      onResources: () => {
        host.onSettings();
        host.onResources?.();
      },
      onCatalog: (kind, items, next) => {
        RuntimeUIState.libraries[kind] = items;
        RuntimeUIState.libraryNext[kind] = next;
      },
    });
    this.client = new RuntimeSyncClient({
      baseUrl,
      serverId,
      outbox: this.outbox,
      onBootstrap: async (snapshot) => {
        this.fieldReadChecksVersion = snapshot.fieldReadChecksVersion ?? 0;
        this.groupImageSourcesVersion = snapshot.groupImageSourcesVersion ?? 0;
        this.closeBookmarkList();
        await this.model.bootstrap(snapshot);
        this.displayProjectedCursor = snapshot.cursor;
        void this.notices.refresh(snapshot.cursor);
        void this.interactions.refresh(snapshot.cursor);
        if (this.selectedId) {
          const index = this.model.characterIndex(this.selectedId);
          host.selected(index);
          if (index < 0) {
            this.selectedId = null;
            RuntimeUIState.scopeReady = false;
          } else {
            await this.hydrateJobs();
            await this.hydrateDisplay();
          }
        }
        this.refreshFields();
        this.refreshGroups();
        this.refreshPresentation();
        RuntimeUIState.displayScopeRevision++;
      },
      onChange: async (change) => {
        if (change.type === "notice" || change.type === "interaction") {
          const waiting =
            this.display.ready &&
            (this.displayProjectedCursor < (this.display.state?.cursor ?? 0) ||
              this.displayProjectedCursor <
                (this.model.displayHistory(-1)?.cursor ?? 0));
          this.displayProjectedCursor = change.sequence;
          if (change.type === "notice") this.notices.observe(change);
          else this.interactions.observe(change);
          if (waiting) RuntimeUIState.displayRevision++;
          return;
        }
        const bookmarkChanged = this.bookmarks.observe(change);
        // Remove the selected screen before deleting its last chat. Awaiting the
        // projection can otherwise let Svelte render a character with no chat.
        if (
          this.selectedId &&
          change.payload.deleted &&
          ((change.type === "character" && change.id === this.selectedId) ||
            (change.type === "chat" &&
              change.payload.characterDeleted &&
              change.payload.characterId === this.selectedId))
        ) {
          this.selectedId = null;
          host.selected(-1);
          RuntimeUIState.scopeReady = false;
        }
        const displayChanged = this.display.observe(change);
        const displayWasWaiting =
          this.display.ready &&
          (this.displayProjectedCursor < (this.display.state?.cursor ?? 0) ||
            this.displayProjectedCursor <
              (this.display.state?.inputClock ?? 0) ||
            // A refreshed history page may already include the final job
            // event. Its fence must retry display when replay catches up,
            // even if that last event does not itself change display inputs.
            this.displayProjectedCursor <
              (this.model.displayHistory(-1)?.cursor ?? 0));
        await this.model.change(change);
        this.displayProjectedCursor = change.sequence;
        this.bookmarks.projected();
        if (bookmarkChanged) this.scheduleBookmarkRefresh();
        if (displayChanged || displayWasWaiting)
          RuntimeUIState.displayRevision++;
        if (
          this.selectedId &&
          ["character", "chat"].includes(change.type) &&
          change.payload.deleted
        ) {
          const index = this.model.characterIndex(this.selectedId);
          host.selected(index);
          if (index < 0) {
            this.selectedId = null;
            RuntimeUIState.scopeReady = false;
          } else if (!this.model.activeChatId) {
            try {
              await this.selectCharacter(this.selectedId);
            } catch (error) {
              if (!(
                error instanceof RuntimeClientError &&
                error.code === "NOT_FOUND"
              ))
                throw error;
              this.selectedId = null;
              host.selected(-1);
              RuntimeUIState.scopeReady = false;
            }
          }
        }
        if (change.type === "job" || change.type === "job-progress")
          await this.refreshJob(change.id);
        this.refreshFields();
        this.refreshGroups();
        this.refreshPresentation();
        // Plain revision/epoch maps also affect captures when projected JSON is
        // unchanged. A shared body must observe every completed projection.
        RuntimeUIState.displayScopeRevision++;
      },
      onAccepted: async (entry, receipt) => {
        if (
          entry.command.type === "move-reply-choice" &&
          receipt.kind === "generation" &&
          typeof receipt.jobId === "string"
        )
          await this.refreshJob(receipt.jobId);
        if (
          entry.command.type === "retry-job-result" &&
          receipt.disposition &&
          typeof receipt.disposition === "object" &&
          !Array.isArray(receipt.disposition) &&
          typeof receipt.disposition.resultJobId === "string"
        ) {
          await this.refreshJob(receipt.disposition.resultJobId);
        }
        if (entry.command.type === "apply-display-effects") {
          this.displayDrafts.delete(String(entry.command.displayKey));
          this.rejectedDisplay.delete(String(entry.command.displayKey));
          if (
            receipt.result &&
            typeof receipt.result === "object" &&
            !Array.isArray(receipt.result) &&
            receipt.result.matchesOriginalIntent === false
          )
            reportRuntimeError(
              new Error(
                "Another display proposal was already saved for this occurrence. The server result was retained.",
              ),
            );
        }
        if (entry.kind === "job") {
          this.commands.set(entry.requestId, entry.command);
          await this.refreshJob(entry.requestId);
        }
      },
      onPending: (entries) => {
        const signature = entries
          .filter((e) => e.command.type === "apply-display-effects")
          .map((e) => e.requestId + ":" + e.state)
          .join("|");
        if (signature !== this.displayPendingSignature) {
          this.displayPendingSignature = signature;
          RuntimeUIState.displayRevision++;
        }
        RuntimeUIState.pending = entries;
        for (const entry of entries)
          if (
            entry.command.type === "apply-display-effects" &&
            entry.state === "blocked"
          ) {
            this.displayDrafts.delete(String(entry.command.displayKey));
            this.rejectedDisplay.set(
              String(entry.command.displayKey),
              Number(entry.command.inputClock),
            );
            if (this.rejectedDisplay.size > 512)
              this.rejectedDisplay.delete(
                this.rejectedDisplay.keys().next().value,
              );
            reportRuntimeError(
              new Error(
                "Display change was rejected: " +
                  (entry.error?.message ?? "unknown reason") +
                  ". It remains in pending commands for review/discard.",
              ),
            );
          }
        for (const entry of entries)
          if (entry.state === "blocked") {
            this.commandWaiters
              .get(entry.requestId)
              ?.reject(
                new Error(entry.error?.message ?? "Command was rejected"),
              );
            this.commandWaiters.delete(entry.requestId);
          }
        this.refreshVariables();
        this.refreshFields();
        this.refreshGroups();
        this.refreshPresentation();
      },
      onStatus: (state) => {
        RuntimeUIState.connection = state;
      },
      onError: reportRuntimeError,
      onProjected: (entry) => {
        this.commandWaiters.get(entry.requestId)?.resolve();
        this.commandWaiters.delete(entry.requestId);
      },
    });
    this.notices = new RuntimeNotices({
      read: (path) => this.client.read(path),
      publish: (state) => {
        RuntimeUIState.notices = state;
      },
    });
    this.interactions = new RuntimeInteractions({
      read: (path) => this.client.read(path),
      publish: (state) => {
        RuntimeUIState.interactions = state;
      },
    });
    this.bookmarks = new BookmarkPreviews({
      owner: () => {
        const chatId = this.model.activeChatId;
        if (!chatId || !this.selectedId) return;
        return {
          chatId,
          characterId: this.selectedId,
          epoch: this.model.entityHeader("chat", chatId).epoch,
          selection: this.selection,
        };
      },
      projectedCursor: () => this.displayProjectedCursor,
      read: (path) => this.client.read(path),
      publish: (state) => {
        RuntimeUIState.bookmarkList = state;
      },
    });
  }
  private refreshVariables() {
    const blocked = new Set<string>();
    const durable = new Set<string>();
    const desired = new Map<
      string,
      { exists: boolean; value?: string | number | boolean | null }
    >();
    const apply = (edits: VariableEdit[]) => {
      for (const edit of edits)
        desired.set(
          variableIdentity(edit),
          edit.remove ? { exists: false } : { exists: true, value: edit.value },
        );
    };
    for (const entry of RuntimeUIState.pending) {
      durable.add(entry.requestId);
      if (
        entry.state === "blocked" ||
        (Array.isArray(entry.command.after) &&
          entry.command.after.some((id) => blocked.has(String(id))))
      ) {
        blocked.add(entry.requestId);
        continue;
      }
      apply(variableEdits(entry.command));
    }
    for (const [id, edits] of this.variableDrafts)
      if (!durable.has(id)) apply(edits);
    for (const key of VariableOverlays.keys())
      if (!desired.has(key)) VariableOverlays.delete(key);
    for (const [key, value] of desired) {
      const old = VariableOverlays.get(key);
      if (!old || old.exists !== value.exists || old.value !== value.value)
        VariableOverlays.set(key, value);
    }
  }
  private refreshFields() {
    const blocked = new Set<string>();
    const durable = new Set<string>();
    const desired = new Map<
      string,
      { exists: boolean; value?: Json; entityEpoch: number }
    >();
    const apply = (edits: FieldEdit[]) => {
      for (const edit of edits) {
        if (edit.expectedEpoch !== this.model.fieldVersion(edit).entityEpoch)
          continue;
        desired.set(
          fieldIdentity(edit),
          edit.remove
            ? { exists: false, entityEpoch: edit.expectedEpoch }
            : {
                exists: true,
                value: edit.value,
                entityEpoch: edit.expectedEpoch,
              },
        );
      }
    };
    for (const entry of RuntimeUIState.pending) {
      durable.add(entry.requestId);
      if (
        entry.state === "blocked" ||
        (Array.isArray(entry.command.after) &&
          entry.command.after.some((id) => blocked.has(String(id))))
      ) {
        blocked.add(entry.requestId);
        continue;
      }
      apply(fieldEdits(entry.command));
    }
    for (const [id, edits] of this.fieldDrafts)
      if (!durable.has(id)) apply(edits);
    for (const key of FieldOverlays.keys())
      if (!desired.has(key)) FieldOverlays.delete(key);
    for (const [key, value] of desired) {
      const old = FieldOverlays.get(key);
      if (
        !old ||
        old.exists !== value.exists ||
        old.entityEpoch !== value.entityEpoch ||
        (old.value !== value.value &&
          JSON.stringify(old.value) !== JSON.stringify(value.value))
      )
        FieldOverlays.set(key, value);
    }
  }
  private pendingGroups() {
    const entries = RuntimeUIState.pending.filter(
      (entry) => entry.state !== "blocked" && groupCommands(entry.command),
    );
    const durable = new Set(
      RuntimeUIState.pending.map((entry) => entry.requestId),
    );
    return [
      ...entries.map((entry) => entry.command),
      ...[...this.groupDrafts]
        .filter(([id]) => !durable.has(id))
        .map(([, command]) => command),
    ];
  }
  private refreshGroups() {
    const commands = this.pendingGroups();
    for (const groupId of new Set([
      ...GroupOverlays.keys(),
      ...commands.map((command) => String(command.groupId)),
    ])) {
      const relevant = commands.filter(
        (command) => command.groupId === groupId,
      );
      const group =
        this.model.database.characters[this.model.characterIndex(groupId)];
      if (
        !relevant.length ||
        !this.model.characterLoaded(groupId) ||
        !group ||
        group.type !== "group" ||
        ![group.characters, group.characterTalks, group.characterActive].every(
          Array.isArray,
        )
      ) {
        GroupOverlays.delete(groupId);
        continue;
      }
      const field = this.model.fieldVersion({
        scope: "character",
        entityId: groupId,
        key: "characters",
      });
      GroupOverlays.set(
        groupId,
        projectGroup(group, relevant, {
          groupId,
          expectedEpoch: field.entityEpoch,
          expectedOrderRevision: field.revision,
        }),
      );
    }
  }
  groupView(groupId: string): GroupView {
    const group =
      this.model.database.characters[this.model.characterIndex(groupId)];
    if (!group || group.type !== "group")
      throw new Error("The selected character is not a group");
    return GroupOverlays.get(groupId) ?? group;
  }
  groupPending(groupId: string, memberId?: string) {
    return this.pendingGroups().some(
      (command) =>
        command.groupId === groupId &&
        (memberId === undefined ||
          ["add", "remove"].includes(String(command.action)) ||
          command.memberId === memberId),
    );
  }
  captureGroup(groupId: string): Readonly<GroupTarget> {
    if (
      !RuntimeUIState.ready ||
      !this.model.characterLoaded(groupId) ||
      this.model.entityHeader("character", groupId).deleted
    )
      throw new Error("Group is not ready");
    const group =
      this.model.database.characters[this.model.characterIndex(groupId)];
    if (group.type !== "group") throw new Error("The character is not a group");
    if (
      this.pendingGroups().some(
        (command) =>
          command.groupId === groupId &&
          ["add", "remove"].includes(String(command.action)),
      )
    )
      throw new Error("A group membership change is pending");
    const field = this.model.fieldVersion({
      scope: "character",
      entityId: groupId,
      key: "characters",
    });
    const chatId =
      this.selectedId === groupId ? this.model.activeChatId : undefined;
    const chat = chatId ? this.model.entityHeader("chat", chatId) : undefined;
    return Object.freeze({
      groupId,
      expectedEpoch: field.entityEpoch,
      expectedOrderRevision: field.revision,
      ...(chatId && chat && !chat.deleted
        ? {
            chatId,
            expectedChatEpoch: chat.epoch,
            expectedChatRevision: chat.revision,
          }
        : {}),
    });
  }
  captureGroupMember(
    groupId: string,
    memberId: string,
    position: number,
  ): Readonly<GroupMemberTarget> {
    const target = this.captureGroup(groupId);
    if (this.groupPending(groupId, memberId))
      throw new Error("This group member has a pending change");
    const member = this.model.groupMemberHeader(groupId, memberId);
    if (
      !member.slots.some((slot) => slot.position === position) ||
      this.groupView(groupId).characters[position] !== memberId
    )
      throw new Error("The group member moved or was removed");
    return Object.freeze({
      ...target,
      memberId,
      position,
      expectedMemberRevision: member.revision,
    });
  }
  private async executeGroup(command: RuntimeCommand) {
    const id = crypto.randomUUID();
    this.groupDrafts.set(id, command);
    this.refreshGroups();
    try {
      await this.execute(command, id);
    } finally {
      this.groupDrafts.delete(id);
      this.refreshGroups();
    }
  }
  async changeGroupMember(
    target: Readonly<GroupMemberTarget>,
    action: "remove" | "set-active" | "set-talkness",
    value?: number | boolean,
  ) {
    await this.executeGroup({
      type: "change-group-member",
      groupId: target.groupId,
      expectedEpoch: target.expectedEpoch,
      expectedOrderRevision: target.expectedOrderRevision,
      memberId: target.memberId,
      position: target.position,
      expectedMemberRevision: target.expectedMemberRevision,
      action,
      ...(value === undefined ? {} : { value }),
    });
  }
  async addGroupMember(
    target: Readonly<GroupTarget>,
    memberId: string,
    includeGreeting: boolean,
  ) {
    const header = await this.client.read<{
      groupId: string;
      entityEpoch: number;
      orderRevision: number;
      member: GroupMemberHeader;
    }>(
      "/groups/" +
        encodeURIComponent(target.groupId) +
        "/members/" +
        encodeURIComponent(memberId),
    );
    if (
      header.groupId !== target.groupId ||
      header.entityEpoch !== target.expectedEpoch ||
      header.orderRevision !== target.expectedOrderRevision ||
      header.member.memberId !== memberId
    )
      throw new Error("The group changed while selecting a member");
    let greeting;
    if (includeGreeting) {
      if (
        !target.chatId ||
        target.expectedChatEpoch === undefined ||
        target.expectedChatRevision === undefined
      )
        throw new Error("A captured group chat is required for a greeting");
      const member = await this.client.read<{
        id: string;
        entityEpoch: number;
        fieldRevisions: Record<string, number>;
      }>("/characters/" + encodeURIComponent(memberId));
      if (member.id !== memberId)
        throw new Error("Greeting source identity changed");
      greeting = {
        chatId: target.chatId,
        messageId: v4(),
        expectedChatEpoch: target.expectedChatEpoch,
        expectedChatRevision: target.expectedChatRevision,
        expectedMemberEpoch: member.entityEpoch,
        expectedGreetingRevision: member.fieldRevisions.firstMessage ?? 0,
      };
    }
    await this.executeGroup({
      type: "change-group-member",
      groupId: target.groupId,
      memberId,
      action: "add",
      expectedEpoch: target.expectedEpoch,
      expectedOrderRevision: target.expectedOrderRevision,
      expectedMemberRevision: header.member.revision,
      ...(greeting ? { greeting } : {}),
    });
  }
  fieldHeader(target: FieldTarget) {
    const version = this.model.fieldVersion(target);
    return { revision: version.revision, epoch: version.entityEpoch };
  }
  setField(
    target: FieldTarget,
    value: Json | undefined,
    expected?: { revision: number; epoch: number },
  ) {
    void this.stageFields(
      [{ target, value }],
      expected ? [expected] : undefined,
    ).catch(reportRuntimeError);
  }
  setFields(
    changes: readonly FieldIntent[],
    expected?: readonly { revision: number; epoch: number }[],
    dependencies?: DerivedFieldOptions,
  ) {
    void this.stageFields(changes, expected, undefined, dependencies).catch(
      reportRuntimeError,
    );
  }
  /** Keep immediate field intent, but await the owned command's projection. */
  async commitFields(
    changes: readonly FieldIntent[],
    expected: readonly { revision: number; epoch: number }[],
    dependencies?: DerivedFieldOptions,
  ) {
    const id = crypto.randomUUID();
    const projected = new Promise<void>((resolve, reject) =>
      this.commandWaiters.set(id, { resolve, reject }),
    );
    projected.catch(() => {});
    try {
      await this.stageFields(changes, expected, id, dependencies);
      await projected;
    } finally {
      this.commandWaiters.delete(id);
    }
  }
  private stageFields(
    changes: readonly FieldIntent[],
    expected?: readonly { revision: number; epoch: number }[],
    id = crypto.randomUUID(),
    dependencies: DerivedFieldOptions = {},
  ) {
    if (
      (dependencies.checks?.length && this.fieldReadChecksVersion !== 1) ||
      (dependencies.groupImageSources && this.groupImageSourcesVersion !== 1)
    )
      throw new Error(
        "The server cannot safely save this derived image; update it first",
      );
    if (!changes.length || changes.length > 128)
      throw new Error("A field change requires between 1 and 128 targets");
    if (expected && expected.length !== changes.length)
      throw new Error("Captured field versions must match the targets");
    if (
      !RuntimeUIState.ready ||
      changes.some(
        ({ target }) =>
          target.scope === "chat" &&
          !this.model.chatMetadataLoaded(target.entityId),
      ) ||
      changes.some(
        ({ target }) =>
          target.scope === "character" &&
          !this.model.characterLoaded(target.entityId),
      )
    )
      throw new Error("Data is not ready");
    // Validate/snapshot before exposing intent: later UI mutation cannot alter its payload.
    const identities = new Set<string>();
    const edits: FieldEdit[] = changes.map(({ target, value }, index) => {
      const identity = fieldIdentity(target);
      if (identities.has(identity)) throw new Error("Duplicate field target");
      identities.add(identity);
      const version = expected
        ? {
            revision: expected[index].revision,
            entityEpoch: expected[index].epoch,
          }
        : this.model.fieldVersion(target);
      if (
        !Number.isSafeInteger(version.revision) ||
        version.revision < 0 ||
        !Number.isSafeInteger(version.entityEpoch) ||
        version.entityEpoch < 0
      )
        throw new Error("Invalid captured field version");
      const base = {
        ...fieldTarget(target),
        expectedRevision: version.revision,
        expectedEpoch: version.entityEpoch,
      };
      return value === undefined
        ? { ...base, remove: true }
        : { ...base, value: JSON.parse(commandJson(value)) };
    });
    this.fieldDrafts.set(id, edits);
    this.refreshFields();
    return this.client.enqueueFields(edits, id, dependencies).finally(() => {
      this.fieldDrafts.delete(id);
      this.refreshFields();
    });
  }
  async readFields(targets: FieldTarget[]): Promise<FieldValue[]> {
    if (this.fieldReadChecksVersion !== 1)
      throw new Error(
        "The server does not support captured image dependencies",
      );
    const result = await this.client.read<{ fields: FieldValue[] }>(
      "/fields/read",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      },
    );
    return result.fields;
  }
  async groupImageSources(
    groupId: string,
    offset = 0,
    expected?: GroupImageSourceGuard,
  ): Promise<GroupImageSourcePage> {
    if (this.groupImageSourcesVersion !== 1)
      throw new Error("The server does not support captured group images");
    return this.client.read<GroupImageSourcePage>(
      `/groups/${encodeURIComponent(groupId)}/image-sources`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, ...(expected ? { expected } : {}) }),
      },
    );
  }
  async resolveFieldConflict(requestId: string, keepLocal: boolean) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries = await this.outbox.list();
      const affected = new Set([requestId]);
      const targets = new Map<string, FieldTarget>();
      for (const entry of entries) {
        if (
          Array.isArray(entry.command.after) &&
          entry.command.after.some((id) => affected.has(String(id)))
        )
          affected.add(entry.requestId);
        if (!affected.has(entry.requestId)) continue;
        for (const edit of fieldEdits(entry.command))
          targets.set(fieldIdentity(edit), fieldTarget(edit));
      }
      const result = await this.client.read<{
        cursor: number;
        fields: FieldValue[];
      }>("/fields/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [...targets.values()] }),
      });
      await this.model.applyFieldRead(result);
      this.refreshFields();
      try {
        await this.client.resolveFieldChain(
          requestId,
          result.fields,
          keepLocal,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof RuntimeClientError) ||
          error.code !== "RESOLUTION_CHANGED"
        )
          throw error;
      }
    }
    throw new Error("Changes continued during conflict resolution; try again");
  }
  private variableEdit(target: VariableTarget, value?: string): VariableEdit {
    const base = {
      ...target,
      expectedRevision: this.model.scopedVariableRevision(target),
    };
    return value === undefined ? { ...base, remove: true } : { ...base, value };
  }
  private queueVariables(edits: VariableEdit[]) {
    const id = crypto.randomUUID();
    this.variableDrafts.set(id, edits);
    this.refreshVariables();
    void this.client
      .enqueueVariables(edits, id)
      .catch(reportRuntimeError)
      .finally(() => {
        this.variableDrafts.delete(id);
        this.refreshVariables();
      });
  }
  setGlobalVariable(key: string, value: string) {
    const chat = this.model.activeChat;
    if (!chat || !RuntimeUIState.scopeReady)
      throw new Error("Conversation is not ready");
    const local: VariableTarget = {
      scope: "chat-global",
      chatId: chat.id,
      key,
    };
    if (
      getFieldValue(
        {
          scope: "chat",
          entityId: chat.id,
          key: "useLocallySetGlobalVariables",
        },
        chat.useLocallySetGlobalVariables,
      )
    ) {
      this.queueVariables([this.variableEdit(local, value)]);
      return;
    }
    const overlay = VariableOverlays.get(variableIdentity(local));
    const exists = overlay
      ? overlay.exists
      : Object.hasOwn(chat.GLGlobalVariables ?? {}, key);
    this.queueVariables([
      ...(exists ? [this.variableEdit(local)] : []),
      this.variableEdit({ scope: "global", key }, value),
    ]);
  }
  unpinGlobalVariable(key: string) {
    const chatId = this.model.activeChatId;
    if (!chatId || !RuntimeUIState.scopeReady)
      throw new Error("Conversation is not ready");
    this.queueVariables([
      this.variableEdit({ scope: "chat-global", chatId, key }),
    ]);
  }
  async resolveVariableConflict(requestId: string, keepLocal: boolean) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries = await this.outbox.list();
      const affected = new Set([requestId]);
      const targets = new Map<string, VariableTarget>();
      for (const entry of entries) {
        if (
          Array.isArray(entry.command.after) &&
          entry.command.after.some((id) => affected.has(String(id)))
        )
          affected.add(entry.requestId);
        if (!affected.has(entry.requestId)) continue;
        for (const edit of variableEdits(entry.command))
          targets.set(
            variableIdentity(edit),
            edit.scope === "global"
              ? { scope: edit.scope, key: edit.key }
              : { scope: edit.scope, key: edit.key, chatId: edit.chatId },
          );
      }
      const result = await this.client.read<{
        cursor: number;
        variables: VariableValue[];
      }>("/variables/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [...targets.values()] }),
      });
      this.model.applyVariableRead(result);
      try {
        await this.client.resolveVariableChain(
          requestId,
          result.variables,
          keepLocal,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof RuntimeClientError) ||
          error.code !== "RESOLUTION_CHANGED"
        )
          throw error;
      }
    }
    throw new Error("Changes continued during conflict resolution; try again");
  }
  static async connect(host: Host) {
    // Pin the authority by origin. A replacement database must not inherit old pending work.
    const key = "risu-runtime-authority:" + location.origin;
    const pinned = localStorage.getItem(key);
    const headers = pinned ? { "Risu-Runtime-Id": pinned } : {};
    const response = await runtimeFetch("/api/runtime/bootstrap", {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = await runtimeHttpFailure(
        response,
        "Cannot connect to runtime",
      );
      if (error.requestId) error.message += ` (request ${error.requestId})`;
      throw error;
    }
    const body = await response.json();
    const snapshot = body as RuntimeBootstrap;
    if (!snapshot.serverId || (pinned && pinned !== snapshot.serverId))
      throw new RuntimeClientError(
        "SERVER_CHANGED",
        "Server database changed; pending work needs reconciliation",
      );
    if (!pinned) localStorage.setItem(key, snapshot.serverId);
    const runtime = new BrowserRuntimeController(host, snapshot.serverId);
    try {
      await runtime.client.start();
      RuntimeUIState.ready = true;
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  async selectCharacter(id: string, chatId?: string) {
    this.closeBookmarkList();
    const selection = ++this.selection;
    this.historyNavigation++;
    RuntimeUIState.historyViewGeneration++;
    RuntimeUIState.loadingHistory = false;
    const selected = await this.model.selectCharacter(id, chatId);
    if (!selected || selection !== this.selection) return false;
    this.selectedId = id;
    this.refreshGroups();
    this.host.selected(this.model.characterIndex(id));
    await this.hydrateJobs();
    await this.hydrateDisplay();
    if (selection !== this.selection) return false;
    this.refreshPresentation();
    RuntimeUIState.scopeReady = true;
    return true;
  }
  private async hydrateDisplay() {
    const chatId = this.model.activeChatId,
      characterId = this.selectedId;
    if (!chatId || !characterId) return;
    this.display.begin(chatId, characterId);
    for (let attempt = 0; attempt < 3; attempt++) {
      let snapshot: DisplayState,
        after: string | null = null;
      const applied: string[] = [];
      let changed = false;
      do {
        const page = await this.client.read<DisplayState>(
          "/chats/" +
            encodeURIComponent(chatId) +
            "/display?limit=1000" +
            (after ? "&after=" + after : ""),
        );
        if (chatId !== this.model.activeChatId) return;
        if (
          snapshot &&
          (page.inputClock !== snapshot.inputClock ||
            page.chatEpoch !== snapshot.chatEpoch ||
            page.characterEpoch !== snapshot.characterEpoch)
        ) {
          changed = true;
          break;
        }
        snapshot ??= page;
        applied.push(...page.applied);
        after = page.next;
      } while (after);
      if (
        !changed &&
        this.display.install({ ...snapshot, applied, next: null })
      ) {
        RuntimeUIState.displayRevision++;
        return;
      }
      this.display.begin(chatId, characterId);
    }
    throw new Error(
      "Display state changed repeatedly while opening this chat; reopen the chat",
    );
  }
  captureDisplayHeader(
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
  ): BrowserDisplayHeader | undefined {
    // Capture fresh ownership/source metadata without enumerating definitions.
    // The display cache pins the body before awaiting, once per source change.
    const chatId = this.model.activeChatId,
      characterId = this.selectedId,
      state = this.display.state;
    if (
      !RuntimeUIState.scopeReady ||
      !this.display.ready ||
      !state ||
      state.chatId !== chatId ||
      state.characterId !== characterId ||
      this.displayProjectedCursor < state.cursor ||
      // observe() advances the input clock before an asynchronous body/resource
      // projection completes. Server CAS alone cannot detect values read from
      // the previous body but tagged with that already-current input clock.
      this.displayProjectedCursor < state.inputClock ||
      (expectedCharacterId && expectedCharacterId !== characterId)
    )
      return;
    const char =
      this.model.database.characters[this.model.characterIndex(characterId)];
    const originalChat = this.model.activeChat;
    if (!char || !originalChat) return;
    if (expectedMessageId && !firstMessage) {
      index = originalChat.message.findIndex(
        (message) => message.chatId === expectedMessageId,
      );
      if (index < 0) return;
    }
    const history = this.model.displayHistory(firstMessage ? -1 : index);
    if (!history)
      throw new Error(
        "Display history metadata is unavailable; refresh the conversation",
      );
    // A page may include mutations not yet applied by the SSE projection.
    if (history.cursor > this.displayProjectedCursor) return;
    const message =
      firstMessage || index < 0 ? undefined : originalChat.message[index];
    const revision = message ? this.model.messageRevision(message.chatId) : 0;
    return {
      projectedCursor: this.displayProjectedCursor,
      historyWindow: this.model.displayWindow(),
      history,
      serverId: this.serverId,
      state: { ...state },
      aiModel: this.model.database.aiModel,
      versions: this.model.captureVariableVersions(chatId),
      sourceContent:
        firstMessage && char.type !== "group"
          ? originalChat.fmIndex === -1 || originalChat.fmIndex === undefined
            ? char.firstMessage
            : char.alternateGreetings[originalChat.fmIndex]
          : message && revision
            ? message.data
            : undefined,
      message:
        message && revision
          ? {
              id: message.chatId,
              revision,
              origin: this.model.messageDisplayOrigin(message.chatId),
            }
          : undefined,
      hasEarlier: this.model.hasEarlier,
      persistent: firstMessage || index < 0 || Boolean(message && revision),
    };
  }
  captureProvisionalDisplayHeader(
    messageId: string,
    expectedCharacterId?: string,
  ): { header: BrowserDisplayHeader; rows: Message[] } | undefined {
    const header = this.captureDisplayHeader(-1, false, expectedCharacterId);
    if (
      !header ||
      this.model.isWindowed ||
      header.state.chatEpoch !==
        this.model.entityHeader("chat", header.state.chatId).epoch ||
      header.state.characterEpoch !==
        this.model.entityHeader("character", header.state.characterId).epoch ||
      this.model.activeChat.message.some((row) => row.chatId === messageId)
    )
      return;
    const rows = this.provisionalMessages();
    if (!rows.some((row) => row.chatId === messageId)) return;
    return { header, rows };
  }
  captureDisplay(
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
  ): DisplayCapture | undefined {
    const header = this.captureDisplayHeader(
      index,
      firstMessage,
      expectedCharacterId,
      expectedMessageId,
    );
    return header && this.displayBody(header);
  }
  private displayBody(header: BrowserDisplayHeader): DisplayCapture {
    const char =
      this.model.database.characters[
        this.model.characterIndex(header.state.characterId)
      ];
    const chat = { ...this.model.activeChat };
    const character = {
      ...char,
      chats: [chat],
      chatPage: 0,
      triggerscript: char.type === "group" ? [] : (char.triggerscript ?? []),
    };
    const database = { ...this.model.database, characters: [character] };
    const { aiModel: _aiModel, ...fields } = header;
    return {
      ...fields,
      character,
      chat,
      database,
      triggers: character.triggerscript as triggerscript[],
    };
  }
  openBookmarkList() {
    if (!RuntimeUIState.scopeReady) throw Error("Conversation is not ready");
    return this.bookmarks.open();
  }
  loadBookmarkPage(session: string, after?: string) {
    return this.bookmarks.load(session, after);
  }
  closeBookmarkList(session?: string) {
    // An older component's destruction cannot close a newly opened list.
    const currentSession = RuntimeUIState.bookmarkList.session;
    this.bookmarks?.close(session);
    if (currentSession && !RuntimeUIState.bookmarkList.session)
      closeBookmarkDisplayScopes();
    if (this.bookmarkRefresh && !RuntimeUIState.bookmarkList.session) {
      clearTimeout(this.bookmarkRefresh);
      this.bookmarkRefresh = undefined;
    }
  }
  private scheduleBookmarkRefresh() {
    if (this.bookmarkRefresh || !RuntimeUIState.bookmarkList.session) return;
    this.bookmarkRefresh = setTimeout(() => {
      this.bookmarkRefresh = undefined;
      const session = RuntimeUIState.bookmarkList.session;
      if (session)
        void this.loadBookmarkPage(session).catch(reportRuntimeError);
    }, 20);
  }
  bookmarkPreviewCurrent(token: string, id: string, revision: number) {
    return (
      this.bookmarks
        .presentation(token)
        ?.items.some(
          (item) => item.messageId === id && item.messageRevision === revision,
        ) ?? false
    );
  }
  private bookmarkDisplayOwner(token: string, id?: string) {
    const page = this.bookmarks.presentation(token);
    const base = page && this.captureDisplayHeader(-1, true);
    if (!base || page.cursor > this.displayProjectedCursor) return;
    const item = id && page.items.find((row) => row.messageId === id);
    if (id && !item) return;
    const ordered = [...page.items].sort((a, b) => a.ordinal - b.ordinal);
    const header: BrowserDisplayHeader = {
      ...base,
      history: {
        count: page.historyCount,
        cursor: page.cursor,
        ...(item ? { ordinal: item.ordinal } : {}),
      },
      historyWindow: ordered.map(
        (row) => [row.messageId, row.ordinal] as const,
      ),
      sourceContent: item ? item.message.data : undefined,
      message: item
        ? {
            id: item.messageId,
            revision: item.messageRevision,
            ...(item.displayOrigin
              ? { origin: { ...item.displayOrigin } }
              : {}),
          }
        : undefined,
      hasEarlier: ordered.length < page.historyCount,
      persistent: Boolean(item),
    };
    return { header, ordered };
  }
  captureBookmarkDisplayHeader(
    token: string,
    id?: string,
  ): BrowserDisplayHeader | undefined {
    return this.bookmarkDisplayOwner(token, id)?.header;
  }
  captureBookmarkDisplay(
    token: string,
    id?: string,
  ): DisplayCapture | undefined {
    const owner = this.bookmarkDisplayOwner(token, id);
    if (!owner) return;
    const capture = this.displayBody(owner.header);
    const chat = {
      ...capture.chat,
      message: owner.ordered.map((row) => row.message),
    };
    const character = { ...capture.character, chats: [chat] };
    return {
      ...capture,
      database: { ...capture.database, characters: [character] },
      character,
      chat,
    };
  }
  displaySeen(key: string, capture: DisplayCapture) {
    return (
      this.display.seen(key, capture.state.inputClock) ||
      this.rejectedDisplay.get(key) === capture.state.inputClock
    );
  }
  pendingDisplay(key: string) {
    const entry = RuntimeUIState.pending.find(
      (e) =>
        e.command.type === "apply-display-effects" &&
        e.command.displayKey === key,
    );
    // Rejected intent stays reviewable in IDB, but must not pretend to be confirmed UI state.
    if (entry?.state === "blocked") return { ...entry.command, edits: [] };
    return this.displayDrafts.get(key) ?? entry?.command;
  }
  async submitDisplay(command: RuntimeCommand, capture: DisplayCapture) {
    // Navigation does not redirect the captured chat ID. Server CAS guards any later change.
    if (
      this.pendingDisplay(String(command.displayKey)) ||
      this.displaySeen(String(command.displayKey), capture)
    )
      return;
    const key = String(command.displayKey);
    this.displayDrafts.set(key, command);
    try {
      await this.client.enqueue("command", command);
    } catch (error) {
      this.displayDrafts.delete(key);
      throw error;
    }
  }
  async previewJobResult(jobId: string) {
    return this.client.read<import("./jobResults").JobResultPreview>(
      "/jobs/" + encodeURIComponent(jobId) + "/result",
    );
  }
  jobHistoryOwner() {
    const chatId = this.model.activeChatId;
    return this.selectedId && chatId
      ? {
          chatId,
          chatEpoch: this.model.entityHeader("chat", chatId).epoch,
          selection: this.selection,
        }
      : null;
  }
  readJobHistory(
    owner: import("./jobHistory").JobHistoryOwner,
    filter: import("./jobHistory").JobHistoryFilter,
    after?: string,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      expectedEpoch: String(owner.chatEpoch),
      filter,
      limit: "20",
    });
    if (after !== undefined) params.set("after", after);
    return this.client.read<import("./jobHistory").JobHistoryPage>(
      "/chats/" + encodeURIComponent(owner.chatId) + "/job-history?" + params,
      { signal },
    );
  }
  async observeJob(jobId: string) {
    const owner = this.jobHistoryOwner();
    if (!owner) throw new Error("Select a conversation before reviewing a job");
    const job = await this.client.read<RuntimeJob>(
      "/jobs/" + encodeURIComponent(jobId) + "/status",
    );
    const current = this.jobHistoryOwner();
    if (
      !current ||
      current.chatId !== owner.chatId ||
      current.chatEpoch !== owner.chatEpoch ||
      current.selection !== owner.selection ||
      job.chatId !== owner.chatId ||
      (job.chatEpoch ?? 0) !== owner.chatEpoch
    )
      throw new Error("The conversation changed while opening its job");
    // Viewing history is not a new completion/receipt: never hydrate the active
    // message window, acknowledge durable intent or grow the live-job registry.
    return job;
  }
  async previewMemorySummary(jobId: string) {
    return this.client.read<import("./memorySummaries").MemorySummaryPreview>(
      "/jobs/" + encodeURIComponent(jobId) + "/memory-summary",
    );
  }
  async cancelMemorySummary(jobId: string) {
    const job = await this.client.read<RuntimeJob>(
      "/jobs/" + encodeURIComponent(jobId),
    );
    if (job.type !== "memory-summary")
      throw new Error("This is not a memory summary job");
    await this.client.read("/jobs/" + encodeURIComponent(jobId) + "/cancel", {
      method: "POST",
    });
    await this.refreshJob(jobId);
  }
  async applyMemorySummary(
    preview: import("./memorySummaries").MemorySummaryPreview,
    dismiss = false,
    editedText?: string,
  ) {
    await this.execute({
      type: dismiss ? "dismiss-memory-summary" : "apply-memory-summary",
      jobId: preview.jobId,
      chatId: preview.chatId,
      expectedChatEpoch: preview.expectedChatEpoch,
      ...(editedText === undefined ? {} : { editedText }),
    });
    await this.refreshJob(preview.jobId);
  }
  async summarizeMemory(
    mode: "single" | "bulk",
    indices: number[],
    chatId = this.model.activeChatId,
    expectedSource?: { revision: number; epoch: number },
  ) {
    if (
      !RuntimeUIState.ready ||
      !chatId ||
      !this.model.chatMetadataLoaded(chatId)
    )
      throw new Error("Memory data is still loading");
    const relevant = (edit: FieldEdit) =>
      (edit.scope === "chat" && edit.entityId === chatId) ||
      edit.scope === "resource";
    if (
      [...this.fieldDrafts.values()].some((edits) => edits.some(relevant)) ||
      RuntimeUIState.pending.some((entry) =>
        fieldEdits(entry.command).some(relevant),
      )
    )
      throw new Error(
        "Wait for pending memory and configuration edits before re-summary",
      );
    const header = this.fieldHeader({
      scope: "chat",
      entityId: chatId,
      key: "hypaV3Data",
    });
    if (
      expectedSource &&
      (header.epoch !== expectedSource.epoch ||
        header.revision !== expectedSource.revision)
    )
      throw new Error(
        "The selected memory changed; reopen the selection before re-summary",
      );
    return (
      await this.client.enqueue("job", {
        type: "memory-summary",
        chatId,
        expectedChatEpoch: header.epoch,
        expectedMemoryRevision: header.revision,
        mode,
        indices: [...indices],
      })
    ).requestId;
  }
  memorySourceClock(chatId: string) {
    if (chatId !== this.model.activeChatId || !this.selectedId)
      return "conversation-changed";
    const chat = this.model.entityHeader("chat", chatId);
    const character = this.model.entityHeader("character", this.selectedId);
    return `${chat.epoch}:${chat.revision}:${character.epoch}:${character.revision}`;
  }
  async readMemorySource(
    chatId: string,
    request: import("./memorySources").MemorySourceRequest,
  ) {
    return this.client.read<import("./memorySources").MemorySourceResponse>(
      "/chats/" + encodeURIComponent(chatId) + "/memory-source",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }
  async recoverJobResult(target: import("./jobResults").JobResultTarget) {
    await this.execute({ type: "recover-job-result", ...target });
    await this.refreshJob(target.jobId);
  }
  async retryJobResult(target: import("./jobResults").JobResultTarget) {
    await this.execute({ type: "retry-job-result", ...target });
    await this.refreshJob(target.jobId);
  }
  private replyChoicePreparations = new Map<string, ReplyChoicePreparation>();
  private replyChoiceFailures = new Map<
    string,
    ReplyChoicePreparation & { error: string }
  >();
  private replyChoiceClosed = false;
  private replyChoiceView(chatId: string, epoch: number) {
    return replyChoiceActivity(
      { chatId, epoch },
      this.replyChoicePreparations.get(chatId),
      this.replyChoiceFailures.get(chatId),
      RuntimeUIState.pending,
      [...this.jobs.values()],
    );
  }
  private refreshReplyChoice() {
    if (this.replyChoiceClosed) return;
    const chatId = this.model.activeChatId;
    RuntimeUIState.replyChoice = chatId
      ? this.replyChoiceView(
          chatId,
          this.model.entityHeader("chat", chatId).epoch,
        )
      : null;
  }
  async moveReplyChoice(direction: "previous" | "next") {
    if (!RuntimeUIState.scopeReady || !this.model.activeChatId)
      throw new Error("Chat is still loading");
    const chatId = this.model.activeChatId;
    const message = this.model.activeChat.message.at(-1);
    if (!message || message.role !== "char")
      throw new Error("No assistant reply to select");
    const epoch = this.model.entityHeader("chat", chatId).epoch;
    if (this.replyChoiceView(chatId, epoch)?.busy) return;
    const requestId = crypto.randomUUID();
    const preparation: ReplyChoicePreparation = {
      chatId,
      epoch,
      messageId: message.chatId,
      requestId,
      direction,
      stage: "preparing",
    };
    // Pin identity before the header request. Navigation never redirects intent;
    // the server rejects edits or a history window that is not the current tail.
    const query = new URLSearchParams({
      messageId: message.chatId,
      revision: String(this.model.messageRevision(message.chatId)),
      epoch: String(epoch),
    });
    this.replyChoiceFailures.delete(chatId);
    this.replyChoicePreparations.set(chatId, preparation);
    this.refreshReplyChoice();
    try {
      const header = await this.client.read<
        import("./replyChoices").ReplyChoiceHeader
      >("/chats/" + encodeURIComponent(chatId) + "/choices?" + query);
      if (this.replyChoiceClosed)
        throw new Error("Runtime closed before selection admission");
      preparation.stage = "saving";
      this.refreshReplyChoice();
      await this.execute(
        {
          type: "move-reply-choice",
          ...header.target,
          direction,
        },
        requestId,
      );
    } catch (error) {
      if (!this.replyChoiceClosed) {
        this.replyChoiceFailures.set(chatId, {
          ...preparation,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.replyChoiceFailures.size > 512)
          this.replyChoiceFailures.delete(
            this.replyChoiceFailures.keys().next().value,
          );
      }
      throw error;
    } finally {
      if (
        this.replyChoicePreparations.get(chatId)?.requestId ===
        preparation.requestId
      )
        this.replyChoicePreparations.delete(chatId);
      this.refreshReplyChoice();
    }
  }
  private async hydrateJobs() {
    const chatId = this.model.activeChatId;
    if (!chatId) return;
    const rows = await this.client.read<
      { id: string; state: string; type: string }[]
    >("/chats/" + encodeURIComponent(chatId) + "/jobs");
    const pending = new Set(
      RuntimeUIState.pending.map((entry) => entry.requestId),
    );
    await Promise.all(
      rows
        .filter(
          (row, index) =>
            index === 0 ||
            row.type === "memory-summary" ||
            row.state !== "completed" ||
            pending.has(row.id),
        )
        .map((row) => this.refreshJob(row.id)),
    );
  }
  private async refreshJob(id: string) {
    const job = await this.client.read<RuntimeJob>(
      "/jobs/" + encodeURIComponent(id) + "/status",
    );
    const old = this.jobs.get(id);
    // Responses can race between hydration, receipts and journal projection.
    if (
      old &&
      (old.fence > job.fence ||
        old.progressRevision > job.progressRevision ||
        (old.disposition && !job.disposition) ||
        (terminal.has(old.state) && !terminal.has(job.state)))
    )
      return;
    if (!terminal.has(job.state) && !this.commands.has(id))
      this.commands.set(
        id,
        await this.client.read("/jobs/" + encodeURIComponent(id) + "/command"),
      );
    // A receipt/read can see completion before the event feed projects its writes.
    // Hydrate those writes before removing progress or acknowledging the durable intent.
    if (
      terminal.has(job.state) &&
      !terminal.has(old?.state) &&
      job.chatId === this.model.activeChatId &&
      (job.chatEpoch ?? 0) === this.model.entityHeader("chat", job.chatId).epoch
    )
      await this.model.refreshActive();
    this.jobs.set(id, job);
    if (RuntimeUIState.historyResultJob?.id === id)
      RuntimeUIState.historyResultJob = job;
    if (terminal.has(job.state)) {
      this.commands.delete(id);
      if (
        job.state !== "completed" &&
        !terminal.has(old?.state) &&
        !job.disposition
      )
        reportRuntimeError(new Error(jobFailureMessage(job)));
      for (const waiter of this.waiters.get(id) ?? [])
        job.state === "completed"
          ? waiter.resolve()
          : waiter.reject(new Error("Job " + job.state));
      this.waiters.delete(id);
      await this.client.acknowledgeJob(id);
    }
    this.refreshPresentation();
  }
  private provisionalMessages(): Message[] {
    const chatId = this.model.activeChatId;
    if (!chatId || !this.model.activeChat || this.model.isWindowed) return [];
    const epoch = this.model.entityHeader("chat", chatId).epoch;
    const messages: Message[] = [];
    const ids = new Set<string>();
    const add = (message: Message) => {
      if (!message.chatId || ids.has(message.chatId)) return;
      ids.add(message.chatId);
      messages.push(message);
    };
    for (const entry of RuntimeUIState.pending) {
      if (
        entry.kind === "job" &&
        entry.state !== "blocked" &&
        entry.command.chatId === chatId &&
        (entry.command.expectedChatEpoch ?? 0) === epoch &&
        entry.command.type === "send"
      ) {
        const job = this.jobs.get(entry.requestId);
        if (!job || !terminal.has(job.state))
          add({
            role: "user",
            data: String(entry.command.input),
            chatId: String(entry.command.messageId),
          });
      }
    }
    for (const job of this.jobs.values()) {
      if (
        job.chatId !== chatId ||
        job.type === "memory-summary" ||
        (job.chatEpoch ?? 0) !== epoch ||
        terminal.has(job.state)
      )
        continue;
      const command = this.commands.get(job.id);
      if (
        command?.type === "send" &&
        command.chatId === chatId &&
        (command.expectedChatEpoch ?? 0) === epoch
      )
        add({
          role: "user",
          data: String(command.input),
          chatId: String(command.messageId),
        });
      for (const message of job.progress.messages ?? []) add(message);
    }
    return messages;
  }
  private refreshPresentation() {
    const chatId = this.model.activeChatId;
    const chat = this.model.activeChat;
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        job.chatId === chatId &&
        (job.chatEpoch ?? 0) === this.model.entityHeader("chat", chatId).epoch,
    );
    RuntimeUIState.jobs = jobs;
    RuntimeUIState.hasEarlier = this.model.hasEarlier;
    RuntimeUIState.hasLater = this.model.hasLater;
    RuntimeUIState.historicalWindow = this.model.isWindowed;
    RuntimeUIState.newerMessageCount = this.model.newerMessageCount;
    const messages: Message[] = [...(chat?.message ?? [])];
    const byId = new Map(messages.map((m, i) => [m.chatId, i]));
    const add = (m: Message) => {
      if (!m.chatId) return;
      const index = byId.get(m.chatId);
      if (index !== undefined) return; // Confirmed records always beat presentation overlays.
      byId.set(m.chatId, messages.length);
      messages.push(m);
    };
    for (const message of this.provisionalMessages()) add(message);
    // Keep reactive presentation objects through streaming and confirmation; keys never use text.
    const keep = new Set<string>();
    const next = messages.map((m) => {
      const id = m.chatId;
      keep.add(id);
      let value = this.presentation.get(id);
      if (value) reconcileValue(value, m);
      else {
        RuntimeUIState.messages.push(structuredClone($state.snapshot(m)));
        value = RuntimeUIState.messages.at(-1);
        this.presentation.set(id, value);
      }
      return value;
    });
    if (
      RuntimeUIState.messages.length !== next.length ||
      RuntimeUIState.messages.some((value, index) => value !== next[index])
    )
      RuntimeUIState.messages.splice(
        0,
        RuntimeUIState.messages.length,
        ...next,
      );
    for (const id of this.presentation.keys())
      if (!keep.has(id)) this.presentation.delete(id);
    const active = jobs.find(
      (job) =>
        !terminal.has(job.state) &&
        ["send", "continue", "reroll"].includes(job.type),
    );
    const pending = RuntimeUIState.pending.some(
      (entry) =>
        entry.kind === "job" &&
        entry.command.chatId === chatId &&
        entry.command.type !== "button" &&
        entry.command.type !== "memory-summary" &&
        entry.command.type !== "apply-display-effects" &&
        entry.state !== "blocked" &&
        !terminal.has(this.jobs.get(entry.requestId)?.state),
    );
    if (chat) chat.isStreaming = Boolean(active?.progress.streaming);
    this.host.busy(
      Boolean(active || pending),
      Number(active?.progress.stage ?? 0),
    );
    this.refreshReplyChoice();
  }
  async enqueue(command: RuntimeCommand) {
    return (await this.client.enqueue("command", command)).requestId;
  }
  async acknowledgeNotice(noticeId: string, expectedRevision: number) {
    await this.execute({
      type: "acknowledge-notice",
      noticeId,
      expectedRevision,
    });
    await this.notices.refresh();
  }
  async answerInteraction(
    interactionId: string,
    expectedRevision: number,
    answer: string | boolean,
  ) {
    await this.execute({
      type: "answer-interaction",
      interactionId,
      expectedRevision,
      answer,
    });
    await this.interactions.refresh();
  }
  async cancelInteraction(interactionId: string, expectedRevision: number) {
    await this.execute({
      type: "cancel-interaction",
      interactionId,
      expectedRevision,
    });
    await this.interactions.refresh();
  }
  refreshInteractions() {
    void this.interactions.refresh();
  }
  refreshNotices() {
    void this.notices.refresh();
  }
  private async execute(command: RuntimeCommand, id = crypto.randomUUID()) {
    // Register before admission: a fast receipt/feed must not outrun the waiter.
    const projected = new Promise<void>((resolve, reject) =>
      this.commandWaiters.set(id, { resolve, reject }),
    );
    // Attach immediately, including errors during the asynchronous IDB write.
    projected.catch(() => {});
    try {
      await this.client.enqueue("command", command, id);
      await projected;
    } finally {
      this.commandWaiters.delete(id);
    }
  }
  async createCharacter(
    value: Record<string, Json>,
    metadata: Record<string, Json>,
  ) {
    const id = String(value.chaId ?? v4()),
      chatId = String(metadata.id ?? v4());
    await this.execute({
      type: "create-character",
      characterId: id,
      definition: value,
      chat: { chatId, metadata },
    });
    await this.selectCharacter(id, chatId);
    return id;
  }
  async createChat(characterId: string, metadata: Record<string, Json>) {
    const chatId = String(metadata.id ?? v4());
    const header = this.model.entityHeader("character", characterId);
    await this.execute({
      type: "create-chat",
      characterId,
      expectedCharacterEpoch: header.epoch,
      chatId,
      metadata,
      prepend: true,
    });
    await this.selectCharacter(characterId, chatId);
    return chatId;
  }
  captureChatFolder(characterId: string, folderId: string): ChatFolderTarget {
    if (!RuntimeUIState.ready || !this.model.characterLoaded(characterId))
      throw new Error("Chat folders are not ready");
    const folder = this.model.fieldVersion({
      scope: "character",
      entityId: characterId,
      key: "chatFolders",
    });
    if (this.model.entityHeader("character", characterId).deleted)
      throw new Error("The character was removed");
    return {
      characterId,
      folderId,
      expectedCharacterEpoch: folder.entityEpoch,
      expectedFolderRevision: folder.revision,
    };
  }
  private characterNavigationOverlay() {
    const values = [
      ...RuntimeUIState.pending
        .filter((entry) => entry.state !== "blocked")
        .map((entry) => entry.command),
      ...this.characterNavigationDrafts.values(),
    ];
    const epoch = this.model.fieldVersion({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "characterOrder",
    }).entityEpoch;
    return values.findLast(
      (value) =>
        value.type === "change-character-navigation" &&
        value.expectedSettingsEpoch === epoch,
    );
  }
  captureCharacterNavigation(): CharacterNavigationTarget {
    if (!RuntimeUIState.ready)
      throw new Error("Character navigation is not ready");
    if (
      this.characterNavigationOverlay() ||
      FieldOverlays.has(
        fieldIdentity({
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "characterOrder",
        }),
      )
    )
      throw new Error("A character navigation change is already pending");
    return this.model.characterNavigationTarget();
  }
  characterNavigationOrder() {
    // Read the confirmed reactive view, including its members, so a server
    // projection invalidates this UI computation without changing DBState early.
    const confirmed = JSON.parse(
      JSON.stringify(this.model.database.characterOrder),
    );
    const command = this.characterNavigationOverlay();
    if (!command) return confirmed;
    try {
      return projectCharacterOrder(
        applyCharacterNavigation(
          this.model.characterOrderSource(),
          command.action as unknown as CharacterNavigationAction,
          this.model.visibleCharacterIds(),
        ),
        this.model.visibleCharacterIds(),
      );
    } catch {
      // The authority may have invalidated an immutable pending intent. Its
      // explicit blocked receipt remains in the outbox for review/discard.
      return confirmed;
    }
  }
  async changeCharacterNavigation(
    target: CharacterNavigationTarget,
    action: CharacterNavigationAction,
  ) {
    if (this.characterNavigationOverlay())
      throw new Error("A character navigation change is already pending");
    const command = JSON.parse(
      commandJson({ type: "change-character-navigation", ...target, action }),
    ) as RuntimeCommand;
    const token = crypto.randomUUID();
    this.characterNavigationDrafts = new Map(
      this.characterNavigationDrafts,
    ).set(token, command);
    try {
      await this.execute(command);
    } finally {
      const next = new Map(this.characterNavigationDrafts);
      next.delete(token);
      this.characterNavigationDrafts = next;
    }
  }
  captureChatNavigation(characterId: string): ChatNavigationTarget {
    const folder = this.captureChatFolder(characterId, ""),
      navigation = this.model.chatNavigationHeader(characterId);
    if (this.chatNavigationOverlay(characterId))
      throw new Error("A chat navigation change is already pending");
    const character =
      this.model.database.characters[this.model.characterIndex(characterId)];
    return {
      characterId,
      expectedCharacterEpoch: folder.expectedCharacterEpoch,
      expectedFolderRevision: folder.expectedFolderRevision,
      expectedNavigationRevision: navigation.revision,
      members: character.chats.map((chat) => {
        const field = this.model.fieldVersion({
          scope: "chat",
          entityId: chat.id,
          key: "folderId",
        });
        return {
          chatId: chat.id,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
        };
      }),
    };
  }
  setChatFolders(target: ChatFolderTarget, value: Json) {
    const field = {
      scope: "character" as const,
      entityId: target.characterId,
      key: "chatFolders",
    };
    const current = this.model.fieldVersion(field);
    if (
      current.entityEpoch !== target.expectedCharacterEpoch ||
      current.revision !== target.expectedFolderRevision
    )
      throw new RuntimeClientError(
        "REVISION_CONFLICT",
        "The captured chat folder list changed",
      );
    this.setField(field, value);
  }
  chatNavigationOverlay(characterId: string) {
    const epoch = this.model.entityHeader("character", characterId).epoch;
    const values = [
      ...RuntimeUIState.pending
        .filter((entry) => entry.state !== "blocked")
        .map((entry) => entry.command),
      ...this.navigationDrafts.values(),
    ];
    return values.findLast(
      (command) =>
        ["remove-chat-folder", "reorder-chat-navigation"].includes(
          command.type,
        ) &&
        command.characterId === characterId &&
        command.expectedCharacterEpoch === epoch,
    );
  }
  private async executeNavigation(command: RuntimeCommand) {
    const token = crypto.randomUUID();
    this.navigationDrafts = new Map(this.navigationDrafts).set(token, command);
    try {
      await this.execute(command);
    } finally {
      const next = new Map(this.navigationDrafts);
      next.delete(token);
      this.navigationDrafts = next;
    }
  }
  async removeChatFolder(target: ChatFolderTarget) {
    if (this.chatNavigationOverlay(target.characterId))
      throw new Error("A chat navigation change is already pending");
    await this.executeNavigation({ type: "remove-chat-folder", ...target });
  }
  async reorderChatNavigation(
    target: ChatNavigationTarget,
    folderIds: string[],
    chatIds: string[],
    moved?: { chatId: string; folderId: string | null },
  ) {
    const { members, ...owner } = target;
    const member = moved
      ? members.find((value) => value.chatId === moved.chatId)
      : undefined;
    if (moved && !member)
      throw new Error("The dragged chat was not in the captured navigation");
    await this.executeNavigation(
      JSON.parse(
        commandJson({
          type: "reorder-chat-navigation",
          ...owner,
          folderIds: [...folderIds],
          chatIds: [...chatIds],
          memberships: moved ? [{ ...member, folderId: moved.folderId }] : [],
        }),
      ),
    );
  }
  async cloneChat(chatId: string, name: string) {
    const source = this.model.entityHeader("chat", chatId);
    const copyId = v4();
    await this.execute({
      type: "clone-chat",
      sourceChatId: chatId,
      chatId: copyId,
      name,
      expectedRevision: source.revision,
      expectedEpoch: source.epoch,
    });
    if (this.selectedId) await this.selectCharacter(this.selectedId, copyId);
    return copyId;
  }
  private branchInputsPending(chatId: string, epoch: number) {
    const field = (edit: FieldEdit) =>
      (edit.scope === "chat" && edit.entityId === chatId) ||
      (edit.scope === "character" &&
        edit.entityId === this.selectedId &&
        edit.key === "chatFolders") ||
      (edit.scope === "resource" &&
        edit.resourceKind === "settings" &&
        edit.entityId === "global" &&
        edit.key === "createFolderOnBranch");
    const variable = (edit: VariableEdit) =>
      "chatId" in edit && edit.chatId === chatId;
    return (
      [...this.fieldDrafts.values()].some((edits) => edits.some(field)) ||
      [...this.variableDrafts.values()].some((edits) => edits.some(variable)) ||
      RuntimeUIState.pending.some(
        (entry) =>
          fieldEdits(entry.command).some(field) ||
          variableEdits(entry.command).some(variable) ||
          entry.command.chatId === chatId,
      ) ||
      RuntimeUIState.jobs.some(
        (job) =>
          job.chatId === chatId &&
          (job.chatEpoch ?? 0) === epoch &&
          !terminal.has(job.state),
      )
    );
  }
  pendingBranch(id: string) {
    RuntimeUIState.displayRevision;
    const chatId = this.model.activeChatId;
    if (!chatId || !id) return false;
    const epoch = this.model.entityHeader("chat", chatId).epoch;
    return (
      this.branchInputsPending(chatId, epoch) ||
      BranchPreparations.get(JSON.stringify([chatId, id]))?.epoch === epoch ||
      RuntimeUIState.pending.some(
        (entry) =>
          entry.state !== "blocked" &&
          entry.command.type === "branch-chat" &&
          entry.command.sourceChatId === chatId &&
          entry.command.messageId === id &&
          entry.command.expectedChatEpoch === epoch,
      )
    );
  }
  async branchMessage(id: string) {
    const target = this.captureMessageRemoval(id),
      characterId = this.selectedId,
      selection = this.selection;
    if (!characterId || this.pendingBranch(id))
      throw new Error(
        "This branch is already pending or its owner is unavailable",
      );
    const setting = this.model.fieldVersion({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "createFolderOnBranch",
    });
    const folder = this.model.fieldVersion({
      scope: "character",
      entityId: characterId,
      key: "chatFolders",
    });
    const copyId = v4(),
      token = v4(),
      key = JSON.stringify([target.chatId, id]);
    BranchPreparations.set(key, { token, epoch: target.expectedChatEpoch });
    try {
      await this.execute({
        type: "branch-chat",
        sourceChatId: target.chatId,
        chatId: copyId,
        messageId: id,
        expectedRevision: target.expectedRevision,
        expectedChatRevision: target.expectedChatRevision,
        expectedChatEpoch: target.expectedChatEpoch,
        expectedCharacterEpoch: folder.entityEpoch,
        expectedFolderRevision: folder.revision,
        expectedSettingRevision: setting.revision,
        expectedSettingEpoch: setting.entityEpoch,
      });
      // Admission retains its captured owner; finishing must not hijack a later navigation.
      if (
        selection === this.selection &&
        this.selectedId === characterId &&
        this.model.activeChatId === target.chatId
      )
        await this.selectCharacter(characterId, copyId);
      return copyId;
    } finally {
      if (BranchPreparations.get(key)?.token === token)
        BranchPreparations.delete(key);
    }
  }
  async deleteChat(chatId: string) {
    const header = this.model.entityHeader("chat", chatId);
    await this.execute({
      type: "delete-chat",
      chatId,
      expectedRevision: header.revision,
      expectedEpoch: header.epoch,
    });
  }
  async removeCharacter(id: string, permanent: boolean) {
    await this.model.ensureCharacter(id);
    if (permanent) {
      const header = this.model.entityHeader("character", id);
      await this.execute({
        type: "delete-character",
        characterId: id,
        expectedRevision: header.revision,
        expectedEpoch: header.epoch,
      });
    } else {
      this.setField(
        { scope: "character", entityId: id, key: "trashTime" },
        Date.now(),
      );
      this.selectedId = null;
      this.host.selected(-1);
      this.model.clearSelection();
      RuntimeUIState.scopeReady = false;
      this.refreshPresentation();
    }
  }
  async restoreCharacter(id: string) {
    await this.model.ensureCharacter(id);
    this.setField(
      { scope: "character", entityId: id, key: "trashTime" },
      undefined,
    );
  }
  async discardCommand(id: string) {
    await this.client.discardCommand(id);
    for (const [chatId, failure] of this.replyChoiceFailures)
      if (failure.requestId === id) this.replyChoiceFailures.delete(chatId);
    this.refreshReplyChoice();
  }
  async recordImport() {
    await this.execute({ type: "record-import" });
  }
  private assetId(path: string) {
    const match = /^assets\/(?:runtime\/)?([a-f0-9]{64}\.[a-z0-9]{1,16})$/.exec(
      path,
    );
    if (!match) throw new Error("Shared server asset path is required");
    return match[1];
  }
  async uploadAsset(data: Uint8Array, fileName = "") {
    const candidate = fileName.split(".").at(-1)?.toLowerCase() || "png";
    const extension = /^[a-z0-9]{1,16}$/.test(candidate) ? candidate : "bin";
    const asset = await this.client.read<{ path: string }>(
      "/assets?extension=" + extension,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(data).buffer,
      },
      120000,
    );
    this.assetId(asset.path);
    return asset.path;
  }
  readAsset(path: string) {
    return this.client.readBytes(
      "/assets/" +
        this.assetId(path) +
        "?authority=" +
        encodeURIComponent(this.serverId),
    );
  }
  async exportArchive() {
    this.requireExportReady();
    // Keep the complete value detached. Applying it to DBState would defeat pagination.
    return validateOriginalArchive(
      await this.client.read<OriginalArchive>("/archive", {}, 120000),
      this.serverId,
    );
  }
  async exportServerSnapshot(write: (chunk: Uint8Array) => Promise<void>) {
    this.requireExportReady();
    await this.client.downloadServerSnapshot(write);
  }
  private requireExportReady() {
    if (
      RuntimeUIState.pending.length ||
      this.fieldDrafts.size ||
      this.variableDrafts.size ||
      this.groupDrafts.size
    )
      throw new Error(
        "Finish or resolve pending changes before exporting a server backup",
      );
  }
  assetUrl(path: string) {
    return (
      this.baseUrl.replace(/\/$/, "") +
      "/assets/" +
      this.assetId(path) +
      "?authority=" +
      encodeURIComponent(this.serverId)
    );
  }
  private activeLibraryGuard(kind: "preset" | "persona") {
    const key = kind === "preset" ? "botPresetsId" : "selectedPersona";
    const order = (this.model.database as any)[kind + "Ids"] as string[];
    const activeId = order?.[this.model.database[key]];
    if (!activeId) throw new Error("Active library item is not ready");
    const selection = this.model.fieldVersion({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key,
    });
    return {
      expectedActiveId: activeId,
      expectedSelectionRevision: selection.revision,
      expectedSelectionEpoch: selection.entityEpoch,
    };
  }
  personaImageHeader(): PersonaImageHeader {
    const selected = this.activeLibraryGuard("persona"),
      id = selected.expectedActiveId,
      header = this.libraryHeader("persona", id);
    const icon = this.model.fieldVersion({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "userIcon",
    });
    return {
      id,
      ...header,
      selectionRevision: selected.expectedSelectionRevision,
      selectionEpoch: selected.expectedSelectionEpoch,
      iconRevision: icon.revision,
      iconEpoch: icon.entityEpoch,
    };
  }
  async setPersonaImage(path: string, header: PersonaImageHeader) {
    await this.execute({
      type: "set-persona-image",
      kind: "persona",
      resourceId: header.id,
      expectedActiveId: header.id,
      expectedRevision: header.revision,
      expectedEpoch: header.epoch,
      expectedSelectionRevision: header.selectionRevision,
      expectedSelectionEpoch: header.selectionEpoch,
      expectedIconRevision: header.iconRevision,
      expectedIconEpoch: header.iconEpoch,
      path,
    });
  }
  async activateLibrary(
    kind: "preset" | "persona",
    id: string,
    saveCurrent = true,
  ) {
    const guard = this.activeLibraryGuard(kind);
    const resource = await this.model.getLibraryResource(kind, id);
    await this.execute({
      type: "activate-library-resource",
      kind,
      resourceId: id,
      expectedRevision: resource.header.revision,
      expectedEpoch: resource.header.epoch,
      ...guard,
      saveCurrent,
    });
  }
  async saveActiveLibrary(kind: "preset" | "persona") {
    const guard = this.activeLibraryGuard(kind),
      resource = await this.model.getLibraryResource(
        kind,
        guard.expectedActiveId,
      );
    await this.execute({
      type: "save-active-library",
      kind,
      resourceId: guard.expectedActiveId,
      expectedRevision: resource.header.revision,
      expectedEpoch: resource.header.epoch,
      ...guard,
    });
  }
  async loadLibrary(kind: string, search = "") {
    await this.model.loadLibrary(kind, search);
    this.refreshFields();
  }
  async loadLibraryMore(kind: string) {
    await this.model.loadLibraryMore(kind);
  }
  closeLibrary(kind: string) {
    this.model.closeLibrary(kind);
  }
  getLibraryResource(kind: string, id: string) {
    return this.model.getLibraryResource(kind, id);
  }
  libraryHeader(kind: string, id: string) {
    return this.model.libraryHeader(kind, id);
  }
  async saveLibraryResource(
    kind: string,
    payload: Record<string, unknown>,
    expected = { revision: 0, epoch: 0 },
  ) {
    const id = String(payload.id ?? v4());
    await this.execute(
      JSON.parse(
        commandJson({
          type: "save-library-resource",
          kind,
          resourceId: id,
          payload: { ...payload, id },
          expectedRevision: expected.revision,
          expectedEpoch: expected.epoch,
        }),
      ),
    );
    return id;
  }
  async deleteLibraryResource(
    kind: string,
    id: string,
    expected: { revision: number; epoch: number },
  ) {
    await this.execute({
      type: "delete-library-resource",
      kind,
      resourceId: id,
      expectedRevision: expected.revision,
      expectedEpoch: expected.epoch,
    });
  }
  libraryOrderHeader(kind: string) {
    const header = this.model.fieldVersion({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: kind + "Ids",
    });
    return { revision: header.revision, epoch: header.entityEpoch };
  }
  async reorderLibrary(
    kind: string,
    order: string[],
    expected = this.libraryOrderHeader(kind),
  ) {
    await this.execute({
      type: "reorder-library",
      kind,
      order,
      expectedRevision: expected.revision,
      expectedEpoch: expected.epoch,
    });
  }
  async editMessage(id: string, text: string) {
    const revision =
      this.model.messageRevision(id) ||
      this.bookmarks.item(id)?.messageRevision;
    if (!revision) throw new Error("This message is not saved yet");
    return this.enqueue({
      type: "edit-message",
      chatId: this.model.activeChatId,
      messageId: id,
      text,
      expectedRevision: revision,
    });
  }
  captureMessageRemoval(id: string) {
    const chatId = this.model.activeChatId;
    if (
      !RuntimeUIState.scopeReady ||
      !chatId ||
      !id ||
      (!this.model.activeChat?.message.some(
        (message) => message.chatId === id,
      ) &&
        !this.bookmarks.item(id))
    )
      throw new Error("This message is not saved in the selected chat");
    const header = this.model.entityHeader("chat", chatId);
    return Object.freeze({
      chatId,
      messageId: id,
      expectedRevision:
        this.model.messageRevision(id) ||
        this.bookmarks.item(id).messageRevision,
      expectedChatRevision: header.revision,
      expectedChatEpoch: header.epoch,
    });
  }
  pendingBookmark(id: string): BookmarkPending | undefined {
    // A replacement chat incarnation must not inherit an older device intent.
    RuntimeUIState.displayRevision;
    const chatId = this.model.activeChatId;
    if (!chatId || !id) return;
    const epoch = this.model.entityHeader("chat", chatId).epoch;
    const preparation = BookmarkPreparations.get(JSON.stringify([chatId, id]));
    if (preparation?.epoch === epoch)
      return {
        action: preparation.action,
        present: preparation.action !== "remove",
        ...(preparation.name === undefined ? {} : { name: preparation.name }),
      };
    const command = RuntimeUIState.pending.findLast(
      (entry) =>
        entry.state !== "blocked" &&
        entry.command.type === "set-bookmark" &&
        entry.command.chatId === chatId &&
        entry.command.messageId === id &&
        entry.command.expectedChatEpoch === epoch,
    )?.command;
    if (!command) return;
    return {
      action: command.action as BookmarkAction,
      present: command.action !== "remove",
      ...(typeof command.name === "string" ? { name: command.name } : {}),
    };
  }
  async captureBookmark(id: string, action: "toggle" | "rename" | "remove") {
    const saved = this.captureMessageRemoval(id),
      selection = this.selection,
      chat = this.model.activeChat,
      observedCursor = Math.max(
        0,
        this.displayProjectedCursor,
        this.model.chatMetadataCursor(saved.chatId),
        this.bookmarks.current()?.cursor ?? 0,
      );
    if (this.pendingBookmark(id))
      throw new Error("Bookmark is already pending");
    const preview = this.bookmarks.item(id);
    const present = preview
      ? true
      : Array.isArray(chat.bookmarks) && chat.bookmarks.includes(id);
    const names = chat.bookmarkNames;
    const nameExists = preview
        ? preview.nameExists
        : names != null && id in names && Object.hasOwn(names, id),
      nameJson = nameExists
        ? commandJson(preview ? preview.name : names[id])
        : undefined;
    const resolved: BookmarkAction =
      action === "toggle" ? (present ? "remove" : "add") : action;
    const key = JSON.stringify([saved.chatId, id]),
      token = crypto.randomUUID();
    BookmarkPreparations.set(key, {
      token,
      epoch: saved.expectedChatEpoch,
      action: resolved,
    });
    try {
      const header = await this.client.read<{
        entityEpoch: number;
        messageRevision: number | null;
        revision: number;
        present: boolean;
        nameExists: boolean;
        name?: Json;
        changedAfterObservedCursor: boolean;
      }>(
        "/chats/" +
          encodeURIComponent(saved.chatId) +
          "/bookmarks/" +
          encodeURIComponent(id) +
          "?observedCursor=" +
          observedCursor,
      );
      if (
        selection !== this.selection ||
        this.model.activeChatId !== saved.chatId
      )
        throw new Error("Conversation changed while preparing bookmark; retry");
      if (
        header.changedAfterObservedCursor ||
        header.entityEpoch !== saved.expectedChatEpoch ||
        header.messageRevision !== saved.expectedRevision ||
        header.present !== present ||
        header.nameExists !== nameExists ||
        (header.nameExists && commandJson(header.name) !== nameJson)
      )
        throw new RuntimeClientError(
          "REVISION_CONFLICT",
          "Bookmark or message changed; retry from its confirmed state",
        );
      if (resolved !== "add" && !header.present)
        throw new Error("Bookmark does not exist");
      return Object.freeze({
        chatId: saved.chatId,
        messageId: id,
        expectedRevision: header.revision,
        expectedMessageRevision: saved.expectedRevision,
        expectedChatEpoch: saved.expectedChatEpoch,
        action: resolved,
        token,
        ...(header.nameExists ? { name: header.name } : {}),
      });
    } catch (error) {
      if (BookmarkPreparations.get(key)?.token === token)
        BookmarkPreparations.delete(key);
      throw error;
    }
  }
  releaseBookmark(target: Readonly<BookmarkTarget>) {
    const key = JSON.stringify([target.chatId, target.messageId]);
    if (BookmarkPreparations.get(key)?.token === target.token)
      BookmarkPreparations.delete(key);
  }
  async setBookmark(target: Readonly<BookmarkTarget>, name?: string) {
    const key = JSON.stringify([target.chatId, target.messageId]),
      preparation = BookmarkPreparations.get(key);
    if (preparation?.token !== target.token)
      throw new Error("Bookmark preparation was retired; retry");
    if (target.action !== "remove" && typeof name !== "string")
      throw new Error("Bookmark name must be a string");
    BookmarkPreparations.set(key, {
      ...preparation,
      ...(name === undefined ? {} : { name }),
    });
    const {
      chatId,
      messageId,
      expectedRevision,
      expectedMessageRevision,
      expectedChatEpoch,
      action,
    } = target;
    try {
      await this.execute({
        type: "set-bookmark",
        chatId,
        messageId,
        expectedRevision,
        expectedMessageRevision,
        expectedChatEpoch,
        action,
        ...(action === "remove" ? {} : { name }),
      });
    } finally {
      this.releaseBookmark(target);
    }
  }
  async removeMessage(
    target: ReturnType<BrowserRuntimeController["captureMessageRemoval"]>,
    mode: "one" | "from",
  ) {
    await this.execute({ type: "remove-message", ...target, mode });
  }
  captureMessageDisabled(id: string) {
    const target = this.captureMessageRemoval(id);
    const message =
      this.model.activeChat.message.find((message) => message.chatId === id) ??
      this.bookmarks.item(id)?.message;
    return Object.freeze({ ...target, disabled: message.disabled ?? false });
  }
  pendingMessageDisabled(id: string) {
    // Canonical projection can retire an incarnation while IDB intent remains.
    RuntimeUIState.displayRevision;
    const chatId = this.model.activeChatId;
    if (!chatId) return;
    const epoch = this.model.entityHeader("chat", chatId).epoch;
    const revision =
      this.model.messageRevision(id) ||
      this.bookmarks.item(id)?.messageRevision;
    const value = RuntimeUIState.pending.findLast(
      (entry) =>
        entry.state !== "blocked" &&
        entry.command.type === "set-message-disabled" &&
        entry.command.chatId === chatId &&
        entry.command.messageId === id &&
        entry.command.expectedChatEpoch === epoch &&
        entry.command.expectedRevision === revision,
    )?.command.disabled;
    return value === true || value === false || value === "allBefore"
      ? value
      : undefined;
  }
  async setMessageDisabled(
    target: ReturnType<BrowserRuntimeController["captureMessageDisabled"]>,
    disabled: false | true | "allBefore",
  ) {
    const { chatId, messageId, expectedRevision, expectedChatEpoch } = target;
    await this.execute({
      type: "set-message-disabled",
      chatId,
      messageId,
      expectedRevision,
      expectedChatEpoch,
      disabled,
    });
  }
  async send(input: string, type: "send" | "continue" | "reroll" = "send") {
    if (!RuntimeUIState.scopeReady || !this.model.activeChatId)
      throw new Error("Chat is still loading");
    if (this.selectedId && this.groupPending(this.selectedId))
      throw new Error(
        "Wait for the group member change to be saved before generation",
      );
    const command: RuntimeCommand = {
      type,
      chatId: this.model.activeChatId,
      expectedChatEpoch: this.model.entityHeader(
        "chat",
        this.model.activeChatId,
      ).epoch,
    };
    if (type === "send") Object.assign(command, { input, messageId: v4() });
    else {
      const target = this.model.activeChat.message.at(-1);
      if (!target || target.role !== "char")
        throw new Error("No assistant message to " + type);
      Object.assign(command, {
        messageId: target.chatId,
        expectedRevision: this.model.messageRevision(target.chatId),
      });
    }
    return (await this.client.enqueue("job", command)).requestId;
  }
  async button(
    data: string | null,
    manualName: string | null,
    triggerId: string | null,
  ) {
    if (!RuntimeUIState.scopeReady) throw new Error("Chat is still loading");
    const command: RuntimeCommand = {
      type: "button",
      chatId: this.model.activeChatId,
      expectedChatEpoch: this.model.entityHeader(
        "chat",
        this.model.activeChatId,
      ).epoch,
    };
    if (manualName) Object.assign(command, { manualName, triggerId });
    else command.data = data ?? "";
    return (await this.client.enqueue("job", command)).requestId;
  }
  async cancel() {
    const jobs = RuntimeUIState.jobs.filter(
      (job) =>
        !terminal.has(job.state) &&
        ["send", "continue", "reroll"].includes(job.type),
    );
    for (const job of jobs)
      await this.client.read(
        "/jobs/" + encodeURIComponent(job.id) + "/cancel",
        { method: "POST" },
      );
  }
  waitForJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job && terminal.has(job.state))
      return job.state === "completed"
        ? Promise.resolve()
        : Promise.reject(new Error("Job " + job.state));
    return new Promise((resolve, reject) => {
      const rows = this.waiters.get(id) ?? [];
      rows.push({ resolve, reject });
      this.waiters.set(id, rows);
    });
  }
  private historyNavigation = 0;
  private async navigateHistory<T>(read: () => Promise<T>): Promise<T> {
    const generation = ++this.historyNavigation,
      selection = this.selection,
      chatId = this.model.activeChatId;
    RuntimeUIState.historyViewGeneration++;
    RuntimeUIState.loadingHistory = true;
    RuntimeUIState.scopeReady = false;
    try {
      const result = await read();
      if (
        generation === this.historyNavigation &&
        selection === this.selection &&
        chatId === this.model.activeChatId
      ) {
        await this.hydrateDisplay();
        this.refreshPresentation();
        RuntimeUIState.displayScopeRevision++;
      }
      return result;
    } finally {
      if (generation === this.historyNavigation) {
        RuntimeUIState.loadingHistory = false;
        if (selection === this.selection && chatId === this.model.activeChatId)
          RuntimeUIState.scopeReady = true;
      }
    }
  }
  async jumpToMessage(id: string) {
    const generation = this.historyNavigation + 1,
      selection = this.selection,
      chatId = this.model.activeChatId;
    const accepted = await this.navigateHistory(() =>
      this.model.jumpToMessage(id),
    );
    if (
      accepted < 0 ||
      generation !== this.historyNavigation ||
      selection !== this.selection ||
      chatId !== this.model.activeChatId
    )
      return -1;
    // Hydration can await while a peer removes/reorders the selected row.
    return this.model.activeChat.message.findIndex(
      (message) => message.chatId === id,
    );
  }
  async loadLatest() {
    const generation = this.historyNavigation + 1,
      selection = this.selection,
      chatId = this.model.activeChatId;
    const accepted = await this.navigateHistory(() => this.model.loadLatest());
    return (
      accepted &&
      generation === this.historyNavigation &&
      selection === this.selection &&
      chatId === this.model.activeChatId
    );
  }
  async loadLater() {
    await this.navigateHistory(() => this.model.loadLater());
  }
  async loadEarlier() {
    if (this.model.isWindowed) {
      await this.navigateHistory(() => this.model.loadEarlier());
      return;
    }
    if (RuntimeUIState.loadingEarlier) return;
    RuntimeUIState.loadingEarlier = true;
    try {
      await this.model.loadEarlier();
      this.refreshPresentation();
    } finally {
      RuntimeUIState.loadingEarlier = false;
    }
  }
  async close() {
    RuntimeUIState.historyResultJob = null;
    this.replyChoiceClosed = true;
    this.replyChoicePreparations.clear();
    this.replyChoiceFailures.clear();
    RuntimeUIState.replyChoice = null;
    this.notices.close();
    this.interactions.close();
    this.closeBookmarkList();
    for (const waiter of this.commandWaiters.values())
      waiter.reject(
        new Error("Runtime closed; durable commands remain pending"),
      );
    this.commandWaiters.clear();
    this.navigationDrafts = new Map();
    this.characterNavigationDrafts = new Map();
    this.groupDrafts.clear();
    GroupOverlays.clear();
    closeDisplayRuntime();
    await this.client.close();
    await this.outbox.close();
  }
}

import {
  closeDisplayRuntime,
  closeBookmarkDisplayScopes,
} from "../process/scriptings";
