import { get, writable } from "svelte/store";
import { v4 } from "uuid";
import { createCharacterFactory } from "../characterFactory";
import { createChatVariableRuntime } from "../parser/chatVariableRuntime";
import { createUtilStateRuntime } from "../utilStateRuntime";
import { getDefaultSdData } from "../storage/defaultCharacterData";
import { parseKeyValue } from "../utilText";
import {
  createVariableReadDependencies,
  type VariableRead,
} from "./variableReadDependencies";
import type {
  Database,
  Chat,
  character,
  groupChat,
  Message,
} from "../storage/database.svelte";

type Definition = {
  id: string;
  revision: number;
  definition: Record<string, unknown>;
  activity?: { revision: number; lastInteraction: number } | null;
  fieldRevisions?: Record<string, number>;
  entityEpoch?: number;
  groupMembers?: import("./groupMembers").GroupMemberHeader[];
};
type Resource = {
  kind: string;
  id: string;
  revision: number;
  payload: unknown;
  fieldRevisions?: Record<string, number>;
  entityEpoch?: number;
};
export type FieldChange = { key: string; expectedRevision: number } & (
  { value: unknown; remove?: false } | { remove: true; value?: never }
);
export interface ExecutionSnapshot {
  cursor: number;
  history?: { count: number; offset: number };
  hasLater?: boolean;
  character: Definition;
  chat: {
    id: string;
    characterId: string;
    revision: number;
    metadata: Record<string, unknown>;
    contentRevision?: number;
    chatGlobalRevision?: number;
    fieldRevisions?: Record<string, number>;
    entityEpoch?: number;
  };
  messages: {
    id: string;
    revision: number;
    position: number;
    ordinal?: number;
    displayOrigin?: import("./displayEffects").DisplayMessageOrigin;
    message: Message;
  }[];
  variables: {
    key: string;
    value: string | number | boolean | null;
    revision: number;
  }[];
  resources?: Resource[];
  deletedVariables?: { key: string; revision: number }[];
  chatGlobalVariables?: {
    key: string;
    value: string | number | boolean | null;
    revision: number;
  }[];
  deletedChatGlobalVariables?: { key: string; revision: number }[];
  deletedMessages?: { id: string; revision: number }[];
  deletedResources?: { kind: string; id: string; revision: number }[];
  characterIndex?: { id: string; kind: string; revision: number }[];
  relatedCharacters?: Definition[];
  statistics?: {
    settingsId: string;
    revision: number;
    messages: number;
    imports: number;
  }[];
  hasEarlier: boolean;
}
export interface JobWriteSet {
  chatId: string;
  expectedRevision: number;
  expectedContentRevision?: number;
  characterReads?: { id: string; expectedEpoch: number }[];
  resourceReads?: { kind: string; id: string; expectedEpoch: number }[];
  variableReads?: VariableRead[];
  metadata?: Record<string, unknown>;
  metadataFields?: FieldChange[];
  metadataEpoch?: number;
  chatGlobalVariables?: {
    key: string;
    value: unknown;
    expectedRevision: number;
  }[];
  deleteChatGlobalVariables?: { key: string; expectedRevision: number }[];
  chatGlobalShape?: {
    type: "absent" | "null" | "object";
    expectedRevision: number;
  };
  characters: {
    id: string;
    expectedRevision: number;
    definition?: Record<string, unknown>;
    fields?: FieldChange[];
    expectedEpoch?: number;
  }[];
  messages: { id: string; expectedRevision: number; message: Message }[];
  deleteMessages: { id: string; expectedRevision: number }[];
  messageOrder?: string[];
  variables: { key: string; value: unknown; expectedRevision: number }[];
  deleteVariables: { key: string; expectedRevision: number }[];
  resources: {
    kind: string;
    id: string;
    payload?: unknown;
    fields?: FieldChange[];
    expectedEpoch?: number;
    expectedRevision: number;
  }[];
  deleteResources: { kind: string; id: string; expectedRevision: number }[];
  statistics?: {
    settingsId: string;
    expectedEpoch?: number;
    messagesDelta?: number;
    expectedRevision?: number;
    messages?: number;
    imports?: number;
  }[];
  activities?: {
    characterId: string;
    expectedEpoch?: number;
    lastInteraction: number;
    expectedRevision?: number;
  }[];
}

