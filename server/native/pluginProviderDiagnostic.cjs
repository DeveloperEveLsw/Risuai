"use strict";

const phases = new Set(["request", "response", "body"]);
const categories = new Set([
  "timeout",
  "aborted",
  "dns",
  "connection",
  "tls",
  "transport",
  "unknown",
]);
const codes = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const names = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "RuntimeError",
]);
const endpointKinds = new Set([
  "google-oauth",
  "vertex-generation",
  "vertex-prediction",
  "gemini-generation",
  "gemini-embedding",
  "voyage-embedding",
  "openai-generation",
  "openai-embedding",
  "anthropic-generation",
  "unknown",
]);
const stopOrigins = new Set([
  "plugin-slow-limit",
  "plugin-request-limit",
  "embedding-limit",
  "slot-test-limit",
  "host-header-limit",
  "host-lifetime",
  "request-unknown",
  "transport-limit",
  "none",
  "unknown",
]);

// Classify only known public provider routes. A matching path on a custom proxy
// does not establish its provider, and no part of the URL leaves this function.
function classifyPluginProviderEndpoint(endpoint) {
  try {
    if (typeof endpoint !== "string" && !(endpoint instanceof URL))
      return "unknown";
    const target = new URL(endpoint);
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password
    )
      return "unknown";
    const host = target.hostname,
      path = target.pathname;
    if (host === "oauth2.googleapis.com" && path === "/token")
      return "google-oauth";
    if (
      host === "aiplatform.googleapis.com" ||
      /^aiplatform\.(?:us|eu)\.rep\.googleapis\.com$/.test(host) ||
      /^[a-z][a-z0-9-]*-aiplatform\.googleapis\.com$/.test(host)
    ) {
      if (
        /^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/(?:google|anthropic)\/models\/[^/]+:(?:generateContent|streamGenerateContent|rawPredict)$/.test(
          path,
        )
      )
        return "vertex-generation";
      if (
        /^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/[^/]+:predict$/.test(
          path,
        )
      )
        return "vertex-prediction";
      return "unknown";
    }
    if (host === "generativelanguage.googleapis.com") {
      if (
        /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(
          path,
        )
      )
        return "gemini-generation";
      if (
        /^\/v1(?:beta)?\/models\/[^/]+:(?:embedContent|batchEmbedContents)$/.test(
          path,
        )
      )
        return "gemini-embedding";
    }
    if (host === "api.voyageai.com" && path === "/v1/embeddings")
      return "voyage-embedding";
    if (host === "api.openai.com") {
      if (["/v1/chat/completions", "/v1/responses"].includes(path))
        return "openai-generation";
      if (path === "/v1/embeddings") return "openai-embedding";
    }
    if (host === "api.anthropic.com" && path === "/v1/messages")
      return "anthropic-generation";
  } catch {}
  return "unknown";
}

function publicStopReasonOrigin(reason) {
  try {
    if (typeof reason === "string") {
      if (/^llm-slow-abort-[1-9]\d{0,8}ms$/.test(reason))
        return "plugin-slow-limit";
      if (/^llm-timeout-[1-9]\d{0,8}ms$/.test(reason))
        return "plugin-request-limit";
      if (/^embed-timeout-[1-9]\d{0,8}ms$/.test(reason))
        return "embedding-limit";
    } else if (reason && typeof reason === "object") {
      if (
        reason.name === "TimeoutError" &&
        reason.message === "WygLore slot test deadline"
      )
        return "slot-test-limit";
      if (
        reason.name === "Error" &&
        reason.code === "WL_HOST_TIMEOUT" &&
        /^host transport timeout \([1-9]\d{0,8}ms\)$/.test(reason.message)
      )
        return "host-header-limit";
    }
  } catch {}
  return "unknown";
}

