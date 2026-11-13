import { expect, test } from "vitest";
import { RuntimeNotices, type RuntimeNoticeState } from "./runtimeNotices";
const header = {
  id: "n1",
  jobId: "j1",
  chatId: "a",
  chatEpoch: 1,
  position: 1,
  revision: 1,
  unread: true,
  createdAt: 1,
};
function fixture() {
  let state: RuntimeNoticeState;
  let read: (path: string) => Promise<unknown> = async (path) =>
    path.includes("limit")
      ? { cursor: 5, count: 1, items: [header], next: null }
      : { cursor: 5, notice: { ...header, message: "synthetic" } };
  const paths: string[] = [];
  const notices = new RuntimeNotices({
    read: (path) => {
      paths.push(path);
      return read(path);
    },
    publish: (value) => {
      state = value;
    },
  });
  return {
    notices,
    paths,
    state: () => state,
    read: (value: typeof read) => {
      read = value;
    },
  };
}
function held<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}
test("unread headers are bounded, only the first body loads and unchanged head reuses its text", async () => {
  const f = fixture();
  await f.notices.refresh(5);
  await f.notices.refresh(5);
  expect(f.state().current.message).toBe("synthetic");
  expect(f.paths.filter((path) => !path.includes("limit"))).toEqual([
    "/notices/n1",
  ]);
  expect(f.state().loading).toBe(false);
});
test("peer acknowledgement while a body is held retires it and cannot redisplay the old alert", async () => {
  const f = fixture(),
    body = held();
  f.read(async (path) =>
    path.includes("limit")
      ? { cursor: 5, count: 1, items: [header] }
      : body.promise,
  );
  const reading = f.notices.refresh();
  await Promise.resolve();
  f.read(async () => ({ cursor: 6, count: 0, items: [] }));
  f.notices.observe({
    sequence: 6,
    type: "notice",
    id: "n1",
    chatId: null,
    revision: 2,
    payload: { unread: false },
  });
  body.resolve({ cursor: 5, notice: { ...header, message: "stale" } });
  await reading;
  expect(f.state().current).toBeNull();
  expect(f.state().count).toBe(0);
});
test("closed owners reject held responses and a pruned-journal bootstrap reloads the durable queue", async () => {
  const f = fixture(),
    pending = held();
  f.read(async () => pending.promise);
  const reading = f.notices.refresh(5);
  f.notices.close();
  pending.resolve({ cursor: 5, count: 1, items: [header] });
  await reading;
  expect(f.state().current).toBeNull();
  expect(f.state().loading).toBe(false);
  const reopened = fixture();
  await reopened.notices.refresh(5);
  expect(reopened.state().current.id).toBe("n1");
});
test("failed/stale reads remain visible and an explicit refresh recovers without changing generation data", async () => {
  const f = fixture();
  f.read(async () => ({ cursor: 3, count: 1, items: [header] }));
  await f.notices.refresh(5);
  expect(f.state().error).toContain("older");
  expect(f.state().current).toBeNull();
  f.read(async (path) =>
    path.includes("limit")
      ? { cursor: 7, count: 1, items: [header] }
      : { cursor: 7, notice: { ...header, message: "recovered" } },
  );
  await f.notices.refresh();
  expect(f.state().current.message).toBe("recovered");
  expect(f.state().error).toBe("");
});
