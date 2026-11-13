// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { DisplayDigestCache } from "./displayDigestCache";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
test("replacing the browser digest adapter cannot inherit old successes or mask a new error", async () => {
  const cache = new DisplayDigestCache();
  try {
    expect(await cache.hash("Synthetic")).toBe(sha("Synthetic"));
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(Error("New digest adapter"));
    try {
      await expect(cache.hash("Synthetic")).rejects.toThrow(
        "New digest adapter",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await cache.hash("Synthetic")).toBe(sha("Synthetic"));
  } finally {
    cache.close();
  }
});

test("exact Unicode and JSON-like inputs share only the same digest, including concurrent requests", async () => {
  const digest = vi.fn(async (value: string) => sha(value));
  const cache = new DisplayDigestCache(4096, 16, digest);
  try {
    const first = cache.hash("합성😀\u0000"),
      same = cache.hash("합성😀\u0000");
    expect(same).toBe(first);
    expect(await first).toBe(sha("합성😀\u0000"));
    for (const value of [
      '["x"]',
      '"[x]"',
      "합성😃\u0000",
      "합성😀",
      "\ud800",
      "\ufffd",
    ])
      expect(await cache.hash(value)).toBe(sha(value));
    expect(await cache.hash("합성😀\u0000")).toBe(await first);
    expect(digest).toHaveBeenCalledTimes(7);
  } finally {
    cache.close();
  }
});

test("LRU and UTF-16 budgets bound pending input retention while oversized inputs remain uncached", async () => {
  const digest = vi.fn(async (value: string) => sha(value));
  const cache = new DisplayDigestCache(260, 2, digest);
  try {
    await cache.hash("a");
    await cache.hash("b");
    await cache.hash("a");
    await cache.hash("c");
    expect(cache.diagnostics()).toMatchObject({
      entries: 2,
      bytes: 260,
      evictions: 1,
    });
    await cache.hash("a");
    const prior = digest.mock.calls.length;
    await cache.hash("b");
    expect(digest.mock.calls.length).toBe(prior + 1);
    const budget = cache.diagnostics();
    await cache.hash("large".repeat(100));
    await cache.hash("large".repeat(100));
    expect(cache.diagnostics()).toMatchObject({
      entries: budget.entries,
      bytes: budget.bytes,
      evictions: budget.evictions,
    });
    const emoji = new DisplayDigestCache(131, 1, digest);
    try {
      await emoji.hash("😀");
      await emoji.hash("😀");
      expect(emoji.diagnostics().entries).toBe(0);
    } finally {
      emoji.close();
    }
  } finally {
    cache.close();
  }
});

test("failed digests can retry and a late evicted failure cannot delete a newer same-input entry", async () => {
  const pending: {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  const digest = vi.fn(
    () =>
      new Promise<string>((resolve, reject) =>
        pending.push({ resolve, reject }),
      ),
  );
  const cache = new DisplayDigestCache(4096, 1, digest);
  try {
    const first = cache.hash("a");
    const failed = expect(first).rejects.toThrow("Synthetic failure");
    const middle = cache.hash("b");
    pending[1].resolve(sha("b"));
    await middle;
    const newer = cache.hash("a");
    pending[0].reject(Error("Synthetic failure"));
    await failed;
    expect(cache.hash("a")).toBe(newer);
    pending[2].resolve(sha("a"));
    expect(await newer).toBe(sha("a"));
    const second = cache.hash("c");
    const secondFailed = expect(second).rejects.toThrow("Retry");
    pending[3].reject(Error("Retry"));
    await secondFailed;
    const retry = cache.hash("c");
    pending[4].resolve(sha("c"));
    expect(await retry).toBe(sha("c"));
    expect(digest).toHaveBeenCalledTimes(5);
  } finally {
    cache.close();
  }
});

test("closing an owner frees retained inputs and pending success cannot repopulate it or another owner", async () => {
  let finish: (s: string) => void;
  const cache = new DisplayDigestCache(
    4096,
    2,
    () => new Promise((resolve) => (finish = resolve)),
  );
  const pending = cache.hash("pending");
  cache.close();
  finish(sha("pending"));
  await pending;
  expect(cache.diagnostics()).toMatchObject({ entries: 0, bytes: 0 });
  await expect(cache.hash("pending")).rejects.toThrow("owner closed");
  const digest = vi.fn(async (value: string) => sha(value)),
    other = new DisplayDigestCache(4096, 2, digest);
  try {
    expect(await other.hash("pending")).toBe(sha("pending"));
    expect(digest).toHaveBeenCalledOnce();
  } finally {
    other.close();
  }
  expect(() => new DisplayDigestCache(-1)).toThrow("budget");
  expect(() => new DisplayDigestCache(4096, 1.5)).toThrow("budget");
});