function normalized<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (
        typeof item === "function" ||
        typeof item === "symbol" ||
        typeof item === "bigint" ||
        (typeof item === "number" && !Number.isFinite(item))
      )
        throw new Error("Runtime state contains a non-JSON value");
      return item;
    }),
  );
}
function canonical(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, sort(v[key])]),
          )
        : v;
  return JSON.stringify(sort(normalized(value)));
}

function fieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  versions: Record<string, number>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const existed = Object.hasOwn(before, key),
      exists = Object.hasOwn(after, key);
    if (
      existed === exists &&
      (!exists || canonical(before[key]) === canonical(after[key]))
    )
      continue;
    changes.push({
      key,
      expectedRevision: Object.hasOwn(versions, key) ? versions[key] : 0,
      ...(exists ? { value: after[key] } : { remove: true as const }),
    });
  }
  return changes;
}
function omit(value: object, keys: string[]): Record<string, unknown> {
  return normalized(
    Object.fromEntries(
      Object.keys(value)
        .filter((key) => !keys.includes(key))
        .map((key) => [key, value[key]]),
    ),
  );
}
const collections = {
  module: "modules",
  preset: "botPresets",
  persona: "personas",
  plugin: "plugins",
} as const;
const separatelyStored = [
  "characters",
  ...Object.values(collections),
  "globalChatVariables",
];
const transientChat = [
  "GLGlobalVariables",
  "message",
  "scriptstate",
  "isStreaming",
  "activeStreamingDisplayOptimizationMode",
];
const separateCharacterFields = [
  "chats",
  "chatPage",
  "reloadKeys",
  "lastInteraction",
];
function persistentSettings(value: Database) {
  const result = omit(value, separatelyStored);
  if (result.statics && typeof result.statics === "object") {
    const extra = omit(result.statics, ["messages", "imports"]);
    if (Object.keys(extra).length) result.statics = extra;
    else delete result.statics;
  }
  return result;
}

