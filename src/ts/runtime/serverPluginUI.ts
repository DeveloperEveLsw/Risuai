/** The original plugin engine and handlers run in one fenced server owner.
 * This client projects its sanitized DOM into an opaque iframe. Plugin source
 * and writer leases never enter this browser bridge. It projects the original
 * settings fields, including plugin API settings the authorized owner can see;
 * it does not attach the application's provider transport credentials.
 */
export interface ServerPluginUIScope {
  sessionId: string;
  pluginId: string;
  bundleSha: string;
  pluginEpoch: number;
  characterId: string;
  chatId: string;
  chatEpoch: number;
  writerId: string;
  writerFence: number;
}
export interface ServerPluginUIControl {
  nodeId: string;
  tag: string;
  type: string;
  value: string;
  checked: boolean;
  indeterminate: boolean;
  selectedValues: string[];
  selectedIndex: number;
}
export interface ServerPluginUISnapshot {
  scope: ServerPluginUIScope;
  revision: number;
  html: string;
  styles: string[];
  controlStates: ServerPluginUIControl[];
  visible: boolean;
  busy: boolean;
  capabilities?: Record<string, unknown>;
  effects?: ServerPluginUIEffect[];
}
interface ServerPluginUIEffectBase {
  id: string;
  eventId: string;
}
export type ServerPluginUIEffect = ServerPluginUIEffectBase &
  (
    | {
        kind: "download";
        name: string;
        mime: "application/json" | "text/plain";
        bytes: number;
      }
    | { kind: "file"; accept: string; multiple: false }
    | { kind: "confirm"; text: string }
    | { kind: "clipboard"; text: string }
  );
export type ServerPluginUIEffectAnswer =
  | { kind: "download"; received: boolean }
  | { kind: "file"; file: { name: string; text: string } | null }
  | { kind: "confirm"; accepted: boolean }
  | { kind: "clipboard"; ok: boolean; error?: string };
export const SERVER_PLUGIN_UI_TRANSFER_LIMIT = 8 * 1024 * 1024;
export interface ServerPluginUIEvent {
  scope: ServerPluginUIScope;
  revision: number;
  eventId: string;
  nodeId: string;
  type: "click" | "input" | "change" | "blur" | "keydown";
  value?: string;
  checked?: boolean;
  selectedValues?: string[];
  key?: string;
}
export interface ServerPluginUIReceipt {
  eventId: string;
  appliedRevision: number;
  replayed: boolean;
  snapshot: ServerPluginUISnapshot;
}
export interface ServerPluginUIOwner {
  chatId: string;
  chatEpoch: number;
  selection?: unknown;
}
export class ServerPluginUIError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerPluginUIError";
  }
}
export interface ServerPluginUISession {
  readonly closed: boolean;
  readonly snapshot: ServerPluginUISnapshot;
  subscribe(listener: (snapshot: ServerPluginUISnapshot) => void): () => void;
  dispatch(event: ServerPluginUIEvent): Promise<ServerPluginUIReceipt>;
  refresh(): Promise<ServerPluginUISnapshot>;
  resolveEffect(
    effect: ServerPluginUIEffect,
    answer: ServerPluginUIEffectAnswer,
  ): Promise<ServerPluginUISnapshot>;
  downloadArtifact(
    effect: Extract<ServerPluginUIEffect, { kind: "download" }>,
  ): Promise<Blob>;
  close(options?: { keepalive?: boolean }): Promise<void>;
}
const EVENT_KEYS = new Set([
  "scope",
  "revision",
  "eventId",
  "nodeId",
  "type",
  "value",
  "checked",
  "selectedValues",
  "key",
]);
const EVENT_TYPES = new Set(["click", "input", "change", "blur", "keydown"]);
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function fileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= 256 &&
    !/[\\/:\u0000-\u001f\u007f]/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}
