import { createDisplayScopeCache } from "../../src/ts/runtime/displayScopeCache.svelte";
import { BrowserRuntimeController } from "../../src/ts/runtime/browserRuntimeController.svelte";
import { RuntimeUIState } from "../../src/ts/runtime/browserRuntimeState.svelte";
import type {
  DisplayCapture,
  DisplayScopeHeader,
} from "../../src/ts/runtime/displayEffects";

/** Actual compiled controller methods with an authored projection, no network. */
export function checkControllerDisplayHeaders() {
  const previousReady = RuntimeUIState.scopeReady;
  RuntimeUIState.scopeReady = true;
  const counts = { database: 0, character: 0, chat: 0 };
  const counted = <T extends object>(value: T, key: keyof typeof counts) =>
    new Proxy(value, {
      ownKeys(object) {
        counts[key]++;
        return Reflect.ownKeys(object);
      },
    });
  const messages = [
    { chatId: "m0", role: "char", data: "Synthetic zero" },
    { chatId: "m1", role: "user", data: "Synthetic one" },
  ];
  const chat = counted(
    {
      id: "a",
      message: messages,
      fmIndex: -1,
      scriptstate: {},
      GLGlobalVariables: {},
    },
    "chat",
  );
  const character = counted(
    {
      type: "character",
      chaId: "c",
      chatPage: 0,
      chats: [chat],
      triggerscript: [],
      firstMessage: "Synthetic greeting",
      alternateGreetings: [],
    },
    "character",
  );
  const database = counted(
    {
      characters: [character],
      aiModel: "Synthetic model",
      globalChatVariables: {},
      arbitraryDefinition: { neutral: "Synthetic preserved" },
    },
    "database",
  );
  let historyCursor = 20,
    available = true;
  const window = Object.freeze([
    Object.freeze(["m0", 2] as const),
    Object.freeze(["m1", 21] as const),
  ]);
  const outside = {
    messageId: "outside",
    ordinal: 8,
    messageRevision: 3,
    message: { chatId: "outside", role: "char", data: "Synthetic outside" },
    displayOrigin: {
      messageRevision: 3,
      chatEpoch: 4,
      characterEpoch: 5,
      inputClock: 18,
      codeHash: "synthetic-code",
      displayKey: "synthetic-key",
    },
  };
  const page = { cursor: 20, historyCount: 220, items: [outside] };
  const owner = Object.create(BrowserRuntimeController.prototype) as any;
  Object.assign(owner, {
    serverId: "synthetic",
    selectedId: "c",
    displayProjectedCursor: 20,
    display: {
      ready: true,
      state: {
        cursor: 20,
        inputClock: 18,
        chatId: "a",
        characterId: "c",
        chatEpoch: 4,
        characterEpoch: 5,
        applied: [],
        next: null,
      },
    },
    model: {
      activeChatId: "a",
      activeChat: chat,
      database,
      hasEarlier: true,
      characterIndex: () => 0,
      messageRevision: () => 2,
      messageDisplayOrigin: () => undefined,
      displayHistory: (index: number) =>
        available
          ? {
              count: 220,
              cursor: historyCursor,
              ...(index >= 0 ? { ordinal: index === 0 ? 2 : 21 } : {}),
            }
          : undefined,
      displayWindow: () => window,
      captureVariableVersions: () => ({
        chat: new Map([["$v", 2]]),
        localGlobal: new Map(),
        global: new Map(),
      }),
    },
    bookmarks: {
      presentation: (token: string) => (token === "current" ? page : undefined),
    },
  });
  const reset = () => {
    counts.database = counts.character = counts.chat = 0;
  };
  const clean = () => Object.values(counts).every((count) => count === 0);
  try {
    const header = owner.captureDisplayHeader(0, false, "c", "m1");
    const mainNoEnumeration = clean();
    const mainFields = {
      id: header.message.id,
      revision: header.message.revision,
      ordinal: header.history.ordinal,
      count: header.history.count,
      model: header.aiModel,
      source: header.sourceContent,
      epochs: [header.state.chatEpoch, header.state.characterEpoch],
    };
    header.versions.chat.set("$v", 99);
    const independentVersions =
      owner.captureDisplayHeader(0, false).versions.chat.get("$v") === 2;
    reset();
    const bookmark = owner.captureBookmarkDisplayHeader("current", "outside");
    const bookmarkNoEnumeration = clean();
    const outsideFields = {
      id: bookmark.message.id,
      ordinal: bookmark.history.ordinal,
      count: bookmark.history.count,
      source: bookmark.sourceContent,
      origin: bookmark.message.origin.displayKey,
      partial: bookmark.hasEarlier,
    };
    reset();
    const full = owner.captureDisplay(0, false);
    const fullEnumerations = { ...counts };
    const aliases =
      full.database.characters[0] === full.character &&
      full.character.chats[0] === full.chat &&
      full.chat.message === messages;
    reset();
    const preview = owner.captureBookmarkDisplay("current", "outside");
    const bookmarkFullEnumerations = { ...counts };
    const previewAliases =
      preview.database.characters[0] === preview.character &&
      preview.character.chats[0] === preview.chat &&
      preview.chat.message[0].chatId === "outside";
    owner.displayProjectedCursor = 19;
    const cursorFence =
      !owner.captureDisplayHeader(0, false) &&
      !owner.captureBookmarkDisplayHeader("current", "outside");
    owner.displayProjectedCursor = 20;
    owner.display.state.inputClock = 21;
    const clockFence =
      !owner.captureDisplayHeader(0, false) &&
      !owner.captureBookmarkDisplayHeader("current", "outside");
    owner.display.state.inputClock = 18;
    historyCursor = 21;
    const historyFence = !owner.captureDisplayHeader(0, false);
    historyCursor = 20;
    page.cursor = 21;
    const bookmarkPageFence = !owner.captureBookmarkDisplayHeader(
      "current",
      "outside",
    );
    page.cursor = 20;
    const retiredPreview = !owner.captureBookmarkDisplayHeader(
      "retired",
      "outside",
    );
    const missingTargets =
      !owner.captureDisplayHeader(0, false, "other", "m0") &&
      !owner.captureDisplayHeader(0, false, "c", "missing") &&
      !owner.captureBookmarkDisplayHeader("current", "missing");
    available = false;
    let unavailableHistory = false;
    try {
      owner.captureDisplayHeader(0, false);
    } catch (error) {
      unavailableHistory = String(error).includes(
        "history metadata is unavailable",
      );
    }
    available = true;
    RuntimeUIState.scopeReady = false;
    const notReady =
      !owner.captureDisplayHeader(0, false) &&
      !owner.captureBookmarkDisplayHeader("current", "outside");
    return {
      actualControllerMethods: true,
      syntheticProjectionOnly: true,
      mainNoEnumeration,
      bookmarkNoEnumeration,
      mainFields,
      outsideFields,
      independentVersions,
      fullEnumerations,
      bookmarkFullEnumerations,
      aliases,
      previewAliases,
      cursorFence,
      clockFence,
      historyFence,
      bookmarkPageFence,
      retiredPreview,
      missingTargets,
      unavailableHistory,
      notReady,
    };
  } finally {
    RuntimeUIState.scopeReady = previousReady;
  }
}

