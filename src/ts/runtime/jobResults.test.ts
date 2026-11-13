import { describe, expect, it } from "vitest";
import { jobFailureMessage, type JobResultPreview } from "./jobResults";

describe("concise job failure presentation", () => {
  it("never serializes stored execution or arbitrary nested values", () => {
    const result = {
      code: "SAVE_FAILED",
      message: "Save unavailable",
      uncommitted: { settings: "synthetic-secret", reply: "private reply" },
    };
    expect(jobFailureMessage({ state: "failed", result })).toBe(
      "Job failed [SAVE_FAILED]: Save unavailable",
    );
    expect(
      jobFailureMessage({
        state: "interrupted",
        result: { reason: "Worker stopped" },
      }),
    ).toBe("Job interrupted: Worker stopped");
    expect(jobFailureMessage({ state: "failed", result: ["unrelated"] })).toBe(
      "Job failed",
    );
  });
  it("bounds the display even for a large provider error", () => {
    expect(
      jobFailureMessage({
        state: "failed",
        result: { code: "c".repeat(10000), message: "m".repeat(10000) },
      }).length,
    ).toBeLessThan(620);
  });
  it("formats the preview failure independently of an unrelated recovery limitation", () => {
    const preview: Pick<JobResultPreview, "state" | "failure" | "blocked"> = {
      state: "failed",
      failure: {
        code: "ENGINE_ERROR",
        message:
          "<script>synthetic()</script> A complete server plugin host is required for native generation",
      },
      blocked: {
        code: "RESULT_NOT_RECOVERABLE",
        message: "No complete guarded transaction",
      },
    };
    const message = jobFailureMessage({
      state: preview.state,
      result: preview.failure,
    });
    expect(message).toBe(
      "Job failed [ENGINE_ERROR]: <script>synthetic()</script> A complete server plugin host is required for native generation",
    );
    expect(message).not.toContain(preview.blocked?.code);
    expect(
      jobFailureMessage({
        state: "interrupted",
        result: { reason: "Original worker interruption" },
      }),
    ).toBe("Job interrupted: Original worker interruption");
  });
});
