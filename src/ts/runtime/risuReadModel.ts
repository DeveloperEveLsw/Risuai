import type {
  Database,
  Chat,
  Message,
  character,
  groupChat,
} from "../storage/database.svelte";
import type { ExecutionSnapshot } from "./executionContext";
import {
  RuntimeClientError,
  type RuntimeBootstrap,
  type RuntimeChange,
  type RuntimeLibraryItem,
  type RuntimeLibraryPage,
  type Json,
} from "./clientProtocol";
import type { VariableTarget, VariableValue } from "./variableCommands";

import {
  fieldIdentity,
  type FieldTarget,
  type FieldValue,
} from "./fieldCommands";

import type { DisplayHistoryWindow } from "./canonicalDisplayHistory";
import type { GroupMemberHeader } from "./groupMembers";
import {
  projectCharacterOrder,
  type CharacterNavigationHeader,
  type CharacterNavigationTarget,
} from "./characterNavigation.mjs";

type Character = character | groupChat;
type ChatSummary = {
  id: string;
  name: string;
  revision: number;
  entityEpoch?: number;
  sortPosition?: number;
  fieldRevisions?: Record<string, number>;
  navigation?: { folderId: { exists: boolean; value?: Json } };
};
type Definition = ExecutionSnapshot["character"] & {
  cursor?: number;
  chatSummaries?: ChatSummary[];
  navigationRevision?: number;
};
type Resource = {
  cursor?: number;
  characterNavigation?: CharacterNavigationHeader;
  kind: string;
  id: string;
  revision: number;
  payload: any;
  fieldRevisions?: Record<string, number>;
  entityEpoch?: number;
  statistics?: {
    settingsId: string;
    revision: number;
    messages: number;
    imports: number;
  };
};
type MessageRow = {
  revision: number;
  position: number;
  cursor: number;
  ordinal?: number;
  ordinalCursor?: number;
  displayOrigin?: import("./displayEffects").DisplayMessageOrigin;
  value: Message;
  deleted?: boolean;
};
type ChatView = {
  value: Chat;
  characterId: string;
  revision: number;
  snapshotCursor: number;
  metadataCursor: number;
  variableRevisions: Map<string, number>;
  variableSequences: Map<string, number>;
  chatGlobalRevisions: Map<string, number>;
  chatGlobalSequences: Map<string, number>;
  chatGlobalShapeCursor: number;
  messages: Map<string, MessageRow>;
  hasEarlier: boolean;
  windowed: boolean;
  historyCount?: number;
  historyWindow?: DisplayHistoryWindow;
  historyCursor: number;
  historyMutationCursor: number;
  removalCursor: number;
  messageAttributeCursor: number;
  latestPageCursor: number;
};

/** Patch through Svelte's existing proxies; never replace unchanged objects or arrays. */
export function reconcileValue(
  target: any,
  source: any,
  preserve = new Set<string>(),
) {
  for (const key of Object.keys(target))
    if (!preserve.has(key) && !Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (preserve.has(key)) continue;
    const old = Object.hasOwn(target, key) ? target[key] : undefined;
    if (old === value) continue;
    if (Array.isArray(old) && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (
          old[i] &&
          value[i] &&
          typeof old[i] === "object" &&
          typeof value[i] === "object" &&
          Array.isArray(old[i]) === Array.isArray(value[i])
        )
          reconcileValue(old[i], value[i]);
        else if (old[i] !== value[i]) old[i] = structuredClone(value[i]);
      }
      if (old.length > value.length) old.splice(value.length);
    } else if (
      old &&
      value &&
      typeof old === "object" &&
      typeof value === "object" &&
      !Array.isArray(old) &&
      !Array.isArray(value)
    )
      reconcileValue(old, value);
    else
      Object.defineProperty(target, key, {
        value: structuredClone(value),
        writable: true,
        configurable: true,
        enumerable: true,
      });
  }
}
const characterLocal = new Set([
  "chats",
  "chatPage",
  "reloadKeys",
  "lastInteraction",
]);
const chatLocal = new Set([
  "GLGlobalVariables",
  "message",
  "scriptstate",
  "isStreaming",
  "activeStreamingDisplayOptimizationMode",
]);
const databaseCollections = new Set([
  "characters",
  "modules",
  "botPresets",
  "personas",
  "plugins",
  "globalChatVariables",
]);
function chatMetadata(id: string, metadata: Record<string, unknown>) {
  return {
    ...metadata,
    id,
    name: metadata.name ?? "",
    note: metadata.note ?? "",
    localLore: metadata.localLore ?? [],
    fmIndex: metadata.fmIndex ?? -1,
  };
}

/** Confirmed, paginated Risu-shaped state. Transport and pending presentation remain separate. */
export class RisuReadModel {
  private definitions = new Map<
    string,
    { revision: number; value: Character }
  >();
  private chats = new Map<string, ChatView>();
  private lifecycle = new Map<
    string,
    { revision: number; epoch: number; deleted: boolean }
  >();
  private chatPositions = new Map<string, number>();
  private navigationVersions = new Map<
    string,
    { revision: number; epoch: number; cursor: number }
  >();
  private resources = new Map<string, Resource>();
  private characterNavigationRevision = -1;
  private canonicalCharacterOrder?: { field: FieldValue; cursor: number };
  private resourceIndex = new Map<
    string,
    { kind: string; id: string; revision: number; deleted: number }
  >();
  private statisticsRevisions = new Map<string, number>();
  private fieldVersions = new Map<
    string,
    { revision: number; entityEpoch: number; cursor: number }
  >();
  private fieldEpochs = new Map<string, number>();
  private openedLibraries = new Set<string>();
  private catalogs = new Map<
    string,
    { item: RuntimeLibraryItem; cursor: number }
  >();
  private libraryPages = new Map<
    string,
    { search: string; ids: string[]; next: string | null; generation: number }
  >();
  private libraryGeneration = 0;
  private editingModuleId?: string;
  private editingGeneration = 0;
  private resolvedModuleIds = new Set<string>();
  private resolvedModuleSignature = "";
  private moduleResolutionGeneration = 0;
  private selection = 0;
  private initialized = false;
  private settingDefaults?: Database;
  activeChatId: string | null = null;
  pageSize: number;
  constructor(
    private host: {
      DBState: { db: Database };
      read: <T>(path: string, options?: RequestInit) => Promise<T>;
      characterDefaults: () => character;
      normalizeSettings: (database: Database) => void;
      onScope?: (ready: boolean) => void;
      onResources?: () => void;
      onCatalog?: (
        kind: string,
        items: RuntimeLibraryItem[],
        next: string | null,
      ) => void;
    },
    pageSize = 100,
  ) {
    this.pageSize = pageSize;
  }
  get database() {
    return this.host.DBState.db;
  }
  get activeChat() {
    return this.chats.get(this.activeChatId)?.value;
  }
  chatMetadataCursor(chatId: string) {
    return this.chats.get(chatId)?.metadataCursor ?? -1;
  }
  get isWindowed() {
    return this.chats.get(this.activeChatId)?.windowed ?? false;
  }
  get hasEarlier() {
    const view = this.chats.get(this.activeChatId);
    if (view?.windowed) return (this.windowRows(view)[0]?.ordinal ?? 0) > 0;
    return view?.hasEarlier ?? false;
  }
  private windowRows(view: ChatView) {
    return [...view.messages.values()]
      .filter((row) => !row.deleted)
      .sort((a, b) => a.position - b.position);
  }
  get newerMessageCount() {
    const view = this.chats.get(this.activeChatId);
    if (!view?.windowed || view.historyCount === undefined) return 0;
    const last = this.windowRows(view).at(-1)?.ordinal;
    return Math.max(0, view.historyCount - (last === undefined ? 0 : last + 1));
  }
  get hasLater() {
    return this.newerMessageCount > 0;
  }

