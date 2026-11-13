"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describePluginProviderFailure,
  sanitizePluginProviderDiagnostic,
  pluginProviderWarning,
  classifyPluginProviderEndpoint,
} = require("./pluginProviderDiagnostic.cjs");

test("nested network errors retain a useful category without private messages or payloads", () => {
  const error = new TypeError(
    "https://private.invalid/key?token=synthetic-secret",
    {
      cause: Object.assign(new Error("synthetic-private-prompt"), {
        code: "ECONNRESET",
      }),
    },
  );
  const diagnostic = describePluginProviderFailure(error, {
    phase: "body",
    startedAt: Date.now() - 20,
    status: 200,
    call: 1,
    endpoint: "https://api.voyageai.com/v1/embeddings?key=synthetic-secret",
  });
  assert.equal(diagnostic.category, "connection");
  assert.equal(diagnostic.phase, "body");
  assert.equal(diagnostic.causeCode, "ECONNRESET");
  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.endpointKind, "voyage-embedding");
  assert.equal(diagnostic.stopOrigin, "none");
  assert.ok(diagnostic.elapsedMs >= 20);
  const persisted =
    JSON.stringify(diagnostic) + pluginProviderWarning(diagnostic);
  for (const privateValue of [
    "private.invalid",
    "synthetic-secret",
    "synthetic-private-prompt",
  ])
    assert.equal(persisted.includes(privateValue), false);
});

test("a plugin abort preserves its origin and timeout classification", () => {
  const request = new AbortController();
  request.abort(
    new DOMException("synthetic-private-timeout-text", "TimeoutError"),
  );
  const diagnostic = describePluginProviderFailure(request.signal.reason, {
    phase: "request",
    requestSignal: request.signal,
    startedAt: Date.now(),
  });
  assert.equal(diagnostic.category, "timeout");
  assert.equal(diagnostic.abortSource, "request");
  assert.equal(diagnostic.stopOrigin, "request-unknown");
  assert.equal(
    JSON.stringify(diagnostic).includes("synthetic-private-timeout-text"),
    false,
  );
});

test("diagnostic boundaries reject arbitrary nested data and unrecognized strings", () => {
  const diagnostic = sanitizePluginProviderDiagnostic({
    phase: "private-phase",
    category: "private-category",
    causeCode: "private-key",
    errorName: "private-name",
    abortSource: "private-url",
    elapsedMs: -1,
    status: 900,
    call: Infinity,
    body: "private-body",
    endpointKind: "private-endpoint",
    stopOrigin: "private-abort-reason",
  });
  assert.deepEqual(diagnostic, {
    phase: "request",
    category: "unknown",
    abortSource: "none",
    errorName: null,
    causeCode: null,
    elapsedMs: 0,
    status: null,
    call: null,
    endpointKind: "unknown",
    stopOrigin: "unknown",
  });
  assert.deepEqual(sanitizePluginProviderDiagnostic(null), diagnostic);
});

test("provider kinds use official hosts and operation paths without retaining URL details", () => {
  const fixtures = [
    ["https://oauth2.googleapis.com/token", "google-oauth"],
    [
      "https://aiplatform.googleapis.com/v1/projects/private-project/locations/global/publishers/google/models/private-model:streamGenerateContent?alt=sse&key=private-key",
      "vertex-generation",
    ],
    [
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/private-project/locations/us-central1/publishers/anthropic/models/private-model:rawPredict",
      "vertex-generation",
    ],
    [
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/private-project/locations/eu/publishers/google/models/private-model:generateContent",
      "vertex-generation",
    ],
    [
      "https://aiplatform.us.rep.googleapis.com/v1/projects/private-project/locations/us/publishers/google/models/private-model:predict",
      "vertex-prediction",
    ],
    [
      "https://generativelanguage.googleapis.com/v1beta/models/private-model:generateContent?key=private-key",
      "gemini-generation",
    ],
    [
      "https://generativelanguage.googleapis.com/v1/models/private-model:batchEmbedContents",
      "gemini-embedding",
    ],
    ["https://api.voyageai.com/v1/embeddings", "voyage-embedding"],
    ["https://api.openai.com/v1/chat/completions", "openai-generation"],
    ["https://api.openai.com/v1/responses", "openai-generation"],
    ["https://api.openai.com/v1/embeddings", "openai-embedding"],
    ["https://api.anthropic.com/v1/messages", "anthropic-generation"],
  ];
  for (const [endpoint, expected] of fixtures) {
    assert.equal(classifyPluginProviderEndpoint(endpoint), expected);
    const diagnostic = describePluginProviderFailure(
      new Error("private-body"),
      {
        endpoint: new URL(endpoint),
      },
    );
    assert.equal(diagnostic.endpointKind, expected);
    const persisted =
      JSON.stringify(diagnostic) + pluginProviderWarning(diagnostic);
    for (const privateValue of [
      endpoint,
      new URL(endpoint).hostname,
      "private-project",
      "private-model",
      "private-key",
      "private-body",
    ])
      assert.equal(persisted.includes(privateValue), false);
  }
});

test("custom proxies, malformed URLs and misleading provider paths remain unknown", () => {
  for (const endpoint of [
    "https://custom-proxy.invalid/v1/embeddings",
    "https://custom-proxy.invalid/v1/projects/private/locations/global/publishers/google/models/private:generateContent",
    "https://api.voyageai.com.private.invalid/v1/embeddings",
    "https://private.invalid@api.voyageai.com/v1/embeddings",
    "https://private:private@api.voyageai.com/v1/embeddings",
    "https://api.voyageai.com:8443/v1/embeddings",
    "http://api.voyageai.com/v1/embeddings",
    "https://api.voyageai.com/v1/private-body",
    "https://aiplatform.private.rep.googleapis.com/v1/projects/private/locations/private/publishers/google/models/private:generateContent",
    "https://aiplatform.googleapis.com/private:generateContent",
    "https://oauth2.googleapis.com/private",
    "private-invalid-url",
    null,
    {},
    { toString: () => "https://api.voyageai.com/v1/embeddings" },
  ])
    assert.equal(classifyPluginProviderEndpoint(endpoint), "unknown");
});

