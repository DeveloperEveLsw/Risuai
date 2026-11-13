import { writable } from "svelte/store";
import type { OutboxEntry } from "./browserOutbox";

export interface ButtonOwner {
  chatId: string;
  epoch: number;
  messageId: string;
}
export interface ButtonActivity extends ButtonOwner {
  token: number;
  buttonKey: string;
  requestId?: string;
  phase: "saving" | "pending" | "accepted" | "running" | "error";
  error?: string;
}
interface ButtonJob {
  id: string;
  chatId: string;
  chatEpoch?: number;
  type: string;
  state: string;
}
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const BUTTON_STATUS_DELAY_MS = 1500;
export const BUTTON_ERROR_PRESENTATION_LIMIT = 64;

export function sameButtonOwner(a: ButtonOwner, b: ButtonOwner) {
  return (
    a.chatId === b.chatId && a.epoch === b.epoch && a.messageId === b.messageId
  );
}

/** Presentation only. Every invocation still has its own durable outbox identity. */
export class ButtonActivityTracker {
  private records: ButtonActivity[] = [];
  private next = 0;
  private state = writable<readonly ButtonActivity[]>([]);
  readonly subscribe = this.state.subscribe;
  private publish() {
    // Only transient error presentations are bounded. Never evict a saving or
    // durable invocation, and never mutate its authoritative outbox/history.
    const errors = this.records.filter((record) => record.phase === "error");
    if (errors.length > BUTTON_ERROR_PRESENTATION_LIMIT) {
      const retained = new Set(
        errors
          .slice(-BUTTON_ERROR_PRESENTATION_LIMIT)
          .map((record) => record.token),
      );
      this.records = this.records.filter(
        (record) => record.phase !== "error" || retained.has(record.token),
      );
    }
    this.state.set([...this.records]);
  }
  begin(owner: ButtonOwner, buttonKey: string) {
    const token = ++this.next;
    this.records.push({ ...owner, buttonKey, token, phase: "saving" });
    this.publish();
    return token;
  }
  admitted(token: number, requestId: string) {
    const record = this.records.find((value) => value.token === token);
    if (!record) return;
    record.requestId = requestId;
    record.phase = "pending";
    this.publish();
  }
  fail(token: number, error: unknown) {
    const record = this.records.find((value) => value.token === token);
    if (!record) return;
    record.phase = "error";
    record.error = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 512);
    this.publish();
  }
  dismiss(token: number) {
    const old = this.records.length;
    this.records = this.records.filter(
      (value) => value.token !== token || value.phase !== "error",
    );
    if (this.records.length !== old) this.publish();
  }
  reconcile(entries: readonly OutboxEntry[], jobs: readonly ButtonJob[]) {
    let changed = false;
    const next: ButtonActivity[] = [];
    for (const record of this.records) {
      if (!record.requestId || record.phase === "error") {
        next.push(record);
        continue;
      }
      const entry = entries.find(
        (value) =>
          value.requestId === record.requestId &&
          value.command.type === "button" &&
          value.command.chatId === record.chatId &&
          value.command.expectedChatEpoch === record.epoch,
      );
      const job = jobs.find(
        (value) =>
          value.id === record.requestId &&
          value.type === "button" &&
          value.chatId === record.chatId &&
          (value.chatEpoch ?? 0) === record.epoch,
      );
      let phase: ButtonActivity["phase"];
      let error: string | undefined;
      if (entry?.state === "blocked") {
        phase = "error";
        error = entry.error?.message ?? "버튼 동작이 거절되었습니다";
      } else if (job && terminal.has(job.state)) {
        if (job.state === "completed") {
          changed = true;
          continue;
        }
        phase = "error";
        error = "버튼 동작이 완료되지 않았습니다. 작업 기록을 확인해 주세요.";
      } else if (job?.state === "running") phase = "running";
      else if (entry)
        phase = entry.state === "accepted" ? "accepted" : "pending";
      else if (job) phase = "accepted";
      else {
        // button() returns only after the durable enqueue and onPending publication.
        // An absent request has already completed projection or been explicitly removed.
        changed = true;
        continue;
      }
      if (phase !== record.phase || error !== record.error) {
        changed = true;
        next.push({ ...record, phase, error });
      } else next.push(record);
    }
    this.records = next;
    if (changed) this.publish();
  }
}
export const buttonActivities = new ButtonActivityTracker();

