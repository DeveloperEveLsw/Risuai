import {
  commandJson,
  RuntimeClientError,
  type AdmissionKind,
  type RuntimeCommand,
  type RuntimeFailure,
  type Json,
} from "./clientProtocol";
import {
  variableEdits,
  variableIdentity,
  type VariableEdit,
  type VariableValue,
} from "./variableCommands";

import {
  fieldIdentity,
  fieldHeadIdentity,
  type FieldEdit,
  type FieldValue,
  type DerivedFieldOptions,
} from "./fieldCommands";

export interface OutboxEntry {
  sequence?: number;
  requestId: string;
  kind: AdmissionKind;
  command: RuntimeCommand;
  payload: string;
  createdAt: number;
  state: "pending" | "accepted" | "blocked";
  receipt?: Record<string, Json>;
  error?: RuntimeFailure;
  intentPayload?: string;
}
export interface RuntimeOutbox {
  readonly derivedFieldsVersion?: 1;
  enqueue(
    requestId: string,
    kind: AdmissionKind,
    command: RuntimeCommand,
  ): Promise<OutboxEntry>;
  list(): Promise<OutboxEntry[]>;
  accept(
    requestId: string,
    receipt: Record<string, Json>,
  ): Promise<OutboxEntry | undefined>;
  block(requestId: string, error: RuntimeFailure): Promise<void>;
  remove(requestId: string): Promise<void>;
  enqueueFields?(
    requestId: string,
    edits: FieldEdit[],
    dependencies?: DerivedFieldOptions,
  ): Promise<OutboxEntry>;
  resolveFieldChain?(
    requestId: string,
    values: FieldValue[],
    replacementId?: string,
  ): Promise<void>;
  enqueueVariables?(
    requestId: string,
    edits: VariableEdit[],
  ): Promise<OutboxEntry>;
  resolveVariableChain?(
    requestId: string,
    values: VariableValue[],
    replacementId?: string,
  ): Promise<void>;
}

