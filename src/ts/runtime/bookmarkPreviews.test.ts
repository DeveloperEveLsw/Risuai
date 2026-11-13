import { expect, test } from "vitest";
import {
  BookmarkPreviews,
  type BookmarkPreviewPage,
  type BookmarkPreviewState,
} from "./bookmarkPreviews";
import type { RuntimeChange } from "./clientProtocol";

const page = (cursor = 5): BookmarkPreviewPage => ({
  chatId: "a",
  entityEpoch: 2,
  cursor,
  collectionRevision: 3,
  contentRevision: 7,
  count: 110,
  historyCount: 220,
  items: [
    {
      messageId: "m10",
      messageRevision: 1,
      bookmarkRevision: 2,
      position: 12,
      ordinal: 10,
      nameExists: true,
      name: "Synthetic",
      message: { chatId: "m10", role: "char", data: "Synthetic source" },
    },
  ],
  next: "synthetic-token",
});
const change = (sequence: number, type = "message"): RuntimeChange => ({
  sequence,
  type,
  id: "m10",
  chatId: "a",
  revision: 2,
  payload: {},
});
function fixture() {
  let owner = { chatId: "a", characterId: "c", epoch: 2, selection: 1 },
    cursor = 5;
  let state: BookmarkPreviewState;
  const requests: string[] = [];
  let read = async () => page();
  const previews = new BookmarkPreviews({
    owner: () => owner,
    projectedCursor: () => cursor,
    read: (path) => {
      requests.push(path);
      return read();
    },
    publish: (value) => {
      state = value;
    },
  });
  return {
    previews,
    requests,
    state: () => state,
    read: (value: typeof read) => {
      read = value;
    },
    cursor: (value: number) => {
      cursor = value;
    },
    owner: (value: typeof owner) => {
      owner = value;
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
test("a bookmark body read ahead of journal projection cannot be tagged with the current display clock", async () => {
  const f = fixture(),
    session = f.previews.open();
  f.read(async () => page(9));
  await f.previews.load(session);
  expect(f.state().items).toEqual([]);
  expect(f.state().loading).toBe(true);
  expect(f.previews.item("m10")).toBeUndefined();
  expect(f.previews.observe(change(8))).toBe(false);
  f.cursor(8);
  f.previews.projected();
  expect(f.previews.current()).toBeUndefined();
  f.cursor(9);
  f.previews.projected();
  expect(f.previews.item("m10").message.data).toBe("Synthetic source");
  expect(f.state().ready).toBe(true);
});
test("close/reopen and selection/epoch replacement retire held bodies without publishing into a new list", async () => {
  const f = fixture(),
    old = f.previews.open(),
    pending = held<BookmarkPreviewPage>();
  f.read(() => pending.promise);
  const reading = f.previews.load(old);
  f.previews.close(old);
  const current = f.previews.open();
  f.previews.close(old);
  expect(f.state().session).toBe(current);
  pending.resolve(page());
  await reading;
  expect(f.previews.current()).toBeUndefined();
  f.read(async () => page());
  await f.previews.load(current);
  f.owner({ chatId: "a", characterId: "c", epoch: 3, selection: 2 });
  f.previews.projected();
  expect(f.state().session).toBe("");
  expect(f.state().items).toEqual([]);
});
test("newer page navigation retires the old HTML owner and supersedes an older delayed response", async () => {
  const f = fixture(),
    session = f.previews.open();
  await f.previews.load(session);
  const token = f.state().presentationToken,
    pending = held<BookmarkPreviewPage>();
  f.read(() => pending.promise);
  const oldRead = f.previews.load(session, "old-next");
  expect(f.previews.presentation(token)).toBeUndefined();
  f.read(async () => ({ ...page(), items: [] }));
  await f.previews.load(session);
  pending.resolve(page());
  await oldRead;
  expect(f.state().items).toEqual([]);
  expect(f.state().first).toBe(true);
});
test("body/ordinal/member changes retire a page before projection, while variables and other conversations retain it", async () => {
  const f = fixture(),
    session = f.previews.open();
  await f.previews.load(session);
  const token = f.state().presentationToken;
  expect(f.previews.observe(change(6, "variable"))).toBe(false);
  expect(f.previews.observe({ ...change(6), chatId: "b" })).toBe(false);
  expect(f.previews.presentation(token)).toBeDefined();
  expect(f.previews.observe(change(6, "messages-removed"))).toBe(true);
  expect(f.previews.presentation(token)).toBeUndefined();
  expect(f.state().items).toEqual([]);
  f.cursor(6);
  f.read(async () => page(6));
  await f.previews.load(session);
  expect(f.previews.current().cursor).toBe(6);
  expect(f.previews.observe(change(7, "reply-batch"))).toBe(true);
  expect(f.previews.current()).toBeUndefined();
  f.cursor(7);
  f.read(async () => page(7));
  await f.previews.load(session);
  expect(
    f.previews.observe({
      ...change(8, "fields"),
      payload: {
        fields: [{ scope: "chat", entityId: "a", key: "bookmarkNames" }],
      },
    }),
  ).toBe(true);
  expect(f.previews.current()).toBeUndefined();
});
test("a stale page token restarts a bounded first page and never appends old bodies", async () => {
  const f = fixture(),
    session = f.previews.open();
  let attempts = 0;
  f.read(async () => {
    if (!attempts++)
      throw Object.assign(Error("Synthetic page changed"), {
        code: "PAGE_CHANGED",
      });
    return page();
  });
  await f.previews.load(session, "stale");
  expect(f.requests).toEqual([
    "/chats/a/bookmarks?limit=100&after=stale",
    "/chats/a/bookmarks?limit=100",
  ]);
  expect(f.state().first).toBe(true);
  expect(f.state().items.length).toBe(1);
});
test("invalid owner, oversized body sets and duplicate/foreign stable IDs reject without an admitted preview", async () => {
  for (const invalid of [
    { ...page(), entityEpoch: 1 },
    { ...page(), chatId: "b" },
    { ...page(), items: Array.from({ length: 101 }, () => page().items[0]) },
    { ...page(), items: [page().items[0], page().items[0]] },
    {
      ...page(),
      items: [
        {
          ...page().items[0],
          message: { ...page().items[0].message, chatId: "other" },
        },
      ],
    },
    { ...page(), historyCount: 10 },
  ]) {
    const f = fixture(),
      session = f.previews.open();
    f.read(async () => invalid);
    await expect(f.previews.load(session)).rejects.toThrow();
    expect(f.previews.current()).toBeUndefined();
  }
});
