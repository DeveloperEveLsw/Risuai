import type { ScriptingRuntimeHost } from "../process/scriptingRuntime";
import {
  displayIdentity,
  displaySourceApplied,
  type DisplayCapture,
} from "./displayEffects";
import type { RuntimeCommand } from "./clientProtocol";
import type { triggerscript } from "../storage/database.svelte";
import { yieldDisplayTurn } from "./displayScheduling";
import { displayScopeJson } from "./displayScopeIdentity";
import { DisplayWireBudget } from "./displayWireBudget";
import { DisplayDigestCache } from "./displayDigestCache";
import {
  mergeDisplayReads,
  displayPresentationIdentity,
  type DisplayReadAdmission,
} from "./displayReadDependencies";
import { commandJson } from "./clientProtocol";
import {
  DisplayLuaContext,
  type DisplayExecutor,
  type DisplayParser,
} from "./displayLuaContext";
export type { DisplayScope } from "./displayLuaContext";
export function hasDisplayLua(triggers: triggerscript[] | undefined) {
  return Boolean(triggers?.some((t) => t?.effect?.[0]?.type === "triggerlua"));
}
export type DisplayDraft = {
  output: string;
  command?: RuntimeCommand;
  failed?: boolean;
  /** Bounded underlying failure; no captured state or script body is attached. */
  error?: string;
  commit: (admission?: DisplayReadAdmission) => Promise<void>;
};
const unchanged = (
  output: string,
  failed = false,
  error?: unknown,
): DisplayDraft => ({
  output,
  failed,
  ...(error === undefined
    ? {}
    : {
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          512,
        ),
      }),
  commit: async () => {},
});
type Lease = {
  executor: DisplayExecutor;
  tail: Promise<unknown>;
  users: number;
  retired: boolean;
  space?: { promise: Promise<void>; release: () => void };
};
type Invocation = {
  ready: Promise<void>;
  work: Promise<DisplayDraft>;
};
type Hooks = {
  capture: (
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
    bookmarkToken?: string,
  ) => DisplayCapture | undefined;
  seen: (key: string, capture: DisplayCapture) => boolean;
  pending: (key: string) => RuntimeCommand | undefined;
  submit: (command: RuntimeCommand, capture: DisplayCapture) => Promise<void>;
  error: (error: unknown) => void;
  parser: DisplayParser;
};

