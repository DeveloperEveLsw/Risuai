import { expect, test } from "vitest";
import { get } from "svelte/store";
import type { OutboxEntry } from "./browserOutbox";
import {
  ButtonActivityTracker,
  BUTTON_ERROR_PRESENTATION_LIMIT,
  buttonActivityMessage,
  buttonNodeKey,
  markButtonActivity,
  pendingButtonSummary,
  sameButtonOwner,
} from "./buttonActivity";

const owner = { chatId: "chat-a", epoch: 3, messageId: "message-a" };
function entry(
  requestId: string,
  state: OutboxEntry["state"] = "pending",
): OutboxEntry {
  return {
    requestId,
    kind: "job",
    command: {
      type: "button",
      chatId: owner.chatId,
      expectedChatEpoch: owner.epoch,
      data: "increment",
    },
    payload: "synthetic",
    createdAt: 100,
    state,
  };
}
function job(id: string, state: string) {
  return {
    id,
    chatId: owner.chatId,
    chatEpoch: owner.epoch,
    type: "button",
    state,
  };
}

test("input is acknowledged before IDB resolves and deliberate repeat invocations remain distinct", () => {
  const tracker = new ButtonActivityTracker();
  const first = tracker.begin(owner, "same-button");
  const second = tracker.begin(owner, "same-button");
  expect(first).not.toBe(second);
  expect(get(tracker)).toHaveLength(2);
  expect(buttonActivityMessage(get(tracker))).toContain("기기에 보관 중");
  tracker.admitted(first, "one");
  tracker.admitted(second, "two");
  tracker.reconcile(
    [entry("one", "accepted"), entry("two")],
    [job("one", "running")],
  );
  expect(get(tracker).map((value) => value.phase)).toEqual([
    "running",
    "pending",
  ]);
  tracker.reconcile([entry("two")], [job("one", "completed")]);
  expect(get(tracker).map((value) => value.requestId)).toEqual(["two"]);
});

test("local storage, server acceptance and actual running are distinct acknowledgements", () => {
  const tracker = new ButtonActivityTracker();
  const token = tracker.begin(owner, "button");
  tracker.admitted(token, "one");
  tracker.reconcile([entry("one")], []);
  expect(buttonActivityMessage(get(tracker))).toContain(
    "기기에 보관됨 · 서버 전송 중",
  );
  tracker.reconcile([entry("one", "accepted")], [job("one", "queued")]);
  expect(buttonActivityMessage(get(tracker))).toContain("서버 접수됨");
  tracker.reconcile([entry("one", "accepted")], [job("one", "running")]);
  expect(buttonActivityMessage(get(tracker))).toContain(
    "서버에서 버튼 동작 처리 중",
  );
  // Receipt and terminal projection can both arrive before button() resolves.
  const raced = tracker.begin(owner, "other");
  tracker.admitted(raced, "already-completed");
  tracker.reconcile(
    [entry("one", "accepted")],
    [job("one", "running"), job("already-completed", "completed")],
  );
  expect(get(tracker)).toHaveLength(1);
});

test("a failed action remains visible independently of other clicks and captured owners never migrate", () => {
  const tracker = new ButtonActivityTracker();
  const local = tracker.begin(owner, "local-failure");
  tracker.fail(local, new Error("Synthetic IDB failure"));
  const durable = tracker.begin(owner, "blocked");
  tracker.admitted(durable, "blocked");
  tracker.reconcile(
    [
      {
        ...entry("blocked", "blocked"),
        error: { code: "REVISION_CONFLICT", message: "Synthetic conflict" },
      },
    ],
    [],
  );
  expect(get(tracker).map((value) => value.error)).toEqual([
    "Synthetic IDB failure",
    "Synthetic conflict",
  ]);
  tracker.dismiss(local);
  expect(get(tracker)).toHaveLength(1);
  for (const target of [
    { ...owner, chatId: "chat-b" },
    { ...owner, epoch: 4 },
    { ...owner, messageId: "message-b" },
  ])
    expect(sameButtonOwner(owner, target)).toBe(false);
});