/** Pending commands are scoped to a persisted server identity, not a reusable port. */
export class IndexedDbOutbox implements RuntimeOutbox {
  readonly derivedFieldsVersion = 1 as const;
  private database: Promise<IDBDatabase>;
  constructor(serverId: string, factory: IDBFactory = globalThis.indexedDB) {
    if (!serverId || !factory)
      throw new RuntimeClientError(
        "OUTBOX_UNAVAILABLE",
        "Persistent browser storage is unavailable",
      );
    this.database = new Promise((resolve, reject) => {
      let failed = false;
      const request = factory.open("risu-runtime-outbox:" + serverId, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("entries")) {
          const store = db.createObjectStore("entries", {
            keyPath: "sequence",
            autoIncrement: true,
          });
          store.createIndex("requestId", "requestId", { unique: true });
        }
        if (!db.objectStoreNames.contains("variableHeads"))
          db.createObjectStore("variableHeads", { keyPath: "key" });
      };
      request.onerror = () => {
        failed = true;
        reject(request.error);
      };
      request.onblocked = () => {
        failed = true;
        reject(
          new RuntimeClientError(
            "OUTBOX_BLOCKED",
            "Another tab blocks the storage upgrade",
          ),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      save: (value: T) => void,
      guard: (run: () => void) => () => void,
      heads: IDBObjectStore,
    ) => void,
  ): Promise<T> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      let value: T;
      let failure: unknown;
      const transaction = database.transaction(
        ["entries", "variableHeads"],
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new RuntimeClientError(
              "OUTBOX_ABORTED",
              "Pending command could not be saved",
            ),
        );
      const store = transaction.objectStore("entries");
      // Request success alone does not confirm the enclosing transaction committed.
      const guard = (run: () => void) => () => {
        try {
          run();
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      guard(() =>
        operation(
          store,
          (result) => {
            value = result;
          },
          guard,
          transaction.objectStore("variableHeads"),
        ),
      )();
    });
  }

  enqueue(
    requestId: string,
    kind: AdmissionKind,
    command: RuntimeCommand,
  ): Promise<OutboxEntry> {
    if (
      !requestId ||
      requestId.length > 256 ||
      !["command", "job"].includes(kind)
    )
      return Promise.reject(
        new RuntimeClientError(
          "INVALID_COMMAND",
          "Invalid pending command identity",
        ),
      );
    const payload = commandJson(command);
    const entry: OutboxEntry = {
      requestId,
      kind,
      command: JSON.parse(payload),
      payload,
      createdAt: Date.now(),
      state: "pending",
    };
    return this.transaction<OutboxEntry>("readwrite", (store, save, guard) => {
      const lookup = store.index("requestId").get(requestId);
      lookup.onsuccess = guard(() => {
        const existing: OutboxEntry | undefined = lookup.result;
        if (existing) {
          if (existing.kind !== kind || existing.payload !== payload)
            throw new RuntimeClientError(
              "IDEMPOTENCY_CONFLICT",
              "Request ID was reused with different content",
            );
          save(existing);
        } else {
          const add = store.add(entry);
          add.onsuccess = () =>
            save({ ...entry, sequence: Number(add.result) });
        }
      });
    });
  }

  list(): Promise<OutboxEntry[]> {
    return this.transaction("readonly", (store, save) => {
      const request = store.getAll();
      request.onsuccess = () => save(request.result);
    });
  }

  enqueueVariables(requestId: string, edits: VariableEdit[]) {
    return this.enqueueMutations<VariableEdit>(
      requestId,
      "change-variables",
      edits,
      variableIdentity,
    );
  }
  enqueueFields(
    requestId: string,
    edits: FieldEdit[],
    dependencies: DerivedFieldOptions = {},
  ) {
    if (
      edits.some(
        (edit) =>
          !Number.isSafeInteger(edit.expectedEpoch) || edit.expectedEpoch < 0,
      )
    )
      return Promise.reject(
        new RuntimeClientError("INVALID_COMMAND", "Invalid entity epoch"),
      );
    return this.enqueueMutations<FieldEdit>(
      requestId,
      "change-fields",
      edits,
      fieldHeadIdentity,
      dependencies,
    );
  }
  /** Allocate revisions and predecessors atomically across tabs; field heads include incarnation. */
  private enqueueMutations<E extends { expectedRevision: number }>(
    requestId: string,
    type: "change-variables" | "change-fields",
    edits: E[],
    identity: (edit: E) => string,
    dependencies: DerivedFieldOptions = {},
  ): Promise<OutboxEntry> {
    if (
      !requestId ||
      requestId.length > 256 ||
      !edits.length ||
      edits.length > 128
    )
      return Promise.reject(
        new RuntimeClientError("INVALID_COMMAND", "Invalid mutation intent"),
      );
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies) ||
      Object.keys(dependencies).some(
        (key) => key !== "checks" && key !== "groupImageSources",
      ) ||
      (Object.hasOwn(dependencies, "checks") &&
        !Array.isArray(dependencies.checks)) ||
      (Object.hasOwn(dependencies, "groupImageSources") &&
        (!dependencies.groupImageSources ||
          typeof dependencies.groupImageSources !== "object" ||
          Array.isArray(dependencies.groupImageSources)))
    )
      return Promise.reject(
        new RuntimeClientError(
          "INVALID_COMMAND",
          "Invalid derived field dependencies",
        ),
      );
    const intentPayload = commandJson({
      type,
      edits,
      ...dependencies,
    } as unknown as Json);
    // Snapshot before the first asynchronous IDB boundary. Caller mutation must
    // never change the payload admitted under an already allocated identity.
    const immutable = JSON.parse(intentPayload);
    edits = immutable.edits;
    dependencies = {
      ...(immutable.checks ? { checks: immutable.checks } : {}),
      ...(immutable.groupImageSources
        ? { groupImageSources: immutable.groupImageSources }
        : {}),
    };
    const unique = new Set(edits.map(identity));
    if (
      unique.size !== edits.length ||
      edits.some(
        (edit) =>
          !Number.isSafeInteger(edit.expectedRevision) ||
          edit.expectedRevision < 0,
      )
    )
      return Promise.reject(
        new RuntimeClientError(
          "INVALID_COMMAND",
          "Duplicate mutation or invalid revision",
        ),
      );
    return this.transaction<OutboxEntry>(
      "readwrite",
      (store, save, guard, heads) => {
        const request = store.getAll();
        request.onsuccess = guard(() => {
          const entries: OutboxEntry[] = request.result;
          const old = entries.find((entry) => entry.requestId === requestId);
          if (old) {
            if (old.intentPayload !== intentPayload)
              throw new RuntimeClientError(
                "IDEMPOTENCY_CONFLICT",
                "Request ID was reused with different mutation intent",
              );
            return save(old);
          }
          const readHeads = heads.getAll();
          readHeads.onsuccess = guard(() => {
            const headIndex = new Map<
              string,
              { key: string; revision: number; requestId?: string }
            >(readHeads.result.map((head) => [head.key, head]));
            const predecessors = new Set<string>();
            const allocated = edits.map((edit) => {
              const key = identity(edit);
              for (let i = entries.length - 1; i >= 0; i--) {
                const previous = (
                  entries[i].command.type === type
                    ? (entries[i].command.edits as unknown as E[])
                    : []
                ).find((value) => identity(value) === key);
                if (!previous) continue;
                predecessors.add(entries[i].requestId);
                const revision = previous.expectedRevision + 1;
                if (!Number.isSafeInteger(revision))
                  throw new RuntimeClientError(
                    "INVALID_COMMAND",
                    "Mutation revision exhausted",
                  );
                return { ...edit, expectedRevision: revision };
              }
              const head = headIndex.get(key);
              if (head && head.revision >= edit.expectedRevision) {
                if (head.requestId) predecessors.add(head.requestId);
                return { ...edit, expectedRevision: head.revision };
              }
              return { ...edit };
            });
            if (
              allocated.some(
                (edit) => !Number.isSafeInteger(edit.expectedRevision + 1),
              )
            )
              throw new RuntimeClientError(
                "INVALID_COMMAND",
                "Mutation revision exhausted",
              );
            const command = {
              type,
              edits: allocated,
              after: [...predecessors],
              ...dependencies,
            } as unknown as RuntimeCommand;
            const payload = commandJson(command);
            const entry: OutboxEntry = {
              kind: "command",
              requestId,
              command: JSON.parse(payload),
              payload,
              intentPayload,
              createdAt: Date.now(),
              state: "pending",
            };
            const add = store.add(entry);
            for (const edit of allocated)
              heads.put({
                key: identity(edit),
                revision: edit.expectedRevision + 1,
                requestId,
              });
            add.onsuccess = () =>
              save({ ...entry, sequence: Number(add.result) });
          });
        });
      },
    );
  }

  resolveVariableChain(
    requestId: string,
    values: VariableValue[],
    replacementId?: string,
  ) {
    return this.resolveMutationChain<VariableEdit, VariableValue>(
      requestId,
      values,
      replacementId,
      "change-variables",
      variableIdentity,
      variableIdentity,
      (edit, value) => ({ ...edit, expectedRevision: value.revision }),
    );
  }
  resolveFieldChain(
    requestId: string,
    values: FieldValue[],
    replacementId?: string,
  ) {
    return this.resolveMutationChain<FieldEdit, FieldValue>(
      requestId,
      values,
      replacementId,
      "change-fields",
      fieldIdentity,
      fieldHeadIdentity,
      (edit, value) => ({
        ...edit,
        expectedRevision: value.revision,
        expectedEpoch: value.entityEpoch,
      }),
    );
  }
  private resolveMutationChain<E extends { expectedRevision: number }, V>(
    requestId: string,
    values: V[],
    replacementId: string | undefined,
    type: "change-variables" | "change-fields",
    identity: (edit: E | V) => string,
    headIdentity: (edit: E) => string,
    rebase: (edit: E, value: V) => E,
  ): Promise<void> {
    values = JSON.parse(commandJson(values));
    return this.transaction("readwrite", (store, save, guard, heads) => {
      const request = store.getAll();
      request.onsuccess = guard(() => {
        const entries: OutboxEntry[] = request.result;
        const root = entries.find((entry) => entry.requestId === requestId);
        if (!root || root.state !== "blocked" || root.command.type !== type)
          throw new RuntimeClientError(
            "OUTBOX_UNCERTAIN",
            "Only a rejected mutation can be resolved",
          );
        const removed = new Set([requestId]);
        const desired = new Map<string, E>();
        const current = new Map(
          values.map((value) => [identity(value), value]),
        );
        for (const entry of entries) {
          if (
            Array.isArray(entry.command.after) &&
            entry.command.after.some((id) => removed.has(String(id)))
          )
            removed.add(entry.requestId);
          if (!removed.has(entry.requestId)) continue;
          if (
            replacementId &&
            (entry.command.groupImageSources ||
              (Array.isArray(entry.command.checks) &&
                entry.command.checks.length))
          )
            throw new RuntimeClientError(
              "DERIVED_RESULT_STALE",
              "The source of this result changed; discard it and create the image again",
            );
          if (entry.state === "accepted")
            throw new RuntimeClientError(
              "OUTBOX_UNCERTAIN",
              "An accepted change requires reconciliation",
            );
          if (entry.command.type !== type)
            throw new RuntimeClientError(
              "OUTBOX_UNCERTAIN",
              "Dependent commands require separate reconciliation",
            );
          for (const edit of entry.command.edits as unknown as E[]) {
            const key = identity(edit);
            if (!current.has(key))
              throw new RuntimeClientError(
                "RESOLUTION_CHANGED",
                "New changes require another scoped read",
              );
            desired.set(key, rebase(edit, current.get(key)));
            heads.delete(headIdentity(edit));
          }
        }
        if (
          replacementId &&
          entries.some((entry) => entry.requestId === replacementId)
        )
          throw new RuntimeClientError(
            "IDEMPOTENCY_CONFLICT",
            "Replacement identity already exists",
          );
        for (const entry of entries)
          if (removed.has(entry.requestId)) store.delete(entry.sequence);
        for (const edit of desired.values()) {
          const competing = entries.some(
            (entry) =>
              !removed.has(entry.requestId) &&
              entry.command.type === type &&
              (entry.command.edits as unknown as E[]).some(
                (value) => headIdentity(value) === headIdentity(edit),
              ),
          );
          if (competing && replacementId)
            throw new RuntimeClientError(
              "OUTBOX_UNCERTAIN",
              "This entity incarnation already has pending changes",
            );
          if (competing) continue;
          if (
            !Number.isSafeInteger(
              edit.expectedRevision + (replacementId ? 1 : 0),
            )
          )
            throw new RuntimeClientError(
              "INVALID_COMMAND",
              "Mutation revision exhausted",
            );
          heads.put({
            key: headIdentity(edit),
            revision: edit.expectedRevision + (replacementId ? 1 : 0),
            ...(replacementId ? { requestId: replacementId } : {}),
          });
        }
        if (replacementId) {
          const command = {
            type,
            edits: [...desired.values()],
            after: [],
          } as unknown as RuntimeCommand;
          const payload = commandJson(command);
          store.add({
            kind: "command",
            requestId: replacementId,
            command: JSON.parse(payload),
            payload,
            intentPayload: commandJson({
              type,
              edits: [...desired.values()],
            }),
            createdAt: Date.now(),
            state: "pending",
          } satisfies OutboxEntry);
        }
        save(undefined);
      });
    });
  }

  private change(
    requestId: string,
    update: (entry: OutboxEntry) => OutboxEntry | undefined,
  ): Promise<OutboxEntry | undefined> {
    return this.transaction("readwrite", (store, save, guard) => {
      const request = store.index("requestId").get(requestId);
      request.onsuccess = guard(() => {
        const old: OutboxEntry | undefined = request.result;
        if (!old) return save(undefined);
        const next = update(old);
        if (next) store.put(next);
        else store.delete(old.sequence);
        save(next);
      });
    });
  }
  accept(requestId: string, receipt: Record<string, Json>) {
    return this.change(requestId, (entry) => ({
      ...entry,
      state: "accepted",
      receipt,
      error: undefined,
    }));
  }
  async block(requestId: string, error: RuntimeFailure) {
    await this.change(requestId, (entry) =>
      entry.state === "accepted"
        ? entry
        : { ...entry, state: "blocked", error },
    );
  }
  async remove(requestId: string) {
    await this.change(requestId, () => undefined);
  }
  async close() {
    (await this.database).close();
  }
}
