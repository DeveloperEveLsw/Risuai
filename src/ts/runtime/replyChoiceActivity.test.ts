import { expect, test } from "vitest";
import {
  replyChoiceActivity,
  type ReplyChoicePreparation,
} from "./replyChoiceActivity";
import type { OutboxEntry } from "./browserOutbox";
const owner = { chatId: "a", epoch: 2 };
const draft: ReplyChoicePreparation = {
  ...owner,
  messageId: "m1",
  requestId: "r1",
  direction: "next",
  stage: "preparing",
};
function entry(state: OutboxEntry["state"] = "pending"): OutboxEntry {
  return {
    requestId: "r1",
    kind: "command",
    command: {
      type: "move-reply-choice",
      chatId: "a",
      messageId: "m1",
      expectedChatEpoch: 2,
      direction: "next",
    },
    payload: "synthetic",
    state,
    createdAt: 1,
  };
}
test("captured preparation is immediately busy, follows its own chat and never migrates to a recreated owner", () => {
  expect(replyChoiceActivity(owner, draft, undefined, [], [])).toMatchObject({
    phase: "preparing",
    busy: true,
    requestId: "r1",
  });
  for (const target of [
    null,
    { chatId: "b", epoch: 2 },
    { chatId: "a", epoch: 3 },
  ])
    expect(replyChoiceActivity(target, draft, undefined, [], [])).toBeNull();
  expect(
    replyChoiceActivity(owner, { ...draft, stage: "saving" }, undefined, [], [])
      .phase,
  ).toBe("saving");
});
test("durable pending and accepted requests remain busy after the local draft or visible old reply disappears", () => {
  const pending = entry();
  expect(
    replyChoiceActivity(owner, undefined, undefined, [pending], []),
  ).toMatchObject({ phase: "pending", busy: true, direction: "next" });
  const accepted = {
    ...pending,
    state: "accepted" as const,
    receipt: { cursor: 10, kind: "selected" },
  };
  expect(
    replyChoiceActivity(owner, undefined, undefined, [accepted], []),
  ).toMatchObject({ phase: "accepted", busy: true });
  expect(replyChoiceActivity(owner, undefined, undefined, [], [])).toBeNull();
});
test("a blocked peer selection stays actionable until explicit discard, independently of an earlier local failure", () => {
  const blocked = {
    ...entry("blocked"),
    error: { code: "REVISION_CONFLICT", message: "Synthetic changed source" },
  };
  const failed = { ...draft, error: "Synthetic local failure" };
  expect(
    replyChoiceActivity(owner, undefined, failed, [blocked], []),
  ).toMatchObject({
    phase: "blocked",
    busy: true,
    requestId: "r1",
    message: "선택 변경 실패: Synthetic changed source",
  });
  expect(replyChoiceActivity(owner, undefined, undefined, [], [])).toBeNull();
});
test("a header failure allows a fresh attempt while its captured error cannot label another incarnation", () => {
  const failed = { ...draft, error: "Synthetic network failure" };
  expect(replyChoiceActivity(owner, undefined, failed, [], [])).toMatchObject({
    phase: "error",
    busy: false,
  });
  expect(
    replyChoiceActivity({ ...owner, epoch: 3 }, undefined, failed, [], []),
  ).toBeNull();
  expect(replyChoiceActivity(owner, draft, failed, [], []).phase).toBe(
    "preparing",
  );
});
test("native jobs keep choices unavailable through fallback generation and button execution but leave another chat usable", () => {
  for (const type of ["reroll", "send", "button"]) {
    const job = {
      id: "job",
      chatId: "a",
      chatEpoch: 2,
      type,
      state: "running",
    };
    expect(
      replyChoiceActivity(owner, undefined, undefined, [entry()], [job]),
    ).toMatchObject({
      phase: type === "button" ? "job" : "generation",
      busy: true,
    });
    expect(
      replyChoiceActivity(
        { chatId: "b", epoch: 2 },
        undefined,
        undefined,
        [entry()],
        [job],
      ),
    ).toBeNull();
    expect(
      replyChoiceActivity(
        { ...owner, epoch: 3 },
        undefined,
        undefined,
        [entry()],
        [job],
      ),
    ).toBeNull();
    for (const state of ["completed", "failed", "cancelled", "interrupted"])
      expect(
        replyChoiceActivity(
          owner,
          undefined,
          undefined,
          [],
          [{ ...job, state }],
        ),
      ).toBeNull();
  }
});
test("unrelated rejected settings or another chat's durable selection do not impersonate a choice on this owner", () => {
  const unrelated = {
    ...entry("blocked"),
    command: { type: "change-fields", chatId: "a" },
  };
  expect(
    replyChoiceActivity(owner, undefined, undefined, [unrelated], []),
  ).toBeNull();
  expect(
    replyChoiceActivity(
      owner,
      undefined,
      undefined,
      [{ ...entry(), command: { ...entry().command, chatId: "b" } }],
      [],
    ),
  ).toBeNull();
});