/** Provisional sources use the same compiled ownership/projection fences. */
export function checkProvisionalHeaders() {
  const previousReady = RuntimeUIState.scopeReady;
  const previousPending = RuntimeUIState.pending;
  RuntimeUIState.scopeReady = true;
  const chat = {
    id: "a",
    message: [{ chatId: "canonical", role: "char", data: "confirmed" }],
  };
  const character = { chaId: "c", type: "character", chats: [chat] };
  const pending = (id: string, fields = {}) => ({
    requestId: id,
    kind: "job",
    state: "pending",
    command: {
      type: "send",
      chatId: "a",
      expectedChatEpoch: 4,
      messageId: id,
      input: "Pending",
      ...fields,
    },
  });
  const job = (id: string, fields = {}) => ({
    id,
    chatId: "a",
    chatEpoch: 4,
    state: "running",
    progress: { messages: [{ chatId: id, role: "char", data: "Progress" }] },
    ...fields,
  });
  const owner = Object.create(BrowserRuntimeController.prototype) as any;
  Object.assign(owner, {
    serverId: "synthetic",
    selectedId: "c",
    displayProjectedCursor: 20,
    display: {
      ready: true,
      state: {
        cursor: 20,
        inputClock: 18,
        chatId: "a",
        characterId: "c",
        chatEpoch: 4,
        characterEpoch: 5,
        applied: [],
        next: null,
      },
    },
    jobs: new Map([
      ["progress", job("progress")],
      ["foreign", job("foreign", { chatId: "b" })],
      ["old", job("old", { chatEpoch: 3 })],
      ["terminal", job("terminal", { state: "failed" })],
    ]),
    commands: new Map(),
    model: {
      activeChatId: "a",
      activeChat: chat,
      database: { characters: [character], aiModel: "synthetic" },
      characterIndex: () => 0,
      entityHeader: (kind: string) => ({ epoch: kind === "chat" ? 4 : 5 }),
      messageRevision: () => 1,
      messageDisplayOrigin: () => undefined,
      displayHistory: () => ({ count: 1, cursor: 20 }),
      displayWindow: () => [["canonical", 0]],
      captureVariableVersions: () => ({
        chat: new Map(),
        localGlobal: new Map(),
        global: new Map(),
      }),
      hasEarlier: false,
      isWindowed: false,
    },
  });
  RuntimeUIState.pending = [
    pending("pending"),
    pending("old-pending", { expectedChatEpoch: 3 }),
    pending("foreign-pending", { chatId: "b" }),
    { ...pending("blocked"), state: "blocked" },
    pending("terminal"),
  ] as typeof RuntimeUIState.pending;
  try {
    const read = (id: string) => owner.captureProvisionalDisplayHeader(id, "c");
    const admittedOwned =
      read("pending")?.rows.some((row) => row.chatId === "progress") &&
      read("progress")?.header.history.count === 1;
    const rejectsForeignRetiredBlocked = [
      "foreign",
      "old",
      "terminal",
      "old-pending",
      "foreign-pending",
      "blocked",
      "unknown",
      "canonical",
    ].every((id) => !read(id));
    const first = read("progress");
    owner.jobs.get("progress").progress.messages[0].data = "Changed";
    const freshProgress =
      read("progress").rows.find((row) => row.chatId === "progress").data ===
      "Changed";
    owner.model.isWindowed = true;
    const historicalWindowFence = !read("progress") && !read("pending");
    owner.model.isWindowed = false;
    owner.displayProjectedCursor = 17;
    const clockFence = !read("progress");
    owner.displayProjectedCursor = 20;
    owner.display.state.chatEpoch = 3;
    const chatEpochFence = !read("progress");
    owner.display.state.chatEpoch = 4;
    owner.display.state.characterEpoch = 4;
    const characterEpochFence = !read("progress");
    owner.display.state.characterEpoch = 5;
    const characterFence = !owner.captureProvisionalDisplayHeader(
      "progress",
      "other",
    );
    RuntimeUIState.scopeReady = false;
    const notReady = !read("progress");
    return {
      actualControllerMethods: true,
      admittedOwned: Boolean(admittedOwned),
      rejectsForeignRetiredBlocked,
      freshProgress,
      historicalWindowFence,
      clockFence,
      chatEpochFence,
      characterEpochFence,
      characterFence,
      notReady,
      canonicalCountUnchanged:
        first.header.history.count === 1 && chat.message.length === 1,
    };
  } finally {
    RuntimeUIState.pending = previousPending;
    RuntimeUIState.scopeReady = previousReady;
  }
}

