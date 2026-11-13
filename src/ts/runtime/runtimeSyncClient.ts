import { type RuntimeOutbox, type OutboxEntry } from "./browserOutbox";
import {
  RuntimeClientError,
  validCursor,
  type RuntimeBootstrap,
  type RuntimeChange,
  type RuntimeCommand,
  type AdmissionKind,
  type Json,
} from "./clientProtocol";
import { runtimeEvents } from "./runtimeEventStream";
import {
  runtimeFetch,
  runtimeHttpFailure,
  recordRuntimeDiagnostic,
} from "./runtimeDiagnostics";
import { diagnosticRequestId } from "./runtimeDiagnosticProtocol.mjs";
import {
  variableEdits,
  variableIdentity,
  type VariableEdit,
  type VariableValue,
} from "./variableCommands";
import {
  fieldEdits,
  fieldIdentity,
  type FieldEdit,
  type FieldValue,
  type DerivedFieldOptions,
} from "./fieldCommands";

export interface RuntimeSyncOptions {
  baseUrl: string;
  serverId: string;
  outbox: RuntimeOutbox;
  onBootstrap: (snapshot: RuntimeBootstrap) => void | Promise<void>;
  onChange: (change: RuntimeChange) => void | Promise<void>;
  onAccepted: (
    entry: OutboxEntry,
    receipt: Record<string, Json>,
  ) => void | Promise<void>;
  onPending?: (entries: OutboxEntry[]) => void;
  onProjected?: (entry: OutboxEntry) => void;
  onStatus?: (state: "connecting" | "connected" | "offline" | "closed") => void;
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
  retryMs?: number;
  requestTimeoutMs?: number;
}
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const scope = (entry: OutboxEntry) => String(entry.command.chatId ?? "global");
const scopes = (entry: OutboxEntry) =>
  ["answer-interaction", "cancel-interaction"].includes(entry.command.type)
    ? ["interaction:" + String(entry.command.interactionId)]
    : entry.command.type === "acknowledge-notice"
      ? ["notice:" + String(entry.command.noticeId)]
      : entry.command.type === "change-group-member"
        ? [
            "group-member:" +
              JSON.stringify([entry.command.groupId, entry.command.memberId]),
          ]
        : entry.command.type === "apply-display-effects"
          ? ["display:" + String(entry.command.displayKey ?? entry.requestId)]
          : variableEdits(entry.command).length
            ? variableEdits(entry.command).map(
                (edit) => "variable:" + variableIdentity(edit),
              )
            : fieldEdits(entry.command).length
              ? fieldEdits(entry.command).map(fieldIdentity)
              : [scope(entry)];

/** Transport/projection boundary: no whole-database save, provider calls or UI navigation. */
export class RuntimeSyncClient {
  private cursor = 0;
  private started = false;
  private ready = false;
  private closed = false;
  private abort = new AbortController();
  private streamAbort?: AbortController;
  private observing?: Promise<void>;
  private pumping?: Promise<void>;
  private pumpAgain = false;
  private timer?: ReturnType<typeof setInterval>;
  private request: typeof fetch;
  private deliveredReceipts = new Set<string>();
  constructor(private options: RuntimeSyncOptions) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  get appliedCursor() {
    return this.cursor;
  }
  private error(error: unknown) {
    this.options.onError?.(error);
  }
  private pending = async () => {
    this.options.onPending?.(await this.options.outbox.list());
  };