function effectIdentity(effect: ServerPluginUIEffect): string {
  return `${effect.kind}:${effect.id}:${effect.eventId}`;
}
function validateEffects(raw: unknown): ServerPluginUIEffect[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 4)
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_EFFECT",
      "플러그인 파일·확인 요청 형식이 올바르지 않습니다.",
    );
  const ids = new Set<string>();
  for (const effect of raw) {
    if (
      !plain(effect) ||
      typeof effect.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        effect.id,
      ) ||
      typeof effect.eventId !== "string" ||
      !/^plugin-ui:[a-f0-9-]{36}$/i.test(effect.eventId) ||
      ids.has(effect.id)
    )
      throw new ServerPluginUIError(
        "INVALID_PLUGIN_UI_EFFECT",
        "플러그인 파일·확인 요청 식별자가 올바르지 않습니다.",
      );
    ids.add(effect.id);
    let fields: string[];
    switch (effect.kind) {
      case "download":
        fields = ["id", "eventId", "kind", "name", "mime", "bytes"];
        if (
          !fileName(effect.name) ||
          !["application/json", "text/plain"].includes(String(effect.mime)) ||
          !Number.isSafeInteger(effect.bytes) ||
          Number(effect.bytes) < 0 ||
          Number(effect.bytes) > SERVER_PLUGIN_UI_TRANSFER_LIMIT
        )
          throw new ServerPluginUIError(
            "INVALID_PLUGIN_UI_EFFECT",
            "플러그인 내보내기 파일은 JSON·텍스트 형식, 최대 8 MiB만 지원합니다.",
          );
        break;
      case "file":
        fields = ["id", "eventId", "kind", "accept", "multiple"];
        if (
          typeof effect.accept !== "string" ||
          byteLength(effect.accept) > 512 ||
          effect.multiple !== false
        )
          throw new ServerPluginUIError(
            "INVALID_PLUGIN_UI_EFFECT",
            "플러그인 파일 선택 요청 형식이 올바르지 않습니다.",
          );
        break;
      case "confirm":
      case "clipboard":
        fields = ["id", "eventId", "kind", "text"];
        if (
          typeof effect.text !== "string" ||
          byteLength(effect.text) > SERVER_PLUGIN_UI_TRANSFER_LIMIT
        )
          throw new ServerPluginUIError(
            "INVALID_PLUGIN_UI_EFFECT",
            "플러그인 확인·복사 내용이 8 MiB 제한을 넘었습니다.",
          );
        break;
      default:
        throw new ServerPluginUIError(
          "INVALID_PLUGIN_UI_EFFECT",
          "지원하지 않는 플러그인 브라우저 요청입니다.",
        );
    }
    if (Object.keys(effect).some((key) => !fields.includes(key)))
      throw new ServerPluginUIError(
        "INVALID_PLUGIN_UI_EFFECT",
        "플러그인 브라우저 요청에 알 수 없는 필드가 있습니다.",
      );
  }
  return structuredClone(raw) as ServerPluginUIEffect[];
}
function validateEffectAnswer(
  effect: ServerPluginUIEffect,
  answer: ServerPluginUIEffectAnswer,
): void {
  const bad = () => {
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_EFFECT",
      "플러그인 브라우저 응답 형식이 올바르지 않습니다.",
    );
  };
  if (!plain(answer) || answer.kind !== effect.kind) bad();
  const keys = Object.keys(answer);
  if (answer.kind === "file") {
    if (keys.some((key) => !["kind", "file"].includes(key))) bad();
    if (
      answer.file !== null &&
      (!plain(answer.file) ||
        Object.keys(answer.file).some(
          (key) => !["name", "text"].includes(key),
        ) ||
        !fileName(answer.file.name) ||
        typeof answer.file.text !== "string" ||
        byteLength(answer.file.text) > SERVER_PLUGIN_UI_TRANSFER_LIMIT)
    )
      bad();
  } else if (answer.kind === "confirm") {
    if (
      keys.some((key) => !["kind", "accepted"].includes(key)) ||
      typeof answer.accepted !== "boolean"
    )
      bad();
  } else if (answer.kind === "download") {
    if (
      keys.some((key) => !["kind", "received"].includes(key)) ||
      typeof answer.received !== "boolean"
    )
      bad();
  } else if (answer.kind === "clipboard") {
    if (
      keys.some((key) => !["kind", "ok", "error"].includes(key)) ||
      typeof answer.ok !== "boolean" ||
      (answer.error !== undefined &&
        (typeof answer.error !== "string" || byteLength(answer.error) > 512))
    )
      bad();
  } else bad();
}
function scopeKey(scope: ServerPluginUIScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.pluginId,
    scope.bundleSha,
    scope.pluginEpoch,
    scope.characterId,
    scope.chatId,
    scope.chatEpoch,
    scope.writerId,
    scope.writerFence,
  ]);
}
function canonicalWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalWire);
  if (plain(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalWire(value[key])]),
    );
  return value;
}
async function eventHash(event: ServerPluginUIEvent): Promise<string> {
  const wire = JSON.parse(JSON.stringify(event));
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonicalWire(wire))),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function validateServerPluginUISnapshot(
  raw: unknown,
  expected?: ServerPluginUIScope,
): ServerPluginUISnapshot {
  if (
    !plain(raw) ||
    !plain(raw.scope) ||
    typeof raw.html !== "string" ||
    raw.html.length > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 1 ||
    !Array.isArray(raw.styles) ||
    raw.styles.some((s) => typeof s !== "string") ||
    raw.styles.join("").length > 512 * 1024 ||
    !Array.isArray(raw.controlStates) ||
    raw.controlStates.length > 10000 ||
    typeof raw.busy !== "boolean" ||
    typeof raw.visible !== "boolean"
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI",
      "서버 플러그인 화면 형식이 올바르지 않습니다.",
    );
  const s = raw.scope;
  if (
    ![
      "sessionId",
      "pluginId",
      "bundleSha",
      "characterId",
      "chatId",
      "writerId",
    ].every(
      (k) =>
        typeof s[k] === "string" &&
        String(s[k]).length > 0 &&
        String(s[k]).length <= 256,
    ) ||
    !/^[a-f0-9]{64}$/.test(String(s.bundleSha)) ||
    !["pluginEpoch", "chatEpoch", "writerFence"].every(
      (k) =>
        Number.isSafeInteger(s[k]) &&
        Number(s[k]) >= (k === "writerFence" ? 1 : 0),
    )
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_SCOPE",
      "서버 플러그인 화면 범위가 올바르지 않습니다.",
    );
  for (const item of raw.controlStates) {
    if (
      !plain(item) ||
      typeof item.nodeId !== "string" ||
      typeof item.tag !== "string" ||
      typeof item.type !== "string" ||
      typeof item.value !== "string" ||
      typeof item.checked !== "boolean" ||
      typeof item.indeterminate !== "boolean" ||
      !Array.isArray(item.selectedValues) ||
      item.selectedValues.some((v) => typeof v !== "string") ||
      !Number.isInteger(item.selectedIndex)
    )
      throw new ServerPluginUIError(
        "INVALID_PLUGIN_UI",
        "서버 플러그인 입력 상태가 올바르지 않습니다.",
      );
  }
  const snapshot = structuredClone(raw) as unknown as ServerPluginUISnapshot;
  snapshot.effects = validateEffects(raw.effects);
  if (expected && scopeKey(snapshot.scope) !== scopeKey(expected))
    throw new ServerPluginUIError(
      "PLUGIN_UI_SCOPE_CHANGED",
      "플러그인 화면의 채팅 또는 실행 소유자가 변경되었습니다.",
    );
  return snapshot;
}
function validateEvent(
  event: ServerPluginUIEvent,
  snapshot: ServerPluginUISnapshot,
): void {
  if (
    !plain(event) ||
    Object.keys(event).some((k) => !EVENT_KEYS.has(k)) ||
    scopeKey(event.scope) !== scopeKey(snapshot.scope) ||
    !Number.isSafeInteger(event.revision) ||
    event.revision !== snapshot.revision ||
    !/^plugin-ui:[a-f0-9-]{36}$/i.test(event.eventId) ||
    typeof event.nodeId !== "string" ||
    !EVENT_TYPES.has(event.type)
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_EVENT",
      "플러그인 화면 입력의 범위나 버전이 올바르지 않습니다.",
    );
}
export async function openServerPluginUI(options: {
  pluginId: string;
  owner: ServerPluginUIOwner;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<ServerPluginUISession> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<(snapshot: ServerPluginUISnapshot) => void>();
  const lifetime = new AbortController();
  const resolvedEffects = new Set<string>();
  const artifactAttempts = new Set<string>();
  const receivedArtifacts = new Set<string>();
  let current: ServerPluginUISnapshot;
  let closed = false,
    failure: Error | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0,
    read: Promise<ServerPluginUISnapshot> | undefined;
  const interval = options.pollIntervalMs ?? 1000;
  if (!Number.isFinite(interval) || interval < 100 || interval > 60000)
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_INTERVAL",
      "플러그인 화면 새로고침 간격이 올바르지 않습니다.",
    );
  const fail = (error: unknown): Error => {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (!failure && !closed) {
      failure = cause;
      clearTimeout(timer);
      try {
        options.onError?.(cause);
      } catch {
        /* consumer notification */
      }
    }
    return cause;
  };
  const healthy = () => {
    if (failure) throw failure;
    if (closed)
      throw new ServerPluginUIError(
        "PLUGIN_UI_CLOSED",
        "플러그인 설정 창이 닫혔습니다.",
      );
    options.signal?.throwIfAborted();
  };
  async function json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await request(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ServerPluginUIError(
        "PLUGIN_UI_TRANSPORT_UNCERTAIN",
        "서버 응답을 확인하지 못했습니다. 작업을 자동으로 반복하지 않습니다.",
      );
    }
    if (!response.ok) {
      const problem = plain(body) && plain(body.error) ? body.error : body;
      throw new ServerPluginUIError(
        plain(problem) && typeof problem.code === "string"
          ? problem.code
          : "PLUGIN_UI_REQUEST_FAILED",
        plain(problem) && typeof problem.message === "string"
          ? problem.message
          : "플러그인 설정 요청이 실패했습니다.",
      );
    }
    return body;
  }
  options.signal?.throwIfAborted();
  const cap = await json(
    `/api/runtime/plugins/${encodeURIComponent(options.pluginId)}/capability`,
    { signal: options.signal },
  );
  if (
    !plain(cap) ||
    cap.supported !== true ||
    cap.enabled !== true ||
    typeof cap.serverId !== "string"
  )
    throw new ServerPluginUIError(
      "PLUGIN_UI_UNAVAILABLE",
      "이 서버에서 해당 원본 플러그인 설정 기능을 사용할 수 없습니다.",
    );
  const opened = await json("/api/runtime/plugin-ui", {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      "Risu-Runtime-Id": cap.serverId,
    },
    body: JSON.stringify({
      pluginId: options.pluginId,
      chatId: options.owner.chatId,
      expectedChatEpoch: options.owner.chatEpoch,
    }),
  });
  if (
    !plain(opened) ||
    typeof opened.sessionId !== "string" ||
    typeof opened.ownerToken !== "string"
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI",
      "플러그인 설정 실행 소유자를 확인하지 못했습니다.",
    );
  const headers = {
    "Content-Type": "application/json",
    "Risu-Runtime-Id": cap.serverId,
    "Risu-Plugin-Owner": opened.ownerToken,
  };
  const base = `/api/runtime/plugin-ui/${encodeURIComponent(opened.sessionId)}`;
  try {
    current = validateServerPluginUISnapshot(opened.snapshot);
    if (
      current.scope.sessionId !== opened.sessionId ||
      current.scope.pluginId !== options.pluginId ||
      current.scope.chatId !== options.owner.chatId ||
      current.scope.chatEpoch !== options.owner.chatEpoch
    )
      throw new ServerPluginUIError(
        "PLUGIN_UI_SCOPE_CHANGED",
        "플러그인 설정 창의 대상 채팅이 변경되었습니다.",
      );
  } catch (error) {
    await json(base + "/close", { method: "POST", headers }).catch(() => {});
    throw error;
  }
  function publish(raw: unknown) {
    const next = validateServerPluginUISnapshot(raw, current.scope);
    // A progress poll can finish after the event acknowledgement. It cannot
    // move the view back to an earlier server revision.
    if (next.revision >= current.revision) {
      current = next;
      for (const listener of listeners) listener(structuredClone(current));
    }
    return structuredClone(current);
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || failure) return;
    timer = setTimeout(() => {
      void refresh().catch(() => {});
    }, interval);
  }
  async function refresh() {
    healthy();
    if (read) return read;
    read = (async () => {
      try {
        return publish(await json(base, { headers, signal: options.signal }));
      } catch (error) {
        throw fail(error);
      } finally {
        read = undefined;
        schedule();
      }
    })();
    return read;
  }
  async function close(closeOptions: { keepalive?: boolean } = {}) {
    if (closed) return;
    closed = true;
    lifetime.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
    if (typeof window !== "undefined")
      window.removeEventListener("pagehide", pagehide);
    listeners.clear();
    // A dropped response never causes an event to be replayed. Closing the
    // opaque owner is safe after a failed or interrupted action.
    await json(base + "/close", {
      method: "POST",
      headers,
      keepalive: closeOptions.keepalive ?? false,
    });
  }
  function pagehide() {
    void close({ keepalive: true }).catch(() => {});
  }
  function aborted() {
    void close({ keepalive: true }).catch(() => {});
  }
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", pagehide, { once: true });
  options.signal?.addEventListener("abort", aborted, { once: true });
  function advertised(effect: ServerPluginUIEffect): string {
    healthy();
    validateEffects([effect]);
    const identity = effectIdentity(effect);
    if (resolvedEffects.has(identity))
      throw new ServerPluginUIError(
        "PLUGIN_UI_EFFECT_USED",
        "이미 답한 플러그인 요청은 다시 실행하지 않습니다.",
      );
    const original = current.effects?.find(
      (item) => effectIdentity(item) === identity,
    );
    if (
      !original ||
      JSON.stringify(canonicalWire(original)) !==
        JSON.stringify(canonicalWire(effect))
    )
      throw new ServerPluginUIError(
        "PLUGIN_UI_EFFECT_CHANGED",
        "플러그인 브라우저 요청이 변경되었거나 종료되었습니다.",
      );
    return identity;
  }
  async function resolveEffect(
    effect: ServerPluginUIEffect,
    answer: ServerPluginUIEffectAnswer,
  ) {
    const identity = advertised(effect);
    validateEffectAnswer(effect, answer);
    if (
      answer.kind === "download" &&
      answer.received &&
      !receivedArtifacts.has(identity)
    )
      throw new ServerPluginUIError(
        "INVALID_PLUGIN_UI_EFFECT",
        "내보내기 파일을 받기 전에 완료로 답할 수 없습니다.",
      );
    resolvedEffects.add(identity);
    try {
      const raw = await json(base + "/effect", {
        method: "POST",
        headers,
        signal: lifetime.signal,
        body: JSON.stringify({
          effectId: effect.id,
          eventId: effect.eventId,
          ...answer,
        }),
      });
      healthy();
      if (
        !plain(raw) ||
        raw.effectId !== effect.id ||
        raw.eventId !== effect.eventId ||
        raw.kind !== effect.kind ||
        raw.resolved !== true
      )
        throw new ServerPluginUIError(
          "PLUGIN_UI_EFFECT_UNCERTAIN",
          "브라우저 요청의 완료를 확인하지 못했습니다. 복사·다운로드·입력을 자동으로 반복하지 않습니다.",
        );
      try {
        const next = await json(base, { headers, signal: lifetime.signal });
        healthy();
        return publish(next);
      } catch (error) {
        const cancelled =
          (answer.kind === "file" && answer.file === null) ||
          (answer.kind === "confirm" && !answer.accepted);
        if (
          cancelled &&
          error instanceof ServerPluginUIError &&
          ["PLUGIN_UI_CLOSED", "FORBIDDEN"].includes(error.code)
        ) {
          publish({ ...current, visible: false, effects: [] });
          await close({ keepalive: true }).catch(() => {});
          return structuredClone(current);
        }
        throw error;
      }
    } catch (error) {
      if (closed) healthy();
      throw fail(error);
    }
  }
  async function downloadArtifact(
    effect: Extract<ServerPluginUIEffect, { kind: "download" }>,
  ) {
    const identity = advertised(effect);
    if (effect.kind !== "download" || artifactAttempts.has(identity))
      throw new ServerPluginUIError(
        "PLUGIN_UI_EFFECT_USED",
        "이미 받기 시작한 파일은 자동으로 다시 다운로드하지 않습니다.",
      );
    artifactAttempts.add(identity);
    try {
      const response = await request(
        `${base}/artifact/${encodeURIComponent(effect.id)}?eventId=${encodeURIComponent(effect.eventId)}`,
        {
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal: lifetime.signal,
        },
      );
      healthy();
      if (!response.ok)
        throw new ServerPluginUIError(
          "PLUGIN_UI_ARTIFACT_FAILED",
          "플러그인 내보내기 파일을 받을 수 없습니다. 설정 창을 다시 열어 주세요.",
        );
      const mime = response.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      const declared = response.headers.get("Content-Length");
      if (
        mime !== effect.mime ||
        (declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) !== effect.bytes))
      )
        throw new ServerPluginUIError(
          "INVALID_PLUGIN_UI_ARTIFACT",
          "내보내기 파일 형식이나 크기가 원본 요청과 다릅니다.",
        );
      const chunks: BlobPart[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const next = await reader.read();
            healthy();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > effect.bytes || bytes > SERVER_PLUGIN_UI_TRANSFER_LIMIT)
              throw new ServerPluginUIError(
                "INVALID_PLUGIN_UI_ARTIFACT",
                "내보내기 파일이 광고된 크기 또는 8 MiB 제한을 넘었습니다.",
              );
            chunks.push(new Uint8Array(next.value));
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      healthy();
      if (bytes !== effect.bytes)
        throw new ServerPluginUIError(
          "INVALID_PLUGIN_UI_ARTIFACT",
          "내보내기 파일이 완전히 수신되지 않았습니다.",
        );
      receivedArtifacts.add(identity);
      return new Blob(chunks, { type: effect.mime });
    } catch (error) {
      if (closed) healthy();
      throw fail(error);
    }
  }
  schedule();
  return {
    get closed() {
      return closed;
    },
    get snapshot() {
      return structuredClone(current);
    },
    subscribe(listener) {
      healthy();
      listeners.add(listener);
      listener(structuredClone(current));
      return () => listeners.delete(listener);
    },
    async dispatch(event) {
      healthy();
      validateEvent(event, current);
      if (inFlight)
        throw new ServerPluginUIError(
          "PLUGIN_UI_EVENT_BUSY",
          "이전 플러그인 입력의 완료를 기다리고 있습니다.",
        );
      inFlight++;
      let requestHash: string | undefined;
      try {
        requestHash = await eventHash(event);
        const raw = await json(base + "/event", {
          method: "POST",
          headers,
          body: JSON.stringify(event),
          signal: options.signal,
        });
        if (
          !plain(raw) ||
          raw.eventId !== event.eventId ||
          !Number.isSafeInteger(raw.appliedRevision) ||
          Number(raw.appliedRevision) < 1 ||
          typeof raw.replayed !== "boolean"
        )
          throw new ServerPluginUIError(
            "PLUGIN_UI_EVENT_UNCERTAIN",
            "플러그인 입력의 저장 결과를 확인하지 못했습니다. 작업을 자동으로 반복하지 않습니다.",
          );
        const snapshot = publish(raw.snapshot);
        if (Number(raw.appliedRevision) > snapshot.revision)
          throw new ServerPluginUIError(
            "PLUGIN_UI_EVENT_UNCERTAIN",
            "플러그인 입력의 화면 버전과 저장 증명이 일치하지 않습니다.",
          );
        return {
          eventId: event.eventId,
          appliedRevision: Number(raw.appliedRevision),
          replayed: raw.replayed,
          snapshot,
        };
      } catch (error) {
        // Staleness is rejected before admission. Refresh the display, but leave
        // retrying that user action explicit. Every uncertain execution stops.
        if (
          error instanceof ServerPluginUIError &&
          [
            "PLUGIN_UI_REVISION_CHANGED",
            "PLUGIN_UI_NODE_CHANGED",
            "INVALID_PLUGIN_UI_VALUE",
            "PLUGIN_UI_DISABLED",
          ].includes(error.code)
        ) {
          await refresh();
          throw error;
        }
        if (
          requestHash &&
          (!(error instanceof ServerPluginUIError) ||
            [
              "PLUGIN_UI_TRANSPORT_UNCERTAIN",
              "PLUGIN_UI_EVENT_UNCERTAIN",
            ].includes(error.code))
        ) {
          // Body-free read is safe even if the request completed after this
          // browser lost its response. No original event is sent a second time.
          let proof: unknown;
          try {
            proof = await json(
              `/api/runtime/plugin-ui-events/${encodeURIComponent(event.eventId)}?sessionId=${encodeURIComponent(opened.sessionId as string)}`,
              {
                headers: { "Risu-Runtime-Id": cap.serverId as string },
              },
            );
          } catch {
            /* An absent or unavailable receipt remains uncertain. */
          }
          if (
            plain(proof) &&
            proof.state === "completed" &&
            proof.eventId === event.eventId &&
            proof.sessionId === opened.sessionId &&
            proof.requestHash === requestHash &&
            proof.commitId === event.eventId &&
            Number.isSafeInteger(proof.appliedRevision) &&
            Number(proof.appliedRevision) >= 1
          ) {
            let snapshot: ServerPluginUISnapshot;
            try {
              snapshot = publish(await json(base, { headers }));
            } catch {
              throw fail(
                new ServerPluginUIError(
                  "PLUGIN_UI_EVENT_COMPLETED",
                  "입력이 저장되었음을 확인했습니다. 설정 창을 다시 열어 주세요.",
                ),
              );
            }
            if (Number(proof.appliedRevision) <= snapshot.revision)
              return {
                eventId: event.eventId,
                appliedRevision: Number(proof.appliedRevision),
                replayed: true,
                snapshot,
              };
          }
        }
        throw fail(error);
      } finally {
        inFlight--;
        schedule();
      }
    },
    refresh,
    resolveEffect,
    downloadArtifact,
    close,
  };
}

