import {
  commandJson,
  type RuntimeChange,
  type RuntimeCommand,
} from "./clientProtocol";
import type {
  Chat,
  Database,
  character,
  groupChat,
  triggerscript,
} from "../storage/database.svelte";
import {
  variableIdentity,
  type VariableEdit,
  type VariableTarget,
} from "./variableCommands";

export interface DisplayState {
  cursor: number;
  chatId: string;
  characterId: string;
  chatEpoch: number;
  characterEpoch: number;
  inputClock: number;
  applied: string[];
  next: string | null;
}
export type DisplaySource =
  | { kind: "view"; contentHash: string }
  | {
      kind: "message";
      contentHash: string;
      messageId: string;
      expectedRevision: number;
    };
export interface DisplayCapture {
  presentationVariables?: readonly (readonly [
    string,
    { exists: boolean; value?: import("./variableCommands").VariableScalar },
  ])[];
  historyWindow?: import("./canonicalDisplayHistory").DisplayHistoryWindow;
  cbsEnvironment?: {
    model: ReturnType<
      import("../parser/cbsRuntime").CbsRuntimeHost["getModelInfo"]
    >;
    triggerId: ReturnType<
      import("../parser/cbsRuntime").CbsRuntimeHost["getCurrentTriggerId"]
    >;
    isTauri: boolean;
    isNodeServer: boolean;
    isMobile: boolean;
    appVer: string;
  };
  cbsModules?: ReturnType<
    import("../parser/cbsRuntime").CbsRuntimeHost["getModules"]
  >;
  cbsLorebooks?: ReturnType<
    import("../parser/cbsRuntime").CbsRuntimeHost["getModuleLorebooks"]
  >;
  projectedCursor?: number;
  history?: { count: number; cursor: number; ordinal?: number };
  serverId: string;
  state: DisplayState;
  database: Database;
  character: character | groupChat;
  chat: Chat;
  triggers: triggerscript[];
  versions: {
    chat: Map<string, number>;
    localGlobal: Map<string, number>;
    global: Map<string, number>;
  };
  sourceContent?: string;
  message?: { id: string; revision: number; origin?: DisplayMessageOrigin };
  hasEarlier: boolean;
  persistent: boolean;
}
/** Fresh ownership/source metadata without enumerating projected definitions. */
export type DisplayScopeHeader = Pick<
  DisplayCapture,
  | "serverId"
  | "state"
  | "projectedCursor"
  | "history"
  | "historyWindow"
  | "versions"
  | "sourceContent"
  | "message"
  | "hasEarlier"
  | "persistent"