/** A private compatibility view for one explicit server job. No Svelte runes or browser globals. */
export function createExecutionContext(
  snapshot: ExecutionSnapshot,
  options: {
    jobId: string;
    settingsId?: string;
    settings?: Partial<Database>;
    normalizeSettings?: (database: Database) => void;
    mode?: "persistent" | "display";
    resolveCharacter?: (id: string) => Definition | null;
  },
) {
  if (snapshot.hasEarlier)
    throw new Error("Generation requires a complete server snapshot");
  if (snapshot.character.id !== snapshot.chat.characterId)
    throw new Error("Character/chat relationship does not match");
  const source = structuredClone(snapshot),
    settingsId = options.settingsId ?? "global";
  const issues: string[] = [];
  const presentationListeners = new Set<() => void>();
  const observedPresentation = new WeakSet<object>();
  function observePresentation(value: character | groupChat) {
    if (observedPresentation.has(value)) return;
    observedPresentation.add(value);
    let reload = value.reloadKeys ?? 0;
    Object.defineProperty(value, "reloadKeys", {
      enumerable: true,
      configurable: true,
      get: () => reload,
      set: (next) => {
        reload = next;
        for (const listener of presentationListeners) listener();
      },
    });
  }
  function problem(message: string): never {
    issues.push(message);
    throw new Error(message);
  }
  function ensureHealthy() {
    if (issues.length)
      throw new Error("Execution capability errors: " + issues.join("; "));
  }
  const initialResources = source.resources ?? [];
  const originalResources = new Map(
    initialResources.map((row) => [JSON.stringify([row.kind, row.id]), row]),
  );
  const settings = initialResources.find(
    (r) => r.kind === "settings" && r.id === settingsId,
  );
  if (
    settings &&
    (!settings.payload ||
      typeof settings.payload !== "object" ||
      Array.isArray(settings.payload))
  )
    throw new Error("Settings definition must be an object");
  const settingsData = (settings?.payload ?? {}) as Record<string, unknown>;
  const chat = {
    note: "",
    name: "",
    localLore: [],
    ...source.chat.metadata,
    id: source.chat.id,
    message: source.messages.map((row) => ({ ...row.message, chatId: row.id })),
    scriptstate: Object.fromEntries(
      source.variables.map((row) => [row.key, row.value]),
    ),
  } as Chat;
  const factory = createCharacterFactory({
    uuidv4: v4,
    defaultSdDataFunc: getDefaultSdData,
  });
  const loaded = new Map<
    string,
    {
      record: Definition;
      value: character | groupChat;
      baseline: Record<string, unknown>;
      baselineActivity: number | undefined;
    }
  >();
  function load(record: Definition) {
    const value = {
      ...factory.createBlankChar(),
      reloadKeys: 0,
      ...record.definition,
      ...(record.activity
        ? { lastInteraction: record.activity.lastInteraction }
        : {}),
      chaId: record.id,
      chats: record.id === source.character.id ? [chat] : [],
      chatPage: 0,
    } as character | groupChat;
    if (record.id !== source.character.id)
      Object.defineProperty(value, "chats", {
        enumerable: true,
        get: () => problem("Cross-chat history capability is required"),
        set: () =>
          problem("An engine job cannot replace another character's chats"),
      });
    const baseline = omit(value, separateCharacterFields);
    observePresentation(value);
    loaded.set(record.id, {
      record,
      value,
      baseline,
      baselineActivity: value.lastInteraction,
    });
    return value;
  }
  load(source.character);
  chat.fmIndex ??= loaded.get(source.character.id)!.value.firstMsgIndex ?? -1;
  for (const record of source.relatedCharacters ?? []) load(record);
  const index =
    source.characterIndex ??
    [source.character, ...(source.relatedCharacters ?? [])].map((row) => ({
      id: row.id,
      kind: row.definition.type === "group" ? "group" : "character",
      revision: row.revision,
    }));
  const selected = index.findIndex((row) => row.id === source.character.id);
  if (selected < 0)
    throw new Error("Execution character is absent from the index");
  const knownIds = new Map(index.map((row, i) => [row.id, i]));
  function resolve(id: string) {
    if (loaded.has(id)) return loaded.get(id)!.value;
    if (!knownIds.has(id)) return null;
    if (!options.resolveCharacter)
      problem("Character resolver capability is required");
    const record = options.resolveCharacter(id);
    if (
      !record ||
      record.id !== id ||
      record.revision !== index[knownIds.get(id)!].revision
    )
      problem(
        "Character changed after admission or resolver returned another identity",
      );
    return load(structuredClone(record));
  }
  const characters = new Proxy(new Array<character | groupChat>(index.length), {
    get(target, key, receiver) {
      if (
        typeof key === "string" &&
        /^(0|[1-9]\d*)$/.test(key) &&
        Number(key) < index.length
      )
        return resolve(index[Number(key)].id);
      return Reflect.get(target, key, receiver);
    },
    set(_target, key, value) {
      if (
        typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= index.length ||
        value?.chaId !== index[Number(key)].id
      )
        problem("An engine job cannot change character membership or identity");
      const previous =
        loaded.get(value.chaId) ??
        (resolve(value.chaId), loaded.get(value.chaId));
      previous!.value = value;
      observePresentation(value);
      return true;
    },
    has(target, key) {
      if (
        typeof key === "string" &&
        /^(0|[1-9]\d*)$/.test(key) &&
        Number(key) < index.length
      )
        return true;
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      return [
        ...index.map((_, i) => String(i)),
        ...Reflect.ownKeys(target).filter(
          (key) => typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key),
        ),
      ];
    },
    getOwnPropertyDescriptor(target, key) {
      if (
        typeof key === "string" &&
        /^(0|[1-9]\d*)$/.test(key) &&
        Number(key) < index.length
      )
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: undefined,
        };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    deleteProperty() {
      return problem("An engine job cannot delete character membership");
    },
    defineProperty() {
      return problem("An engine job cannot redefine character membership");
    },
  });
  const resourceIds = new WeakMap<object, { kind: string; id: string }>();
  const resourceDatabaseCopies = new WeakSet<object>();
  const resourceRowArrays = new WeakSet<object>();
  function copyResourceOrigins(value: unknown, copy: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      !copy ||
      typeof copy !== "object"
    )
      return;
    const identity = resourceIds.get(value);
    if (identity) resourceIds.set(copy, identity);
    // Only data properties in the known row arrays are tracked. Do not rerun
    // getters or recursively walk arbitrary application/user object graphs.
    if (
      resourceRowArrays.has(value) &&
      Array.isArray(value) &&
      Array.isArray(copy)
    ) {
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (!/^(0|[1-9]\d*)$/.test(key) || !("value" in descriptor)) continue;
        const item = descriptor.value,
          copied = copy[Number(key)];
        if (
          !item ||
          typeof item !== "object" ||
          !copied ||
          typeof copied !== "object"
        )
          continue;
        const row = resourceIds.get(item);
        if (row) resourceIds.set(copied, row);
      }
      resourceRowArrays.add(copy);
    }
    if (resourceDatabaseCopies.has(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const field of Object.values(collections)) {
        const descriptor = descriptors[field];
        if (descriptor && "value" in descriptor)
          copyResourceOrigins(descriptor.value, (copy as any)[field]);
      }
      resourceDatabaseCopies.add(copy);
    }
  }
  function cloneResourceValue<T>(value: T): T {
    const copy = structuredClone(value);
    copyResourceOrigins(value, copy);
    return copy;
  }
  const resourceReads = new Map<
    string,
    { kind: string; id: string; expectedEpoch: number }
  >();
  function observeResource(row: Resource) {
    if (options.mode === "display" || row.kind === "global-variable") return;
    const key = JSON.stringify([row.kind, row.id]);
    if (!resourceReads.has(key)) {
      if (resourceReads.size >= 4096)
        problem("Resource read dependencies exceed 4096 entries");
      resourceReads.set(key, {
        kind: row.kind,
        id: row.id,
        expectedEpoch: row.entityEpoch ?? 0,
      });
    }
  }
  function readResourceValue<T>(value: T): T {
    if (options.mode !== "display")
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!item || typeof item !== "object") continue;
        const identity = resourceIds.get(item);
        if (identity) {
          const row = originalResources.get(
            JSON.stringify([identity.kind, identity.id]),
          );
          if (row) observeResource(row);
          if (Array.isArray(value)) resourceRowArrays.add(value);
        }
      }
    return value;
  }
  if (settings) observeResource(settings);
  const baselineCollections = new Map<string, string[]>();
  const db = {
    username: "User",
    templateDefaultVariables: "",
    ...structuredClone(options.settings ?? {}),
    ...structuredClone(settingsData),
    characters,
    globalChatVariables: Object.fromEntries(
      initialResources
        .filter((r) => r.kind === "global-variable")
        .map((r) => [r.id, structuredClone(r.payload)]),
    ),
  } as unknown as Database;
  for (const [kind, field] of Object.entries(collections)) {
    const rows = initialResources.filter((r) => r.kind === kind);
    const values = rows.map((row) => {
      const value = structuredClone(row.payload) as object;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${kind} definition must be an object`);
      resourceIds.set(value, { kind, id: row.id });
      return value;
    });
    (db as any)[field] = values;
    resourceRowArrays.add(values);
    baselineCollections.set(
      kind,
      rows.map((row) => row.id),
    );
  }
  options.normalizeSettings?.(db);
  const sourceStatistics = source.statistics?.find(
    (row) => row.settingsId === settingsId,
  );
  if (sourceStatistics)
    db.statics = {
      ...db.statics,
      messages: sourceStatistics.messages,
      imports: sourceStatistics.imports,
    };
  const baselineStatistics = db.statics ? normalized(db.statics) : undefined;
  let messageIncrements = 0;
  const generatedActivities = new Map<string, number>();
  const DBState = { db };
  resourceDatabaseCopies.add(db);
  const selectedCharID = writable(selected);
  const getDatabase = (arg: { snapshot?: boolean } = {}) => {
    if (!arg.snapshot) return DBState.db;
    const copy = normalized(DBState.db);
    copyResourceOrigins(DBState.db, copy);
    return copy;
  };
  const getCurrentCharacter = (arg: { snapshot?: boolean } = {}) =>
    arg.snapshot
      ? normalized(DBState.db.characters[get(selectedCharID)])
      : DBState.db.characters[get(selectedCharID)];
  const getCurrentChat = () => getCurrentCharacter().chats[0];
  const invalidateListeners = new Set<() => void>();
  const invalidate = () => {
    for (const listener of invalidateListeners) listener();
  };
  const variableRuntime = createChatVariableRuntime({
    DBState,
    selectedCharID,
    parseKeyValue,
    getCurrentChat,
  });
  let variableReads:
    ReturnType<typeof createVariableReadDependencies> | undefined;
  const observeVariable = (scope: VariableRead["scope"], key: string) => {
    if (options.mode !== "display")
      (variableReads ??= createVariableReadDependencies(
        source,
        problem,
      )).observe(scope, key);
  };
  const variables = {
    ...variableRuntime,
    getChatVar: (key: string) => {
      observeVariable("chat", "$" + key);
      return variableRuntime.getChatVar(key);
    },
    getGLChatVar: (key: string) => {
      observeVariable("chat-global", key);
      return variableRuntime.getGLChatVar(key);
    },
    getGlobalChatVar: (key: string) => {
      observeVariable("chat-global", key);
      const local = variableRuntime.getGLChatVar(key);
      // Preserve original truthiness and literal-null fallback semantics.
      if (local !== "null" && local) return local;
      observeVariable("global", key);
      return DBState.db.globalChatVariables[key] ?? "null";
    },
    setChatVar: (key: string, value: string) => {
      observeVariable("chat", "$" + key);
      return variableRuntime.setChatVar(key, value);
    },
    setGlobalChatVar: (key: string, value: string) => {
      observeVariable("chat-global", key);
      return variableRuntime.setGlobalChatVar(key, value);
    },
    isLocallyHandledGlobalChatVar: (key: string) => {
      observeVariable("chat-global", key);
      return variableRuntime.isLocallyHandledGlobalChatVar(key);
    },
    removeLocallyHandledGlobalChatVar: (key: string) => {
      observeVariable("chat-global", key);
      return variableRuntime.removeLocallyHandledGlobalChatVar(key);
    },
  };
  const util = createUtilStateRuntime({
    readResourceValue,
    DBState,
    selectedCharID,
    getDatabase,
    createBlankChar: factory.createBlankChar,
  });
  const baselineMetadata = omit(chat, transientChat),
    baselineSettings = persistentSettings(db);
  const variableVersions = new Map(
    [...source.variables, ...(source.deletedVariables ?? [])].map((row) => [
      row.key,
      row.revision,
    ]),
  );
  const baselineChatGlobals = new Map(
    Object.entries(chat.GLGlobalVariables ?? {}),
  );
  const chatGlobalVersions = new Map(
    [
      ...(source.chatGlobalVariables ?? []),
      ...(source.deletedChatGlobalVariables ?? []),
    ].map((row) => [row.key, row.revision]),
  );
  const globalShape = (value: Chat): "absent" | "null" | "object" =>
    value.GLGlobalVariables === undefined
      ? "absent"
      : value.GLGlobalVariables === null
        ? "null"
        : "object";
  const baselineChatGlobalShape = globalShape(chat);
  const messageVersions = new Map(
    [...source.messages, ...(source.deletedMessages ?? [])].map((row) => [
      row.id,
      row.revision,
    ]),
  );
  const resourceVersions = new Map(
    [...initialResources, ...(source.deletedResources ?? [])].map((row) => [
      JSON.stringify([row.kind, row.id]),
      row.revision,
    ]),
  );

  function writeSet(): JobWriteSet {
    ensureHealthy();
    if (options.mode === "display")
      throw new Error("Display contexts cannot commit persistent writes");
    if (get(selectedCharID) !== selected || DBState.db !== db)
      throw new Error("The job execution target or database root changed");
    const current = getCurrentChat();
    if (
      !current ||
      current.id !== source.chat.id ||
      getCurrentCharacter().chaId !== source.character.id
    )
      throw new Error("Chat identity changed");
    const writes: JobWriteSet = {
      chatId: source.chat.id,
      expectedRevision: source.chat.revision,
      expectedContentRevision:
        source.chat.contentRevision ?? source.chat.revision,
      characterReads: [...loaded.values()].map(({ record }) => ({
        id: record.id,
        expectedEpoch: record.entityEpoch ?? 0,
      })),
      variableReads: variableReads?.snapshot() ?? [],
      resourceReads: [...resourceReads.values()],
      characters: [],
      messages: [],
      deleteMessages: [],
      variables: [],
      deleteVariables: [],
      chatGlobalVariables: [],
      deleteChatGlobalVariables: [],
      resources: [],
      deleteResources: [],
    };
    const metadata = omit(current, transientChat);
    if (canonical(metadata) !== canonical(baselineMetadata)) {
      if (source.chat.fieldRevisions) {
        writes.metadataFields = fieldDiff(
          baselineMetadata,
          metadata,
          source.chat.fieldRevisions,
        );
        writes.metadataEpoch = source.chat.entityEpoch ?? 0;
      } else writes.metadata = metadata;
    }
    for (const {
      record,
      value,
      baseline,
      baselineActivity,
    } of loaded.values()) {
      if (
        value.chaId !== record.id ||
        value.chatPage !== 0 ||
        (record.id === source.character.id && value.chats.length !== 1)
      )
        throw new Error(
          "An engine job cannot change another chat or device navigation",
        );
      const definition = omit(value, separateCharacterFields);
      if (canonical(definition) !== canonical(baseline))
        writes.characters.push({
          id: record.id,
          expectedRevision: record.revision,
          ...(record.fieldRevisions
            ? {
                fields: fieldDiff(baseline, definition, record.fieldRevisions),
                expectedEpoch: record.entityEpoch ?? 0,
              }
            : { definition }),
        });
      if (
        value.lastInteraction !== baselineActivity ||
        generatedActivities.has(record.id)
      ) {
        if (
          !Number.isSafeInteger(value.lastInteraction) ||
          value.lastInteraction! < 0
        )
          problem("Character activity needs a nonnegative integer timestamp");
        (writes.activities ??= []).push({
          characterId: record.id,
          expectedEpoch: record.entityEpoch ?? 0,
          lastInteraction: value.lastInteraction!,
          ...(generatedActivities.get(record.id) === value.lastInteraction
            ? {}
            : { expectedRevision: record.activity?.revision ?? 0 }),
        });
      }
    }
    const originalMessages = new Map(
      source.messages.map((row) => [row.id, row]),
    );
    const currentMessages = new Map<string, Message>();
    for (const message of current.message) {
      message.chatId ??= v4();
      if (currentMessages.has(message.chatId))
        throw new Error("Duplicate message identity");
      currentMessages.set(message.chatId, message);
      const before = originalMessages.get(message.chatId);
      if (!before || canonical(message) !== canonical(before.message))
        writes.messages.push({
          id: message.chatId,
          expectedRevision: messageVersions.get(message.chatId) ?? 0,
          message: normalized(message),
        });
    }
    for (const before of source.messages)
      if (!currentMessages.has(before.id))
        writes.deleteMessages.push({
          id: before.id,
          expectedRevision: before.revision,
        });
    const naturalOrder = [
      ...source.messages
        .filter((row) => currentMessages.has(row.id))
        .map((row) => row.id),
      ...writes.messages
        .filter((row) => !originalMessages.has(row.id))
        .map((row) => row.id),
    ];
    const desiredOrder = [...currentMessages.keys()];
    if (canonical(naturalOrder) !== canonical(desiredOrder))
      writes.messageOrder = desiredOrder;
    const originalVariables = new Map(
      source.variables.map((row) => [row.key, row]),
    );
    for (const [key, value] of Object.entries(current.scriptstate ?? {})) {
      if (value === undefined) continue;
      const before = originalVariables.get(key);
      if (!before || canonical(value) !== canonical(before.value))
        writes.variables.push({
          key,
          value,
          expectedRevision: variableVersions.get(key) ?? 0,
        });
    }
    for (const before of source.variables)
      if (
        !Object.hasOwn(current.scriptstate ?? {}, before.key) ||
        (current.scriptstate ?? {})[before.key] === undefined
      )
        writes.deleteVariables.push({
          key: before.key,
          expectedRevision: before.revision,
        });
    for (const [key, value] of Object.entries(
      current.GLGlobalVariables ?? {},
    )) {
      if (value === undefined) continue;
      if (
        !baselineChatGlobals.has(key) ||
        canonical(value) !== canonical(baselineChatGlobals.get(key))
      )
        writes.chatGlobalVariables.push({
          key,
          value,
          expectedRevision: chatGlobalVersions.get(key) ?? 0,
        });
    }
    for (const key of baselineChatGlobals.keys())
      if (
        !Object.hasOwn(current.GLGlobalVariables ?? {}, key) ||
        current.GLGlobalVariables[key] === undefined
      )
        writes.deleteChatGlobalVariables.push({
          key,
          expectedRevision: chatGlobalVersions.get(key) ?? 0,
        });
    if (globalShape(current) !== baselineChatGlobalShape)
      writes.chatGlobalShape = {
        type: globalShape(current),
        expectedRevision: source.chat.chatGlobalRevision ?? 0,
      };
    const currentResources = new Map<
      string,
      { kind: string; id: string; payload: unknown }
    >();
    function addResource(kind: string, id: string, payload: unknown) {
      const key = JSON.stringify([kind, id]);
      if (currentResources.has(key))
        throw new Error("Duplicate resource identity");
      currentResources.set(key, { kind, id, payload: normalized(payload) });
    }
    for (const [kind, field] of Object.entries(collections)) {
      const values = (db as any)[field] as object[];
      const used = new Set<string>();
      const ids = values.map((value, i) => {
        let identity = resourceIds.get(value);
        if (!identity) {
          const embeddedId = (value as any).id;
          const baseId = baselineCollections.get(kind)![i];
          const id =
            typeof embeddedId === "string" && embeddedId
              ? embeddedId
              : baseId && !used.has(baseId)
                ? baseId
                : v4();
          identity = { kind, id };
          resourceIds.set(value, identity);
        }
        if (identity.kind !== kind)
          throw new Error("Resource moved to another collection");
        used.add(identity.id);
        addResource(kind, identity.id, value);
        return identity.id;
      });
      const before = baselineCollections.get(kind)!;
      const natural = [
        ...before.filter((id) => used.has(id)),
        ...ids.filter((id) => !before.includes(id)),
      ];
      if (canonical(ids) !== canonical(natural))
        throw new Error("Explicit resource-order capability is required");
    }
    for (const [key, value] of Object.entries(db.globalChatVariables ?? {}))
      if (value !== undefined) addResource("global-variable", key, value);
    const currentSettings = persistentSettings(db);
    if (canonical(currentSettings) !== canonical(baselineSettings))
      addResource("settings", settingsId, currentSettings);
    else if (settings) addResource("settings", settingsId, settings.payload);
    const managed = new Set([...Object.keys(collections), "global-variable"]);
    if (
      settings ||
      currentResources.has(JSON.stringify(["settings", settingsId]))
    )
      managed.add("settings");
    for (const [key, value] of currentResources) {
      const before = originalResources.get(key);
      if (!before || canonical(value.payload) !== canonical(before.payload))
        writes.resources.push({
          kind: value.kind,
          id: value.id,
          ...(before?.fieldRevisions &&
          typeof value.payload === "object" &&
          value.payload &&
          !Array.isArray(value.payload)
            ? {
                fields: fieldDiff(
                  before.payload as Record<string, unknown>,
                  value.payload as Record<string, unknown>,
                  before.fieldRevisions,
                ),
                expectedEpoch: before.entityEpoch ?? 0,
              }
            : { payload: value.payload }),
          expectedRevision: resourceVersions.get(key) ?? 0,
        });
    }
    for (const before of initialResources)
      if (
        managed.has(before.kind) &&
        (before.kind !== "settings" || before.id === settingsId) &&
        !currentResources.has(JSON.stringify([before.kind, before.id]))
      )
        writes.deleteResources.push({
          kind: before.kind,
          id: before.id,
          expectedRevision: before.revision,
        });
    if (
      canonical(db.statics ?? null) !== canonical(baselineStatistics ?? null) ||
      messageIncrements
    ) {
      if (
        !db.statics ||
        !Number.isSafeInteger(db.statics.messages) ||
        db.statics.messages < 0 ||
        !Number.isSafeInteger(db.statics.imports) ||
        db.statics.imports < 0
      )
        problem("Statistics need nonnegative integer counters");
      const isGeneratedIncrement = Boolean(
        baselineStatistics &&
        messageIncrements > 0 &&
        db.statics.messages ===
          baselineStatistics.messages + messageIncrements &&
        db.statics.imports === baselineStatistics.imports,
      );
      writes.statistics = [
        {
          settingsId,
          expectedEpoch:
            settings?.entityEpoch ??
            source.deletedResources?.find(
              (row) => row.kind === "settings" && row.id === settingsId,
            )?.revision ??
            0,
          ...(isGeneratedIncrement
            ? { messagesDelta: messageIncrements }
            : {
                expectedRevision: sourceStatistics?.revision ?? 0,
                messages: db.statics.messages,
                imports: db.statics.imports,
              }),
        },
      ];
    }
    return normalized(writes);
  }
  return {
    jobId: options.jobId,
    incrementMessageCount: () => {
      db.statics.messages += 1;
      messageIncrements += 1;
    },
    recordCharacterInteraction: (
      value: character | groupChat,
      timestamp: number,
    ) => {
      if (loaded.get(value.chaId)?.value !== value)
        problem("Activity must target a character in this execution context");
      value.lastInteraction = timestamp;
      generatedActivities.set(value.chaId, timestamp);
    },
    DBState,
    selectedCharID,
    getDatabase,
    getCurrentCharacter,
    getCurrentChat,
    readResourceValue,
    cloneResourceValue,
    readGlobalVariable: (key: string) => {
      observeVariable("global", key);
      return DBState.db.globalChatVariables[key];
    },
    readOptionalScriptState: (state: Chat["scriptstate"], key: string) => {
      observeVariable("chat", key);
      return state?.[key];
    },
    readScriptState: (state: NonNullable<Chat["scriptstate"]>, key: string) => {
      observeVariable("chat", key);
      return state[key];
    },
    util,
    variables: {
      ...variables,
      setChatVar: (key: string, value: string) => {
        const changed = variables.setChatVar(key, value);
        if (changed) invalidate();
        return changed;
      },
      setGlobalChatVar: (key: string, value: string) => {
        variables.setGlobalChatVar(key, value);
        invalidate();
      },
    },
    setCurrentChat: (value: Chat) => {
      if (value.id !== undefined && value.id !== source.chat.id)
        throw new Error("Cannot switch a job to another chat");
      value.id = source.chat.id;
      getCurrentCharacter().chats[0] = value;
      invalidate();
    },
    resolveCharacter: resolve,
    setCurrentCharacter: (value: character | groupChat) => {
      if (
        value.chaId !== source.character.id ||
        get(selectedCharID) !== selected
      )
        problem("Cannot switch a job to another character");
      DBState.db.characters[selected] = value;
      invalidate();
    },
    fail: problem,
    ensureHealthy,
    invalidate,
    onInvalidate: (listener: () => void) => {
      invalidateListeners.add(listener);
      return () => invalidateListeners.delete(listener);
    },
    onPresentationChange: (listener: () => void) => {
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
    writeSet,
  };
}
