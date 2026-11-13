import { expect, test } from "vitest";
import type { Message, character } from "../storage/database.svelte";
import { defaultCBSRegisterArg } from "../cbs";
import type { DisplayCapture } from "./displayEffects";
import { pinDisplayCapture } from "./displayWorkerExecutor";
import { freezeDisplayJson } from "./displayScopeIdentity";
import { forkDisplayScope } from "./displayScopeCache.svelte";
import { provisionalDisplayScope } from "./provisionalDisplayScope";
import { createDisplayCbsScope } from "./displayCbsScope";
import { displayReadAdmission } from "./displayReadDependencies";

function fixture() {
  const chat = {
    id: "a",
    message: [
      { chatId: "m0", role: "char", data: "Synthetic zero" },
      { chatId: "m1", role: "user", data: "Synthetic one" },
    ],
    scriptstate: { $counter: "0" },
    GLGlobalVariables: {},
  };
  const character = {
    type: "character",
    chaId: "c",
    name: "Synthetic",
    chats: [chat],
    chatPage: 0,
    triggerscript: [],
  };
  const capture = {
    serverId: "synthetic",
    state: {
      cursor: 20,
      inputClock: 18,
      chatId: "a",
      characterId: "c",
      chatEpoch: 4,
      characterEpoch: 5,
      applied: [],
      next: null,
    },
    projectedCursor: 20,
    history: { count: 220, cursor: 20 },
    historyWindow: [
      ["m0", 2],
      ["m1", 21],
    ],
    database: { characters: [character], globalChatVariables: {} },
    character,
    chat,
    triggers: [],
    versions: {
      chat: new Map([["$counter", 2]]),
      localGlobal: new Map(),
      global: new Map(),
    },
    hasEarlier: true,
    persistent: true,
  } as unknown as DisplayCapture;
  const pinned = pinDisplayCapture(capture);
  freezeDisplayJson(pinned);
  const fresh = () => forkDisplayScope(pinned, pinned, undefined);
  return { capture, pinned, fresh };
}
const previews = (): Message[] => [
  { chatId: "pending", role: "user", data: "Pending" },
  {
    chatId: "progress",
    role: "char",
    data: "Progress",
    generationInfo: { model: "synthetic" } as Message["generationInfo"],
  },
];

test("preview history appends owned ordinals without filling unloaded canonical gaps, and original CBS sees actual index/role/length", () => {
  const f = fixture();
  const preview = provisionalDisplayScope(f.fresh(), previews(), "progress");
  expect(preview.history).toEqual({ count: 222, cursor: 20, ordinal: 221 });
  expect(preview.historyWindow).toEqual([
    ["m0", 2],
    ["m1", 21],
    ["pending", 220],
    ["progress", 221],
  ]);
  const base = {
    ...defaultCBSRegisterArg,
    findCharacterbyId: () => preview.character as character,
  };
  const scope = createDisplayCbsScope(preview, base);
  expect(
    scope.parse("{{chat_index}}:{{role}}:{{lastmessageid}}:{{lastmessage}}", {
      chatID: 221,
    }),
  ).toBe("221:char:221:Progress");
  expect(scope.chat.message[21].data).toBe("Synthetic one");
  expect(scope.chat.message[220].data).toBe("Pending");
  expect(() => scope.chat.message[219]).toThrow(/unloaded history/);
  expect(() => scope.check()).toThrow(/unloaded history/);
  expect(f.capture.chat.message).toHaveLength(2);
  expect(f.pinned.history.count).toBe(220);
});

test("fresh private aliases and maps keep preview CBS own-source rewrites provisional with revision zero", () => {
  const f = fixture();
  const untouched = f.fresh();
  const preview = provisionalDisplayScope(f.fresh(), previews(), "progress");
  expect(preview.database.characters[0]).toBe(preview.character);
  expect(preview.character.chats[0]).toBe(preview.chat);
  const base = {
    ...defaultCBSRegisterArg,
    findCharacterbyId: () => preview.character as character,
  };
  const scope = createDisplayCbsScope(preview, base);
  scope.chat.message[221].data = "";
  scope.check();
  expect(createDisplayCbsScope(preview, base).chat.message[221].data).toBe("");
  expect(displayReadAdmission(preview)).toMatchObject({
    provisional: true,
    messageEdits: [{ messageId: "progress", expectedRevision: 0, text: "" }],
  });
  preview.chat.scriptstate.$counter = "private";
  preview.versions.chat.set("$counter", 99);
  expect(untouched.chat.message).toHaveLength(2);
  expect(untouched.chat.scriptstate.$counter).toBe("0");
  expect(untouched.versions.chat.get("$counter")).toBe(2);
  expect(preview.chat.message.at(-1).data).toBe("Progress");
});

test("equal fresh preview bodies reuse immutable history identities while changed text and unknown metadata are captured anew", () => {
  const f = fixture();
  const rows = previews();
  const first = provisionalDisplayScope(f.fresh(), rows, "progress");
  const same = provisionalDisplayScope(f.fresh(), previews(), "pending");
  expect(same.chat.message).toBe(first.chat.message);
  expect(same.historyWindow).toBe(first.historyWindow);
  rows[1].data = "";
  (rows[1] as Message & { unknown: { value: string } }).unknown = {
    value: "fresh",
  };
  const changed = provisionalDisplayScope(f.fresh(), rows, "progress");
  expect(changed.chat.message).not.toBe(first.chat.message);
  expect(changed.sourceContent).toBe("");
  rows[1].data = "later";
  expect(changed.chat.message.at(-1).data).toBe("");
  expect(first.sourceContent).toBe("Progress");
  expect(Object.isFrozen(rows[1])).toBe(false);
  expect(Object.isFrozen(changed.chat.message.at(-1))).toBe(true);
});

test("confirmed and duplicate IDs never become preview sources, and incomplete/overflow history fails explicitly", () => {
  const f = fixture();
  const rows = [
    { chatId: "m0", role: "char", data: "must not replace" },
    ...previews(),
    ...previews(),
  ] as Message[];
  expect(
    provisionalDisplayScope(f.fresh(), rows, "progress").chat.message,
  ).toHaveLength(4);
  for (const id of ["m0", "unknown"])
    expect(() => provisionalDisplayScope(f.fresh(), rows, id)).toThrow(
      /owned message source/,
    );
  expect(() =>
    provisionalDisplayScope(
      { ...f.fresh(), history: undefined },
      rows,
      "progress",
    ),
  ).toThrow(/history metadata/);
  expect(() =>
    provisionalDisplayScope(
      { ...f.fresh(), history: { count: Number.MAX_SAFE_INTEGER, cursor: 20 } },
      rows,
      "progress",
    ),
  ).toThrow(/count limit/);
});