/** Presentation runs immediately against a private, pinned scope. Admission only awaits local IDB. */
export class BrowserDisplayLua {
  private leases = new Map<string, Lease>();
  private inflight = new Map<string, Invocation>();
  private preparingWork = new Map<string, Promise<DisplayDraft>>();
  private preparations = new Map<
    string,
    { tail: Promise<void>; users: number }
  >();
  private preparing = 0;
  private ownerIds = new WeakMap<() => boolean, number>();
  private nextOwnerId = 0;
  private scopeBudget = new DisplayWireBudget(
    16 * 1024 * 1024,
    256,
    2 * 1024 * 1024,
  );
  private closed = false;
  private digests = new DisplayDigestCache();
  private hash = (value: string) => this.digests.hash(value);
  constructor(
    private base: () => ScriptingRuntimeHost,
    private hooks: Hooks,
    private maxContexts = 8,
    private executorFactory: (
      base: () => ScriptingRuntimeHost,
      parser: DisplayParser,
    ) => DisplayExecutor = (base, parser) =>
      new DisplayLuaContext(base, parser),
  ) {}
  capture(
    index: number,
    firstMessage: boolean,
    expectedCharacterId?: string,
    expectedMessageId?: string,
    bookmarkToken?: string,
  ) {
    if (this.closed) return;
    return this.hooks.capture(
      index,
      firstMessage,
      expectedCharacterId,
      expectedMessageId,
      bookmarkToken,
    );
  }
  /** Fresh identity; reuse only bounded scalar sizes for this browser owner. */
  presentationIdentity(capture: DisplayCapture) {
    if (this.closed)
      throw Error("Display Lua owner closed before presentation");
    return displayPresentationIdentity(capture, this.scopeBudget);
  }
  async run(
    content: string,
    index = -1,
    firstMessage = false,
    expectedCharacterId?: string,
    rawContent?: string,
    pinnedCapture?: DisplayCapture,
    current?: () => boolean,
  ) {
    const draft = await this.compute(
      content,
      index,
      firstMessage,
      expectedCharacterId,
      rawContent,
      pinnedCapture,
      current,
    );
    try {
      await draft.commit();
      return draft.output;
    } catch {
      return content;
    }
  }
  async defer(
    content: string,
    index = -1,
    firstMessage = false,
    expectedCharacterId?: string,
    rawContent?: string,
    pinnedCapture?: DisplayCapture,
    current?: () => boolean,
  ): Promise<DisplayDraft> {
    return this.compute(
      content,
      index,
      firstMessage,
      expectedCharacterId,
      rawContent,
      pinnedCapture,
      current,
    );
  }
  /** A pure original regex can produce a source intent without starting Lua. */
  async admit(capture: DisplayCapture, admission: DisplayReadAdmission) {
    if (admission.provisional || !capture.persistent) return;
    if (this.closed) throw Error("Display Lua owner closed before admission");
    const identity = await displayIdentity(
      capture,
      capture.sourceContent ?? "",
      this.hash,
    );
    const command = mergeDisplayReads(
      {
        type: "apply-display-effects",
        ...identity,
        chatId: capture.state.chatId,
        expectedChatEpoch: capture.state.chatEpoch,
        expectedCharacterEpoch: capture.state.characterEpoch,
        inputClock: capture.state.inputClock,
        reads: [],
        edits: [],
      },
      admission,
    );
    if (this.closed) throw Error("Display Lua owner closed before admission");
    if (
      !displaySourceApplied(capture, identity.codeHash) &&
      !this.hooks.seen(identity.displayKey, capture) &&
      !this.hooks.pending(identity.displayKey)
    )
      await this.hooks.submit(command, capture);
  }
  private async compute(
    content: string,
    index = -1,
    firstMessage = false,
    expectedCharacterId?: string,
    rawContent?: string,
    pinnedCapture?: DisplayCapture,
    current?: () => boolean,
  ) {
    if (current && !current()) return unchanged(content);
    let ownerId = 0;
    if (current) {
      ownerId = this.ownerIds.get(current) ?? ++this.nextOwnerId;
      this.ownerIds.set(current, ownerId);
    }
    let capture: DisplayCapture;
    let scopeJson: string;
    try {
      capture =
        pinnedCapture ?? this.capture(index, firstMessage, expectedCharacterId);
      if (!capture || this.closed || !hasDisplayLua(capture.triggers))
        return unchanged(content);
      scopeJson = displayScopeJson(capture, this.scopeBudget);
    } catch (error) {
      this.hooks.error(error);
      return unchanged(content, true, error);
    }
    // Share only exact concurrent presentations before allocating digest/queue
    // work. The snapshot includes every header, dependency and capability;
    // nothing is reused after this calculation finishes.
    const key = JSON.stringify([
      scopeJson,
      content,
      index,
      capture.sourceContent ?? rawContent ?? content,
      ownerId,
    ]);
    const existing = this.preparingWork.get(key);
    if (existing) return existing;
    const work = this.prepare(
      capture,
      scopeJson,
      content,
      index,
      rawContent,
      current,
      ownerId,
    );
    this.preparingWork.set(key, work);
    try {
      return await work;
    } finally {
      if (this.preparingWork.get(key) === work) this.preparingWork.delete(key);
    }
  }
  private async prepare(
    capture: DisplayCapture,
    scopeJson: string,
    content: string,
    index: number,
    rawContent?: string,
    current?: () => boolean,
    ownerId = 0,
  ) {
    const key = JSON.stringify([
      capture.serverId,
      capture.state.chatId,
      capture.state.chatEpoch,
    ]);
    let preparation = this.preparations.get(key);
    if (this.preparing >= this.maxContexts * 128 || preparation?.users >= 128) {
      const error = new Error("Display scope preparation queue limit reached");
      this.hooks.error(error);
      return unchanged(content, true, error);
    }
    if (!preparation) {
      preparation = { tail: Promise.resolve(), users: 0 };
      this.preparations.set(key, preparation);
    }
    const previous = preparation.tail;
    let release: () => void;
    preparation.tail = new Promise<void>((resolve) => (release = resolve));
    preparation.users++;
    this.preparing++;
    // Hash independently, then admit in capture order for this chat. A slow
    // digest cannot reverse the original VM globals; other chats do not wait.
    const hashes = Promise.all([
      displayIdentity(
        capture,
        capture.sourceContent ?? rawContent ?? content,
        this.hash,
      ),
      this.hash(content),
      this.hash(scopeJson),
    ]);
    void hashes.catch(() => {});
    let identity: Awaited<ReturnType<typeof displayIdentity>>;
    let presentationHash: string;
    let scopeHash: string;
    try {
      await previous;
      if (current && !current()) return unchanged(content);
      [identity, presentationHash, scopeHash] = await hashes;
      if (this.closed) return unchanged(content);
      const invocation = this.dispatch(
        capture,
        content,
        index,
        identity,
        presentationHash,
        scopeHash,
        current,
        ownerId,
      );
      // Keep this chat's preparation turn until a Lua queue slot is reserved.
      // Later inputs wait in the existing bounded preparation queue instead of
      // overflowing the invocation queue. Execution still follows capture order.
      await invocation.ready;
      return invocation.work;
    } catch (error) {
      if (!this.closed) this.hooks.error(error);
      return unchanged(content, true, error);
    } finally {
      release();
      preparation.users--;
      this.preparing--;
      if (preparation.users === 0 && this.preparations.get(key) === preparation)
        this.preparations.delete(key);
    }
  }
  private dispatch(
    capture: DisplayCapture,
    content: string,
    index: number,
    identity: Awaited<ReturnType<typeof displayIdentity>>,
    presentationHash: string,
    scopeHash: string,
    current?: () => boolean,
    ownerId = 0,
  ) {
    // A durable occurrence may have multiple presentations after pagination.
    // Keep original metadata and capability/admission policy distinct in-flight;
    // server displayKey deduplication still applies to persistent proposals.
    const inflightKey = [
      capture.serverId,
      identity.displayKey,
      capture.projectedCursor ?? capture.state.cursor,
      presentationHash,
      scopeHash,
      index,
      capture.hasEarlier,
      capture.persistent,
      ownerId,
    ].join(":");
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;
    let release: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    const invocation: Invocation = {
      ready,
      work: this.evaluate(capture, content, index, identity, release, current)
        .finally(release)
        .finally(() => {
          if (this.inflight.get(inflightKey) === invocation)
            this.inflight.delete(inflightKey);
        }),
    };
    this.inflight.set(inflightKey, invocation);
    return invocation;
  }
  private async evaluate(
    capture: DisplayCapture,
    content: string,
    index: number,
    identity: Awaited<ReturnType<typeof displayIdentity>>,
    ready: () => void,
    current?: () => boolean,
  ) {
    const key = [
      capture.serverId,
      capture.state.chatId,
      capture.state.chatEpoch,
      identity.codeHash,
    ].join(":");
    let lease = this.leases.get(key);
    if (!lease) {
      // Never evict an executing engine. At capacity, fail visibly instead of growing without bound.
      if (this.leases.size >= this.maxContexts) {
        const idle = [...this.leases].find(([, value]) => value.users === 0);
        if (!idle) {
          const error = new Error("Display Lua context limit reached");
          this.hooks.error(error);
          return unchanged(content, true, error);
        }
        this.leases.delete(idle[0]);
        idle[1].executor.close();
      }
      lease = {
        executor: undefined,
        tail: Promise.resolve(),
        users: 0,
        retired: false,
      };
      try {
        lease.executor = this.executorFactory(this.base, this.hooks.parser);
      } catch (error) {
        this.hooks.error(error);
        return unchanged(content, true, error);
      }
      this.leases.set(key, lease);
    }
    // Refresh LRU position without resetting the original Lua globals.
    this.leases.delete(key);
    this.leases.set(key, lease);
    while (lease.users >= 128) {
      if (!lease.space) {
        let release: () => void;
        const promise = new Promise<void>((resolve) => (release = resolve));
        lease.space = { promise, release };
      }
      await lease.space.promise;
      if (this.closed || lease.retired) return unchanged(content);
    }
    lease.users++;
    ready();
    const work = lease.tail.then(async () => {
      // Retired presentations release their queued slot without entering Lua.
      // Live calls and calls already executing keep original VM order/globals.
      if (current && !current()) return unchanged(content);
      // Lua executes synchronously inside WASM. Promise chaining alone keeps all rows in one task.
      // The captured values/revisions remain pinned across this yield; server CAS still checks them.
      await yieldDisplayTurn();
      if (this.closed || lease.retired || (current && !current()))
        return unchanged(content);
      const pending = this.hooks.pending(identity.displayKey);
      const suppressed = Boolean(
        pending ||
        this.hooks.seen(identity.displayKey, capture) ||
        displaySourceApplied(capture, identity.codeHash),
      );
      if (pending && Array.isArray(pending.edits))
        for (const edit of pending.edits as unknown as {
          key: string;
          value?: string;
          remove?: boolean;
        }[]) {
          if (edit.remove) delete capture.chat.scriptstate[edit.key];
          else capture.chat.scriptstate[edit.key] = edit.value;
        }
      try {
        const {
          output,
          command,
          reads: luaReads,
        } = await lease.executor.execute({
          capture,
          content,
          index,
          identity,
          suppressed,
        });
        if (this.closed || lease.retired) return unchanged(content);
        let admission: Promise<void>;
        let admissionSignature: string;
        return {
          output,
          command,
          commit: (reads) => {
            if (
              !capture.persistent ||
              suppressed ||
              (!command && !reads?.messageEdits?.length)
            )
              return Promise.resolve();
            // Pending presentation values can be shown immediately, but never
            // justify a canonical write. Confirmation creates a fresh owner.
            if (reads?.provisional) return Promise.resolve();
            let proposal: RuntimeCommand;
            try {
              proposal = mergeDisplayReads(
                command ?? {
                  type: "apply-display-effects",
                  ...identity,
                  chatId: capture.state.chatId,
                  expectedChatEpoch: capture.state.chatEpoch,
                  expectedCharacterEpoch: capture.state.characterEpoch,
                  inputClock: capture.state.inputClock,
                  reads: luaReads ?? [],
                  edits: [],
                },
                reads,
              );
            } catch (error) {
              return Promise.reject(error);
            }
            const signature = commandJson(proposal);
            if (admission)
              return signature === admissionSignature
                ? admission
                : Promise.reject(
                    new Error(
                      "Coalesced display proposal has different read provenance",
                    ),
                  );
            if (this.closed || lease.retired)
              return Promise.reject(
                new Error("Display scope owner closed before admission"),
              );
            admissionSignature = signature;
            admission = (async () => {
              try {
                await this.hooks.submit(proposal, capture);
              } catch (error) {
                lease.retired = true;
                if (this.leases.get(key) === lease) this.leases.delete(key);
                lease.executor.close();
                if (!this.closed) this.hooks.error(error);
                throw error;
              }
            })();
            return admission;
          },
        } satisfies DisplayDraft;
      } catch (error) {
        lease.retired = true;
        if (this.leases.get(key) === lease) this.leases.delete(key);
        lease.executor.close();
        if (!this.closed) this.hooks.error(error);
        return unchanged(content, true, error);
      }
    });
    lease.tail = work.catch(() => {});
    try {
      return await work;
    } finally {
      lease.users--;
      lease.space?.release();
      lease.space = undefined;
      if (lease.retired && lease.users === 0) lease.executor.close();
    }
  }
  close() {
    this.closed = true;
    this.preparingWork.clear();
    for (const lease of this.leases.values()) {
      lease.retired = true;
      lease.space?.release();
      lease.executor.close();
    }
    this.leases.clear();
    this.preparations.clear();
    this.scopeBudget.close();
    this.digests.close();
  }
  diagnostics() {
    return { contexts: this.leases.size, invocations: this.inflight.size };
  }
}
