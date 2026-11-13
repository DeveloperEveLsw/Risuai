import { expect, test } from "vitest";
import { defaultCBSRegisterArg } from "../cbs";
import { createDisplayCbsScope } from "./displayCbsScope";
import type { DisplayCapture } from "./displayEffects";
import { variableIdentity } from "./variableCommands";
import {
  displayReadAdmission,
  inheritDisplayReads,
  mergeDisplayReads,
} from "./displayReadDependencies";

function fixture() {
  const chat = {
    id: "a",
    message: [],
    scriptstate: { $counter: "1" },
    GLGlobalVariables: { toggle_fast: "local" },
  };
  const character = {
    type: "character",
    chaId: "c",
    name: "Synthetic",
    chats: [chat],
    chatPage: 0,
  };
  const database = {
    characters: [character],
    globalChatVariables: { toggle_fast: "0" },
  };
  const capture = {
    chat,
    character,
    database,
    cbsModules: [],
    cbsLorebooks: [],
    hasEarlier: false,
    presentationVariables: [
      [
        variableIdentity({ scope: "global", key: "toggle_fast" }),
        { exists: true, value: "1" },
      ],
      [
        variableIdentity({
          scope: "chat-global",
          chatId: "a",
          key: "toggle_fast",
        }),
        { exists: false },
      ],
    ],
  } as unknown as DisplayCapture;
  const base = {
    ...defaultCBSRegisterArg,
    findCharacterbyId: () => character as any,
  };
  return { capture, base };
}

test("later original scopes see the private source proposal while forked owners and canonical bodies remain independent", () => {
  const { capture, base } = fixture();
  capture.chat.message = [{ role: "char", data: "Synthetic raw", chatId: "m" }];
  capture.message = { id: "m", revision: 3 };
  capture.history = { count: 1, cursor: 0, ordinal: 0 };
  capture.historyWindow = [["m", 0]];
  Object.freeze(capture.chat.message[0]);
  Object.freeze(capture.chat.message);
  const first = createDisplayCbsScope(capture, base);
  first.chat.message[0].data = "Synthetic processed";
  const later = createDisplayCbsScope(capture, base);
  expect(later.chat.message[0].data).toBe("Synthetic processed");
  const fork = { ...capture };
  inheritDisplayReads(capture, fork);
  const child = createDisplayCbsScope(fork, base);
  child.chat.message[0].data = "";
  expect(child.chat.message[0].data).toBe("");
  expect(later.chat.message[0].data).toBe("Synthetic processed");
  expect(first.chat.message[0].data).toBe("Synthetic processed");
  expect(capture.chat.message[0].data).toBe("Synthetic raw");
  expect(displayReadAdmission(capture).messageEdits).toEqual([
    { messageId: "m", expectedRevision: 3, text: "Synthetic processed" },
  ]);
  expect(() => {
    child.chat.message[0].role = "user";
  }).toThrow(/server intent/);
  expect(() => child.check()).toThrow(/server intent/);
});

test("original CBS retains captured optimistic globals while persistent worker input remains confirmed", () => {
  const { capture, base } = fixture();
  const scope = createDisplayCbsScope(capture, base);
  expect(
    scope.parse("{{getglobalvar::toggle_fast}}:{{getvar::counter}}", {
      chatID: -1,
    }),
  ).toBe("1:1");
  expect(capture.database.globalChatVariables.toggle_fast).toBe("0");
  expect(capture.chat.GLGlobalVariables.toggle_fast).toBe("local");
  // A subsequent input change cannot retarget this original synchronous scope.
  capture.presentationVariables[0][1].value = "later";
  expect(scope.parse("{{getglobalvar::toggle_fast}}", { chatID: -1 })).toBe(
    "1",
  );
  scope.check();
});

