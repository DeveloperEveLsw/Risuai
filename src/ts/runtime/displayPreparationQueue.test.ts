import { expect, test } from "vitest";
import { DisplayPreparationQueue } from "./displayPreparationQueue";

test("a slow row retains only its newest successor across 400 updates", async () => {
  const queue = new DisplayPreparationQueue();
  const active = await queue.enter();
  const pending = Array.from({ length: 400 }, () => queue.enter());
  expect(await Promise.all(pending.slice(0, -1))).toEqual(
    Array(399).fill(undefined),
  );
  let granted = false;
  void pending[399].then(() => (granted = true));
  await Promise.resolve();
  expect(granted).toBe(false);
  active();
  const latest = await pending[399];
  expect(latest).toBeTypeOf("function");
  const next = queue.enter();
  let nextGranted = false;
  void next.then(() => (nextGranted = true));
  active(); // A stale completion cannot release the new active preparation.
  await Promise.resolve();
  expect(nextGranted).toBe(false);
  latest();
  (await next)();
  queue.close();
});

test("closing a row retires its successor and permits the active finally to finish", async () => {
  const queue = new DisplayPreparationQueue();
  const active = await queue.enter();
  const pending = queue.enter();
  queue.close();
  expect(await pending).toBeUndefined();
  expect(await queue.enter()).toBeUndefined();
  active();
  active();
});

test("independent rows do not wait for each other", async () => {
  const a = new DisplayPreparationQueue(),
    b = new DisplayPreparationQueue();
  const releaseA = await a.enter();
  const pendingA = a.enter();
  const releaseB = await b.enter();
  releaseB();
  expect(await b.enter()).toBeTypeOf("function");
  a.close();
  expect(await pendingA).toBeUndefined();
  releaseA();
  b.close();
});
