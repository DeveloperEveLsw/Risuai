import { expect, test } from "vitest";
import {
  DisplayRenderCache,
  DisplayRenderCachePool,
  displayRenderCacheDiagnostics,
} from "./displayRenderCache";

test("mounted owners use the shared pool and closing restores its retention", () => {
  const before = displayRenderCacheDiagnostics();
  const owner = new DisplayRenderCache();
  const ticket = owner.remember("Synthetic", "quotes", "<p>Synthetic</p>");
  expect(owner.lookup("Synthetic", "quotes")).toBe(ticket);
  expect(displayRenderCacheDiagnostics().owners).toBe(before.owners + 1);
  owner.close();
  owner.close();
  expect(displayRenderCacheDiagnostics().owners).toBe(before.owners);
  expect(displayRenderCacheDiagnostics().retainedBytes).toBe(
    before.retainedBytes,
  );
});

test("render reuse needs the exact input/policy and sanitizer input/policy; it does not cross owners", () => {
  const pool = new DisplayRenderCachePool(),
    a = new DisplayRenderCache(pool),
    b = new DisplayRenderCache(pool);
  const ticket = a.remember("Synthetic", "quotes", "<p>Synthetic</p>");
  expect(a.lookup("Synthetic", "quotes")).toBe(ticket);
  expect(a.lookup("Synthetic changed", "quotes")).toBeUndefined();
  expect(a.lookup("Synthetic", "changed-quotes")).toBeUndefined();
  expect(b.lookup("Synthetic", "quotes")).toBeUndefined();
  a.rememberSanitized(
    ticket,
    ticket.rendered,
    "images-visible",
    "<p>Synthetic</p>",
  );
  expect(a.sanitized(ticket, ticket.rendered, "images-visible")).toBe(
    "<p>Synthetic</p>",
  );
  expect(
    a.sanitized(ticket, ticket.rendered + " watermark", "images-visible"),
  ).toBeUndefined();
  expect(a.sanitized(ticket, ticket.rendered, "images-hidden")).toBeUndefined();
  expect(Object.isFrozen(ticket)).toBe(true);
  a.close();
  b.close();
  expect(pool.diagnostics().owners).toBe(0);
});

test("CSS markers cannot reuse sanitized output even though pure Markdown can be reused", () => {
  const pool = new DisplayRenderCachePool(),
    owner = new DisplayRenderCache(pool);
  for (const input of [
    "<risu-style>00</risu-style>",
    "<RISU-STYLE>00</RISU-STYLE>",
    '<div title="<risu-style>">Synthetic</div>',
  ]) {
    const ticket = owner.remember(input, "quotes", input);
    owner.rememberSanitized(
      ticket,
      input,
      "images-visible",
      "Synthetic stale CSS",
    );
    expect(owner.lookup(input, "quotes")).toBe(ticket);
    expect(owner.sanitized(ticket, input, "images-visible")).toBeUndefined();
  }
  expect(pool.diagnostics().cssBypasses).toBe(3);
  owner.close();
});

test("per-owner, total UTF16 retention and owner-count budgets evict strings; oversized results retain no fallback entry", () => {
  const pool = new DisplayRenderCachePool(80, 2, 60),
    a = new DisplayRenderCache(pool),
    b = new DisplayRenderCache(pool),
    c = new DisplayRenderCache(pool);
  a.remember("가나다", "k", "<p>a</p>");
  b.remember("b", "k", "<p>b</p>");
  expect(a.lookup("가나다", "k")).toBeDefined();
  c.remember("c", "k", "<p>c</p>");
  expect(b.lookup("b", "k")).toBeUndefined();
  expect(pool.diagnostics().owners).toBe(2);
  expect(pool.diagnostics().retainedBytes).toBeLessThanOrEqual(80);
  expect(a.remember("x".repeat(31), "k", "x")).toBeUndefined();
  expect(a.lookup("가나다", "k")).toBeUndefined();
  const ticket = c.lookup("c", "k");
  c.rememberSanitized(ticket, ticket.rendered, "images", "한".repeat(30));
  expect(pool.diagnostics().owners).toBe(0);
  a.close();
  b.close();
  c.close();
});

test("retired tickets cannot replace a newer render and owner close fences late completions", () => {
  const pool = new DisplayRenderCachePool(),
    owner = new DisplayRenderCache(pool);
  const old = owner.remember("old", "quotes", "Old"),
    current = owner.remember("new", "quotes", "New");
  owner.rememberSanitized(old, "Old", "images", "Stale");
  expect(owner.lookup("new", "quotes")).toBe(current);
  expect(owner.sanitized(current, "New", "images")).toBeUndefined();
  owner.close();
  owner.rememberSanitized(current, "New", "images", "Late");
  expect(owner.remember("newer", "quotes", "Later")).toBeUndefined();
  expect(pool.diagnostics().retainedBytes).toBe(0);
});