  displayHistory(index: number) {
    const view = this.chats.get(this.activeChatId);
    if (!view || view.historyCount === undefined) return;
    const message = view.value.message[index];
    const row = message && view.messages.get(message.chatId);
    if (
      row &&
      (row.ordinal === undefined ||
        (row.ordinalCursor ?? -1) < view.historyMutationCursor)
    )
      return;
    return {
      count: view.historyCount,
      cursor: view.historyCursor,
      ordinal: row?.ordinal,
    };
  }
  displayWindow(): DisplayHistoryWindow {
    const view = this.chats.get(this.activeChatId);
    if (!view) throw new Error("Display conversation is unavailable");
    if (!view.historyWindow)
      view.historyWindow = Object.freeze(
        view.value.message.map((message) => {
          const row = view.messages.get(message.chatId);
          if (
            row?.ordinal === undefined ||
            (row.ordinalCursor ?? -1) < view.historyMutationCursor
          )
            throw new Error(
              "Display history metadata is unavailable; refresh the conversation",
            );
          return Object.freeze([message.chatId, row.ordinal] as const);
        }),
      );
    return view.historyWindow;
  }
  variableRevision(key: string) {
    return this.chats.get(this.activeChatId)?.variableRevisions.get(key) ?? 0;
  }
  captureVariableVersions(chatId: string) {
    const view = this.chats.get(chatId);
    return {
      chat: new Map(view?.variableRevisions),
      localGlobal: new Map(view?.chatGlobalRevisions),
      global: new Map(
        [...this.resourceIndex.values()]
          .filter((row) => row.kind === "global-variable")
          .map((row) => [row.id, row.revision]),
      ),
    };
  }
  scopedVariableRevision(target: VariableTarget) {
    if (target.scope === "global")
      return this.resourceRevision("global-variable", target.key);
    const view = this.chats.get(target.chatId);
    return (
      (target.scope === "chat"
        ? view?.variableRevisions
        : view?.chatGlobalRevisions
      )?.get(target.key) ?? 0
    );
  }
  applyVariableRead(result: { cursor: number; variables: VariableValue[] }) {
    for (const record of result.variables) {
      if (record.scope === "global") {
        if (
          record.revision < this.resourceRevision("global-variable", record.key)
        )
          continue;
        const key = "global-variable:" + record.key;
        this.resourceIndex.set(key, {
          kind: "global-variable",
          id: record.key,
          revision: record.revision,
          deleted: record.exists ? 0 : 1,
        });
        if (!record.exists) this.removeResource("global-variable", record.key);
        else {
          this.resources.set(key, {
            kind: "global-variable",
            id: record.key,
            revision: record.revision,
            payload: record.value,
          });
          Object.defineProperty(this.database.globalChatVariables, record.key, {
            value: record.value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
      } else {
        const view = this.chats.get(record.chatId);
        if (view)
          this.variable(
            view,
            record.key,
            record.exists ? record.value : undefined,
            record.revision,
            result.cursor,
            record.scope === "chat-global",
          );
      }
    }
  }
  private fieldEntityIdentity(target: FieldTarget) {
    return JSON.stringify([
      target.scope,
      "resourceKind" in target ? target.resourceKind : "",
      target.entityId,
    ]);
  }
  fieldVersion(target: FieldTarget) {
    const version = this.fieldVersions.get(fieldIdentity(target));
    return {
      revision: version?.revision ?? 0,
      entityEpoch: this.fieldEpochs.get(this.fieldEntityIdentity(target)) ?? 0,
    };
  }
  private rememberFields(
    target: Omit<FieldTarget, "key">,
    versions: Record<string, number> = {},
    entityEpoch = 0,
    cursor = -1,
  ) {
    const entity = this.fieldEntityIdentity({
      ...target,
      key: "",
    } as FieldTarget);
    if (entityEpoch < (this.fieldEpochs.get(entity) ?? 0)) return;
    this.fieldEpochs.set(entity, entityEpoch);
    for (const [key, revision] of Object.entries(versions)) {
      const identity = fieldIdentity({ ...target, key } as FieldTarget);
      const old = this.fieldVersions.get(identity);
      if (
        !old ||
        entityEpoch > old.entityEpoch ||
        revision > old.revision ||
        (revision === old.revision && cursor >= old.cursor)
      )
        this.fieldVersions.set(identity, { revision, entityEpoch, cursor });
    }
  }
  private reconcileFields(
    target: FieldTarget,
    value: any,
    source: any,
    preserve: Set<string>,
    versions: Record<string, number> | undefined,
    entityEpoch = 0,
    cursor = -1,
  ) {
    if (entityEpoch < this.fieldVersion(target).entityEpoch) return;
    if (!versions) {
      reconcileValue(value, source, preserve);
      return;
    }
    const protectedKeys = new Set(preserve);
    for (const key of new Set([
      ...Object.keys(value),
      ...Object.keys(source),
    ])) {
      const old = this.fieldVersions.get(fieldIdentity({ ...target, key }));
      const revision = Object.hasOwn(versions, key) ? versions[key] : 0;
      if (
        old &&
        old.entityEpoch === entityEpoch &&
        (old.revision > revision ||
          (old.revision === revision && old.cursor > cursor))
      )
        protectedKeys.add(key);
    }
    reconcileValue(value, source, protectedKeys);
    this.rememberFields(target, versions, entityEpoch, cursor);
  }
  private patchField(
    target: any,
    key: string,
    exists: boolean,
    value?: unknown,
  ) {
    if (!exists) {
      delete target[key];
      return;
    }
    const field = {
      [key]: Object.hasOwn(target, key) ? target[key] : undefined,
    };
    reconcileValue(field, { [key]: value });
    Object.defineProperty(target, key, {
      value: field[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  private missingFieldDefault(record: FieldValue): unknown {
    if (record.scope === "resource" && record.resourceKind === "settings") {
      if (!this.settingDefaults) {
        this.settingDefaults = { characters: [] } as Database;
        this.host.normalizeSettings(this.settingDefaults);
      }
      return Object.hasOwn(this.settingDefaults, record.key)
        ? this.settingDefaults[record.key]
        : undefined;
    }
    const defaults =
      record.scope === "character"
        ? this.host.characterDefaults()
        : record.scope === "chat"
          ? chatMetadata(record.entityId, {})
          : {};
    return Object.hasOwn(defaults, record.key)
      ? defaults[record.key]
      : undefined;
  }
  async applyFieldRead(result: { cursor: number; fields: FieldValue[] }) {
    const applied: FieldValue[] = [];
    for (const record of result.fields) {
      // A new resource incarnation requires a complete body once, while ordinary
      // field confirmation must not fetch that body again.
      if (record.scope === "resource") {
        const cached = this.resources.get(
          record.resourceKind + ":" + record.entityId,
        );
        if (cached && record.entityEpoch > (cached.entityEpoch ?? 0))
          await this.ensureResource(record.resourceKind, record.entityId, true);
      }
      const old = this.fieldVersions.get(fieldIdentity(record));
      const epoch = this.fieldVersion(record).entityEpoch;
      if (
        record.entityEpoch < epoch ||
        (old &&
          record.entityEpoch === old.entityEpoch &&
          (record.revision < old.revision ||
            (record.revision === old.revision && result.cursor < old.cursor)))
      )
        continue;
      this.rememberFields(
        record,
        { [record.key]: record.revision },
        record.entityEpoch,
        result.cursor,
      );
      const target =
        record.scope === "character"
          ? (this.definitions.get(record.entityId)?.value ??
            (["name", "trashTime"].includes(record.key)
              ? this.database.characters.find(
                  (value) => value.chaId === record.entityId,
                )
              : undefined))
          : record.scope === "chat"
            ? this.chats.get(record.entityId)?.value
            : record.resourceKind === "settings"
              ? this.database
              : this.database[
                  (
                    {
                      module: "modules",
                      preset: "botPresets",
                      persona: "personas",
                      plugin: "plugins",
                    } as const
                  )[record.resourceKind]
                ]?.find(
                  (value) => (value as { id?: string }).id === record.entityId,
                );
      if (target) {
        let value = record.exists
          ? record.value
          : this.missingFieldDefault(record);
        if (
          record.scope === "resource" &&
          record.resourceKind === "settings" &&
          record.key === "statics"
        )
          value = {
            ...(record.exists ? (record.value as object) : {}),
            messages: this.database.statics?.messages ?? 0,
            imports: this.database.statics?.imports ?? 0,
          };
        this.patchField(
          target,
          record.key,
          record.exists || value !== undefined,
          value,
        );
      }
      if (record.scope === "resource") {
        const resource = this.resources.get(
          record.resourceKind + ":" + record.entityId,
        );
        if (resource) {
          this.patchField(
            resource.payload,
            record.key,
            record.exists,
            record.value,
          );
          resource.fieldRevisions ??= {};
          Object.defineProperty(resource.fieldRevisions, record.key, {
            value: record.revision,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          resource.entityEpoch = record.entityEpoch;
        }
      }
      applied.push(record);
      if (
        record.scope === "resource" &&
        record.resourceKind === "settings" &&
        record.entityId === "global" &&
        record.key === "characterOrder"
      )
        this.rememberCharacterOrder(record, result.cursor);
    }
    if (
      applied.some(
        (record) =>
          (record.scope === "character" && record.key === "trashTime") ||
          (record.scope === "resource" &&
            record.resourceKind === "settings" &&
            record.key === "characterOrder"),
      )
    )
      this.reconcileCharacterOrder();
    this.reconcileLibraryOrders();
    if (applied.some((record) => record.scope === "resource"))
      this.host.onResources?.();
    return applied;
  }
  private async fieldChange(change: RuntimeChange) {
    const records = change.payload.fields as unknown as FieldValue[];
    if (!Array.isArray(records) || !records.length)
      throw new Error("Invalid field change");
    const first = records[0];
    const catalog = change.payload.catalog as unknown as RuntimeLibraryItem;
    if (catalog) this.catalogChange(catalog, change.sequence);
    const applied = await this.applyFieldRead({
      cursor: change.sequence,
      fields: records,
    });
    if (!applied.length) return;
    if (first.scope === "character") {
      const definition = this.definitions.get(first.entityId);
      if (definition)
        definition.revision = Math.max(definition.revision, change.revision);
      if (Array.isArray(change.payload.groupMembers))
        this.updateGroupMembers(
          first.entityId,
          change.payload.groupMembers as unknown as GroupMemberHeader[],
          change.sequence,
        );
    } else if (first.scope === "chat") {
      const view = this.chats.get(first.entityId);
      if (view) view.revision = Math.max(view.revision, change.revision);
    } else {
      const key = first.resourceKind + ":" + first.entityId;
      const current = this.resourceIndex.get(key);
      if (!current || change.revision > current.revision)
        this.resourceIndex.set(key, {
          kind: first.resourceKind,
          id: first.entityId,
          revision: change.revision,
          deleted: 0,
        });
      const resource = this.resources.get(key);
      if (resource)
        resource.revision = Math.max(resource.revision, change.revision);
      else if (first.resourceKind === "plugin")
        await this.ensureResource("plugin", first.entityId);
      if (
        first.resourceKind === "settings" &&
        first.entityId === "global" &&
        applied.some((record) => record.key === "characterOrder")
      )
        this.reconcileCharacterOrder();
    }
    for (const kind of ["preset", "persona"])
      if (
        applied.some(
          (record) =>
            record.scope === "resource" &&
            record.resourceKind === "settings" &&
            record.key === kind + "Ids",
        )
      ) {
        for (const id of (this.database as any)[kind + "Ids"] ?? [])
          if (
            this.resourceIndex.get(kind + ":" + id)?.deleted === 0 ||
            this.catalogs.has(kind + ":" + id)
          )
            await this.ensureResource(kind, id);
      }
    // Only relationship fields require loading newly referenced resources.
    if (
      applied.some(
        (record) =>
          record.key === "modules" ||
          record.key === "enabledModules" ||
          record.key === "moduleIntergration" ||
          record.key === "bindedPersona",
      )
    )
      await this.ensureActiveResources();
  }
  messageRevision(id: string) {
    return this.chats.get(this.activeChatId)?.messages.get(id)?.revision ?? 0;
  }
  messageDisplayOrigin(id: string) {
    const origin = this.chats
      .get(this.activeChatId)
      ?.messages.get(id)?.displayOrigin;
    return origin && { ...origin };
  }
  resourceRevision(kind: string, id: string) {
    return this.resourceIndex.get(kind + ":" + id)?.revision ?? 0;
  }
  libraryHeader(kind: string, id: string) {
    const item = this.catalogs.get(kind + ":" + id)?.item;
    return {
      revision: Math.max(item?.revision ?? 0, this.resourceRevision(kind, id)),
      epoch: Math.max(
        item?.entityEpoch ?? 0,
        this.fieldVersion({
          scope: "resource",
          resourceKind: kind,
          entityId: id,
          key: "",
        } as FieldTarget).entityEpoch,
      ),
    };
  }
  private acceptCatalog(item: RuntimeLibraryItem, cursor: number) {
    const key = item.kind + ":" + item.id;
    const index = this.resourceIndex.get(key),
      old = this.catalogs.get(key);
    const epoch = this.libraryHeader(item.kind, item.id).epoch;
    if (
      item.entityEpoch < epoch ||
      (index &&
        (index.revision > item.revision ||
          (index.deleted && index.revision >= item.revision))) ||
      (old &&
        (old.item.revision > item.revision ||
          (old.item.revision === item.revision && old.cursor > cursor)))
    )
      return false;
    if (item.kind === "module" && (!old || old.item.revision !== item.revision))
      this.resolvedModuleSignature = "";
    this.catalogs.set(key, { item, cursor });
    return true;
  }
  private publishCatalog(kind: string) {
    const page = this.libraryPages.get(kind);
    const items = (page?.ids ?? []).flatMap((id) => {
      const item = this.catalogs.get(kind + ":" + id)?.item;
      return item ? [item] : [];
    });
    items.sort(
      (a, b) =>
        a.summary.name
          .toLowerCase()
          .localeCompare(b.summary.name.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
    this.host.onCatalog?.(kind, items, page?.next ?? null);
  }
  private catalogChange(item: RuntimeLibraryItem, cursor: number) {
    const old = this.catalogs.get(item.kind + ":" + item.id)?.item;
    if (!this.acceptCatalog(item, cursor)) return;
    if (item.kind === "module" && old?.revision !== item.revision)
      this.moduleResolutionGeneration++;
    const page = this.libraryPages.get(item.kind);
    if (page && this.openedLibraries.has(item.kind)) {
      const matches = item.summary.name
        .toLowerCase()
        .includes(page.search.toLowerCase());
      if (matches && !page.ids.includes(item.id)) page.ids.push(item.id);
      else if (!matches) page.ids = page.ids.filter((id) => id !== item.id);
      this.publishCatalog(item.kind);
    }
  }
  async loadLibrary(kind: string, search = "") {
    if (!["module", "preset", "persona", "plugin"].includes(kind))
      throw new Error("Unknown library kind");
    this.openedLibraries.add(kind);
    const page = {
      search,
      ids: [] as string[],
      next: null as string | null,
      generation: ++this.libraryGeneration,
    };
    this.libraryPages.set(kind, page);
    this.publishCatalog(kind);
    await this.readLibraryPage(kind, page, null);
  }
  async loadLibraryMore(kind: string) {
    const page = this.libraryPages.get(kind);
    if (page?.next && this.openedLibraries.has(kind))
      await this.readLibraryPage(kind, page, page.next);
  }
  private async readLibraryPage(
    kind: string,
    page: {
      search: string;
      ids: string[];
      next: string | null;
      generation: number;
    },
    after: string | null,
  ) {
    const result = await this.host.read<RuntimeLibraryPage>(
      "/libraries/" +
        encodeURIComponent(kind) +
        "?limit=50&search=" +
        encodeURIComponent(page.search) +
        (after ? "&after=" + encodeURIComponent(after) : ""),
    );
    if (
      this.libraryPages.get(kind) !== page ||
      !this.openedLibraries.has(kind) ||
      (after && page.next !== after)
    )
      return;
    const ids = new Set(
      after
        ? page.ids
        : page.ids.filter(
            (id) =>
              (this.catalogs.get(kind + ":" + id)?.cursor ?? -1) >
              result.cursor,
          ),
    );
    for (const item of result.items)
      if (this.acceptCatalog(item, result.cursor)) ids.add(item.id);
    page.ids = [...ids];
    page.next = result.next;
    this.publishCatalog(kind);
  }
  closeLibrary(kind: string) {
    this.openedLibraries.delete(kind);
    this.libraryPages.delete(kind);
    if (kind === "module") {
      this.editingModuleId = undefined;
      this.editingGeneration++;
      this.trimModules();
    }
    for (const [key, entry] of this.catalogs)
      if (entry.item.kind === kind) this.catalogs.delete(key);
    this.publishCatalog(kind);
  }
  async getLibraryResource(kind: string, id: string) {
    if (!["module", "preset", "persona", "plugin"].includes(kind))
      throw new Error("Unknown library kind");
    const generation = ++this.editingGeneration;
    if (kind === "module") {
      this.editingModuleId = id;
      this.trimModules();
    }
    try {
      const resource = await this.ensureResource(kind, id, true);
      if (
        !resource ||
        (kind === "module" &&
          (generation !== this.editingGeneration ||
            this.editingModuleId !== id)) ||
        resource.revision < this.libraryHeader(kind, id).revision
      )
        throw new RuntimeClientError(
          "RESOURCE_CHANGED",
          "Resource changed while opening; reopen it",
          409,
        );
      return {
        payload: structuredClone({ ...resource.payload, id }) as Record<
          string,
          unknown
        >,
        header: {
          revision: resource.revision,
          epoch: resource.entityEpoch ?? 0,
        },
      };
    } catch (error) {
      if (kind === "module" && generation === this.editingGeneration)
        this.editingModuleId = undefined;
      throw error;
    } finally {
      if (kind === "module") this.trimModules();
    }
  }
  private moduleTokens() {
    const character = this.database.characters.find(
      (c) => c.chaId === this.chats.get(this.activeChatId)?.characterId,
    );
    return [
      ...new Set([
        ...(this.database.enabledModules ?? []),
        ...(character?.modules ?? []),
        ...(this.activeChat?.modules ?? []),
        ...(this.database.moduleIntergration ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ]),
    ].sort();
  }
  private trimModules() {
    const keep = new Set([
      ...this.moduleTokens(),
      ...this.resolvedModuleIds,
      this.editingModuleId,
    ]);
    let changed = false;
    for (let i = this.database.modules.length - 1; i >= 0; i--) {
      const id = this.database.modules[i].id;
      if (!keep.has(id)) {
        this.database.modules.splice(i, 1);
        this.resources.delete("module:" + id);
        changed = true;
      }
    }
    if (changed) this.host.onResources?.();
  }
  private reconcileLibraryOrders() {
    for (const [kind, collection] of [
      ["module", "modules"],
      ["preset", "botPresets"],
      ["persona", "personas"],
      ["plugin", "plugins"],
    ]) {
      const order = (this.database as any)[kind + "Ids"];
      if (!Array.isArray(order)) continue;
      const values = this.database[collection] as { id: string }[];
      if (!Array.isArray(values)) continue;
      const positions = new Map<string, number>(
        order.map((id: string, index: number) => [id, index]),
      );
      values.sort(
        (a, b) =>
          (positions.get(a.id) ?? order.length) -
          (positions.get(b.id) ?? order.length),
      );
    }
  }
  characterLoaded(id: string) {
    return this.definitions.has(id);
  }
  chatMetadataLoaded(id: string) {
    return (this.chats.get(id)?.metadataCursor ?? -1) >= 0;
  }
  clearSelection() {
    this.selection++;
    this.activeChatId = null;
    this.resolvedModuleIds.clear();
    this.resolvedModuleSignature = "";
    this.trimModules();
    this.host.onScope?.(false);
  }
  characterIndex(id: string) {
    return this.database.characters.findIndex((c) => c.chaId === id);
  }

  entityHeader(kind: "character" | "chat", id: string) {
    const known = this.lifecycle.get(kind + ":" + id);
    return {
      revision: Math.max(
        known?.revision ?? 0,
        kind === "chat"
          ? (this.chats.get(id)?.revision ?? 0)
          : (this.definitions.get(id)?.revision ?? 0),
      ),
      epoch:
        known?.epoch ??
        this.fieldVersion({ scope: kind, entityId: id, key: "" }).entityEpoch,
      deleted: known?.deleted ?? false,
    };
  }
  chatNavigationHeader(characterId: string) {
    const value = this.navigationVersions.get(characterId);
    const owner = this.entityHeader("character", characterId);
    if (
      !value ||
      owner.deleted ||
      value.epoch !== owner.epoch ||
      !this.characterLoaded(characterId)
    )
      throw new RuntimeClientError(
        "NOT_READY",
        "Chat navigation is not loaded for this character",
      );
    return { ...value };
  }
  private rememberNavigation(
    characterId: string,
    revision: number,
    epoch: number,
    cursor: number,
  ) {
    const old = this.navigationVersions.get(characterId);
    if (
      old &&
      (epoch < old.epoch ||
        (epoch === old.epoch &&
          (revision < old.revision || cursor < old.cursor)))
    )
      return false;
    this.navigationVersions.set(characterId, { revision, epoch, cursor });
    return true;
  }
  private alive(
    kind: "character" | "chat",
    id: string,
    revision: number,
    epoch = 0,
  ) {
    const old = this.lifecycle.get(kind + ":" + id);
    if (old && (epoch < old.epoch || (old.deleted && revision <= old.revision)))
      return false;
    this.lifecycle.set(kind + ":" + id, {
      revision: Math.max(old?.revision ?? 0, revision),
      epoch,
      deleted: false,
    });
    return true;
  }
  private removeChat(id: string) {
    const view = this.chats.get(id);
    if (view) {
      const character = this.database.characters.find(
        (c) => c.chaId === view.characterId,
      );
      if (character) {
        const selected = character.chats[character.chatPage]?.id;
        const index = character.chats.findIndex((c) => c.id === id);
        if (index >= 0) character.chats.splice(index, 1);
        character.chatPage = Math.max(
          0,
          character.chats.findIndex((c) => c.id === selected),
        );
      }
      this.chats.delete(id);
    }
    this.chatPositions.delete(id);
    if (this.activeChatId === id) {
      this.activeChatId = null;
      this.selection++;
      this.host.onScope?.(false);
    }
  }
  private removeCharacter(id: string) {
    this.selection++;
    for (const [chatId, view] of this.chats)
      if (view.characterId === id) this.removeChat(chatId);
    this.definitions.delete(id);
    this.groupHeaders.delete(id);
    const index = this.characterIndex(id);
    if (index >= 0) this.database.characters.splice(index, 1);
    this.reconcileCharacterOrder();
  }
  private deletion(kind: "character" | "chat", id: string, revision: number) {
    if ((this.lifecycle.get(kind + ":" + id)?.revision ?? 0) > revision) return;
    this.lifecycle.set(kind + ":" + id, {
      revision,
      epoch: revision,
      deleted: true,
    });
    this.rememberFields({ scope: kind, entityId: id }, {}, revision);
    if (kind === "character") this.removeCharacter(id);
    else this.removeChat(id);
  }
  private sortChats(character: Character) {
    const selected = character.chats[character.chatPage]?.id;
    character.chats.sort(
      (a, b) =>
        (this.chatPositions.get(a.id) ?? 0) -
        (this.chatPositions.get(b.id) ?? 0),
    );
    character.chatPage = Math.max(
      0,
      character.chats.findIndex((c) => c.id === selected),
    );
  }

  private character(id: string, name = "", kind = "character"): Character {
    let index = this.characterIndex(id);
    if (index < 0) {
      const value = {
        ...this.host.characterDefaults(),
        chaId: id,
        name,
        type: kind === "group" ? "group" : "character",
        chats: [],
        chatPage: 0,
      } as Character;
      if (kind === "group")
        Object.assign(value, { characters: [], talkness: [], autoMode: false });
      this.database.characters.push(value);
      index = this.database.characters.length - 1;
    }
    return this.database.characters[index];
  }
  private definition(record: Definition) {
    if (
      !this.alive(
        "character",
        record.id,
        record.revision,
        record.entityEpoch ?? 0,
      )
    )
      throw new RuntimeClientError(
        "NOT_FOUND",
        "This character incarnation was removed",
      );
    const old = this.definitions.get(record.id);
    const value = this.character(
      record.id,
      String(record.definition.name ?? ""),
      String(record.definition.type ?? "character"),
    );
    if (!old || record.revision >= old.revision) {
      const normalized = {
        ...this.host.characterDefaults(),
        ...record.definition,
        chaId: record.id,
      };
      this.reconcileFields(
        { scope: "character", entityId: record.id, key: "" },
        value,
        normalized,
        characterLocal,
        record.fieldRevisions,
        record.entityEpoch,
        record.cursor ?? -1,
      );
      if (record.activity)
        value.lastInteraction = record.activity.lastInteraction;
      this.definitions.set(record.id, { revision: record.revision, value });
      if (record.groupMembers)
        this.updateGroupMembers(
          record.id,
          record.groupMembers,
          record.cursor ?? -1,
          true,
        );
    }
    return value;
  }
  private groupHeaders = new Map<
    string,
    { cursor: number; epoch: number; members: Map<string, GroupMemberHeader> }
  >();
  private updateGroupMembers(
    groupId: string,
    members: GroupMemberHeader[],
    cursor: number,
    full = false,
  ) {
    const epoch = this.fieldVersion({
      scope: "character",
      entityId: groupId,
      key: "characters",
    }).entityEpoch;
    const old = this.groupHeaders.get(groupId);
    if (old && old.epoch === epoch && old.cursor > cursor) return;
    const next =
      full || !old || old.epoch !== epoch
        ? new Map<string, GroupMemberHeader>()
        : new Map(old.members);
    for (const member of members)
      next.set(member.memberId, structuredClone(member));
    this.groupHeaders.set(groupId, { cursor, epoch, members: next });
  }
  groupMemberHeader(groupId: string, memberId: string) {
    const value = this.groupHeaders.get(groupId);
    const epoch = this.fieldVersion({
      scope: "character",
      entityId: groupId,
      key: "characters",
    }).entityEpoch;
    if (!value || value.epoch !== epoch)
      throw new Error("Group member headers are not ready");
    return value.members.get(memberId) ?? { memberId, revision: 0, slots: [] };
  }
  private chat(id: string, characterId: string, name = ""): ChatView {
    let view = this.chats.get(id);
    if (!view) {
      const character = this.character(characterId);
      character.chats.push({
        id,
        name,
        note: "",
        localLore: [],
        message: [],
        scriptstate: {},
        fmIndex: -1,
      });
      view = {
        value: character.chats.at(-1),
        characterId,
        revision: 0,
        snapshotCursor: -1,
        metadataCursor: -1,
        variableRevisions: new Map(),
        variableSequences: new Map(),
        chatGlobalRevisions: new Map(),
        chatGlobalSequences: new Map(),
        chatGlobalShapeCursor: -1,
        messages: new Map(),
        hasEarlier: false,
        windowed: false,
        historyCursor: -1,
        historyMutationCursor: -1,
        removalCursor: -1,
        messageAttributeCursor: -1,
        latestPageCursor: -1,
      };
      this.chats.set(id, view);
    }
    return view;
  }

  async bootstrap(snapshot: RuntimeBootstrap) {
    if (snapshot.characterNavigation)
      this.rememberCharacterNavigation(snapshot.characterNavigation);
    const settings = snapshot.resources.find(
      (r) => r.kind === "settings" && r.id === "global" && !r.deleted,
    );
    this.resolvedModuleSignature = "";
    this.resolvedModuleIds.clear();
    this.moduleResolutionGeneration++;
    this.resourceIndex = new Map(
      snapshot.resources.map((r) => [r.kind + ":" + r.id, r]),
    );
    for (const row of snapshot.statistics)
      this.statisticsRevisions.set(
        row.settingsId,
        Math.max(
          this.statisticsRevisions.get(row.settingsId) ?? 0,
          row.revision,
        ),
      );
    if (!this.initialized) {
      const initial = { characters: [] } as Database;
      this.host.normalizeSettings(initial);
      initial.characterOrder ??= [];
      this.host.DBState.db = initial;
      this.initialized = true;
    }
    if (settings) await this.ensureResource("settings", "global", true);
    else {
      const initial = { characters: [] } as Database;
      this.host.normalizeSettings(initial);
      initial.characterOrder ??= [];
      reconcileValue(this.database, initial, databaseCollections);
      this.resources.delete("settings:global");
    }
    const globalStatistics = snapshot.statistics.find(
      (r) => r.settingsId === "global",
    );
    for (const kind of ["preset", "persona"]) {
      const ids = (this.database as any)[kind + "Ids"];
      if (Array.isArray(ids)) {
        const values =
          this.database[kind === "preset" ? "botPresets" : "personas"];
        // Explicit server references replace generated browser defaults. Legacy
        // settings without these references keep their upstream UI defaults.
        for (let i = values.length - 1; i >= 0; i--)
          if (!this.resourceIndex.has(kind + ":" + (values[i] as any).id))
            values.splice(i, 1);
        for (const id of ids)
          if (this.resourceIndex.get(kind + ":" + id)?.deleted === 0)
            await this.ensureResource(kind, id);
      }
    }
    if (
      globalStatistics &&
      globalStatistics.revision >= (this.statisticsRevisions.get("global") ?? 0)
    )
      Object.assign(this.database.statics, {
        messages: globalStatistics.messages,
        imports: globalStatistics.imports,
      });
    for (const summary of snapshot.characters) {
      const existing = this.characterIndex(summary.id) >= 0;
      if (
        !this.alive(
          "character",
          summary.id,
          summary.revision,
          summary.entityEpoch ?? 0,
        )
      )
        continue;
      const value = this.character(summary.id, summary.name, summary.kind);
      // A summary does not mark the full definition loaded at this revision.
      if ((this.definitions.get(summary.id)?.revision ?? 0) <= summary.revision)
        value.name = summary.name;
      if (
        "trashTime" in summary &&
        (!existing ||
          (snapshot.characterNavigation?.revision ?? -1) >=
            this.characterNavigationRevision) &&
        snapshot.cursor >=
          (this.fieldVersions.get(
            fieldIdentity({
              scope: "character",
              entityId: summary.id,
              key: "trashTime",
            }),
          )?.cursor ?? -1)
      )
        value.trashTime =
          summary.trashTime == null ? undefined : Number(summary.trashTime);
      if ("lastInteraction" in summary)
        value.lastInteraction = Number(summary.lastInteraction);
    }
    const present = new Set(snapshot.characters.map((c) => c.id));
    for (const tombstone of snapshot.lifecycleTombstones ?? []) {
      if (tombstone.kind === "character" && present.has(tombstone.id)) continue;
      const known = this.lifecycle.get(tombstone.kind + ":" + tombstone.id);
      if (known && !known.deleted && known.revision > tombstone.revision)
        continue;
      this.deletion(
        tombstone.kind as "character" | "chat",
        tombstone.id,
        tombstone.revision,
      );
    }
    for (let i = this.database.characters.length - 1; i >= 0; i--)
      if (
        !present.has(this.database.characters[i].chaId) &&
        (snapshot.characterNavigation?.revision ?? -1) >=
          this.characterNavigationRevision
      ) {
        this.removeCharacter(this.database.characters[i].chaId);
      }
    this.reconcileCharacterOrder();
    this.trimModules();
    for (const [key, entry] of this.catalogs) {
      const index = this.resourceIndex.get(key);
      if (!index || index.deleted)
        this.removeResource(entry.item.kind, entry.item.id);
    }
    for (const [key, record] of this.resources) {
      const index = this.resourceIndex.get(key);
      if (!index || index.deleted) this.removeResource(record.kind, record.id);
      else if (index.revision !== record.revision)
        await this.ensureResource(record.kind, record.id, true);
    }
    await this.ensureInstalledPlugins();
    for (const kind of this.openedLibraries)
      await this.loadLibrary(kind, this.libraryPages.get(kind)?.search ?? "");
    await this.ensureActiveResources();
    const active = this.chats.get(this.activeChatId);
    if (active && present.has(active.characterId)) {
      await this.ensureCharacter(active.characterId, true);
      // Refresh the loaded window on resync, including previously requested older pages.
      await this.refreshActive();
    }
  }
  private async ensureInstalledPlugins() {
    // Native generation uses every installed plugin resource; pluginIds is only
    // the UI order, so an empty/legacy index must not hide an enabled engine.
    const installed = [...this.resourceIndex.values()].filter(
      (row) => row.kind === "plugin" && !row.deleted,
    );
    const ids = new Set(installed.map((row) => row.id));
    for (let i = this.database.plugins.length - 1; i >= 0; i--) {
      const plugin = this.database.plugins[i];
      if (!plugin.id || !ids.has(plugin.id)) this.database.plugins.splice(i, 1);
    }
    for (const row of installed)
      try {
        // Unchanged reconnects reuse the body, including large original scripts.
        await this.ensureResource("plugin", row.id);
      } catch (error) {
        if (!(
          error instanceof RuntimeClientError && error.code === "NOT_FOUND"
        ))
          throw error;
        this.removeResource("plugin", row.id);
      }
    this.reconcileLibraryOrders();
  }
  async ensureCharacter(id: string, force = false) {
    if (this.definitions.has(id) && !force)
      return this.definitions.get(id).value;
    const record = await this.host.read<Definition>(
      "/characters/" + encodeURIComponent(id),
    );
    const summaries =
      record.chatSummaries ??
      (await this.host.read<ChatSummary[]>(
        "/characters/" + encodeURIComponent(id) + "/chats",
      ));
    const value = this.definition(record);
    const acceptOrder =
      record.navigationRevision !== undefined
        ? this.rememberNavigation(
            id,
            record.navigationRevision,
            record.entityEpoch ?? 0,
            record.cursor ?? -1,
          )
        : (record.cursor ?? -1) >=
          (this.navigationVersions.get(id)?.cursor ?? -1);
    const present = new Set(summaries.map((s) => s.id));
    if (record.cursor !== undefined)
      for (const chat of [...value.chats]) {
        const view = this.chats.get(chat.id);
        if (
          !present.has(chat.id) &&
          (view?.metadataCursor ?? -1) <= record.cursor
        )
          this.removeChat(chat.id);
      }
    for (const summary of summaries) {
      if (
        !this.alive(
          "chat",
          summary.id,
          summary.revision,
          summary.entityEpoch ?? 0,
        )
      )
        continue;
      const chat = this.chat(summary.id, id, summary.name);
      const folder = summary.navigation?.folderId;
      if (folder)
        await this.applyFieldRead({
          cursor: record.cursor ?? -1,
          fields: [
            {
              scope: "chat",
              entityId: summary.id,
              key: "folderId",
              revision: summary.fieldRevisions?.folderId ?? 0,
              entityEpoch: summary.entityEpoch ?? 0,
              ...folder,
            },
          ],
        });
      this.rememberFields(
        { scope: "chat", entityId: summary.id },
        summary.fieldRevisions ?? {},
        summary.entityEpoch ?? 0,
        record.cursor ?? -1,
      );
      if (acceptOrder)
        this.chatPositions.set(
          summary.id,
          summary.sortPosition ?? summaries.indexOf(summary),
        );
      if (summary.revision >= chat.revision) chat.value.name = summary.name;
    }
    this.sortChats(value);
    return value;
  }
  private reconcileCharacterOrder() {
    const projected = projectCharacterOrder(
      this.canonicalCharacterOrder?.field.value ?? [],
      this.visibleCharacterIds(),
    );
    this.database.characterOrder ??= [];
    reconcileValue(
      { order: this.database.characterOrder },
      { order: projected },
    );
  }
  visibleCharacterIds() {
    return this.database.characters
      .filter(
        (c) =>
          !["§temp§", "§playground§"].includes(c.chaId) &&
          !(Number.isSafeInteger(c.trashTime) && c.trashTime !== 0),
      )
      .map((c) => c.chaId);
  }
  characterNavigationTarget(): CharacterNavigationTarget {
    const value = this.canonicalCharacterOrder?.field;
    if (
      !value ||
      this.characterNavigationRevision < 0 ||
      this.resourceIndex.get("settings:global")?.deleted
    )
      throw new RuntimeClientError(
        "RESOURCE_CHANGED",
        "Character navigation is not ready",
      );
    return {
      expectedNavigationRevision: this.characterNavigationRevision,
      expectedOrderRevision: value.revision,
      expectedSettingsEpoch: value.entityEpoch,
    };
  }
  characterOrderSource(): Json[] {
    const value = this.canonicalCharacterOrder?.field;
    return value?.exists && Array.isArray(value.value)
      ? structuredClone(value.value)
      : [];
  }
  private rememberCharacterOrder(field: FieldValue, cursor: number) {
    const old = this.canonicalCharacterOrder;
    const version = this.fieldVersion(field);
    if (
      field.entityEpoch < version.entityEpoch ||
      (field.entityEpoch === version.entityEpoch &&
        field.revision < version.revision)
    )
      return;
    if (
      old &&
      (field.entityEpoch < old.field.entityEpoch ||
        (field.entityEpoch === old.field.entityEpoch &&
          (field.revision < old.field.revision ||
            (field.revision === old.field.revision && cursor < old.cursor))))
    )
      return;
    this.canonicalCharacterOrder = { field: structuredClone(field), cursor };
  }
  private rememberCharacterNavigation(header: CharacterNavigationHeader) {
    if (
      !Number.isSafeInteger(header.revision) ||
      header.revision < this.characterNavigationRevision
    )
      return;
    this.characterNavigationRevision = header.revision;
    if (header.order) this.rememberCharacterOrder(header.order, header.cursor);
    else if (header.cursor >= (this.canonicalCharacterOrder?.cursor ?? -1))
      this.canonicalCharacterOrder = undefined;
  }
  async selectCharacter(id: string, chatId?: string) {
    const selection = ++this.selection;
    this.historyNavigation++;
    this.pendingHistoryNavigation = 0;
    this.deferredHistoryRefresh = false;
    this.host.onScope?.(false);
    const character = await this.ensureCharacter(id);
    if (selection !== this.selection) return false;
    const target =
      chatId ??
      character.chats[character.chatPage]?.id ??
      character.chats[0]?.id;
    if (!target) throw new Error("Character has no server chat");
    const snapshot = await this.host.read<ExecutionSnapshot>(
      "/chats/" + encodeURIComponent(target) + "?limit=" + this.pageSize,
    );
    if (selection !== this.selection) return false;
    if (this.activeChatId && this.activeChatId !== target) {
      const previous = this.chats.get(this.activeChatId);
      previous.messages.clear();
      previous.value.message.splice(0);
      previous.snapshotCursor = -1;
    }
    this.activeChatId = target;
    this.applySnapshot(snapshot, { replace: true, windowed: false });
    character.chatPage = character.chats.findIndex((c) => c.id === target);
    await this.ensureActiveResources();
    if (selection !== this.selection) return false;
    this.host.onScope?.(true);
    return true;
  }
  async ensureActiveResources() {
    const tokens = this.moduleTokens(),
      signature = JSON.stringify(tokens);
    if (this.resolvedModuleSignature !== signature) {
      const generation = this.moduleResolutionGeneration;
      const results: { cursor: number; items: RuntimeLibraryItem[] }[] = [];
      const items: RuntimeLibraryItem[] = [];
      for (let start = 0; start < tokens.length; start += 256) {
        const result = await this.host.read<{
          cursor: number;
          items: RuntimeLibraryItem[];
        }>("/libraries/module/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokens: tokens.slice(start, start + 256) }),
        });
        results.push(result);
      }
      if (
        generation !== this.moduleResolutionGeneration ||
        signature !== JSON.stringify(this.moduleTokens())
      )
        return this.ensureActiveResources();
      for (const result of results)
        for (const item of result.items)
          if (this.acceptCatalog(item, result.cursor)) items.push(item);
      this.resolvedModuleIds = new Set(items.map((item) => item.id));
      this.resolvedModuleSignature = signature;
    }
    for (const id of new Set([...tokens, ...this.resolvedModuleIds]))
      if (
        this.resourceIndex.get("module:" + id)?.deleted === 0 ||
        this.catalogs.has("module:" + id)
      )
        try {
          await this.ensureResource("module", id);
        } catch (error) {
          if (!(
            error instanceof RuntimeClientError && error.code === "NOT_FOUND"
          ))
            throw error;
        }
    this.trimModules();
    const persona = this.activeChat?.bindedPersona;
    if (persona && this.resourceIndex.get("persona:" + persona)?.deleted === 0)
      await this.ensureResource("persona", persona);
    for (const r of this.resourceIndex.values())
      if (r.kind === "global-variable" && !r.deleted)
        await this.ensureResource(r.kind, r.id);
  }
  private render(view: ChatView) {
    view.historyWindow = undefined;
    const ordered = [...view.messages.entries()]
      .filter(([, row]) => !row.deleted)
      .sort((a, b) => a[1].position - b[1].position);
    const messages = view.value.message;
    const desired = ordered.map(([, row]) => row.value);
    // Svelte proxies can differ from their raw object. Match by persistent identity.
    if (
      messages.length !== desired.length ||
      messages.some((m, i) => m.chatId !== desired[i].chatId)
    )
      messages.splice(0, messages.length, ...desired);
    ordered.forEach(([id, row], i) => {
      row.value = messages[i];
    });
  }
  applySnapshot(
    snapshot: ExecutionSnapshot,
    window?: { replace: boolean; windowed: boolean },
  ) {
    const previous = this.chats.get(snapshot.chat.id);
    // Re-reading a stale page is cheaper and safer than inventing rank transforms
    // for mutations already applied before that page arrived.
    if (
      previous &&
      (snapshot.cursor < previous.removalCursor ||
        snapshot.cursor < previous.messageAttributeCursor ||
        (snapshot.history && snapshot.cursor < previous.historyMutationCursor))
    )
      return false;
    if (
      !this.alive(
        "chat",
        snapshot.chat.id,
        snapshot.chat.revision,
        snapshot.chat.entityEpoch ?? 0,
      )
    )
      return;
    this.definition({ ...snapshot.character, cursor: snapshot.cursor });
    const view = this.chat(snapshot.chat.id, snapshot.chat.characterId);
    if (snapshot.history && snapshot.cursor >= view.historyCursor) {
      view.historyCount = snapshot.history.count;
      view.historyCursor = snapshot.cursor;
      if (view.historyMutationCursor < 0)
        view.historyMutationCursor = snapshot.cursor;
    }
    if (
      !snapshot.history ||
      snapshot.history.offset + snapshot.messages.length ===
        snapshot.history.count
    )
      view.latestPageCursor = Math.max(view.latestPageCursor, snapshot.cursor);
    if (snapshot.cursor >= view.metadataCursor) {
      this.reconcileFields(
        { scope: "chat", entityId: snapshot.chat.id, key: "" },
        view.value,
        chatMetadata(snapshot.chat.id, snapshot.chat.metadata),
        chatLocal,
        snapshot.chat.fieldRevisions,
        snapshot.chat.entityEpoch,
        snapshot.cursor,
      );
      view.metadataCursor = snapshot.cursor;

      this.chatGlobalShape(view, snapshot.chat.metadata, snapshot.cursor);
    }
    if (snapshot.cursor >= view.snapshotCursor) {
      view.revision = Math.max(view.revision, snapshot.chat.revision);
      for (const row of snapshot.variables)
        this.variable(view, row.key, row.value, row.revision, snapshot.cursor);
      for (const row of snapshot.deletedVariables ?? [])
        this.variable(view, row.key, undefined, row.revision, snapshot.cursor);
      for (const row of snapshot.chatGlobalVariables ?? [])
        this.variable(
          view,
          row.key,
          row.value,
          row.revision,
          snapshot.cursor,
          true,
        );
      for (const row of snapshot.deletedChatGlobalVariables ?? [])
        this.variable(
          view,
          row.key,
          undefined,
          row.revision,
          snapshot.cursor,
          true,
        );
      const localLive = new Set(
        (snapshot.chatGlobalVariables ?? []).map((v) => v.key),
      );
      for (const key of Object.keys(view.value.GLGlobalVariables ?? {}))
        if (
          !localLive.has(key) &&
          (view.chatGlobalSequences.get(key) ?? 0) <= snapshot.cursor
        )
          delete view.value.GLGlobalVariables[key];
      const live = new Set(snapshot.variables.map((v) => v.key));
      for (const key of Object.keys(view.value.scriptstate))
        if (
          !live.has(key) &&
          (view.variableSequences.get(key) ?? 0) <= snapshot.cursor
        )
          delete view.value.scriptstate[key];
      view.snapshotCursor = snapshot.cursor;
    }
    if (window?.replace) {
      const keep = new Set(snapshot.messages.map((row) => row.id));
      for (const key of view.messages.keys())
        if (!keep.has(key)) view.messages.delete(key);
      view.windowed = window.windowed;
      view.historyWindow = undefined;
    }
    for (const row of snapshot.messages)
      this.message(
        view,
        row.id,
        row.message,
        row.revision,
        row.position,
        snapshot.cursor,
        row.ordinal,
        row.displayOrigin,
      );
    for (const row of snapshot.deletedMessages ?? [])
      this.message(view, row.id, undefined, row.revision, 0, snapshot.cursor);
    const smallest = Math.min(...snapshot.messages.map((m) => m.position));
    const loadedSmallest = Math.min(
      ...[...view.messages.values()]
        .filter((m) => !m.deleted)
        .map((m) => m.position),
    );
    if (smallest <= loadedSmallest) view.hasEarlier = snapshot.hasEarlier;
    this.render(view);
    return true;
  }
  private chatGlobalShape(
    view: ChatView,
    metadata: Record<string, unknown>,
    cursor: number,
  ) {
    if (cursor < view.chatGlobalShapeCursor) return;
    if ([...view.chatGlobalSequences.values()].some((seq) => seq > cursor))
      return;
    if (!Object.hasOwn(metadata, "GLGlobalVariables"))
      delete view.value.GLGlobalVariables;
    else if (metadata.GLGlobalVariables == null)
      view.value.GLGlobalVariables = metadata.GLGlobalVariables as undefined;
    else view.value.GLGlobalVariables ??= {};
    view.chatGlobalShapeCursor = cursor;
  }
  private variable(
    view: ChatView,
    key: string,
    value: unknown,
    revision: number,
    cursor: number,
    localGlobal = false,
  ) {
    const revisions = localGlobal
      ? view.chatGlobalRevisions
      : view.variableRevisions;
    const sequences = localGlobal
      ? view.chatGlobalSequences
      : view.variableSequences;
    if (
      revision < (revisions.get(key) ?? 0) ||
      (revision === revisions.get(key) && cursor < (sequences.get(key) ?? 0))
    )
      return;
    revisions.set(key, revision);
    sequences.set(key, Math.max(sequences.get(key) ?? 0, cursor));
    const values = localGlobal
      ? value === undefined
        ? view.value.GLGlobalVariables
        : (view.value.GLGlobalVariables ??= {})
      : view.value.scriptstate;
    if (value === undefined) {
      if (values) delete values[key];
    } else
      Object.defineProperty(values, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    if (localGlobal)
      view.chatGlobalShapeCursor = Math.max(view.chatGlobalShapeCursor, cursor);
  }
  private message(
    view: ChatView,
    id: string,
    message: Message | undefined,
    revision: number,
    position: number,
    cursor: number,
    ordinal?: number,
    displayOrigin?: import("./displayEffects").DisplayMessageOrigin,
  ) {
    const old = view.messages.get(id);
    if (
      cursor < view.removalCursor ||
      cursor < view.messageAttributeCursor ||
      (old &&
        (revision < old.revision ||
          (revision === old.revision && cursor < old.cursor)))
    )
      return;
    if (!message) {
      view.messages.set(id, {
        revision,
        position,
        cursor,
        value: old?.value,
        deleted: true,
      });
      return;
    }
    if (old?.value) {
      reconcileValue(old.value, { ...message, chatId: id });
      old.revision = revision;
      old.position = position;
      old.cursor = cursor;
      old.deleted = false;
      old.displayOrigin = displayOrigin && { ...displayOrigin };
      if (ordinal !== undefined && cursor >= (old.ordinalCursor ?? -1)) {
        old.ordinal = ordinal;
        old.ordinalCursor = cursor;
      }
    } else
      view.messages.set(id, {
        revision,
        position,
        cursor,
        value: structuredClone({ ...message, chatId: id }),
        ordinal,
        ordinalCursor: ordinal === undefined ? undefined : cursor,
        displayOrigin: displayOrigin && { ...displayOrigin },
      });
  }
  private historyNavigation = 0;
  private pendingHistoryNavigation = 0;
  private deferredHistoryRefresh = false;
  async navigateHistory(
    boundary: { around: string } | { before: number } | { after: number } | {},
    automatic = false,
  ) {
    const chatId = this.activeChatId,
      selection = this.selection,
      generation = ++this.historyNavigation;
    if (!chatId) throw new Error("No selected conversation");
    if (!automatic) this.pendingHistoryNavigation = generation;
    let accepted = false;
    try {
      const epoch = this.entityHeader("chat", chatId).epoch;
      let query = new URLSearchParams({ limit: String(this.pageSize) });
      for (const [key, value] of Object.entries(boundary))
        query.set(key, String(value));
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await this.host.read<ExecutionSnapshot>(
          "/chats/" + encodeURIComponent(chatId) + "?" + query,
        );
        if (
          selection !== this.selection ||
          generation !== this.historyNavigation ||
          chatId !== this.activeChatId
        )
          return false;
        if (
          epoch !== this.entityHeader("chat", chatId).epoch ||
          epoch !== (snapshot.chat.entityEpoch ?? 0)
        )
          throw new Error("Conversation changed while reading history; retry");
        if (
          !snapshot.messages.length &&
          snapshot.history?.count &&
          Object.keys(boundary).length
        ) {
          // The requested boundary may disappear while the read is in flight.
          const surviving = this.chats.get(chatId)?.value.message[0]?.chatId;
          query = new URLSearchParams({
            limit: String(this.pageSize),
            ...(surviving ? { around: surviving } : {}),
          });
          continue;
        }
        if (
          this.applySnapshot(snapshot, {
            replace: true,
            windowed: Object.keys(boundary).length > 0,
          })
        ) {
          accepted = true;
          return true;
        }
      }
      throw new Error(
        "History changed repeatedly while reading a window; retry",
      );
    } finally {
      if (!automatic && this.pendingHistoryNavigation === generation) {
        this.pendingHistoryNavigation = 0;
        const refresh = this.deferredHistoryRefresh;
        this.deferredHistoryRefresh = false;
        if (
          refresh &&
          !accepted &&
          selection === this.selection &&
          chatId === this.activeChatId
        )
          await this.refreshActive();
      }
    }
  }
  async jumpToMessage(id: string) {
    const accepted = await this.navigateHistory({ around: id });
    return accepted
      ? this.activeChat.message.findIndex((message) => message.chatId === id)
      : -1;
  }
  async loadLatest() {
    return this.navigateHistory({});
  }
  async loadLater() {
    const view = this.chats.get(this.activeChatId),
      last = view && this.windowRows(view).at(-1);
    if (last && this.hasLater)
      await this.navigateHistory({ after: last.position });
  }
  async loadEarlier() {
    if (this.isWindowed) {
      const first = this.windowRows(this.chats.get(this.activeChatId))[0];
      if (first && this.hasEarlier)
        await this.navigateHistory({ before: first.position });
      return;
    }
    const chatId = this.activeChatId,
      view = this.chats.get(chatId);
    if (!view?.hasEarlier) return;
    const before = Math.min(
      ...[...view.messages.values()]
        .filter((m) => !m.deleted)
        .map((m) => m.position),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.host.read<ExecutionSnapshot>(
        "/chats/" +
          encodeURIComponent(chatId) +
          "?limit=" +
          this.pageSize +
          (Number.isFinite(before) ? "&before=" + before : ""),
      );
      if (this.activeChatId !== chatId || this.applySnapshot(snapshot)) return;
    }
    throw new Error(
      "History changed repeatedly while loading a page; retry the page",
    );
  }
  async refreshActive() {
    const chatId = this.activeChatId,
      view = this.chats.get(chatId);
    if (!view) return;
    if (this.pendingHistoryNavigation) {
      // Automatic events must not retire a user's in-flight viewport request.
      // Its snapshot fences retry the requested anchor against the newer cursor.
      this.deferredHistoryRefresh = true;
      return;
    }
    const generation = this.historyNavigation,
      selection = this.selection;
    if (view.windowed) {
      const loaded = view.value.message;
      const anchor = loaded[Math.floor(loaded.length / 2)]?.chatId;
      await this.navigateHistory(anchor ? { around: anchor } : {}, true);
      return;
    }
    const count = Math.max(
      this.pageSize,
      [...view.messages.values()].filter((m) => !m.deleted).length,
    );
    let before: number | undefined,
      loaded = 0;
    const received = new Set<string>();
    do {
      let snapshot: ExecutionSnapshot | undefined;
      let accepted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshot = await this.host.read<ExecutionSnapshot>(
          "/chats/" +
            encodeURIComponent(chatId) +
            "?limit=" +
            Math.min(1000, count - loaded) +
            (before === undefined ? "" : "&before=" + before),
        );
        if (
          this.activeChatId !== chatId ||
          selection !== this.selection ||
          generation !== this.historyNavigation
        )
          return;
        if (this.applySnapshot(snapshot)) {
          accepted = true;
          break;
        }
      }
      if (!accepted || !snapshot)
        throw new Error(
          "History changed repeatedly while refreshing; retry the conversation",
        );
      for (const row of snapshot.messages) received.add(row.id);
      loaded += snapshot.messages.length;
      before = snapshot.messages[0]?.position;
      if (!snapshot.hasEarlier || before === undefined) break;
    } while (loaded < count);
    // A reordered message may leave the requested latest window. Retain object
    // identity for surviving IDs, without leaving an extra stale body/rank.
    for (const [id, row] of view.messages)
      if (!row.deleted && !received.has(id)) view.messages.delete(id);
    this.render(view);
  }
  private historyChange(view: ChatView, change: RuntimeChange) {
    view.historyWindow = undefined;
    const p = change.payload,
      position = Number(p.position);
    view.historyMutationCursor = Math.max(
      view.historyMutationCursor,
      change.sequence,
    );
    for (const row of view.messages.values()) {
      if (
        row.deleted ||
        row.ordinal === undefined ||
        (row.ordinalCursor ?? -1) >= change.sequence
      )
        continue;
      if (p.deleted && row.position > position) row.ordinal--;
      row.ordinalCursor = change.sequence;
    }
    if (change.sequence > view.historyCursor) {
      if (view.historyCount !== undefined) {
        if (p.deleted) view.historyCount--;
        else if (p.added) view.historyCount++;
        if (view.historyCount < 0) view.historyCount = undefined;
      }
      view.historyCursor = change.sequence;
    }
    if (view.historyCount === 0) view.hasEarlier = false;
  }
  private async removeMessages(view: ChatView, change: RuntimeChange) {
    const p = change.payload;
    if (
      change.sequence <= view.historyCursor ||
      Number(p.entityEpoch) !== this.entityHeader("chat", change.chatId).epoch
    )
      return;
    const position = Number(p.position);
    view.removalCursor = Math.max(view.removalCursor, change.sequence);
    view.historyMutationCursor = Math.max(
      view.historyMutationCursor,
      change.sequence,
    );
    view.historyCursor = change.sequence;
    view.historyCount = Number(p.count);
    view.historyWindow = undefined;
    for (const [id, row] of view.messages) {
      if (row.deleted || row.cursor > change.sequence) continue;
      if (p.mode === "one" ? id === change.id : row.position >= position) {
        this.message(
          view,
          id,
          undefined,
          id === change.id ? change.revision : row.revision + 1,
          row.position,
          change.sequence,
        );
      } else if ((row.ordinalCursor ?? -1) < change.sequence) {
        if (
          p.mode === "one" &&
          row.position > position &&
          row.ordinal !== undefined
        )
          row.ordinal--;
        row.ordinalCursor = change.sequence;
      }
    }
    if (view.historyCount === 0) view.hasEarlier = false;
    else if (![...view.messages.values()].some((row) => !row.deleted))
      view.hasEarlier = true;
    this.render(view);
    if (!view.value.message.length && view.hasEarlier)
      await this.refreshActive();
  }
  private async replaceReplyBatch(view: ChatView, change: RuntimeChange) {
    const p = change.payload;
    if (
      change.sequence <= view.historyCursor ||
      Number(p.entityEpoch) !== this.entityHeader("chat", change.chatId).epoch
    )
      return;
    const position = Number(p.position),
      count = Number(p.count);
    const messages = p.messages as unknown as {
      id: string;
      message: Message;
      revision: number;
      position: number;
      ordinal: number;
    }[];
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Array.isArray(messages) ||
      !messages.length ||
      messages.some(
        (row, i) =>
          typeof row.id !== "string" ||
          !row.message ||
          !Number.isSafeInteger(row.revision) ||
          row.revision <= 0 ||
          row.position !== position + i ||
          row.ordinal !== count - messages.length + i,
      ) ||
      new Set(messages.map((row) => row.id)).size !== messages.length
    )
      throw new Error("Invalid reply batch projection");
    const loaded = [...view.messages.values()].filter((row) => !row.deleted);
    const atLatest =
      !view.windowed ||
      (view.historyCount !== undefined &&
        loaded.some((row) => row.ordinal === view.historyCount - 1));
    const ids = new Set(messages.map((row) => row.id));
    view.removalCursor = change.sequence;
    view.historyMutationCursor = change.sequence;
    view.historyCursor = change.sequence;
    view.historyCount = count;
    view.historyWindow = undefined;
    for (const [id, row] of view.messages) {
      if (row.deleted || row.cursor > change.sequence) continue;
      if (row.position >= position && (!atLatest || !ids.has(id)))
        view.messages.delete(id);
      else row.ordinalCursor = change.sequence;
    }
    if (atLatest) {
      const visible = view.windowed ? messages.slice(-this.pageSize) : messages;
      for (const row of visible)
        this.message(
          view,
          row.id,
          row.message,
          row.revision,
          row.position,
          change.sequence,
          row.ordinal,
        );
      view.latestPageCursor = Math.max(view.latestPageCursor, change.sequence);
      if (view.windowed) {
        const current = [...view.messages.entries()]
          .filter(([, row]) => !row.deleted)
          .sort((a, b) => a[1].position - b[1].position);
        for (const [id] of current.slice(
          0,
          Math.max(0, current.length - this.pageSize),
        ))
          view.messages.delete(id);
      }
    }
    const first = [...view.messages.values()]
      .filter((row) => !row.deleted)
      .sort((a, b) => a.position - b.position)[0];
    view.hasEarlier = first ? (first.ordinal ?? 0) > 0 : count > 0;
    // Publish once: no intermediate empty tail or mixed old/new response.
    this.render(view);
    if (!first && count > 0)
      await this.navigateHistory(
        position > 0 ? { before: position } : {},
        true,
      );
  }
  private removeResource(kind: string, id: string) {
    this.resources.delete(kind + ":" + id);
    this.catalogs.delete(kind + ":" + id);
    if (kind === "module") {
      this.resolvedModuleIds.delete(id);
      this.resolvedModuleSignature = "";
      this.moduleResolutionGeneration++;
    }
    const page = this.libraryPages.get(kind);
    if (page) {
      page.ids = page.ids.filter((value) => value !== id);
      this.publishCatalog(kind);
    }
    const index = this.resourceIndex.get(kind + ":" + id);
    if (kind !== "global-variable" && index?.deleted)
      this.fieldEpochs.set(
        this.fieldEntityIdentity({
          scope: "resource",
          resourceKind: kind,
          entityId: id,
          key: "",
        } as FieldTarget),
        index.revision,
      );
    const collection = {
      module: "modules",
      preset: "botPresets",
      persona: "personas",
      plugin: "plugins",
    }[kind];
    if (collection) {
      const values = this.database[collection];
      const index = values.findIndex((v) => v.id === id);
      const selectedKey =
        kind === "preset"
          ? "botPresetsId"
          : kind === "persona"
            ? "selectedPersona"
            : null;
      const selectedId = selectedKey
        ? values[this.database[selectedKey]]?.id
        : null;
      if (index >= 0) values.splice(index, 1);
      if (selectedKey)
        this.database[selectedKey] = Math.max(
          0,
          values.findIndex((v) => v.id === selectedId),
        );
    }
    if (kind === "global-variable")
      delete this.database.globalChatVariables[id];
    if (kind === "settings" && id === "global") {
      this.canonicalCharacterOrder = undefined;
      const settings = { characters: [] } as Database;
      this.host.normalizeSettings(settings);
      settings.characterOrder ??= [];
      reconcileValue(this.database, settings, databaseCollections);
      this.reconcileCharacterOrder();
    }
  }
  async ensureResource(kind: string, id: string, force = false) {
    const key = kind + ":" + id;
    const cached = this.resources.get(key);
    if (
      cached &&
      !force &&
      !this.resourceIndex.get(key)?.deleted &&
      cached.revision >= this.libraryHeader(kind, id).revision
    )
      return cached;
    const resource = await this.host.read<Resource>(
      "/resources/" + encodeURIComponent(kind) + "/" + encodeURIComponent(id),
    );
    const current = this.resourceIndex.get(key);
    if (
      current &&
      (current.revision > resource.revision ||
        (current.deleted && current.revision >= resource.revision))
    )
      return this.resources.get(key);
    if (resource.revision < this.libraryHeader(kind, id).revision)
      return this.resources.get(key);
    if ((this.resources.get(key)?.revision ?? 0) > resource.revision)
      return this.resources.get(key);
    this.resources.set(key, resource);

    this.resourceIndex.set(key, {
      kind,
      id,
      revision: resource.revision,
      deleted: 0,
    });
    if (kind === "settings") {
      if (id === "global" && resource.characterNavigation)
        this.rememberCharacterNavigation(resource.characterNavigation);
      const settings = { ...resource.payload, characters: [] } as Database;
      this.host.normalizeSettings(settings);
      // Keep portable members that the original UI default normalizer omits.
      // Known settings still follow the original type/default normalization.
      const portable = resource.payload as Record<string, any>;
      if (Array.isArray(portable.hypaV3Presets))
        settings.hypaV3Presets = settings.hypaV3Presets.map(
          (preset, index) => ({
            ...portable.hypaV3Presets[index],
            ...preset,
            settings: {
              ...portable.hypaV3Presets[index]?.settings,
              ...preset.settings,
            },
          }),
        );
      if (
        portable.hypaCustomSettings &&
        typeof portable.hypaCustomSettings === "object"
      )
        settings.hypaCustomSettings = {
          ...portable.hypaCustomSettings,
          ...settings.hypaCustomSettings,
        };
      settings.characterOrder ??= [];
      const stats = resource.statistics;
      if (
        stats &&
        stats.revision >= (this.statisticsRevisions.get(stats.settingsId) ?? 0)
      )
        this.statisticsRevisions.set(stats.settingsId, stats.revision);
      else if (stats)
        Object.assign(settings.statics, {
          messages: this.database.statics.messages,
          imports: this.database.statics.imports,
        });
      this.reconcileFields(
        { scope: "resource", resourceKind: "settings", entityId: id, key: "" },
        this.database,
        settings,
        databaseCollections,
        resource.fieldRevisions,
        resource.entityEpoch,
        resource.cursor,
      );
      this.reconcileCharacterOrder();
      this.host.onResources?.();
    } else if (kind === "global-variable")
      Object.defineProperty(this.database.globalChatVariables, id, {
        value: resource.payload,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    else {
      const collection = {
        module: "modules",
        preset: "botPresets",
        persona: "personas",
        plugin: "plugins",
      }[kind];
      if (collection) {
        const values = this.database[collection];
        const old = values.find((v) => v.id === id);
        const payload = { ...resource.payload, id };
        if (old)
          this.reconcileFields(
            {
              scope: "resource",
              resourceKind: kind,
              entityId: id,
              key: "",
            } as FieldTarget,
            old,
            payload,
            new Set(),
            resource.fieldRevisions,
            resource.entityEpoch,
            resource.cursor,
          );
        else {
          values.push(payload);
          this.rememberFields(
            { scope: "resource", resourceKind: kind, entityId: id } as Omit<
              FieldTarget,
              "key"
            >,
            resource.fieldRevisions,
            resource.entityEpoch,
            resource.cursor,
          );
        }
      }
    }
    this.reconcileLibraryOrders();
    this.host.onResources?.();
    return resource;
  }
  async change(change: RuntimeChange) {
    const p = change.payload,
      view = this.chats.get(change.chatId);
    if (Number.isSafeInteger(p.characterNavigationRevision))
      this.characterNavigationRevision = Math.max(
        this.characterNavigationRevision,
        Number(p.characterNavigationRevision),
      );
    if (change.type === "bookmark" && view) {
      const epoch = Number(p.entityEpoch);
      if (epoch !== this.entityHeader("chat", change.chatId).epoch) return;
      const bookmarks = (
        Array.isArray(view.value.bookmarks) ? view.value.bookmarks : []
      ).filter((id) => id !== change.id);
      for (const position of p.positions as number[])
        bookmarks.splice(position, 0, change.id);
      const names = { ...view.value.bookmarkNames };
      if (p.nameExists)
        Object.defineProperty(names, change.id, {
          value: p.name,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      else delete names[change.id];
      const versions = p.fieldRevisions as Record<string, number>;
      const existence = (p.collectionExists ?? {}) as Record<string, boolean>;
      await this.applyFieldRead({
        cursor: change.sequence,
        fields: [
          {
            scope: "chat",
            entityId: change.chatId,
            key: "bookmarks",
            exists: existence.bookmarks !== false,
            value: bookmarks,
            revision: versions.bookmarks ?? 0,
            entityEpoch: epoch,
          },
          {
            scope: "chat",
            entityId: change.chatId,
            key: "bookmarkNames",
            exists: existence.bookmarkNames !== false,
            value: names,
            revision: versions.bookmarkNames ?? 0,
            entityEpoch: epoch,
          },
        ],
      });
      view.metadataCursor = Math.max(view.metadataCursor, change.sequence);
      view.revision = Math.max(view.revision, Number(p.chatRevision));
    } else if (change.type === "fields") {
      await this.fieldChange(change);
    } else if (change.type === "chat-order") {
      const characterId = String(p.characterId),
        owner = this.entityHeader("character", characterId);
      if (
        owner.deleted ||
        Number(p.characterEpoch) !== owner.epoch ||
        !this.rememberNavigation(
          characterId,
          Number(p.navigationRevision),
          Number(p.characterEpoch),
          change.sequence,
        )
      )
        return;
      for (const row of p.order as {
        id: string;
        position: number;
        epoch: number;
      }[]) {
        const chat = this.chats.get(row.id);
        if (
          chat?.characterId === characterId &&
          this.entityHeader("chat", row.id).epoch === row.epoch
        )
          this.chatPositions.set(row.id, row.position);
      }
      const character =
        this.database.characters[this.characterIndex(characterId)];
      if (character) this.sortChats(character);
    } else if (change.type === "character") {
      if (p.deleted) {
        this.deletion("character", change.id, change.revision);
        return;
      }
      if (
        !this.alive(
          "character",
          change.id,
          change.revision,
          Number(p.entityEpoch ?? 0),
        )
      )
        return;
      const character = this.character(
        change.id,
        String(p.name ?? ""),
        String(p.kind ?? "character"),
      );
      if (
        "trashTime" in p &&
        Number(
          p.characterNavigationRevision ?? this.characterNavigationRevision,
        ) >= this.characterNavigationRevision &&
        change.sequence >=
          (this.fieldVersions.get(
            fieldIdentity({
              scope: "character",
              entityId: change.id,
              key: "trashTime",
            }),
          )?.cursor ?? -1)
      )
        character.trashTime =
          p.trashTime == null ? undefined : Number(p.trashTime);
      this.reconcileCharacterOrder();
      if ((this.definitions.get(change.id)?.revision ?? 0) < change.revision) {
        character.name = String(p.name ?? character.name);
        if (this.definitions.has(change.id))
          try {
            await this.ensureCharacter(change.id, true);
          } catch (error) {
            if (!(
              error instanceof RuntimeClientError && error.code === "NOT_FOUND"
            ))
              throw error;
          }
      }
    } else if (change.type === "character-activity") {
      const character = this.database.characters.find(
        (c) => c.chaId === change.id,
      );
      if (character)
        character.lastInteraction = Math.max(
          character.lastInteraction ?? 0,
          Number(p.lastInteraction),
        );
    } else if (change.type === "resource") {
      const kind = String(p.kind),
        id = String(p.id),
        key = kind + ":" + id;
      const catalog = p.catalog as unknown as RuntimeLibraryItem;
      if (catalog) this.catalogChange(catalog, change.sequence);
      if ((this.resourceIndex.get(key)?.revision ?? 0) >= change.revision)
        return;
      this.resourceIndex.set(key, {
        kind,
        id,
        revision: change.revision,
        deleted: p.deleted ? 1 : 0,
      });
      if (p.deleted) this.removeResource(kind, id);
      else if (
        this.resources.has(key) ||
        kind === "global-variable" ||
        kind === "plugin"
      ) {
        try {
          await this.ensureResource(kind, id, true);
        } catch (error) {
          if (!(
            error instanceof RuntimeClientError && error.code === "NOT_FOUND"
          ))
            throw error;
        }
      }
      await this.ensureActiveResources();
      this.host.onResources?.();
    } else if (change.type === "statistics") {
      if (
        change.id === "global" &&
        change.revision > (this.statisticsRevisions.get(change.id) ?? 0)
      ) {
        this.statisticsRevisions.set(change.id, change.revision);
        Object.assign(this.database.statics, {
          messages: p.messages,
          imports: p.imports,
        });
      }
    } else if (change.type === "chat") {
      const acceptOrder =
        p.navigationRevision === undefined ||
        this.rememberNavigation(
          String(p.characterId),
          Number(p.navigationRevision),
          Number(p.characterEpoch ?? 0),
          change.sequence,
        );
      if (p.deleted) {
        this.deletion("chat", change.id, change.revision);
        return;
      }
      if (
        !this.alive(
          "chat",
          change.id,
          change.revision,
          Number(p.entityEpoch ?? 0),
        )
      )
        return;
      if (this.lifecycle.get("character:" + String(p.characterId))?.deleted)
        return;
      const chat = this.chat(
        change.id,
        String(p.characterId),
        String((p.metadata as any)?.name ?? ""),
      );
      if (acceptOrder && p.sortPosition !== undefined)
        this.chatPositions.set(change.id, Number(p.sortPosition));
      this.sortChats(
        this.database.characters[this.characterIndex(String(p.characterId))],
      );
      if (change.sequence > chat.metadataCursor) {
        this.reconcileFields(
          { scope: "chat", entityId: change.id, key: "" },
          chat.value,
          chatMetadata(change.id, p.metadata as Record<string, unknown>),
          chatLocal,
          p.fieldRevisions as unknown as Record<string, number>,
          Number(p.entityEpoch ?? 0),
          change.sequence,
        );
        chat.metadataCursor = change.sequence;

        this.chatGlobalShape(
          chat,
          p.metadata as Record<string, unknown>,
          change.sequence,
        );
        chat.revision = Math.max(chat.revision, change.revision);
      }
    } else if (view && view.value.id === this.activeChatId) {
      if (change.type === "message-disabled") {
        if (
          Number(p.entityEpoch) !==
            this.entityHeader("chat", change.chatId).epoch ||
          change.sequence < view.removalCursor
        )
          return;
        const row = view.messages.get(change.id);
        view.messageAttributeCursor = Math.max(
          view.messageAttributeCursor,
          change.sequence,
        );
        view.historyCursor = Math.max(view.historyCursor, change.sequence);
        if (
          row &&
          !row.deleted &&
          row.cursor < change.sequence &&
          row.revision < change.revision
        ) {
          this.message(
            view,
            change.id,
            { ...row.value, disabled: p.disabled as Message["disabled"] },
            change.revision,
            Number(p.position),
            change.sequence,
          );
          this.render(view);
        }
      }
      if (change.type === "messages-removed")
        await this.removeMessages(view, change);
      if (change.type === "reply-batch")
        await this.replaceReplyBatch(view, change);
      if (
        change.type === "chat-global-shape" &&
        change.sequence > view.snapshotCursor
      )
        this.chatGlobalShape(
          view,
          p.shape === "absent"
            ? {}
            : { GLGlobalVariables: p.shape === "null" ? null : {} },
          change.sequence,
        );
      if (
        ["variable", "chat-global-variable"].includes(change.type) &&
        change.sequence > view.snapshotCursor
      )
        this.variable(
          view,
          String(p.key),
          p.deleted ? undefined : p.value,
          change.revision,
          change.sequence,
          change.type === "chat-global-variable",
        );
      if (change.type === "message") this.historyChange(view, change);
      if (
        change.type === "message" &&
        (!view.windowed || view.messages.has(change.id)) &&
        (view.messages.has(change.id) ||
          change.sequence > view.latestPageCursor) &&
        (p.deleted ||
          p.added ||
          view.messages.has(change.id) ||
          view.historyCount === undefined)
      ) {
        this.message(
          view,
          change.id,
          p.deleted ? undefined : (p.message as unknown as Message),
          change.revision,
          Number(p.position),
          change.sequence,
          typeof p.ordinal === "number" ? p.ordinal : undefined,
          p.displayOrigin as unknown as import("./displayEffects").DisplayMessageOrigin,
        );
        this.render(view);
      }
      if (
        change.type === "message-order" &&
        (change.sequence > view.snapshotCursor ||
          [...view.messages.values()].some(
            (row) =>
              !row.deleted && (row.ordinalCursor ?? -1) < change.sequence,
          ))
      ) {
        view.historyMutationCursor = Math.max(
          view.historyMutationCursor,
          change.sequence,
        );
        await this.refreshActive();
      }
      if (typeof p.chatRevision === "number")
        view.revision = Math.max(view.revision, p.chatRevision);
    }
  }
}