function describeStopOrigin(error, options, code, name, category) {
  // This lifetime combines several host causes. It cannot identify a user or
  // job cancellation and must take precedence over a later request abort.
  if (options.signal?.aborted) return "host-lifetime";
  if (options.requestSignal?.aborted) {
    const origin = publicStopReasonOrigin(options.requestSignal.reason);
    return origin === "unknown" ? "request-unknown" : origin;
  }
  const origin = publicStopReasonOrigin(error);
  if (origin !== "unknown") return origin;
  if (codes.has(code) && /TIMEOUT|ETIMEDOUT/.test(code))
    return "transport-limit";
  return category === "timeout" || name === "AbortError" ? "unknown" : "none";
}

// Never retain error messages, URLs, headers, abort text or request/response data.
function sanitizePluginProviderDiagnostic(value = {}) {
  if (!value || typeof value !== "object") value = {};
  return {
    phase: phases.has(value.phase) ? value.phase : "request",
    category: categories.has(value.category) ? value.category : "unknown",
    abortSource: ["host", "request", "none"].includes(value.abortSource)
      ? value.abortSource
      : "none",
    errorName: names.has(value.errorName) ? value.errorName : null,
    causeCode: codes.has(value.causeCode) ? value.causeCode : null,
    elapsedMs:
      Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0
        ? Math.min(value.elapsedMs, 86400000)
        : 0,
    status:
      Number.isInteger(value.status) &&
      value.status >= 100 &&
      value.status <= 599
        ? value.status
        : null,
    call:
      Number.isSafeInteger(value.call) && value.call > 0
        ? Math.min(value.call, 10000)
        : null,
    endpointKind: endpointKinds.has(value.endpointKind)
      ? value.endpointKind
      : "unknown",
    stopOrigin: stopOrigins.has(value.stopOrigin)
      ? value.stopOrigin
      : "unknown",
  };
}

function describePluginProviderFailure(error, options = {}) {
  let code,
    name,
    message = "",
    reason;
  try {
    name = error?.name;
    message = typeof error?.message === "string" ? error.message : "";
    for (
      let item = error, depth = 0;
      item && depth < 4;
      item = item.cause, depth++
    )
      if (codes.has(item.code)) {
        code = item.code;
        break;
      }
    reason = options.signal?.aborted
      ? options.signal.reason
      : options.requestSignal?.aborted
        ? options.requestSignal.reason
        : undefined;
  } catch {}
  const aborted = !!(options.signal?.aborted || options.requestSignal?.aborted);
  const timeout =
    name === "TimeoutError" ||
    reason?.name === "TimeoutError" ||
    /TIMEOUT|ETIMEDOUT/.test(code ?? "") ||
    /time.?out|timed out/i.test(typeof reason === "string" ? reason : "") ||
    /time.?out|timed out/i.test(message);
  const category = timeout
    ? "timeout"
    : aborted || name === "AbortError"
      ? "aborted"
      : ["ENOTFOUND", "EAI_AGAIN"].includes(code)
        ? "dns"
        : /TLS|CERT/.test(code ?? "")
          ? "tls"
          : ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(
                code,
              )
            ? "connection"
            : name === "TypeError"
              ? "transport"
              : "unknown";
  return sanitizePluginProviderDiagnostic({
    phase: options.phase,
    category,
    errorName: name,
    causeCode: code,
    abortSource: options.signal?.aborted
      ? "host"
      : options.requestSignal?.aborted
        ? "request"
        : "none",
    elapsedMs: Math.max(0, Date.now() - options.startedAt),
    status: options.status,
    call: options.call,
    endpointKind: classifyPluginProviderEndpoint(options.endpoint),
    stopOrigin: describeStopOrigin(error, options, code, name, category),
  });
}

function pluginProviderWarning(details) {
  const safe = sanitizePluginProviderDiagnostic(details);
  return `기억뜰 보조 요청이 중단되었습니다. 이번 요청의 플러그인 메모리 변경은 폐기하고 답변 처리를 계속합니다. 자동 재요청은 하지 않습니다.\n진단: ${JSON.stringify(safe)}`;
}

module.exports = {
  describePluginProviderFailure,
  sanitizePluginProviderDiagnostic,
  pluginProviderWarning,
  classifyPluginProviderEndpoint,
};