  private async response(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.options.requestTimeoutMs ?? 15000,
  ): Promise<Response> {
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(timeoutMs),
      ...(init.signal ? [init.signal] : []),
    ]);
    const headers = new Headers(init.headers);
    headers.set("Risu-Runtime-Id", this.options.serverId);
    return await runtimeFetch(
      this.options.baseUrl.replace(/\/$/, "") + path,
      {
        ...init,
        headers,
        signal,
        cache: "no-store",
        credentials: "same-origin",
      },
      this.request,
    );
  }
  private async checkResponse(response: Response, method = "GET") {
    if (!response.ok) {
      throw await runtimeHttpFailure(
        response,
        "Runtime request failed",
        method,
      );
    }
  }
  async read<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.response(path, init, timeoutMs);
    await this.checkResponse(response, init.method ?? "GET");
    return await response.json();
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const response = await this.response(path, {}, 120000);
    await this.checkResponse(response);
    return new Uint8Array(await response.arrayBuffer());
  }
  async downloadServerSnapshot(write: (chunk: Uint8Array) => Promise<void>) {
    const response = await this.response(
      "/server-snapshot",
      {},
      60 * 60 * 1000,
    );
    await this.checkResponse(response);
    if (!response.body) throw new Error("Server snapshot body is unavailable");
    const { ServerSnapshotDownload } = await import("./serverSnapshotDownload");
    const validator = new ServerSnapshotDownload(this.options.serverId);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.length; at += 65536) {
          const chunk = value.subarray(at, at + 65536);
          validator.push(chunk);
          await write(chunk);
        }
      }
      validator.finish();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async bootstrap() {
    const snapshot = await this.read<RuntimeBootstrap>("/bootstrap");
    if (snapshot.serverId !== this.options.serverId)
      throw new RuntimeClientError(
        "SERVER_CHANGED",
        "The server database changed; pending commands require reconciliation",
      );
    if (!validCursor(snapshot.cursor))
      throw new RuntimeClientError(
        "INVALID_SNAPSHOT",
        "Invalid snapshot cursor",
      );
    await this.options.onBootstrap(snapshot);
    if (this.closed)
      throw new RuntimeClientError(
        "CLIENT_CLOSED",
        "Sync client closed during hydration",
      );
    this.deliveredReceipts.clear();
    this.cursor = snapshot.cursor;
    await this.reconcileMutations();
  }
  async start() {
    if (this.started || this.closed)
      throw new RuntimeClientError(
        "CLIENT_STATE",
        "Sync client can only start once",
      );
    this.started = true;
    this.options.onStatus?.("connecting");
    await this.pending();
    await this.bootstrap();
    if (this.closed)
      throw new RuntimeClientError("CLIENT_CLOSED", "Sync client is closed");
    this.ready = true;
    this.observing = this.observe();
    this.timer = setInterval(() => this.kick(), this.options.retryMs ?? 1000);
    this.kick();
  }

  async enqueue(
    kind: AdmissionKind,
    command: RuntimeCommand,
    requestId = crypto.randomUUID(),
  ) {
    if (this.closed)
      throw new RuntimeClientError("CLIENT_CLOSED", "Sync client is closed");
    const entry = await this.options.outbox.enqueue(requestId, kind, command);
    await this.pending();
    if (this.started) this.kick();
    return entry;
  }
  kick() {
    if (this.ready && !this.closed)
      void this.flush().catch((error) => this.error(error));
  }
  async enqueueVariables(
    edits: VariableEdit[],
    requestId = crypto.randomUUID(),
  ) {
    if (this.closed)
      throw new RuntimeClientError("CLIENT_CLOSED", "Sync client is closed");
    const outbox = this.options.outbox;
    if (!outbox.enqueueVariables)
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "Variable admission requires a durable transactional outbox",
      );
    const entry = await outbox.enqueueVariables(requestId, edits);
    await this.pending();
    if (this.started) this.kick();
    return entry;
  }
  async resolveVariableChain(
    requestId: string,
    values: VariableValue[],
    keepLocal: boolean,
  ) {
    const outbox = this.options.outbox;
    if (!outbox.resolveVariableChain)
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "Variable resolution requires a transactional outbox",
      );
    await outbox.resolveVariableChain(
      requestId,
      values,
      keepLocal ? crypto.randomUUID() : undefined,
    );
    await this.pending();
    this.kick();
  }
  async enqueueFields(
    edits: FieldEdit[],
    requestId = crypto.randomUUID(),
    dependencies: DerivedFieldOptions = {},
  ) {
    if (this.closed)
      throw new RuntimeClientError("CLIENT_CLOSED", "Sync client is closed");
    if (!this.options.outbox.enqueueFields)
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "Field admission requires a durable transactional outbox",
      );
    if (
      (dependencies.groupImageSources || dependencies.checks?.length) &&
      this.options.outbox.derivedFieldsVersion !== 1
    )
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "The outbox cannot retain derived image dependencies",
      );
    const entry = await this.options.outbox.enqueueFields(
      requestId,
      edits,
      dependencies,
    );
    await this.pending();
    if (this.started) this.kick();
    return entry;
  }
  async resolveFieldChain(
    requestId: string,
    values: FieldValue[],
    keepLocal: boolean,
  ) {
    if (!this.options.outbox.resolveFieldChain)
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "Field resolution requires a transactional outbox",
      );
    await this.options.outbox.resolveFieldChain(
      requestId,
      values,
      keepLocal ? crypto.randomUUID() : undefined,
    );
    await this.pending();
    this.kick();
  }
  flush(): Promise<void> {
    if (this.closed || !this.ready) return Promise.resolve();
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false;
        const held = new Set<string>();
        const heldIds = new Set<string>();
        const heldVariables: VariableEdit[] = [];
        const heldFields: FieldEdit[] = [];
        const hold = (entry: OutboxEntry) => {
          scopes(entry).forEach((key) => held.add(key));
          heldIds.add(entry.requestId);
          heldVariables.push(...variableEdits(entry.command));
          heldFields.push(...fieldEdits(entry.command));
        };
        const entries = await this.options.outbox.list();
        const isConfiguration = (entry: OutboxEntry) =>
          entry.command.type === "change-group-member" ||
          entry.command.type === "set-persona-image" ||
          fieldEdits(entry.command).some(
            (edit) =>
              edit.scope === "resource" &&
              ((edit.resourceKind === "settings" &&
                edit.entityId === "global") ||
                edit.resourceKind === "preset" ||
                edit.resourceKind === "persona"),
          );
        const pendingConfiguration = entries.filter(
          (entry) => entry.state !== "accepted" && isConfiguration(entry),
        );
        const settledConfiguration = new Set<string>();
        let deferredLibrary = false;
        for (const entry of entries) {
          if (
            (entry.kind === "job" ||
              ["retry-job-result", "move-reply-choice"].includes(
                entry.command.type,
              ) ||
              ["activate-library-resource", "save-active-library"].includes(
                entry.command.type,
              )) &&
            pendingConfiguration.some(
              (field) => !settledConfiguration.has(field.requestId),
            )
          ) {
            hold(entry);
            deferredLibrary = true;
            continue;
          }
          if (this.closed) return;
          if (
            scopes(entry).some((key) => held.has(key)) ||
            (Array.isArray(entry.command.after) &&
              entry.command.after.some((id) => heldIds.has(String(id)))) ||
            (["activate-library-resource", "save-active-library"].includes(
              entry.command.type,
            ) &&
              heldFields.some(
                (edit) =>
                  edit.scope === "resource" &&
                  edit.resourceKind === "settings" &&
                  edit.entityId === "global",
              )) ||
            ((entry.kind === "job" ||
              ["retry-job-result", "move-reply-choice"].includes(
                entry.command.type,
              )) &&
              heldVariables.some(
                (edit) =>
                  edit.scope === "global" ||
                  ("chatId" in edit && edit.chatId === entry.command.chatId),
              )) ||
            // A job can lazily read other characters/resources. Keep its admission behind
            // unresolved configuration edits rather than execute with silent stale intent.
            ((entry.kind === "job" ||
              ["retry-job-result", "move-reply-choice"].includes(
                entry.command.type,
              )) &&
              heldFields.some(
                (edit) =>
                  edit.scope !== "chat" ||
                  edit.entityId === entry.command.chatId,
              ))
          ) {
            hold(entry);
            continue;
          }
          if (entry.state === "blocked") {
            hold(entry);
            continue;
          }
          let accepted = entry;
          if (entry.state === "pending") {
            let receipt: Record<string, Json>;
            try {
              receipt = await this.read(
                entry.kind === "job"
                  ? "/jobs"
                  : entry.command.groupImageSources ||
                      (Array.isArray(entry.command.checks) &&
                        entry.command.checks.length)
                    ? "/commands/guarded-fields"
                    : "/commands",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    requestId: entry.requestId,
                    command: entry.command,
                  }),
                },
              );
            } catch (error) {
              if (this.closed) return;
              if (
                error instanceof RuntimeClientError &&
                error.code === "SERVER_CHANGED"
              ) {
                this.error(error);
                await this.stopObservation();
                return;
              }
              if (
                error instanceof RuntimeClientError &&
                ["CHAT_BUSY", "DEPENDENCY_PENDING"].includes(error.code)
              ) {
                hold(entry);
                continue;
              }
              if (
                error instanceof RuntimeClientError &&
                error.status >= 400 &&
                error.status < 500 &&
                ![408, 429].includes(error.status)
              ) {
                await this.options.outbox.block(entry.requestId, {
                  code: error.code,
                  message: error.message,
                  details: error.details,
                });
                hold(entry);
                await this.pending();
                continue;
              }
              // Lost acknowledgement/network failure: preserve the original identity and payload.
              this.error(error);
              return;
            }
            if (isConfiguration(entry))
              settledConfiguration.add(entry.requestId);
            accepted = await this.options.outbox.accept(
              entry.requestId,
              receipt,
            );
            if (!accepted) continue; // A successfully projected terminal event already removed it.
          }
          if (!this.deliveredReceipts.has(accepted.requestId)) {
            await this.options.onAccepted(accepted, accepted.receipt);
            this.deliveredReceipts.add(accepted.requestId);
          }
          if (
            accepted.kind === "command" &&
            validCursor(accepted.receipt?.cursor) &&
            accepted.receipt.cursor <= this.cursor
          ) {
            this.options.onProjected?.(accepted);
            await this.options.outbox.remove(accepted.requestId);
            this.deliveredReceipts.delete(accepted.requestId);
          }
          await this.pending();
        }
        if (deferredLibrary && settledConfiguration.size) this.pumpAgain = true;
      } while (this.pumpAgain && !this.closed);
    })().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }
  private async reconcileMutations() {
    for (const entry of await this.options.outbox.list())
      if (
        entry.state === "accepted" &&
        entry.kind === "command" &&
        validCursor(entry.receipt?.cursor) &&
        entry.receipt.cursor <= this.cursor
      ) {
        this.options.onProjected?.(entry);
        await this.options.outbox.remove(entry.requestId);
        this.deliveredReceipts.delete(entry.requestId);
      }
    await this.pending();
  }
  async discardCommand(requestId: string) {
    const entry = (await this.options.outbox.list()).find(
      (e) => e.requestId === requestId,
    );
    if (!entry || entry.kind !== "command" || entry.state !== "blocked")
      throw new RuntimeClientError(
        "RESOLUTION_CHANGED",
        "Only a rejected command can be discarded",
      );
    await this.options.outbox.remove(requestId);
    await this.pending();
    this.kick();
  }
  private async apply(change: RuntimeChange) {
    if (!validCursor(change.sequence))
      throw new RuntimeClientError(
        "INVALID_STREAM",
        "Invalid runtime event sequence",
      );
    if (change.sequence <= this.cursor) return;
    if (change.sequence !== this.cursor + 1)
      throw new RuntimeClientError(
        "RESYNC_REQUIRED",
        "Runtime journal has a gap",
      );
    await this.options.onChange(change);
    this.cursor = change.sequence;
    if (change.type === "job" && terminal.has(String(change.payload.state))) {
      await this.options.outbox.remove(change.id);
      this.deliveredReceipts.delete(change.id);
    }
    await this.reconcileMutations();
  }
  private async observe() {
    let retry = this.options.retryMs ?? 1000;
    while (!this.closed) {
      this.streamAbort = new AbortController();
      try {
        const signal = AbortSignal.any([
          this.abort.signal,
          this.streamAbort.signal,
        ]);
        const response = await runtimeFetch(
          this.options.baseUrl.replace(/\/$/, "") +
            "/events?after=" +
            this.cursor,
          {
            signal,
            headers: { "Risu-Runtime-Id": this.options.serverId },
            cache: "no-store",
            credentials: "same-origin",
          },
          this.request,
        );
        if (!response.ok) {
          throw await runtimeHttpFailure(response, "Runtime feed failed");
        }
        if (
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new RuntimeClientError(
            "INVALID_STREAM",
            "Runtime feed is not an event stream",
          );
        this.options.onStatus?.("connected");
        retry = this.options.retryMs ?? 1000;
        for await (const event of runtimeEvents(response.body, signal)) {
          if (this.closed) break;
          if (event.event === "reset") {
            let reset: any;
            try {
              reset = JSON.parse(event.data);
            } catch {
              /* Reconcile even a malformed reset. */
            }
            const requestId =
              diagnosticRequestId(reset?.requestId) ??
              diagnosticRequestId(response.headers.get("Risu-Request-Id"));
            recordRuntimeDiagnostic({
              kind: "stream-reset",
              endpoint: "/api/runtime/events",
              method: "GET",
              code: reset?.code ?? "RESYNC_REQUIRED",
              requestId,
            });
            throw new RuntimeClientError(
              "RESYNC_REQUIRED",
              "Runtime feed requires a fresh snapshot",
              0,
              undefined,
              requestId,
            );
          }
          if (event.event !== "change") continue;
          const change: RuntimeChange = JSON.parse(event.data);
          if (event.id !== String(change.sequence))
            throw new RuntimeClientError(
              "INVALID_STREAM",
              "Runtime event identity does not match its sequence",
            );
          await this.apply(change);
        }
      } catch (error) {
        if (this.closed) break;
        this.error(error);
        if (
          error instanceof RuntimeClientError &&
          error.code === "SERVER_CHANGED"
        ) {
          await this.stopObservation();
          return;
        }
        if (
          error instanceof RuntimeClientError &&
          error.code === "RESYNC_REQUIRED"
        ) {
          try {
            await this.bootstrap();
          } catch (failure) {
            this.error(failure);
            if (
              failure instanceof RuntimeClientError &&
              failure.code === "SERVER_CHANGED"
            ) {
              await this.stopObservation();
              return;
            }
          }
        }
      }
      if (this.closed) break;
      this.options.onStatus?.("offline");
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.abort.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, retry);
        this.abort.signal.addEventListener("abort", finish, { once: true });
      });
      retry = Math.min(retry * 2, 10000);
    }
  }
  /** Reconnect from the last applied cursor, without cancelling any server job. */
  reconnect() {
    this.streamAbort?.abort();
    this.kick();
  }
  /** The projection calls this after restoring a terminal job from a fresh job/chat read. */
  async acknowledgeJob(jobId: string) {
    await this.options.outbox.remove(jobId);
    this.deliveredReceipts.delete(jobId);
    await this.pending();
  }
  private async stopObservation() {
    this.closed = true;
    this.ready = false;
    clearInterval(this.timer);
    this.abort.abort();
    this.options.onStatus?.("closed");
  }
  async close() {
    await this.stopObservation();
    await Promise.allSettled([this.observing, this.pumping]);
  }
}
