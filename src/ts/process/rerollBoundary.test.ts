// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { rerollBoundary } from "./rerollBoundary";
import type { Message } from "../storage/database.svelte";

// Evaluate the actual original UI loop, not a second copy of this helper.
const original = readFileSync(
  "src/lib/ChatScreens/DefaultChatScreen.svelte",
  "utf8",
);
const start = original.indexOf("const saying = cha[cha.length - 1].saying");
const end = original.indexOf(
  "DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].message = cha",
  start,
);
if (start < 0 || end < start)
  throw new Error(
    "Original reroll source boundary moved; review the comparison",
  );
const runOriginal = new Function(
  "cha",
  original.slice(start, end) + "return cha.length",
) as (messages: Message[]) => number;
const message = (role: Message["role"], saying?: string) => ({
  role,
  saying,
  data: "Synthetic",
});

test("first-reroll boundaries match the actual upstream UI for individual, group, repeated-speaker and non-user tail histories", () => {
  const histories = [
    [message("user"), message("char")],
    [message("user"), message("char"), message("char")],
    [message("user"), message("char", "a"), message("char", "b")],
    [
      message("user"),
      message("char", "a"),
      message("char", "b"),
      message("char", "a"),
      message("char", "b"),
    ],
    [
      message("user"),
      message("char", "a"),
      message("char", "a"),
      message("char", "b"),
    ],
    [
      message("user"),
      message("char", "a"),
      message("char", "b"),
      message("char", "b"),
    ],
    [
      message("user"),
      message("char", "a"),
      message("char", "b"),
      message("char"),
    ],
  ];
  for (const history of histories)
    expect(rerollBoundary(history)).toBe(runOriginal(structuredClone(history)));
});

test("history exhaustion fails as in upstream rather than deleting an unbounded reply-only history", () => {
  const history = [message("char", "a"), message("char", "b")];
  expect(() => runOriginal(structuredClone(history))).toThrow();
  expect(() => rerollBoundary(history)).toThrow(
    "earlier user or speaker boundary",
  );
  expect(history).toHaveLength(2);
});
