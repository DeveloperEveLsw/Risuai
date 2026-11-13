import type { RuntimeJob } from "./browserRuntimeState.svelte";

export interface JobResultTarget {
  jobId: string;
  chatId: string;
  expectedChatEpoch: number;
  expectedContentRevision: number;
  retryMessageId?: string;
  retryMessageRevision?: number;
}
export interface JobResultPreview {
  target: JobResultTarget;
  state: string;
  failure?: { code?: string; message?: string; reason?: string } | null;
  complete: boolean;
  canRecover: boolean;
  canRetry: boolean;
  retryTarget: { id: string; data: string; saying?: string } | null;
  retryIntent: {
    type: string;
    input?: string;
    data?: string;
    manualName?: string;
    triggerId?: string;
  } | null;
  retryBlocked: { code: string; message: string } | null;
  disposition: {
    action: string;
    requestId: string;
    resultJobId?: string | null;
  } | null;
  blocked: { code: string; message: string } | null;
  messages: { id: string; role: string; saying?: string; data: string }[];
  providerOutputs?: import("./providerOutputRuntime").ProviderOutput[];
}

export function jobFailureMessage(
  job: Pick<RuntimeJob, "state" | "result">,
): string {
  const result =
    job.result && typeof job.result === "object" && !Array.isArray(job.result)
      ? job.result
      : {};
  const detail =
    typeof result.message === "string"
      ? result.message
      : typeof result.reason === "string"
        ? result.reason
        : "";
  const code =
    typeof result.code === "string"
      ? " [" + result.code.slice(0, 80) + "]"
      : "";
  return (
    "Job " + job.state + code + (detail ? ": " + detail.slice(0, 512) : "")
  );
}
