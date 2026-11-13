import { commandJson, RuntimeClientError, type Json } from "./clientProtocol";

export interface ServerPluginNamespace {
  pluginId: string;
  bundleSha: string;
  pluginEpoch: number;
}

export interface ServerPluginLease {
  namespace: ServerPluginNamespace;
  writerId: string;
  token: string;
  fence: number;
  expiresAt: number;
  revision: number;
}

export interface ServerPluginStorageSnapshot {
  namespace: ServerPluginNamespace;
  revision: number;
  items: { key: string; value: Json; revision: number }[];
}

export type ServerPluginStorageWrite =
  { key: string; value: Json } | { key: string; deleted: true };

export interface ServerPluginStorageCommit {
  lease: ServerPluginLease;
  expectedRevision: number;
  commitId: string;
  writes: ServerPluginStorageWrite[];
}

export interface ServerPluginStorageReceipt {
  namespace: ServerPluginNamespace;
  revision: number;
  commitId: string;
  changed: boolean;
  keys: string[];
}

export interface ServerPluginStorageTransport {
  readAll(
    namespace: ServerPluginNamespace,
  ): Promise<ServerPluginStorageSnapshot>;
  commit(
    command: ServerPluginStorageCommit,
  ): Promise<ServerPluginStorageReceipt>;
}

function sameNamespace(a: ServerPluginNamespace, b: ServerPluginNamespace) {
  return (
    a.pluginId === b.pluginId &&
    a.bundleSha === b.bundleSha &&
    a.pluginEpoch === b.pluginEpoch
  );
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(commandJson(value)) as T;
}

/**
 * One original-plugin iframe owns one fenced storage session. Opening a new
 * session requires restarting that iframe, because the plugin caches its graph
 * independently of this bridge. A conflict never refreshes a stale graph and
 * retries its write against a newer revision.
 *
 * The coordinator acquires/releases the lease and keeps database/replacer/DOM
 * permissions at the existing v3 API boundary. This client cannot grant them.
 */
export class ServerPluginClient {
  private items = new Map<string, Json>();
  private staged = new Map<string, ServerPluginStorageWrite>();
  private revision: number;
  private tail: Promise<unknown> = Promise.resolve();
  private invalid?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly lease: ServerPluginLease;

  private constructor(
    private readonly transport: ServerPluginStorageTransport,
    lease: ServerPluginLease,
    snapshot: ServerPluginStorageSnapshot,
    private readonly options: {
      newCommitId: () => string;
      now: () => number;
      commitMode: "checkpoint" | "per-operation";
      onInvalidated?: (error: Error) => void;
    },
  ) {
    this.lease = jsonCopy(lease);
    this.revision = snapshot.revision;
    for (const item of snapshot.items)
      this.items.set(item.key, jsonCopy(item.value));
  }

  static async open(
    transport: ServerPluginStorageTransport,
    lease: ServerPluginLease,
    options: {
      newCommitId?: () => string;
      now?: () => number;
      /** Original multikey graphs require checkpoint mode. */
      commitMode?: "checkpoint" | "per-operation";
      onInvalidated?: (error: Error) => void;
    } = {},
  ) {
    const now = options.now ?? Date.now;
    if (
      !lease.namespace.pluginId ||
      !/^[a-f\d]{64}$/.test(lease.namespace.bundleSha) ||
      !Number.isSafeInteger(lease.namespace.pluginEpoch) ||
      lease.namespace.pluginEpoch < 0 ||
      !lease.writerId ||
      !lease.token ||
      !Number.isSafeInteger(lease.fence) ||
      lease.fence < 1 ||
      !Number.isSafeInteger(lease.revision) ||
      lease.revision < 0 ||
      !Number.isFinite(lease.expiresAt) ||
      lease.expiresAt <= now()
    )
      throw new RuntimeClientError(
        "INVALID_PLUGIN_LEASE",
        "Invalid plugin lease",
      );
    const snapshot = await transport.readAll(jsonCopy(lease.namespace));
    if (
      !sameNamespace(snapshot.namespace, lease.namespace) ||
      snapshot.revision !== lease.revision ||
      lease.expiresAt <= now() ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.some(
        (item) =>
          typeof item.key !== "string" ||
          !Number.isSafeInteger(item.revision) ||
          item.revision < 0 ||
          item.revision > snapshot.revision,
      ) ||
      new Set(snapshot.items.map((item) => item.key)).size !==
        snapshot.items.length
    )
      throw new RuntimeClientError(
        "STALE_PLUGIN_SESSION",
        "Plugin storage changed while opening its session; reopen the plugin",
      );
    return new ServerPluginClient(transport, lease, snapshot, {
      ...options,
      now,
      newCommitId: options.newCommitId ?? (() => crypto.randomUUID()),
      commitMode: options.commitMode ?? "checkpoint",
    });
  }

  private healthy() {
    if (this.invalid) throw this.invalid;
    if (this.lease.expiresAt <= this.options.now())
      throw this.invalidate(
        new RuntimeClientError(
          "PLUGIN_LEASE_EXPIRED",
          "Plugin editing session expired; reopen the plugin",
        ),
      );
  }