test("exact public plugin deadline reasons identify the limit without changing existing fields", () => {
  for (const [reason, category, stopOrigin] of [
    ["llm-slow-abort-45000ms", "aborted", "plugin-slow-limit"],
    ["llm-timeout-120000ms", "timeout", "plugin-request-limit"],
    ["embed-timeout-120000ms", "timeout", "embedding-limit"],
  ]) {
    const request = new AbortController();
    request.abort(reason);
    const diagnostic = describePluginProviderFailure(reason, {
      requestSignal: request.signal,
      call: 2,
    });
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.abortSource, "request");
    assert.equal(diagnostic.errorName, null);
    assert.equal(diagnostic.causeCode, null);
    assert.equal(diagnostic.status, null);
    assert.equal(diagnostic.call, 2);
    assert.equal(diagnostic.stopOrigin, stopOrigin);
    assert.equal(pluginProviderWarning(diagnostic).includes(reason), false);
  }
});

test("slot and header deadlines require their exact public reason shapes", () => {
  const header = Object.assign(new Error("host transport timeout (60000ms)"), {
    code: "WL_HOST_TIMEOUT",
  });
  const slot = new DOMException("WygLore slot test deadline", "TimeoutError");
  for (const [reason, expected] of [
    [header, "host-header-limit"],
    [slot, "slot-test-limit"],
  ]) {
    const request = new AbortController();
    request.abort(reason);
    const diagnostic = describePluginProviderFailure(reason, {
      requestSignal: request.signal,
    });
    assert.equal(diagnostic.category, "timeout");
    assert.equal(diagnostic.abortSource, "request");
    assert.equal(diagnostic.stopOrigin, expected);
    // WL_HOST_TIMEOUT remains excluded from the original network-code field.
    assert.equal(diagnostic.causeCode, null);
    assert.equal(
      pluginProviderWarning(diagnostic).includes(reason.message),
      false,
    );
  }
  assert.equal(
    describePluginProviderFailure(header).stopOrigin,
    "host-header-limit",
  );
});

test("partial or private abort text is not interpreted as a trusted deadline", () => {
  for (const reason of [
    "private llm-slow-abort-45000ms",
    "llm-slow-abort-45000ms private",
    "llm-timeout-120000ms?key=private-key",
    "embed-timeout-120000ms private",
    "llm-slow-abort-0ms",
    new DOMException("private WygLore slot test deadline", "TimeoutError"),
    Object.assign(new Error("host transport timeout (60000ms) private-key"), {
      code: "WL_HOST_TIMEOUT",
    }),
    Object.assign(new Error("host transport timeout (60000ms)"), {
      code: "private-code",
    }),
    new Error("synthetic user cancellation"),
  ]) {
    const request = new AbortController();
    request.abort(reason);
    const diagnostic = describePluginProviderFailure(reason, {
      requestSignal: request.signal,
    });
    assert.equal(diagnostic.stopOrigin, "request-unknown");
    assert.equal(pluginProviderWarning(diagnostic).includes("private"), false);
  }
});

test("host lifetime aborts never claim a user or job cancellation", () => {
  const host = new AbortController();
  const request = new AbortController();
  host.abort(new Error("private-job-or-lease-or-plugin-lifetime"));
  request.abort("llm-slow-abort-45000ms");
  const diagnostic = describePluginProviderFailure(host.signal.reason, {
    signal: host.signal,
    requestSignal: request.signal,
  });
  assert.equal(diagnostic.abortSource, "host");
  assert.equal(diagnostic.category, "aborted");
  assert.equal(diagnostic.stopOrigin, "host-lifetime");
  assert.equal(JSON.stringify(diagnostic).includes("job"), false);
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
});

test("transport deadlines differ from unidentified timeouts and aborts", () => {
  for (const code of [
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ETIMEDOUT",
  ]) {
    const error = new TypeError("private-message", {
      cause: Object.assign(new Error("private-cause"), { code }),
    });
    const diagnostic = describePluginProviderFailure(error);
    assert.equal(diagnostic.category, "timeout");
    assert.equal(diagnostic.abortSource, "none");
    assert.equal(diagnostic.stopOrigin, "transport-limit");
  }
  for (const error of [
    new DOMException("private-message", "TimeoutError"),
    new DOMException("private-message", "AbortError"),
    new Error("private timeout message"),
  ])
    assert.equal(describePluginProviderFailure(error).stopOrigin, "unknown");
});

test("warning serialization revalidates endpoint and origin enums", () => {
  const details = {
    endpointKind: "https://private.invalid/?key=private-key",
    stopOrigin: "private-abort-reason",
    endpoint: "https://private.invalid",
    reason: "private-abort-reason",
    body: "private-body",
    headers: { authorization: "private-token" },
    response: "private-response",
  };
  const safe = sanitizePluginProviderDiagnostic(details);
  assert.equal(safe.endpointKind, "unknown");
  assert.equal(safe.stopOrigin, "unknown");
  assert.equal(pluginProviderWarning(details).includes("private"), false);
  assert.equal(
    pluginProviderWarning({
      ...details,
      endpointKind: "vertex-generation",
      stopOrigin: "plugin-slow-limit",
    }).includes('"stopOrigin":"plugin-slow-limit"'),
    true,
  );
});