export async function readServerPluginUIFile(
  file: File,
  signal?: AbortSignal,
): Promise<{ name: string; text: string }> {
  signal?.throwIfAborted();
  if (
    !fileName(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > SERVER_PLUGIN_UI_TRANSFER_LIMIT
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_FILE",
      "가져오기 파일은 최대 8 MiB, 파일명은 최대 256 UTF-8 바이트까지 지원합니다.",
    );
  if (
    !["application/json", "text/plain"].includes(
      file.type.split(";")[0].trim().toLowerCase(),
    ) &&
    !/\.(?:json|txt)$/i.test(file.name)
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_FILE",
      "JSON 또는 UTF-8 텍스트 파일만 선택할 수 있습니다.",
    );
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (
    bytes.byteLength !== file.size ||
    bytes.byteLength > SERVER_PLUGIN_UI_TRANSFER_LIMIT
  )
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_FILE",
      "가져오기 파일 크기를 확인하지 못했습니다.",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_FILE",
      "UTF-8로 읽을 수 없는 파일입니다. JSON 또는 UTF-8 텍스트 파일을 선택해 주세요.",
    );
  }
  return { name: file.name, text };
}
function assertBrowserEffectActive(
  session: ServerPluginUISession,
  effect: ServerPluginUIEffect,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (session.closed)
    throw new ServerPluginUIError(
      "PLUGIN_UI_CLOSED",
      "플러그인 설정 창이 닫혔습니다.",
    );
  const advertised = session.snapshot.effects?.find(
    (item) => effectIdentity(item) === effectIdentity(effect),
  );
  if (
    !advertised ||
    JSON.stringify(canonicalWire(advertised)) !==
      JSON.stringify(canonicalWire(effect))
  )
    throw new ServerPluginUIError(
      "PLUGIN_UI_EFFECT_CHANGED",
      "플러그인 브라우저 요청이 변경되었거나 종료되었습니다.",
    );
}
const clipboardAttempts = new WeakMap<ServerPluginUISession, Set<string>>();
/** Call directly from the trusted parent button's user activation. */
export async function copyServerPluginUIToClipboard(
  session: ServerPluginUISession,
  effect: Extract<ServerPluginUIEffect, { kind: "clipboard" }>,
  signal?: AbortSignal,
) {
  assertBrowserEffectActive(session, effect, signal);
  let attempts = clipboardAttempts.get(session);
  if (!attempts) clipboardAttempts.set(session, (attempts = new Set()));
  const identity = effectIdentity(effect);
  if (attempts.has(identity))
    throw new ServerPluginUIError(
      "PLUGIN_UI_EFFECT_USED",
      "복사 요청을 자동으로 반복하지 않습니다.",
    );
  attempts.add(identity);
  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Unavailable");
    await navigator.clipboard.writeText(effect.text);
    copied = true;
  } catch {
    /* No fallback, private text logging or implicit retry. */
  }
  assertBrowserEffectActive(session, effect, signal);
  const message = "브라우저가 클립보드 복사를 허용하지 않았습니다.";
  await session.resolveEffect(effect, {
    kind: "clipboard",
    ok: copied,
    ...(copied ? {} : { error: message }),
  });
  if (!copied)
    throw new ServerPluginUIError("PLUGIN_UI_CLIPBOARD_FAILED", message);
}
/** Invoke directly from a trusted user button; the original plugin never runs
 * browser code or controls the download URL. Completion means the browser was
 * given the verified file, not that a particular path on disk was written. */
