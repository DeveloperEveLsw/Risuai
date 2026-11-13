import type { OutboxEntry } from "./browserOutbox";

export interface ReplyChoicePreparation {
  chatId: string;
  epoch: number;
  messageId: string;
  requestId: string;
  direction: "previous" | "next";
  stage: "preparing" | "saving";
}
export interface ReplyChoiceActivity {
  chatId: string;
  epoch: number;
  requestId: string | null;
  direction: "previous" | "next" | null;
  phase:
    | "preparing"
    | "saving"
    | "pending"
    | "accepted"
    | "generation"
    | "job"
    | "blocked"
    | "error";
  busy: boolean;
  message: string;
}

/** One captured selection per chat incarnation; receipt loss never looks idle. No speculative selection queue. */
export function replyChoiceActivity(
  owner: { chatId: string; epoch: number } | null,
  preparation: ReplyChoicePreparation | undefined,
  failure: (ReplyChoicePreparation & { error: string }) | undefined,
  entries: readonly OutboxEntry[],
  jobs: readonly {
    id: string;
    chatId: string;
    chatEpoch?: number;
    type: string;
    state: string;
  }[],
): ReplyChoiceActivity | null {
  if (!owner) return null;
  const matches = (value: { chatId: string; epoch: number } | undefined) =>
    value?.chatId === owner.chatId && value.epoch === owner.epoch;
  const entry = entries.find(
    (value) =>
      value.command.type === "move-reply-choice" &&
      value.command.chatId === owner.chatId &&
      value.command.expectedChatEpoch === owner.epoch,
  );
  const active = jobs.find(
    (value) =>
      value.chatId === owner.chatId &&
      (value.chatEpoch ?? 0) === owner.epoch &&
      !["completed", "failed", "cancelled", "interrupted"].includes(
        value.state,
      ),
  );
  const draft = matches(preparation) ? preparation : undefined;
  const direction = entry
    ? (entry.command.direction as "previous" | "next")
    : (draft?.direction ?? null);
  const value = {
    ...owner,
    requestId: entry?.requestId ?? draft?.requestId ?? null,
    direction,
  };
  if (entry?.state === "blocked")
    return {
      ...value,
      phase: "blocked",
      busy: true,
      message:
        "선택 변경 실패: " + (entry.error?.message ?? "요청이 거절되었습니다"),
    };
  if (active)
    return {
      ...value,
      phase: active.type === "button" ? "job" : "generation",
      busy: true,
      message:
        active.type === "button"
          ? "대화 동작 처리 중…"
          : active.state === "queued"
            ? "응답 생성 대기 중…"
            : "응답 생성 중…",
    };
  if (entry)
    return {
      ...value,
      phase: entry.state,
      busy: true,
      message:
        entry.state === "accepted"
          ? "선택 변경 반영 중…"
          : "선택 변경 전송 중…",
    };
  if (draft)
    return {
      ...value,
      phase: draft.stage,
      busy: true,
      message:
        draft.stage === "preparing"
          ? "응답 선택 확인 중…"
          : "선택 요청 저장 중…",
    };
  if (matches(failure))
    return {
      ...value,
      requestId: failure.requestId,
      direction: failure.direction,
      phase: "error",
      busy: false,
      message: "선택 확인 실패: " + failure.error,
    };
  return null;
}
