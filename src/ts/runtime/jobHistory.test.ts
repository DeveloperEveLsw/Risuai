import { expect, it } from "vitest";
import {
  JobHistory,
  type JobHistoryOwner,
  type JobHistoryPage,
  type JobHistoryState,
} from "./jobHistory";
const page = (id = "a", filter: "all" | "memory" = "all"): JobHistoryPage => ({
  chatId: id,
  chatEpoch: 0,
  filter,
  upper: 100,
  cursor: 20,
  items: [],
  older: "older",
  newer: null,
});
function fixture() {
  let owner: JobHistoryOwner | null = {
    chatId: "a",
    chatEpoch: 0,
    selection: 1,
  };
  let state: JobHistoryState;
  const calls: {
    owner: JobHistoryOwner;
    filter: string;
    after: string | undefined;
    signal: AbortSignal;
    resolve: (page: JobHistoryPage) => void;
    reject: (error: Error) => void;
  }[] = [];
  const history = new JobHistory({
    owner: () => owner,
    publish: (next) => {
      state = next;
    },
    read: (owner, filter, after, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ owner, filter, after, signal, resolve, reject });
      }),
  });
  return {
    history,
    calls,
    get state() {
      return state;
    },
    set owner(value: JobHistoryOwner | null) {
      owner = value;
    },
  };
}
it("a delayed page never attaches after navigation ABA or closing, and requests are aborted", async () => {
  const f = fixture(),
    request = f.history.open();
  f.owner = { chatId: "a", chatEpoch: 0, selection: 3 };
  f.calls[0].resolve(page());
  await request;
  expect(f.state.page).toBeNull();
  expect(f.history.current()).toBe(false);
  const second = f.history.open();
  f.history.close();
  expect(f.calls[1].signal.aborted).toBe(true);
  f.calls[1].resolve(page());
  await second;
  expect(f.state.page).toBeNull();
});
it("refresh replaces one page and rejects a late response from the earlier filter", async () => {
  const f = fixture(),
    old = f.history.open(),
    next = f.history.refresh("memory");
  expect(f.calls[0].signal.aborted).toBe(true);
  f.calls[1].resolve(page("a", "memory"));
  await next;
  f.calls[0].resolve(page());
  await old;
  expect(f.state.page.filter).toBe("memory");
  expect(f.state.loading).toBe(false);
});
it("a failed or wrong-owner read hides earlier actionable rows and remains retryable", async () => {
  const f = fixture(),
    first = f.history.open();
  f.calls[0].resolve(page());
  await first;
  const older = f.history.older();
  expect(f.state.page).toBeNull();
  f.calls[1].reject(Error("offline"));
  await older;
  expect(f.state.error).toBe("offline");
  const retry = f.history.refresh();
  f.calls[2].resolve(page("b"));
  await retry;
  expect(f.state.page).toBeNull();
  expect(f.state.error).toContain("captured view");
});
it("matching page headers cannot authorize foreign rows or a recreated chat", async () => {
  const f = fixture(),
    first = f.history.open();
  f.calls[0].resolve({
    ...page(),
    items: [
      {
        id: "foreign",
        chatId: "b",
        chatEpoch: 0,
      } as JobHistoryPage["items"][number],
    ],
  });
  await first;
  expect(f.state.page).toBeNull();
  expect(f.state.error).toContain("captured view");
  const second = f.history.refresh();
  f.owner = { chatId: "a", chatEpoch: 1, selection: 1 };
  f.calls[1].resolve(page());
  await second;
  expect(f.state.page).toBeNull();
  expect(f.history.current()).toBe(false);
});
