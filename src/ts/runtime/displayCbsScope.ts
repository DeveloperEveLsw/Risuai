import { writable } from "svelte/store";
import { createCbsRuntime, type CbsRuntimeHost } from "../parser/cbsRuntime";
import { createChatVariableRuntime } from "../parser/chatVariableRuntime";
import { createUtilStateRuntime } from "../utilStateRuntime";
import { parseKeyValue } from "../utilText";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import type { DisplayCapture } from "./displayEffects";
import { canonicalDisplayHistory } from "./canonicalDisplayHistory";
import { variableIdentity } from "./variableCommands";
import { createDisplayCbsParser } from "./displayCbsParser";
import type { VariableTarget } from "./variableCommands";
import {
  recordDisplayRead,
  noteDisplayProvisionalRead,
  noteDisplayVariableEnumeration,
  recordDisplayMessageWrite,
  displayMessageText,
} from "./displayReadDependencies";

/** A private original CBS binding, with complete ordinals and known bodies. */
export function createDisplayCbsScope(
  capture: DisplayCapture,
  base: CbsRuntimeHost,
) {
  let failure: Error;
  const fail = (error: unknown): never => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    throw failure;
  };
  const readonlyVariables = <
    T extends Record<string, string | number | boolean>,
  >(
    value: T,
    target: (key: string) => VariableTarget,
  ): T =>
    new Proxy(value ?? ({} as T), {
      get: (object, key, receiver) => {
        if (typeof key === "string") recordDisplayRead(capture, target(key));
        return Reflect.get(object, key, receiver);
      },
      has: (object, key) => {
        if (typeof key === "string") recordDisplayRead(capture, target(key));
        return Reflect.has(object, key);
      },
      getOwnPropertyDescriptor: (object, key) => {
        if (typeof key === "string") recordDisplayRead(capture, target(key));
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
      ownKeys: (object) => {
        noteDisplayVariableEnumeration(capture);
        return Reflect.ownKeys(object);
      },
      set: () =>
        fail(
          "Persistent outer display variables require deferred server admission",
        ),
      deleteProperty: () =>
        fail(
          "Persistent outer display variables require deferred server admission",
        ),
      defineProperty: () =>
        fail(
          "Persistent outer display variables require deferred server admission",
        ),
    });
  const chat = {
    ...capture.chat,
    scriptstate: readonlyVariables(capture.chat.scriptstate, (key) => ({
      scope: "chat",
      chatId: capture.state?.chatId ?? capture.chat.id,
      key,
    })),
    GLGlobalVariables: readonlyVariables(
      capture.chat.GLGlobalVariables,
      (key) => ({
        scope: "chat-global",
        chatId: capture.state?.chatId ?? capture.chat.id,
        key,
      }),
    ),
  };
  if (capture.history && capture.historyWindow)
    chat.message = canonicalDisplayHistory(
      capture.chat.message,
      capture.history.count,
      capture.historyWindow,
      fail,
      (message, text, ordinal) => {
        if (ordinal !== capture.history?.ordinal)
          return fail(
            "Display message write requires its own canonical source ordinal",
          );
        try {
          recordDisplayMessageWrite(capture, message.chatId, text);
        } catch (error) {
          return fail(error);
        }
      },
      (message) => displayMessageText(capture, message.chatId),
    );
  else if (capture.hasEarlier)
    fail("Canonical display history metadata is unavailable");
  const character = { ...capture.character, chats: [chat], chatPage: 0 };
  const database = {
    ...capture.database,
    characters: [character],
    globalChatVariables: readonlyVariables(
      capture.database.globalChatVariables,
      (key) => ({ scope: "global", key }),
    ),
  };
  const selectedCharID = writable(0),
    DBState = { db: database };
  const confirmedVariables = createChatVariableRuntime({
    selectedCharID,
    DBState,
    parseKeyValue,
    getCurrentChat: () => chat,
  });
  // Retain the original browser's optimistic global getter semantics in a
  // captured presentation layer. Worker/persistent scopes still read confirmed
  // variables and revisions; provisional values never overwrite that body.
  const overlays = new Map(
    (capture.presentationVariables ?? []).map(([key, value]) => [
      key,
      { ...value },
    ]),
  );
  const overlayFor = (
    target: VariableTarget,
    object: Record<string, unknown>,
  ) => {
    recordDisplayRead(capture, target);
    const overlay = overlays.get(variableIdentity(target));
    if (
      overlay &&
      (overlay.exists !== Object.hasOwn(object ?? {}, target.key) ||
        (overlay.exists && !Object.is(overlay.value, object?.[target.key])))
    )
      noteDisplayProvisionalRead(capture);
    return overlay;
  };
  const variables = {
    ...confirmedVariables,
    getChatVar: (key: string) => {
      // Retain original per-key Svelte dependencies; values still come only
      // from this pinned owner, including its later provisional Lua edits.
      if (capture.presentationVariables) base.getChatVar(key);
      return confirmedVariables.getChatVar(key);
    },
    getGLChatVar: (key: string) => {
      const overlay = overlayFor(
        { scope: "chat-global", chatId: chat.id, key },
        capture.chat.GLGlobalVariables,
      );
      return (
        overlay
          ? overlay.exists
            ? overlay.value
            : undefined
          : chat.GLGlobalVariables?.[key]
      ) as string;
    },
    getGlobalChatVar: (key: string) => {
      if (capture.presentationVariables) base.getGlobalChatVar(key);
      const local = variables.getGLChatVar(key);
      if (local && local !== "null") return local;
      const overlay = overlayFor(
        { scope: "global", key },
        capture.database.globalChatVariables,
      );
      return (
        overlay
          ? overlay.exists
            ? (overlay.value ?? "null")
            : "null"
          : (database.globalChatVariables[key] ?? "null")
      ) as string;
    },
  };
  const util = createUtilStateRuntime({
    readResourceValue: (value) => value,
    selectedCharID,
    DBState,
    getDatabase: () => database,
    createBlankChar: () =>
      fail("Display character lookup outside its pinned scope is unavailable"),
  });
  const runtime = createCbsRuntime({
    ...base,
    ...variables,
    ...util,
    getDatabase: () => database,
    getSelectedCharID: () => 0,
    calcString: createExpressionEvaluator(variables),
    setChatVar: () =>
      fail("Persistent outer CBS writes require deferred server admission"),
    getModules: () => capture.cbsModules ?? [],
    getModuleLorebooks: () => capture.cbsLorebooks ?? [],
    getCurrentTriggerId: () =>
      capture.cbsEnvironment?.triggerId ?? base.getCurrentTriggerId(),
    getModelInfo: (model) =>
      capture.cbsEnvironment && model === database.aiModel
        ? capture.cbsEnvironment.model
        : base.getModelInfo(model),
    isTauri: capture.cbsEnvironment?.isTauri ?? base.isTauri,
    isNodeServer: capture.cbsEnvironment?.isNodeServer ?? base.isNodeServer,
    isMobile: capture.cbsEnvironment?.isMobile ?? base.isMobile,
    appVer: capture.cbsEnvironment?.appVer ?? base.appVer,
    findCharacterbyId: (id) =>
      id === character.chaId && character.type !== "group"
        ? character
        : fail(
            "Display character lookup outside its pinned scope is unavailable",
          ),
  });
  return {
    database,
    character,
    chat,
    util,
    parse: createDisplayCbsParser(runtime.parse),
    fail,
    check: () => {
      if (failure) throw failure;
    },
  };
}