>;
export type BrowserDisplayHeader = DisplayScopeHeader & {
  aiModel: Database["aiModel"];
};
export type DisplayMessageOrigin = {
  messageRevision: number;
  chatEpoch: number;
  characterEpoch: number;
  inputClock: number;
  codeHash: string;
  displayKey: string;
};
/** A confirmed rewrite is still the same occurrence on another device/reload. */
export function displaySourceApplied(
  capture: DisplayCapture,
  codeHash: string,
) {
  const origin = capture.message?.origin;
  return Boolean(
    origin &&
    origin.messageRevision === capture.message.revision &&
    origin.chatEpoch === capture.state.chatEpoch &&
    origin.characterEpoch === capture.state.characterEpoch &&
    origin.inputClock === capture.state.inputClock &&
    origin.codeHash === codeHash,
  );
}
export async function displayHash(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function displayIdentity(
  capture: DisplayCapture,
  content: string,
  hash: typeof displayHash = displayHash,
) {
  const codeHash = await hash(
    commandJson(
      capture.triggers.flatMap((t) =>
        t.effect?.[0]?.type === "triggerlua" ? [t.effect[0].code] : [],
      ),
    ),
  );
  const contentHash = await hash(content);
  const source: DisplaySource = capture.message
    ? {
        kind: "message",
        contentHash,
        messageId: capture.message.id,
        expectedRevision: capture.message.revision,
      }
    : { kind: "view", contentHash };
  const { chatId, characterId, chatEpoch, characterEpoch, inputClock } =
    capture.state;
  const displayKey = await hash(
    commandJson({
      chatId,
      characterId,
      chatEpoch,
      characterEpoch,
      inputClock,
      codeHash,
      source,
    }),
  );
  return { displayKey, codeHash, source };
}

/** One active scope; bounded journal catch-up while receipt pages are being read. */
export class DisplayLedger {
  state?: DisplayState;
  ready = false;
  private applied = new Set<string>();
  private observed: RuntimeChange[] = [];
  private overflow = false;
  begin(chatId: string, characterId: string) {
    this.state = {
      chatId,
      characterId,
      chatEpoch: 0,
      characterEpoch: 0,
      cursor: 0,
      inputClock: 0,
      applied: [],
      next: null,
    };
    this.ready = false;
    this.applied.clear();
    this.observed = [];
    this.overflow = false;
  }
  install(snapshot: DisplayState) {
    if (!this.state || this.state.chatId !== snapshot.chatId || this.overflow)
      return false;
    const changes = this.observed.filter((c) => c.sequence > snapshot.cursor);
    this.state = { ...snapshot };
    this.applied = new Set(snapshot.applied);
    for (const change of changes) this.apply(change);
    this.observed = [];
    this.ready = true;
    return true;
  }
  observe(change: RuntimeChange) {
    if (!this.state) return false;
    const previousClock = this.state.inputClock;
    if (!this.ready) {
      if (this.observed.length === 1000) this.overflow = true;
      else this.observed.push(change);
    }
    this.apply(change);
    return (
      previousClock !== this.state.inputClock ||
      Boolean(
        change.payload.displayEffectId &&
        change.chatId === this.state.chatId &&
        change.type === "variable",
      )
    );
  }
  private apply(change: RuntimeChange) {
    const state = this.state;
    if (!state) return;
    const effect = change.payload.displayEffectId;
    if (effect) {
      if (
        change.chatId === state.chatId &&
        change.payload.displayInputClock === state.inputClock
      )
        this.applied.add(String(effect));
      return;
    }
    if (
      [
        "job",
        "job-progress",
        "notice",
        "statistics",
        "character-activity",
        "display-effect",
      ].includes(change.type)
    )
      return;
    const fields = change.type === "fields" ? change.payload.fields : null;
    const scope = Array.isArray(fields)
      ? (fields[0] as { scope?: string })?.scope
      : null;
    const relevant = change.chatId
      ? change.chatId === state.chatId
      : change.type === "character" || scope === "character"
        ? change.id === state.characterId
        : true;
    if (relevant && change.sequence > state.inputClock) {
      state.inputClock = change.sequence;
      this.applied.clear();
    }
  }
  seen(key: string, clock: number) {
    return (
      this.ready && clock === this.state?.inputClock && this.applied.has(key)
    );
  }
}

/** Values and revisions are captured together, before any asynchronous Lua work. */
export class DisplayProposal {
  readonly reads = new Map<
    string,
    VariableTarget & { expectedRevision: number }
  >();
  readonly edits = new Map<string, VariableEdit>();
  failure?: Error;
  constructor(
    readonly capture: DisplayCapture,
    readonly suppressed: boolean,
  ) {}
  fail(error: unknown): never {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    throw this.failure;
  }
  record(target: VariableTarget) {
    const map =
      target.scope === "chat"
        ? this.capture.versions.chat
        : target.scope === "chat-global"
          ? this.capture.versions.localGlobal
          : this.capture.versions.global;
    this.reads.set(variableIdentity(target), {
      ...target,
      expectedRevision: map.get(target.key) ?? 0,
    });
    if (this.reads.size > 128)
      this.fail("Display script reads more than 128 variables");
  }
  write(key: string, value: unknown, changed: () => boolean) {
    if (this.suppressed) return false;
    if (!(
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ))
      this.fail("Display variables must be finite JSON scalars");
    const edit: VariableEdit = {
      scope: "chat",
      chatId: this.capture.state.chatId,
      key: "$" + key,
      expectedRevision: this.capture.versions.chat.get("$" + key) ?? 0,
      value: value as string,
    };
    if (!changed()) return false;
    this.edits.set(variableIdentity(edit), edit);
    if (this.edits.size > 128)
      this.fail("Display script writes more than 128 variables");
    this.validateBytes();
    return true;
  }
  private validateBytes() {
    if (
      new TextEncoder().encode(
        commandJson({
          reads: [...this.reads.values()],
          edits: [...this.edits.values()],
        }),
      ).length >
      256 * 1024
    )
      this.fail("Display effect exceeds 256 KiB");
  }
  command(
    identity: Awaited<ReturnType<typeof displayIdentity>>,
  ): RuntimeCommand {
    if (this.failure) throw this.failure;
    this.validateBytes();
    return {
      type: "apply-display-effects",
      ...identity,
      chatId: this.capture.state.chatId,
      expectedChatEpoch: this.capture.state.chatEpoch,
      expectedCharacterEpoch: this.capture.state.characterEpoch,
      inputClock: this.capture.state.inputClock,
      reads: [...this.reads.values()],
      edits: [...this.edits.values()],
    };
  }
}
