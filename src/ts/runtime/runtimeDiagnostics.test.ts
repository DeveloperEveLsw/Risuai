import { beforeEach, expect, test, vi } from "vitest";
import {
  runtimeHttpFailure,
  runtimeDiagnosticsKey,
  recordRuntimeDiagnostic,
  runtimeFetch,
} from "./runtimeDiagnostics";
const uuid = "60c52b16-430a-4cf0-a9e4-a165950015a2";
beforeEach(() => localStorage.clear());
test("HTTP metadata retains correlation after reload while excluding message, details, URL IDs and credentials", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        code: "ERR_SQLITE_ERROR",
        message: "PRIVATE_SENTINEL",
        details: { token: "PRIVATE_SENTINEL" },
      },
    }),
    { status: 500, headers: { "risu-request-id": uuid } },
  );
  Object.defineProperty(response, "url", {
    value:
      "https://PRIVATE_SENTINEL/api/runtime/chats/PRIVATE_SENTINEL?token=PRIVATE_SENTINEL",
  });
  const error = await runtimeHttpFailure(response);
  expect(error.requestId).toBe(uuid);
  expect(error.status).toBe(500);
  expect(error.message).toBe("PRIVATE_SENTINEL");
  const saved = localStorage.getItem(runtimeDiagnosticsKey)!;
  expect(saved).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.parse(saved)[0]).toMatchObject({
    code: "ERR_SQLITE_ERROR",
    endpoint: "/api/runtime/chats/:id",
    requestId: uuid,
  });
  vi.resetModules();
  const reloaded = await import("./runtimeDiagnostics");
  reloaded.recordRuntimeDiagnostic({ code: "NETWORK_ERROR" });
  expect(JSON.parse(localStorage.getItem(runtimeDiagnosticsKey)!)).toHaveLength(
    2,
  );
});
test("HTML or empty gateway failures preserve HTTP status and request ID rather than throwing JSON parser errors", async () => {
  const error = await runtimeHttpFailure(
    new Response("<html>PRIVATE_SENTINEL</html>", {
      status: 502,
      headers: { "risu-request-id": uuid },
    }),
    "Cannot connect",
  );
  expect(error).toMatchObject({
    code: "HTTP_ERROR",
    status: 502,
    requestId: uuid,
    message: "Cannot connect",
  });
  expect(localStorage.getItem(runtimeDiagnosticsKey)).not.toContain(
    "PRIVATE_SENTINEL",
  );
});
test("recent failure storage is bounded, discards old raw fields and tolerates corrupted/full storage", () => {
  localStorage.setItem(
    runtimeDiagnosticsKey,
    JSON.stringify([
      { message: "PRIVATE_SENTINEL", endpoint: "/PRIVATE_SENTINEL" },
    ]),
  );
  for (let i = 0; i < 40; i++)
    recordRuntimeDiagnostic({ code: "DATABASE_ERROR", requestId: uuid });
  const saved = localStorage.getItem(runtimeDiagnosticsKey)!;
  expect(JSON.parse(saved)).toHaveLength(30);
  expect(saved).not.toContain("PRIVATE_SENTINEL");
  localStorage.setItem(runtimeDiagnosticsKey, "bad json");
  expect(() =>
    recordRuntimeDiagnostic({ code: "DATABASE_ERROR" }),
  ).not.toThrow();
  expect(JSON.parse(localStorage.getItem(runtimeDiagnosticsKey)!)).toHaveLength(
    1,
  );
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw Error("Quota");
  });
  expect(() =>
    recordRuntimeDiagnostic({ code: "DATABASE_ERROR" }),
  ).not.toThrow();
  spy.mockRestore();
});
test("network and timeout failures are recorded but explicit navigation/stop cancellation is ignored", async () => {
  const failure = vi.fn().mockRejectedValue(new TypeError("PRIVATE_SENTINEL"));
  await expect(
    runtimeFetch("/api/runtime/bootstrap", {}, failure),
  ).rejects.toThrow();
  const timeout = new AbortController();
  timeout.abort(new DOMException("Timeout", "TimeoutError"));
  await expect(
    runtimeFetch("/api/runtime/bootstrap", { signal: timeout.signal }, failure),
  ).rejects.toThrow();
  const stop = new AbortController();
  stop.abort();
  await expect(
    runtimeFetch("/api/runtime/events", { signal: stop.signal }, failure),
  ).rejects.toThrow();
  const saved = JSON.parse(localStorage.getItem(runtimeDiagnosticsKey)!);
  expect(saved.map((v) => v.code)).toEqual([
    "NETWORK_ERROR",
    "REQUEST_TIMEOUT",
  ]);
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_SENTINEL");
});
