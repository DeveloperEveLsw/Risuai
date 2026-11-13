export interface RuntimeDiagnostic {
  at: string;
  kind: string;
  endpoint: string;
  method: string;
  code: string;
  status: number;
  requestId?: string;
  elapsedMs?: number;
}
export function diagnosticRequestId(value: unknown): string | undefined;
export function diagnosticEndpoint(value: unknown): string;
export function runtimeDiagnosticRecord(
  value?: Record<string, unknown>,
): RuntimeDiagnostic;