test("only terminal error presentations are bounded while every active invocation survives", () => {
  const tracker = new ButtonActivityTracker();
  const entries = Array.from({ length: 80 }, (_, index) =>
    entry("active-" + index),
  );
  for (const value of entries) {
    const token = tracker.begin(owner, "active-button");
    tracker.admitted(token, value.requestId);
  }
  for (let index = 0; index < BUTTON_ERROR_PRESENTATION_LIMIT + 6; index++) {
    const token = tracker.begin(
      { ...owner, chatId: "departed-chat" },
      "failed-button",
    );
    tracker.fail(token, new Error("Synthetic failure " + index));
  }
  tracker.reconcile(entries, []);
  const records = get(tracker);
  expect(records.filter((record) => record.phase === "error")).toHaveLength(
    BUTTON_ERROR_PRESENTATION_LIMIT,
  );
  expect(
    records
      .filter((record) => record.phase !== "error")
      .map((record) => record.requestId),
  ).toEqual(entries.map((value) => value.requestId));
  expect(records.find((record) => record.phase === "error")?.error).toBe(
    "Synthetic failure 6",
  );
  expect(records.at(-1)?.error).toBe("Synthetic failure 69");
  expect(entries).toHaveLength(80);
});

test("ordinary commands and blocked buttons are visible immediately while quick buttons avoid a global banner", () => {
  const button = entry("one");
  expect(pendingButtonSummary([button], 1599)).toEqual({
    ordinary: 0,
    buttons: 0,
    accepted: 0,
    local: 0,
  });
  const ordinary = {
    ...entry("field"),
    kind: "command" as const,
    command: { type: "change-variables" },
  };
  expect(pendingButtonSummary([button, ordinary], 1599).ordinary).toBe(1);
  expect(
    pendingButtonSummary([button, entry("two", "accepted")], 1600),
  ).toEqual({ ordinary: 0, buttons: 2, accepted: 1, local: 1 });
  expect(pendingButtonSummary([entry("blocked", "blocked")], 101).buttons).toBe(
    1,
  );
});

test("pending marks follow replacement HTML and preserve authored ARIA changes without suppressing clicks", async () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<button risu-btn="increment" aria-checked="false">Add</button><button risu-btn="increment" aria-busy="false">Add again</button>';
  document.body.append(root);
  const first = root.querySelectorAll("button")[0];
  const second = root.querySelectorAll("button")[1];
  const key = buttonNodeKey(root, second);
  const marker = markButtonActivity(root, [key]);
  expect(first.hasAttribute("data-runtime-button-pending")).toBe(false);
  expect(second.getAttribute("aria-busy")).toBe("false");
  expect(second.disabled).toBe(false);
  expect(first.getAttribute("aria-checked")).toBe("false");
  let clicks = 0;
  second.addEventListener("click", () => clicks++);
  second.click();
  second.click();
  expect(clicks).toBe(2);
  root.innerHTML =
    '<button risu-btn="increment" aria-checked="false">Add</button><button risu-btn="increment" aria-busy="false">Replacement</button>';
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = root.querySelectorAll("button")[1];
  expect(replacement.getAttribute("data-runtime-button-pending")).toBe("");
  // A canonical HTML update may change an authored ARIA attribute while the
  // operation is pending. The app never owns or restores that attribute.
  replacement.setAttribute("aria-busy", "true");
  marker.update([key]);
  expect(replacement.getAttribute("aria-busy")).toBe("true");
  marker.update([]);
  expect(replacement.getAttribute("aria-busy")).toBe("true");
  expect(replacement.hasAttribute("data-runtime-button-pending")).toBe(false);
  expect(root.querySelector("button")?.getAttribute("aria-checked")).toBe(
    "false",
  );
  marker.destroy();
  root.remove();
});
