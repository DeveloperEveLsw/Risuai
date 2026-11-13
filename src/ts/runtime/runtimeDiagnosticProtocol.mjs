const codes = new Set(
  `INVALID_COMMAND FORBIDDEN NOT_FOUND REVISION_CONFLICT DISPLAY_INPUT_CHANGED
  IDEMPOTENCY_CONFLICT CHAT_BUSY LAST_CHAT LAST_RESOURCE IDENTITY_CONFLICT
  DEPENDENCY_PENDING RESYNC_REQUIRED SERVER_CHANGED SELECTION_CONFLICT
  ASSET_TOO_LARGE ASSET_STORAGE_ERROR RUNTIME_ERROR DATABASE_ERROR STREAM_ERROR
  AUTH_REQUIRED RUNTIME_UNAVAILABLE INVALID_REQUEST HTTP_ERROR NETWORK_ERROR
  REQUEST_TIMEOUT INVALID_STREAM INVALID_SNAPSHOT STREAM_TOO_LARGE CLIENT_ERROR
  CLIENT_STATE CLIENT_CLOSED OUTBOX_UNAVAILABLE RESOLUTION_CHANGED
  ERR_SQLITE_ERROR ERR_SQLITE_BUSY ERR_SQLITE_CONSTRAINT`.split(/\s+/),
);
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const kinds = new Set([
  "http-error",
  "stream-reset",
  "front-error",
  "transport-error",
  "client-error",
]);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const endpoints = [
  ["/_health", /^\/_health$/],
  ["/login", /^\/login$/],
  ["/logout", /^\/logout$/],
  [
    "/api/runtime/:endpoint",
    /^\/api\/runtime\/(health|bootstrap|assets|library|modules|variables|fields|commands|jobs|changes|events)$/,
  ],
  [
    "/api/runtime/characters/:id/chats",
    /^\/api\/runtime\/characters\/[^/]+\/chats$/,
  ],
  ["/api/runtime/characters/:id", /^\/api\/runtime\/characters\/[^/]+$/],
  [
    "/api/runtime/chats/:id/bookmarks/:messageId",
    /^\/api\/runtime\/chats\/[^/]+\/bookmarks\/[^/]+$/,
  ],
  [
    "/api/runtime/chats/:id/bookmarks",
    /^\/api\/runtime\/chats\/[^/]+\/bookmarks$/,
  ],
  ["/api/runtime/chats/:id/jobs", /^\/api\/runtime\/chats\/[^/]+\/jobs$/],
  ["/api/runtime/chats/:id/display", /^\/api\/runtime\/chats\/[^/]+\/display$/],
  ["/api/runtime/chats/:id", /^\/api\/runtime\/chats\/[^/]+$/],
  [
    "/api/runtime/jobs/:id/:action",
    /^\/api\/runtime\/jobs\/[^/]+\/(cancel|command)$/,
  ],
  ["/api/runtime/jobs/:id", /^\/api\/runtime\/jobs\/[^/]+$/],
  ["/api/runtime/assets/:id", /^\/api\/runtime\/assets\/[^/]+$/],
  ["/api/runtime/variables/read", /^\/api\/runtime\/variables\/read$/],
  ["/api/runtime/fields/read", /^\/api\/runtime\/fields\/read$/],
  [
    "/api/runtime/libraries/module/resolve",
    /^\/api\/runtime\/libraries\/module\/resolve$/,
  ],
  ["/api/runtime/libraries/:kind", /^\/api\/runtime\/libraries\/[^/]+$/],
  [
    "/api/runtime/resources/:kind/:id",
    /^\/api\/runtime\/resources\/[^/]+\/[^/]+$/,
  ],
];
export function diagnosticRequestId(value) {
  return typeof value === "string" && uuid.test(value) ? value : undefined;
}
export function diagnosticEndpoint(value) {
  if (typeof value !== "string" || value.length > 8192) return "unknown";
  // Never decode or retain identifiers, query values, fragments, origins or unknown paths.
  let path;
  try {
    path = new URL(value, "http://runtime.invalid").pathname;
  } catch {
    return "unknown";
  }
  for (const [template, pattern] of endpoints) {
    const match = path.match(pattern);
    if (match)
      return template
        .replace(":endpoint", match[1])
        .replace(":action", match[1]);
  }
  return "unknown";
}
export function runtimeDiagnosticRecord(value = {}) {
  const at =
    typeof value.at === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at) &&
    Number.isFinite(Date.parse(value.at))
      ? value.at
      : new Date().toISOString();
  const endpoint =
    endpoints.some(([template]) => template === value.endpoint) ||
    value.endpoint === "unknown"
      ? value.endpoint
      : diagnosticEndpoint(value.endpoint);
  return {
    at,
    kind: kinds.has(value.kind) ? value.kind : "client-error",
    endpoint,
    method: methods.has(value.method) ? value.method : "OTHER",
    code: codes.has(value.code) ? value.code : "RUNTIME_ERROR",
    status:
      Number.isInteger(value.status) &&
      value.status >= 400 &&
      value.status <= 599
        ? value.status
        : 0,
    ...(diagnosticRequestId(value.requestId)
      ? { requestId: value.requestId }
      : {}),
    ...(Number.isFinite(value.elapsedMs)
      ? {
          elapsedMs: Math.min(
            86400000,
            Math.max(0, Math.round(value.elapsedMs)),
          ),
        }
      : {}),
  };
}
