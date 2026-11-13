import { expect, test } from "vitest";
import {
  RuntimeInteractions,
  type RuntimeInteractionState,
} from "./runtimeInteractions";
const header = {
  id: "i1",
  jobId: "job",
  chatId: "a",
  chatEpoch: 1,
  position: 1,
  kind: "input" as const,
  state: "pending" as const,
  revision: 1,
  createdAt: 1,
  closedReason: null,
};
const descriptor = {
  kind: "input" as const,
  prompt: "Synthetic",
  defaultValue: "one",
  datalist: [],
};
function fixture() {
  let state: RuntimeInteractionState;
  let read: (path: string) => Promise<unknown> = async (path) =>
    path.includes("limit")
      ? { cursor: 5, count: 1, items: [header], next: null }
      : { cursor: 5, interaction: { ...header, descriptor } };
  const paths: string[] = [];
  const queue = new RuntimeInteractions({
    read: (path) => {
      paths.push(path);
      return read(path);
    },
    publish: (value) => {
      state = value;
    },
  });
  return {
    queue,
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
test("global pending headers load only the first descriptor and retain its identity on unrelated refresh", async () => {
  const f = fixture();
  await f.queue.refresh(5);
  const first = f.state().current;
  await f.queue.refresh(5);
  expect(f.state().current).toBe(first);
  expect(f.state().current.descriptor.defaultValue).toBe("one");
  expect(f.paths.filter((path) => !path.includes("limit"))).toEqual([
    "/interactions/i1",
  ]);
});
test("a peer answer or job closure fences a held descriptor; the next prompt cannot inherit the old descriptor", async () => {
  for (const state of ["answered", "closed"]) {
    const f = fixture(),
      body = held();
    f.read(async (path) =>
      path.includes("limit")
        ? { cursor: 5, count: 1, items: [header] }
        : body.promise,
    );
    const reading = f.queue.refresh();
    await Promise.resolve();
    const second = { ...header, id: "i2", position: 2, kind: "confirm" };
    f.read(async (path) =>
      path.includes("limit")
        ? { cursor: 6, count: 1, items: [second] }
        : {
            cursor: 6,
            interaction: {
              ...second,
              descriptor: { kind: "confirm", prompt: "Synthetic next" },
            },
          },
    );
    f.queue.observe({
      sequence: 6,
      type: "interaction",
      id: "i1",
      chatId: null,
      revision: 2,
      payload: { state },
    });
    body.resolve({ cursor: 5, interaction: { ...header, descriptor } });
    await reading;
    expect(f.state().current.id).toBe("i2");
    expect(f.state().current.descriptor.prompt).toBe("Synthetic next");
  }
});
test("closed views reject late pending headers; a fresh bootstrap recovers the stored question after journal pruning", async () => {
  const f = fixture(),
    pending = held();
  f.read(async () => pending.promise);
  const reading = f.queue.refresh(5);
  f.queue.close();
  pending.resolve({ cursor: 5, count: 1, items: [header] });
  await reading;
  expect(f.state().current).toBeNull();
  expect(f.state().loading).toBe(false);
  const reopened = fixture();
  await reopened.queue.refresh(5);
  expect(reopened.state().current.id).toBe("i1");
});
test("a stale failed page remains visible as an error and explicit refresh restores the same waiting execution", async () => {
  const f = fixture();
  f.read(async () => ({ cursor: 3, count: 1, items: [header] }));
  await f.queue.refresh(5);
  expect(f.state().error).toContain("older");
  expect(f.state().current).toBeNull();
  f.read(async (path) =>
    path.includes("limit")
      ? { cursor: 7, count: 1, items: [header] }
      : { cursor: 7, interaction: { ...header, descriptor } },
  );
  await f.queue.refresh();
  expect(f.state().error).toBe("");
  expect(f.state().current.descriptor.prompt).toBe("Synthetic");
});
test("unrelated job/progress/notice events do not re-fetch or replace a typed input descriptor", async () => {
  const f = fixture();
  await f.queue.refresh();
  const count = f.paths.length;
  for (const type of ["job", "job-progress", "notice", "variable"])
    f.queue.observe({
      sequence: 8,
      type,
      id: "other",
      chatId: null,
      revision: 1,
      payload: {},
    });
  expect(f.paths.length).toBe(count);
  expect(f.state().current.descriptor.defaultValue).toBe("one");
});
