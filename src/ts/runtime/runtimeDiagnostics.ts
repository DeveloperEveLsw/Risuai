import { RuntimeClientError } from "./clientProtocol";
import {
  diagnosticRequestId,
  runtimeDiagnosticRecord,
  type RuntimeDiagnostic,
} from "./runtimeDiagnosticProtocol.mjs";

export const runtimeDiagnosticsKey = "risu-runtime-diagnostics:v1";
export function recordRuntimeDiagnostic(value: Record<string, unknown>) {
  try {
    const storage = globalThis.localStorage;
    let previous: unknown;
    try {
      previous = JSON.parse(storage.getItem(runtimeDiagnosticsKey) ?? "[]");
    } catch {
      previous = [];
    }
    const records: RuntimeDiagnostic[] = Array.isArray(previous)
      ? previous
          .slice(-29)
          .map((v) =>
            runtimeDiagnosticRecord(v && typeof v === "object" ? v : {}),
          )
      : [];
    records.push(runtimeDiagnosticRecord(value));
    storage.setItem(runtimeDiagnosticsKey, JSON.stringify(records));
  } catch {
    /* Disabled/full browser storage must never break runtime work. */
  }
}
export async function runtimeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (error) {
    const aborted = init?.signal?.aborted;
    const timeout = aborted && init.signal.reason?.name === "TimeoutError";
    // Explicit stop/navigation is expected. Record only genuine network/timeout failures.
    if (!aborted || timeout)
      recordRuntimeDiagnostic({
        kind: "transport-error",
        endpoint:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method ?? "GET",
        code: timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
      });
    throw error;
  }
}
export async function runtimeHttpFailure(
  response: Response,
  fallback = "Runtime request failed",
  method = "GET",
) {
  let body: any;
  try {
    body = await response.json();
  } catch {
    /* A proxy may return HTML or an empty body. */
  }
  const requestId =
    diagnosticRequestId(response.headers.get("Risu-Request-Id")) ??
    diagnosticRequestId(body?.error?.requestId);
  const error = new RuntimeClientError(
    body?.error?.code ?? "HTTP_ERROR",
    body?.error?.message ?? fallback,
    response.status,
    body?.error?.details,
    requestId,
  );
  recordRuntimeDiagnostic({
    kind: "http-error",
    code: error.code,
    status: response.status,
    requestId,
    endpoint: response.url,
    method,
  });
  return error;
}