test("original local-global precedence and pending deletion remain consistent in private CBS bindings", () => {
  const { capture, base } = fixture();
  capture.presentationVariables = [
    [
      variableIdentity({ scope: "global", key: "toggle_fast" }),
      { exists: false },
    ],
    [
      variableIdentity({
        scope: "chat-global",
        chatId: "a",
        key: "toggle_fast",
      }),
      { exists: true, value: "pending-local" },
    ],
  ];
  expect(
    createDisplayCbsScope(capture, base).parse(
      "{{getglobalvar::toggle_fast}}",
      { chatID: -1 },
    ),
  ).toBe("pending-local");
  capture.presentationVariables = [
    [
      variableIdentity({ scope: "global", key: "toggle_fast" }),
      { exists: false },
    ],
    [
      variableIdentity({
        scope: "chat-global",
        chatId: "a",
        key: "toggle_fast",
      }),
      { exists: false },
    ],
  ];
  expect(
    createDisplayCbsScope(capture, base).parse(
      "{{getglobalvar::toggle_fast}}",
      { chatID: -1 },
    ),
  ).toBe("null");
});

test("original CBS records absence and local-global precedence without a global read when the local value wins", () => {
  const { capture, base } = fixture();
  capture.presentationVariables = [];
  capture.versions = {
    chat: new Map([["$counter", 7]]),
    localGlobal: new Map([["toggle_fast", 3]]),
    global: new Map([["toggle_fast", 4]]),
  };
  const scope = createDisplayCbsScope(capture, base);
  expect(
    scope.parse(
      "{{getvar::counter}}:{{getvar::missing}}:{{getglobalvar::toggle_fast}}",
      { chatID: -1 },
    ),
  ).toBe("1:null:local");
  expect(displayReadAdmission(capture).reads).toEqual([
    { scope: "chat", chatId: "a", key: "$counter", expectedRevision: 7 },
    { scope: "chat", chatId: "a", key: "$missing", expectedRevision: 0 },
    {
      scope: "chat-global",
      chatId: "a",
      key: "toggle_fast",
      expectedRevision: 3,
    },
  ]);
  expect(displayReadAdmission(capture).provisional).not.toBe(true);
  delete capture.chat.GLGlobalVariables.toggle_fast;
  expect(
    createDisplayCbsScope(capture, base).parse(
      "{{getglobalvar::toggle_fast}}",
      { chatID: -1 },
    ),
  ).toBe("0");
  expect(displayReadAdmission(capture).reads).toContainEqual({
    scope: "global",
    key: "toggle_fast",
    expectedRevision: 4,
  });
});

test("pending deletion and replacement remain visible but their read provenance marks the presentation provisional", () => {
  const { capture, base } = fixture();
  const scope = createDisplayCbsScope(capture, base);
  expect(scope.parse("{{getglobalvar::toggle_fast}}", { chatID: -1 })).toBe(
    "1",
  );
  expect(displayReadAdmission(capture).provisional).toBe(true);
  expect(capture.database.globalChatVariables.toggle_fast).toBe("0");
  const same = fixture();
  same.capture.presentationVariables = [
    [
      variableIdentity({
        scope: "chat-global",
        chatId: "a",
        key: "toggle_fast",
      }),
      { exists: true, value: "local" },
    ],
  ];
  createDisplayCbsScope(same.capture, same.base).parse(
    "{{getglobalvar::toggle_fast}}",
    { chatID: -1 },
  );
  expect(displayReadAdmission(same.capture).provisional).not.toBe(true);
});

test("inherited CBS provenance is private and variable enumeration keeps pure display but explicitly prevents a persistent proposal", () => {
  const { capture, base } = fixture();
  createDisplayCbsScope(capture, base).parse("{{getvar::counter}}", {
    chatID: -1,
  });
  const fork = { ...capture };
  inheritDisplayReads(capture, fork);
  const child = createDisplayCbsScope(fork, base);
  child.parse("{{getvar::missing}}", { chatID: -1 });
  expect(displayReadAdmission(capture).reads).toHaveLength(1);
  expect(displayReadAdmission(fork).reads).toHaveLength(2);
  const returned = displayReadAdmission(fork);
  returned.reads[0].expectedRevision = 999;
  expect(displayReadAdmission(fork).reads[0].expectedRevision).toBe(0);
  expect(Object.keys(child.chat.scriptstate)).toEqual(["$counter"]);
  child.check();
  expect(() =>
    mergeDisplayReads(
      { type: "apply-display-effects", reads: [], edits: [] },
      displayReadAdmission(fork),
    ),
  ).toThrow(/collection revision/);
});