/** Actual Svelte cache fallback, with a body unavailable to the lazy derivation. */
export function checkLazyDisplayHeaders() {
  let ready = $state(false),
    value = $state("before");
  let clock = 1,
    epoch = 1,
    revision = 1,
    reads = 0;
  const environment = undefined;
  const header = (index = 0): DisplayScopeHeader => ({
    serverId: "synthetic",
    state: {
      cursor: 1,
      inputClock: clock,
      chatId: "a",
      characterId: "c",
      chatEpoch: epoch,
      characterEpoch: epoch,
      applied: [],
      next: null,
    },
    projectedCursor: 1,
    history: { count: 2, cursor: 1, ordinal: index },
    historyWindow: [
      ["m0", 0],
      ["m1", 1],
    ],
    versions: {
      chat: new Map([["$v", revision]]),
      localGlobal: new Map(),
      global: new Map(),
    },
    sourceContent: "Synthetic " + index,
    message: { id: "m" + index, revision },
    hasEarlier: false,
    persistent: true,
  });
  const full = (): DisplayCapture => {
    const chat = {
      id: "a",
      message: [
        { chatId: "m0", data: value, role: "char" },
        { chatId: "m1", data: value, role: "char" },
      ],
      scriptstate: { $v: value },
      GLGlobalVariables: {},
    };
    const character = {
      type: "character",
      chaId: "c",
      chats: [chat],
      chatPage: 0,
      triggerscript: [],
    };
    return {
      ...header(),
      database: { characters: [character], globalChatVariables: {} },
      character,
      chat,
      triggers: [],
    } as unknown as DisplayCapture;
  };
  const cache = createDisplayScopeCache(
    (fresh) => fresh ?? (ready ? full() : undefined),
    () => {
      ready;
    },
  );
  const body = () => {
    reads++;
    return full();
  };
  const scopes = Array.from({ length: 50 }, (_, index) =>
    cache.capture(header(index % 2), environment, body),
  );
  const initialReads = reads,
    old = scopes[0];
  const sharedFrozen =
    scopes.every((scope) => scope.chat.message === old.chat.message) &&
    Object.isFrozen(old.chat.message);
  old.chat.scriptstate.$v = "private";
  old.versions.chat.set("$v", 99);
  const independentMutable =
    scopes[1].chat.scriptstate.$v === "before" &&
    scopes[1].versions.chat.get("$v") === 1;
  const oldHeader = header();
  clock = 2;
  value = "after";
  const changed = cache.capture(header(), environment, body);
  const changedReads = reads;
  const rebuiltClock =
    changed.state.inputClock === 2 &&
    changed.chat.scriptstate.$v === "after" &&
    old.chat.message[0].data === "before";
  revision = 3;
  const fresh = cache.capture(header(1), environment, body);
  const headerOnlyFresh =
    reads === changedReads &&
    fresh.versions.chat.get("$v") === 3 &&
    fresh.message.id === "m1" &&
    fresh.message.revision === 3 &&
    fresh.history.ordinal === 1;
  epoch = 2;
  const reentered = cache.capture(header(), environment, body);
  const epochReads = reads;
  const rebuiltEpoch =
    reentered.state.chatEpoch === 2 && epochReads === changedReads + 1;
  clock = 3;
  let mismatchedBodyRejected = false;
  try {
    cache.capture(header(), environment, () => ({ ...full(), ...oldHeader }));
  } catch (error) {
    mismatchedBodyRejected = String(error).includes("scope changed");
  }
  let missingBodyRejected = false;
  try {
    cache.capture(header(), environment, () => undefined);
  } catch (error) {
    missingBodyRejected = String(error).includes("scope changed");
  }
  const legacy = cache.capture(full(), environment);
  const legacyFullApi =
    legacy.state.inputClock === 3 && legacy.chat.scriptstate.$v === "after";
  cache.close();
  const closedNoReads =
    cache.capture(header(), environment, body) === undefined &&
    reads === epochReads;
  return {
    clientCompiledSvelte: true,
    initialReads,
    changedReads,
    epochReads,
    sharedFrozen,
    independentMutable,
    rebuiltClock,
    headerOnlyFresh,
    rebuiltEpoch,
    mismatchedBodyRejected,
    missingBodyRejected,
    legacyFullApi,
    closedNoReads,
  };
}