export async function saveServerPluginUIArtifact(
  session: ServerPluginUISession,
  effect: Extract<ServerPluginUIEffect, { kind: "download" }>,
  signal?: AbortSignal,
) {
  assertBrowserEffectActive(session, effect, signal);
  const blob = await session.downloadArtifact(effect);
  assertBrowserEffectActive(session, effect, signal);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = effect.name;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    assertBrowserEffectActive(session, effect, signal);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  await session.resolveEffect(effect, { kind: "download", received: true });
}

// This function is serialized as the only script in the opaque iframe. Keep it
// standalone: it must not close over application objects or import plugin code.
function pluginUIFrameRuntime(secret: string) {
  const parentWindow = window.parent;
  const NODE = "data-risu-plugin-node";
  const EVENTS = "data-risu-plugin-events";
  let port: MessagePort | undefined;
  let view: ServerPluginUISnapshot | undefined;
  let stopped = false,
    sending = false;
  const pending: Array<Omit<ServerPluginUIEvent, "scope" | "revision">> = [];
  const dirty = new Map<string, number>();
  const root = document.createElement("div");
  root.setAttribute("data-risu-plugin-root", "");
  document.body.appendChild(root);
  const styleRoot = document.createElement("div");
  document.head.appendChild(styleRoot);
  function id(node: Node) {
    return node.nodeType === 1 ? (node as Element).getAttribute(NODE) : null;
  }
  function syncAttributes(old: Element, fresh: Element) {
    for (const attribute of Array.from(old.attributes))
      if (!fresh.hasAttribute(attribute.name))
        old.removeAttribute(attribute.name);
    for (const attribute of Array.from(fresh.attributes))
      if (old.getAttribute(attribute.name) !== attribute.value)
        old.setAttribute(attribute.name, attribute.value);
  }
  function patch(old: Node, fresh: Node): Node {
    if (
      old.nodeType !== fresh.nodeType ||
      (old.nodeType === 1 &&
        (old as Element).tagName !== (fresh as Element).tagName)
    ) {
      old.parentNode?.replaceChild(fresh, old);
      return fresh;
    }
    if (old.nodeType === 3) {
      if (old.textContent !== fresh.textContent)
        old.textContent = fresh.textContent;
      return old;
    }
    if (old.nodeType !== 1) return old;
    const element = old as HTMLElement,
      next = fresh as HTMLElement;
    syncAttributes(element, next);
    if (element.tagName !== "TEXTAREA") patchChildren(element, next);
    return old;
  }
  function patchChildren(old: Node, fresh: Node) {
    const keyed = new Map<string, Node>();
    for (const child of Array.from(old.childNodes)) {
      const key = id(child);
      if (key) keyed.set(key, child);
    }
    let position: Node | null = old.firstChild;
    for (const child of Array.from(fresh.childNodes)) {
      const key = id(child);
      const candidate = key
        ? keyed.get(key)
        : position && !id(position) && position.nodeType === child.nodeType
          ? position
          : null;
      const wasPosition = !!candidate && candidate === position;
      const node = candidate ? patch(candidate, child) : child;
      if (wasPosition) position = node;
      if (node !== position) old.insertBefore(node, position);
      position = node.nextSibling;
      if (key) keyed.delete(key);
    }
    while (position) {
      const next = position.nextSibling;
      old.removeChild(position);
      position = next;
    }
  }
  function positionHelpPopovers() {
    for (const popover of root.querySelectorAll<HTMLElement>(
      ".wl-popover[role=tooltip][id]",
    )) {
      if (!/^wl-help-popover-\d+$/.test(popover.id)) continue;
      const anchor = Array.from(
        root.querySelectorAll<HTMLElement>(".wl-helpbtn[aria-describedby]"),
      ).find(
        (element) => element.getAttribute("aria-describedby") === popover.id,
      );
      if (!anchor) continue;
      const rect = anchor.getBoundingClientRect();
      const width = popover.offsetWidth,
        height = popover.offsetHeight;
      const viewportWidth = document.documentElement.clientWidth,
        viewportHeight = document.documentElement.clientHeight;
      let left = rect.left,
        top = rect.bottom + 6;
      if (left + width + 8 > viewportWidth)
        left = Math.max(8, viewportWidth - width - 8);
      if (top + height + 8 > viewportHeight)
        top = Math.max(8, rect.top - height - 6);
      popover.style.left = left + window.scrollX + "px";
      popover.style.top = top + window.scrollY + "px";
    }
  }
  function render(next: ServerPluginUISnapshot) {
    if (view && next.revision < view.revision) return;
    if (view && JSON.stringify(next.scope) !== JSON.stringify(view.scope))
      return stop("플러그인 실행 소유자가 변경되었습니다.");
    const scrolls = Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter((e) => e.scrollTop || e.scrollLeft)
      .map((e) => [e, e.scrollTop, e.scrollLeft] as const);
    const pageScroll = [window.scrollX, window.scrollY];
    const focused = document.activeElement as
      HTMLInputElement | HTMLTextAreaElement | null;
    let selection: [number | null, number | null, string | null] | undefined;
    try {
      if (focused && "selectionStart" in focused)
        selection = [
          focused.selectionStart,
          focused.selectionEnd,
          focused.selectionDirection,
        ];
    } catch {
      /* numeric input */
    }
    const template = document.createElement("template");
    template.innerHTML = next.html;
    patchChildren(root, template.content);
    const nodes = new Map(
      Array.from(root.querySelectorAll<HTMLElement>(`[${NODE}]`)).map((e) => [
        e.getAttribute(NODE),
        e,
      ]),
    );
    for (const state of next.controlStates) {
      const element = nodes.get(state.nodeId) as
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      if (!element || dirty.has(state.nodeId)) continue;
      if (state.tag === "SELECT") {
        const select = element as HTMLSelectElement;
        for (const option of Array.from(select.options))
          option.selected = state.selectedValues.includes(option.value);
        if (!state.selectedValues.length) select.selectedIndex = -1;
      } else {
        if (element.value !== state.value) element.value = state.value;
        if (state.tag === "INPUT") {
          (element as HTMLInputElement).checked = state.checked;
          (element as HTMLInputElement).indeterminate = state.indeterminate;
        }
      }
    }
    const styles = next.styles.join("\n");
    if (styleRoot.textContent !== styles) {
      const style = document.createElement("style");
      style.textContent = styles;
      styleRoot.replaceChildren(style);
    }
    for (const [element, top, left] of scrolls)
      if (element.isConnected) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    window.scrollTo(pageScroll[0], pageScroll[1]);
    if (focused?.isConnected) {
      focused.focus({ preventScroll: true });
      if (selection)
        try {
          focused.setSelectionRange(
            selection[0],
            selection[1],
            selection[2] as "forward" | "backward" | "none",
          );
        } catch {
          /* unsupported control */
        }
    }
    view = next;
    // The reviewed help popup has a stable original aria-describedby link.
    // Derive only its display placement from this iframe's real browser bounds;
    // the original server handlers still create/dismiss its contents and DOM.
    positionHelpPopovers();
    pump();
  }
  function stop(message: string) {
    stopped = true;
    pending.length = 0;
    dirty.clear();
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = message;
    document.body.prepend(notice);
    root.setAttribute("inert", "");
  }
  function pump() {
    if (stopped || sending || !view || !port || !pending.length) return;
    const event = pending[0];
    const element = Array.from(root.querySelectorAll(`[${NODE}]`)).find(
      (e) => e.getAttribute(NODE) === event.nodeId,
    );
    if (!element?.getAttribute(EVENTS)?.split(" ").includes(event.type))
      return stop("입력 대상이 변경되었습니다. 설정 창을 다시 열어 주세요.");
    sending = true;
    port.postMessage({
      type: "event",
      event: { ...event, scope: view.scope, revision: view.revision },
    });
  }
  function formValue(element: Element, type: string) {
    if (
      !["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
      type === "click"
    )
      return {};
    if (
      element.tagName === "INPUT" &&
      ["checkbox", "radio"].includes((element as HTMLInputElement).type)
    )
      return { checked: (element as HTMLInputElement).checked };
    if (element.tagName === "SELECT" && (element as HTMLSelectElement).multiple)
      return {
        selectedValues: Array.from(
          (element as HTMLSelectElement).selectedOptions,
          (option) => option.value,
        ),
      };
    return { value: (element as HTMLInputElement).value };
  }
  function receive(event: Event) {
    if (stopped || !view) return;
    let target = event.target instanceof Element ? event.target : null;
    if (event.type === "keydown" && (!target || !root.contains(target))) {
      target =
        Array.from(root.children)
          .reverse()
          .find((element) =>
            element.getAttribute(EVENTS)?.split(" ").includes("keydown"),
          ) ?? null;
    }
    if (!target || !root.contains(target)) return;
    if (
      event.type === "keydown" &&
      !["Escape", "Enter", "Tab"].includes((event as KeyboardEvent).key)
    )
      return;
    if (event.type === "click") {
      // The browser's actual control interaction emits input/change separately;
      // forwarding an inherited overlay click would commit a second no-op job.
      if (target.closest("input,textarea,select,label")) return;
      if (target.closest("a")) event.preventDefault();
    }
    while (
      target &&
      !target.getAttribute(EVENTS)?.split(" ").includes(event.type)
    )
      target = target.parentElement;
    if (
      !target ||
      !root.contains(target) ||
      target.hasAttribute("disabled") ||
      target.closest("[inert]")
    )
      return;
    const nodeId = target.getAttribute(NODE);
    if (!nodeId) return;
    const payload = {
      eventId: "plugin-ui:" + crypto.randomUUID(),
      nodeId,
      type: event.type as ServerPluginUIEvent["type"],
      ...formValue(target, event.type),
      ...(event.type === "keydown"
        ? { key: (event as KeyboardEvent).key }
        : {}),
    };
    pending.push(payload);
    if (["input", "change"].includes(event.type))
      dirty.set(nodeId, (dirty.get(nodeId) ?? 0) + 1);
    pump();
  }
  for (const type of ["click", "input", "change", "blur"])
    root.addEventListener(type, receive, true);
  document.addEventListener("keydown", receive, true);
  window.addEventListener("resize", positionHelpPopovers);
  document.addEventListener("scroll", positionHelpPopovers, true);
  function connect(event: MessageEvent) {
    if (
      event.source !== parentWindow ||
      event.data?.type !== "risu-plugin-ui-connect" ||
      event.data?.secret !== secret ||
      event.ports.length !== 1 ||
      port
    )
      return;
    port = event.ports[0];
    window.removeEventListener("message", connect);
    port.onmessage = ({ data }) => {
      if (data?.type === "snapshot") render(data.snapshot);
      else if (data?.type === "ack") {
        const event = pending[0];
        if (!event || data.eventId !== event.eventId)
          return stop("플러그인 입력의 완료를 확인하지 못했습니다.");
        pending.shift();
        sending = false;
        if (dirty.has(event.nodeId)) {
          const remaining = dirty.get(event.nodeId)! - 1;
          if (remaining) dirty.set(event.nodeId, remaining);
          else dirty.delete(event.nodeId);
        }
        render(data.snapshot);
      } else if (data?.type === "rejected") {
        const event = pending.shift();
        sending = false;
        if (event && dirty.has(event.nodeId)) dirty.delete(event.nodeId);
        pending.length = 0;
        dirty.clear();
        if (data.snapshot) render(data.snapshot);
        const notice = document.createElement("p");
        notice.setAttribute("role", "alert");
        notice.textContent = data.message;
        document.body.prepend(notice);
      } else if (data?.type === "failed") stop(data.message);
    };
    port.start();
    port.postMessage({ type: "ready" });
  }
  window.addEventListener("message", connect);
}

export function createServerPluginUIFrameDocument(
  secret: string,
  nonce: string,
): string {
  if (![secret, nonce].every((value) => /^[a-zA-Z0-9_-]{24,128}$/.test(value)))
    throw new ServerPluginUIError(
      "INVALID_PLUGIN_UI_NONCE",
      "플러그인 화면 채널 식별자가 올바르지 않습니다.",
    );
  const script = `(${pluginUIFrameRuntime.toString()})(${JSON.stringify(secret)});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#14151a;color:#eee;font:14px sans-serif}body>p[role=alert]{padding:12px;background:#3e2527}body>[data-risu-plugin-root]{min-height:100vh}</style></head><body><script nonce="${nonce}">${script}</script></body></html>`;
}
export function mountServerPluginUI(
  container: HTMLElement,
  session: ServerPluginUISession,
  options: { onError?: (error: Error) => void } = {},
) {
  const secret =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const iframe = document.createElement("iframe");
  iframe.title = "서버 플러그인 설정";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = "no-referrer";
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
  iframe.srcdoc = createServerPluginUIFrameDocument(secret, nonce);
  const channel = new MessageChannel();
  let destroyed = false,
    ready = false;
  const send = (data: unknown) => {
    if (!destroyed && ready) channel.port1.postMessage(data);
  };
  const frameSnapshot = (snapshot: ServerPluginUISnapshot) => {
    // File names, confirmation/copy text and artifact metadata belong to the
    // trusted parent UI. The opaque renderer only needs the original DOM view.
    const { effects: _effects, ...view } = snapshot;
    return view;
  };
  const unsubscribe = session.subscribe((snapshot) =>
    send({ type: "snapshot", snapshot: frameSnapshot(snapshot) }),
  );
  channel.port1.onmessage = async ({ data }) => {
    if (destroyed || !plain(data)) return;
    if (data.type === "ready") {
      ready = true;
      send({ type: "snapshot", snapshot: frameSnapshot(session.snapshot) });
      return;
    }
    if (!ready || data.type !== "event" || !plain(data.event)) return;
    try {
      const receipt = await session.dispatch(
        data.event as unknown as ServerPluginUIEvent,
      );
      send({
        type: "ack",
        eventId: receipt.eventId,
        snapshot: frameSnapshot(receipt.snapshot),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const rejected =
        error instanceof ServerPluginUIError &&
        [
          "PLUGIN_UI_REVISION_CHANGED",
          "PLUGIN_UI_NODE_CHANGED",
          "INVALID_PLUGIN_UI_VALUE",
          "PLUGIN_UI_DISABLED",
        ].includes(error.code);
      send({
        type: rejected ? "rejected" : "failed",
        message: error.message,
        snapshot: rejected ? frameSnapshot(session.snapshot) : undefined,
      });
      options.onError?.(error);
    }
  };
  channel.port1.start();
  iframe.addEventListener(
    "load",
    () => {
      if (!destroyed)
        iframe.contentWindow?.postMessage(
          { type: "risu-plugin-ui-connect", secret },
          "*",
          [channel.port2],
        );
    },
    { once: true },
  );
  container.appendChild(iframe);
  return {
    iframe,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      channel.port1.close();
      channel.port2.close();
      iframe.remove();
    },
  };
}
