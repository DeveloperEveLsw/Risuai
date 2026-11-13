import type { ScriptingRuntimeHost } from "../process/scriptingRuntime";
import type {
  DisplayExecution,
  DisplayExecutionResult,
  DisplayExecutor,
} from "./displayLuaContext";
import type { DisplayCapture } from "./displayEffects";
import { DisplayWireBudget } from "./displayWireBudget";
import { DisplayCaptureEncoder } from "./displayCaptureTransport";
import { isImmutableDisplayJson } from "./displayScopeIdentity";

/** Pin nested Svelte JSON values before an asynchronous boundary. */
export function pinDisplayValue<T>(value: T, previous?: T): T {
  // Entity data is JSON. Copy containers/versions while reusing immutable scalar strings.
  // JSON stringify/parse here would duplicate every loaded message before any task can yield.
  const seen = new Map<object, unknown>();
  const reused = new Map<object, object>();
  let nodes = 0;
  function copy(value: unknown, previous?: unknown, depth = 0): unknown {
    if (++nodes > 200000 || depth > 128)
      throw new Error("Display Lua snapshot exceeds its structural budget");
    if (
      value == null ||
      ["string", "number", "boolean", "undefined"].includes(typeof value)
    )
      return value;
    if (typeof value !== "object")
      throw new Error("Display Lua snapshot requires JSON values");
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Map) return new Map(value);
    const array = Array.isArray(value);
    const result = array ? [] : {};
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new Error("Display Lua snapshot requires JSON containers");
    seen.set(value, result);
    const prior =
      previous !== null &&
      typeof previous === "object" &&
      Array.isArray(previous) === array &&
      Object.getPrototypeOf(previous) ===
        (array ? Array.prototype : Object.prototype)
        ? previous
        : undefined;
    const registered = prior && isImmutableDisplayJson(prior);
    const keys = Object.keys(value);
    const priorKeys = registered ? Object.keys(prior) : [];
    let equal =
      registered &&
      !reused.has(prior) &&
      keys.length === priorKeys.length &&
      keys.every((key, index) => key === priorKeys[index]);
    if (array) {
      // Preserve trailing holes too: Object.keys alone loses array length.
      const length = (value as unknown[]).length;
      (result as unknown[]).length = length;
      equal &&= length === (prior as unknown[])?.length;
    }
    for (const key of keys) {
      // Read every fresh field once, including accessors/proxies and unknown
      // metadata. Prior unregistered wrappers can lead to frozen children,
      // but never execute a prior accessor or qualify for reuse themselves.
      const oldChild = registered
        ? Object.hasOwn(prior, key)
          ? prior[key]
          : undefined
        : prior && Object.getOwnPropertyDescriptor(prior, key)?.value;
      const child = copy(value[key], oldChild, depth + 1);
      equal &&= Object.is(child, oldChild);
      // Ordinary assignments avoid per-field descriptor allocation. Preserve
      // __proto__ as an own JSON key without changing the private prototype.
      if (key === "__proto__")
        Object.defineProperty(result, key, {
          value: child,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      else result[key] = child;
    }
    if (equal) {
      // Two distinct fresh containers cannot collapse onto one old alias.
      reused.set(prior, value);
      seen.set(value, prior);
      return prior;
    }
    return result;
  }
  return copy(value, previous) as T;
}

/** Pin nested Svelte values before the manager's first asynchronous boundary. */
export function pinDisplayCapture(
  capture: DisplayCapture,
  previous?: DisplayCapture,
): DisplayCapture {
  const snapshot = pinDisplayValue(capture, previous);
  snapshot.character = snapshot.database.characters[0];
  snapshot.chat = snapshot.character.chats[0];
  snapshot.versions = {
    chat: new Map(capture.versions.chat),
    localGlobal: new Map(capture.versions.localGlobal),
    global: new Map(capture.versions.global),
  };
  return snapshot;
}

/** One worker per original VM lease; no fallback to running Lua on the UI thread. */
export class DisplayWorkerExecutor implements DisplayExecutor {
  private worker: Worker;
  private ready: Promise<void>;
  private bootTimer: ReturnType<typeof setTimeout>;
  private resolveReady: () => void;
  private rejectReady: (error: Error) => void;
  private active?: {
    id: number;
    input: DisplayExecution;
    resolve: (result: DisplayExecutionResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private sequence = 0;
  private closed = false;
  private wireBudget = new DisplayWireBudget();
  private captureEncoder = new DisplayCaptureEncoder(this.wireBudget);
  constructor(
    private base: () => ScriptingRuntimeHost,
    private budgetMs = 2000,
    worker = new Worker(new URL("./display.worker.ts", import.meta.url), {
      type: "module",
      name: "risu-display-lua",
    }),
  ) {
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A lease can be closed before its first invocation starts.
    void this.ready.catch(() => {});
    this.bootTimer = setTimeout(
      () => this.stop(new Error("Display Lua worker initialization timed out")),
      10000,
    );
    worker.onmessage = (event) => void this.receive(event.data);
    worker.onerror = () => this.stop(new Error("Display Lua worker failed"));
    worker.onmessageerror = () =>
      this.stop(new Error("Display Lua worker response could not be decoded"));
  }
  async execute(input: DisplayExecution): Promise<DisplayExecutionResult> {
    await this.ready;
    if (this.closed) throw new Error("Display Lua worker is closed");
    if (this.active) throw new Error("Display Lua worker is already executing");
    // All mutable invocation fields are fresh. Only registered immutable JSON
    // bodies use transport references; the worker still decodes private values.
    const { capture } = input;
    const wire = {
      ...input,
      capture: {
        ...capture,
        character: undefined,
        chat: undefined,
        versions: {
          chat: [...capture.versions.chat],
          localGlobal: [...capture.versions.localGlobal],
          global: [...capture.versions.global],
        },
      },
    };
    const captureWire = this.captureEncoder.encode(wire.capture, wire);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () =>
          this.stop(
            new Error(
              `Display Lua exceeded its ${this.budgetMs} ms execution budget`,
            ),
          ),
        this.budgetMs,
      );
      this.active = { id, input, resolve, reject, timer };
      try {
        this.worker.postMessage({
          type: "execute",
          id,
          input: { ...wire, capture: undefined },
          captureWire,
        });
      } catch {
        this.stop(new Error("Display Lua scope could not be transferred"));
      }
    });
  }
  private async receive(message: {
    type: string;
    id?: number;
    result?: DisplayExecutionResult;
    error?: string;
    fatal?: boolean;
    args?: unknown[];
    port?: string;
    portId?: number;
  }) {
    if (this.closed) return;
    if (message.type === "boot-error") {
      this.stop(new Error(message.error));
      return;
    }
    if (message.type === "ready") {
      clearTimeout(this.bootTimer);
      this.resolveReady();
      return;
    }
    const active = this.active;
    if (!active || message.id !== active.id) return;
    if (message.type === "log") {
      console.log(...message.args);
      return;
    }
    if (message.type === "port") {
      // The original editDisplay image APIs have no Safe/LowLevel token guard.
      // Only those two DOM-dependent ports cross the worker boundary.
      try {
        let result: unknown;
        if (message.port === "readImage") {
          const path = message.args[0];
          const { capture } = active.input;
          const persona = capture.database.personas.find(
            (p) => p.id === capture.chat.bindedPersona,
          );
          const icon = persona?.icon ?? capture.database.userIcon;
          if (path !== capture.character.image && path !== icon)
            throw new Error("Display image lookup outside its pinned scope");
          result = await this.base().readImage(String(path));
        } else if (message.port === "writeInlayImage") {
          const source = message.args[0];
          if (typeof source !== "string" || !source.startsWith("blob:"))
            throw new Error("Display worker image source must be a Blob URL");
          const image = new Image();
          image.src = source;
          result = await this.base().writeInlayImage(image, message.args[1]);
        } else throw new Error("Unavailable display worker port");
        if (!this.closed && this.active === active)
          this.worker.postMessage({
            type: "port-result",
            id: active.id,
            portId: message.portId,
            result,
          });
      } catch (error) {
        if (!this.closed && this.active === active)
          this.worker.postMessage({
            type: "port-result",
            id: active.id,
            portId: message.portId,
            error: error instanceof Error ? error.message : String(error),
          });
      }
      return;
    }
    if (message.type !== "result" && message.type !== "error") return;
    if (message.fatal) {
      this.stop(new Error(message.error));
      return;
    }
    clearTimeout(active.timer);
    this.active = undefined;
    if (message.type === "error") active.reject(new Error(message.error));
    else active.resolve(message.result);
  }
  private stop(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.bootTimer);
    this.rejectReady(error);
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = undefined;
    }
    this.worker.terminate();
    this.wireBudget.close();
    this.captureEncoder.close();
    this.worker.onmessage =
      this.worker.onerror =
      this.worker.onmessageerror =
        null;
  }
  close() {
    this.stop(new Error("Display Lua worker owner closed"));
  }
  transportDiagnostics() {
    return this.captureEncoder.diagnostics();
  }
}