export function buttonActivityMessage(activities: readonly ButtonActivity[]) {
  const active = activities.filter((value) => value.phase !== "error");
  if (!active.length) return "";
  const latest = active.at(-1)!;
  const message =
    latest.phase === "saving"
      ? "입력 접수 · 기기에 보관 중…"
      : latest.phase === "pending"
        ? "기기에 보관됨 · 서버 전송 중…"
        : latest.phase === "running"
          ? "서버에서 버튼 동작 처리 중…"
          : "서버 접수됨 · 처리 대기 중…";
  return active.length > 1
    ? `버튼 동작 ${active.length}개 · ${message}`
    : message;
}

export function pendingButtonSummary(
  entries: readonly OutboxEntry[],
  now: number,
) {
  const ordinary = entries.filter((entry) => entry.command.type !== "button");
  const buttons = entries.filter((entry) => entry.command.type === "button");
  const delayed = buttons.some(
    (entry) =>
      entry.state === "blocked" ||
      now - entry.createdAt >= BUTTON_STATUS_DELAY_MS,
  );
  return {
    ordinary: ordinary.length,
    buttons: delayed ? buttons.length : 0,
    accepted: delayed
      ? buttons.filter((entry) => entry.state === "accepted").length
      : 0,
    local: delayed
      ? buttons.filter((entry) => entry.state === "pending").length
      : 0,
  };
}

const selector = "[risu-trigger], [risu-btn]";
function commandIdentity(node: Element) {
  return JSON.stringify([
    node.getAttribute("risu-trigger"),
    node.getAttribute("risu-id"),
    node.getAttribute("risu-btn"),
  ]);
}
/** Duplicate controls in one message stay distinct even when HTML nodes are replaced. */
export function buttonNodeKey(root: Element, node: Element) {
  const command = commandIdentity(node);
  const peers = [...root.querySelectorAll(selector)].filter(
    (value) => commandIdentity(value) === command,
  );
  return JSON.stringify([command, peers.indexOf(node)]);
}

/** Mark only app-owned presentation metadata. Authored ARIA/value attributes stay untouched. */
export function markButtonActivity(root: HTMLElement, keys: readonly string[]) {
  const active = new Set(keys);
  const marked = new Set<Element>();
  const restore = (node: Element) => {
    marked.delete(node);
    node.removeAttribute("data-runtime-button-pending");
  };
  const refresh = () => {
    for (const node of marked) if (!root.contains(node)) restore(node);
    if (!active.size && !marked.size) return;
    const occurrences = new Map<string, number>();
    for (const node of root.querySelectorAll(selector)) {
      const command = commandIdentity(node);
      const occurrence = occurrences.get(command) ?? 0;
      occurrences.set(command, occurrence + 1);
      if (active.has(JSON.stringify([command, occurrence]))) {
        marked.add(node);
        node.setAttribute("data-runtime-button-pending", "");
      } else if (marked.has(node)) restore(node);
    }
  };
  refresh();
  const observer = new MutationObserver(refresh);
  const observe = () => {
    observer.disconnect();
    if (active.size) observer.observe(root, { childList: true, subtree: true });
  };
  observe();
  return {
    update(next: readonly string[]) {
      active.clear();
      next.forEach((key) => active.add(key));
      refresh();
      observe();
    },
    destroy() {
      observer.disconnect();
      for (const node of [...marked]) restore(node);
    },
  };
}