  private invalidate(error: Error) {
    if (!this.invalid) {
      this.invalid = error;
      try {
        this.options.onInvalidated?.(error);
      } catch {
        // A notification failure cannot reopen a poisoned original-plugin cache.
      }
    }
    return this.invalid;
  }

  private serialize<T>(
    operation: () => T | Promise<T>,
    closingBarrier = false,
  ): Promise<T> {
    if (this.closing && !closingBarrier)
      return Promise.reject(
        this.invalid ??
          new RuntimeClientError(
            "PLUGIN_SESSION_CLOSING",
            "Plugin session is closing; new storage calls are blocked",
          ),
      );
    const result = this.tail.then(() => {
      this.healthy();
      return operation();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private async write(writes: ServerPluginStorageWrite[]) {
    const command: ServerPluginStorageCommit = {
      lease: jsonCopy(this.lease),
      expectedRevision: this.revision,
      commitId: this.options.newCommitId(),
      writes: jsonCopy(writes),
    };
    let receipt: ServerPluginStorageReceipt;
    try {
      receipt = await this.transport.commit(command);
      this.healthy();
      if (
        !sameNamespace(receipt.namespace, this.lease.namespace) ||
        receipt.commitId !== command.commitId ||
        typeof receipt.changed !== "boolean" ||
        receipt.revision !== this.revision + (receipt.changed ? 1 : 0)
      )
        throw new RuntimeClientError(
          "INVALID_PLUGIN_RECEIPT",
          "Plugin storage acknowledgement does not match its write",
        );
    } catch (error) {
      throw this.invalidate(
        error instanceof Error
          ? error
          : new RuntimeClientError(
              "PLUGIN_STORAGE_UNCERTAIN",
              "Plugin storage outcome is uncertain; reopen the plugin",
            ),
      );
    }
    for (const item of writes) {
      if ("deleted" in item) this.items.delete(item.key);
      else this.items.set(item.key, jsonCopy(item.value));
    }
    this.revision = receipt.revision;
    this.lease.revision = receipt.revision;
  }

  private update(writes: ServerPluginStorageWrite[]) {
    if (this.options.commitMode === "per-operation") return this.write(writes);
    for (const item of writes) {
      this.staged.set(item.key, item);
      if ("deleted" in item) this.items.delete(item.key);
      else this.items.set(item.key, jsonCopy(item.value));
    }
  }

  private async checkpointNow() {
    if (!this.staged.size) return;
    await this.write(Array.from(this.staged.values()));
    this.staged.clear();
  }

  /** Commit a complete original-plugin operation, including its chunk manifest. */
  checkpoint() {
    return this.serialize(() => this.checkpointNow());
  }

  /**
   * Stop new API admission, drain already admitted calls and commit the final
   * complete checkpoint. The coordinator may release the lease only after this
   * promise settles, and must destroy the original iframe even if it rejects.
   */
  closeAndCheckpoint() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.serialize(
      () => this.checkpointNow(),
      true,
    ).finally(() => this.close());
    return this.closePromise;
  }

  /** Accept a coordinator-renewed lease without changing writer ownership. */
  acceptLease(lease: ServerPluginLease) {
    return this.serialize(() => {
      if (
        !sameNamespace(lease.namespace, this.lease.namespace) ||
        lease.writerId !== this.lease.writerId ||
        lease.token !== this.lease.token ||
        lease.fence !== this.lease.fence ||
        lease.revision !== this.revision ||
        !Number.isFinite(lease.expiresAt) ||
        lease.expiresAt <= this.options.now()
      )
        throw this.invalidate(
          new RuntimeClientError(
            "STALE_PLUGIN_SESSION",
            "Plugin lease renewal changed its ownership or revision",
          ),
        );
      this.lease.expiresAt = lease.expiresAt;
    });
  }

  /** Observe ordered server events after any in-flight own acknowledgement. */
  observeRevision(namespace: ServerPluginNamespace, revision: number) {
    return this.serialize(() => {
      if (
        !sameNamespace(namespace, this.lease.namespace) ||
        !Number.isSafeInteger(revision) ||
        revision > this.revision
      )
        throw this.invalidate(
          new RuntimeClientError(
            "STALE_PLUGIN_SESSION",
            "Plugin storage changed on the server; reopen the plugin",
          ),
        );
    });
  }

  /** The coordinator must also release the server lease and destroy the iframe. */
  close() {
    this.closing = true;
    this.invalidate(
      new RuntimeClientError("PLUGIN_SESSION_CLOSED", "Plugin session closed"),
    );
  }

  readonly pluginStorage = {
    getItem: (key: string) =>
      this.serialize(() => jsonCopy(this.items.get(key) ?? null)),
    setItem: (key: string, value: Json) => {
      const copy = jsonCopy(value);
      return this.serialize(() => this.update([{ key, value: copy }]));
    },
    removeItem: (key: string) =>
      this.serialize(() => this.update([{ key, deleted: true }])),
    clear: () =>
      this.serialize(() =>
        this.update(
          Array.from(this.items.keys(), (key) => ({ key, deleted: true })),
        ),
      ),
    key: (index: number) =>
      this.serialize(() => Array.from(this.items.keys())[index] ?? null),
    keys: () => this.serialize(() => Array.from(this.items.keys())),
    length: () => this.serialize(() => this.items.size),
  };
}
