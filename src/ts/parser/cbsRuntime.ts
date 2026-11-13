import type {
  Database,
  character,
  groupChat,
} from "../storage/database.svelte";
import {
  registerCBS,
  type CBSRegisterArg,
  type RegisterCallback,
  type matcherArg,
} from "../cbs";
import { risuEscape } from "./cbsText";

export type CbsConditions = {
  firstmsg?: boolean;
  chatRole?: string;
  messageId?: string;
  bookmarkSession?: string;
};

/** Every stateful callback belongs to this runtime's explicit execution context. */
export type CbsRuntimeHost = Omit<
  CBSRegisterArg,
  | "registerFunction"
  | "risuChatParser"
  | "makeArray"
  | "parseArray"
  | "parseDict"
  | "dateTimeFormat"
> & {
  findCharacterbyId: (id: string) => character;
};

export function createCbsRuntime(host: CbsRuntimeHost) {
  const {
    getDatabase,
    getUserName,
    getPersonaPrompt,
    safeStructuredClone,
    getChatVar,
    setChatVar,
    getGlobalChatVar,
    calcString,
    getModules,
    getModuleLorebooks,
    pickHashRand,
    getSelectedCharID,
    getModelInfo,
    isTauri,
    isNodeServer,
    isMobile,
    appVer,
    findCharacterbyId,
  } = host;
  let matcherInitialized = false;

  const matcherMap = new Map<string, RegisterCallback>();

  function initMatcher() {
    if (matcherInitialized) return;
    registerCBS({
      registerFunction: function (arg: {
        name: string;
        callback: RegisterCallback | "doc_only";
        alias: string[];
        description: string;
        deprecated?: { message: string; since?: string; replacement?: string };
        internalOnly?: boolean;
      }): void | Promise<void> {
        const callback = arg.callback;
        if (callback === "doc_only") {
          return;
        }
        const names = [arg.name, ...arg.alias];
        for (const name of names) {
          matcherMap.set(name, callback);
        }
      },
      getDatabase: getDatabase,
      getUserName: getUserName,
      getPersonaPrompt: getPersonaPrompt,
      risuChatParser: risuChatParser,
      makeArray: makeArray,
      safeStructuredClone: safeStructuredClone,
      parseArray: parseArray,
      parseDict: parseDict,
      getChatVar: getChatVar,
      setChatVar: setChatVar,
      getGlobalChatVar: getGlobalChatVar,
      calcString: calcString,
      dateTimeFormat: dateTimeFormat,
      getModules: getModules,
      getModuleLorebooks: getModuleLorebooks,
      pickHashRand: pickHashRand,
      getSelectedCharID: () => {
        return getSelectedCharID();
      },
      getModelInfo: getModelInfo,
      getCurrentTriggerId: host.getCurrentTriggerId,
      callInternalFunction: function (args: string[]): string {
        return "";
      },
      isTauri: isTauri,
      isNodeServer: isNodeServer,
      isMobile: isMobile,
      appVer: appVer,
    });
    matcherInitialized = true;
  }

  function matcher(
    p1: string,
    matcherArg: matcherArg,
    vars: { [key: string]: string } | null = null,
  ):
    | {
        text: string;
        var: { [key: string]: string };
      }
    | string
    | null {
    initMatcher();

    try {
      if (p1.startsWith("? ")) {
        const substring = p1.substring(2);
        return calcString(substring).toString();
      }
      const colonIndex = p1.indexOf(":");
      let splited: string[];
      if (colonIndex !== -1 && p1[colonIndex + 1] === ":") {
        splited = p1.split("::");
      } else {
        splited = p1.split(":");
      }
      const name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, "");
      const args = splited.slice(1);
      const callback = matcherMap.get(name);
      if (callback) {
        return callback(p1, matcherArg, args, vars);
      }
    } catch (error) {}

    return null;
  }

  const dateTimeFormat = (main: string, time = 0) => {
    const date = time === 0 ? new Date() : new Date(time);
    if (!main) {
      return "";
    }
    if (main.startsWith(":")) {
      main = main.substring(1);
    }
    if (main.length > 300) {
      return "";
    }
    return main
      .replace(/YYYY/g, date.getFullYear().toString())
      .replace(/YY/g, date.getFullYear().toString().substring(2))
      .replace(
        /MMMM/g,
        Intl.DateTimeFormat("en", { month: "long" }).format(date),
      )
      .replace(
        /MMM/g,
        Intl.DateTimeFormat("en", { month: "short" }).format(date),
      )
      .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, "0"))
      .replace(
        /DDDD/g,
        Math.floor(
          (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) /
            (1000 * 60 * 60 * 24),
        ).toString(),
      )
      .replace(/DD/g, date.getDate().toString().padStart(2, "0"))
      .replace(
        /dddd/g,
        Intl.DateTimeFormat("en", { weekday: "long" }).format(date),
      )
      .replace(
        /ddd/g,
        Intl.DateTimeFormat("en", { weekday: "short" }).format(date),
      )
      .replace(/HH/g, date.getHours().toString().padStart(2, "0"))
      .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, "0"))
      .replace(/mm/g, date.getMinutes().toString().padStart(2, "0"))
      .replace(/ss/g, date.getSeconds().toString().padStart(2, "0"))
      .replace(/X/g, Math.floor(date.getTime() / 1000).toString())
      .replace(/x/g, date.getTime().toString())
      .replace(/A/g, date.getHours() >= 12 ? "PM" : "AM");
  };

  const legacyBlockMatcher = (p1: string, matcherArg: matcherArg) => {
    const bn = p1.indexOf("\n");

    if (bn === -1) {
      return null;
    }

    const logic = p1.substring(0, bn);
    const content = p1.substring(bn + 1);
    const statement = logic.split(" ", 2);

    switch (statement[0]) {
      case "if": {
        if (["", "0", "-1"].includes(statement[1])) {
          return "";
        }

        return content.trim();
      }
    }

    return null;
  };

  type blockMatch =
    | "ignore"
    | "parse"
    | "nothing"
    | "ifpure"
    | "pure"
    | "each"
    | "function"
    | "pure-display"
    | "normalize"
    | "escape"
    | "newif"
    | "newif-falsy";

  function parseArray(p1: string): unknown[] {
    try {
      const arr = JSON.parse(p1);
      if (Array.isArray(arr)) {
        return arr;
      }
      return p1.split("§");
    } catch (error) {
      return p1.split("§");
    }
  }

  function parseDict(p1: string): { [key: string]: unknown } {
    try {
      return JSON.parse(p1);
    } catch (error) {
      return {};
    }
  }

  function makeArray(p1: unknown[]): string {
    return JSON.stringify(
      p1.map((f) => {
        if (typeof f === "string") {
          return f.replace(/::/g, "\\u003A\\u003A");
        }
        return f;
      }),
    );
  }

  function blockStartMatcher(
    p1: string,
    matcherArg: matcherArg,
  ): { type: blockMatch; type2?: string; funcArg?: string[]; mode?: string } {
    if (p1.startsWith("#if") || p1.startsWith("#if_pure ")) {
      const statement = p1.split(" ", 2);
      const state = statement[1];
      if (state === "true" || state === "1") {
        return {
          type: p1.startsWith("#if_pure") ? "ifpure" : "parse",
        };
      }
      return { type: "ignore" };
    }

    if (p1.startsWith("#when")) {
      if (p1.startsWith("#when ")) {
        const statement = p1.split(" ", 2);
        const state = statement[1];
        return {
          type: state === "true" || state === "1" ? "newif" : "newif-falsy",
        };
      } else if (p1.startsWith("#when::")) {
        const statement = p1.split("::").slice(1);
        if (statement.length === 1) {
          const state = statement[0];
          return {
            type: state === "true" || state === "1" ? "newif" : "newif-falsy",
          };
        }
        let mode: "normal" | "keep" | "legacy" = "normal";

        const isTruthy = (s: string) => {
          return s === "true" || s === "1";
        };
        while (statement.length > 1) {
          const condition = statement.pop();
          const operator = statement.pop();
          switch (operator) {
            case "not": {
              if (isTruthy(condition)) {
                statement.push("0");
              } else {
                statement.push("1");
              }
              break;
            }
            case "keep": {
              mode = "keep";
              statement.push(condition);
              break;
            }
            case "legacy": {
              mode = "legacy";
              statement.push(condition);
              break;
            }
            case "and": {
              const condition2 = statement.pop();
              if (isTruthy(condition) && isTruthy(condition2)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "or": {
              const condition2 = statement.pop();
              if (isTruthy(condition) || isTruthy(condition2)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "is": {
              const condition2 = statement.pop();
              if (condition === condition2) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "isnot": {
              const condition2 = statement.pop();
              if (condition !== condition2) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "var": {
              const variable = getChatVar(condition);
              if (isTruthy(variable)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "toggle": {
              const variable = getGlobalChatVar("toggle_" + condition);
              if (isTruthy(variable)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "vis": {
              //vis = variable is
              const variable = getChatVar(statement.pop());
              if (variable === condition) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "visnot": {
              //visnot = variable is not
              const variable = getChatVar(statement.pop());
              if (variable !== condition) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "tis": {
              //tis = toggle is
              const variable = getGlobalChatVar("toggle_" + statement.pop());
              if (variable === condition) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "tisnot": {
              //tisnot = toggle is not
              const variable = getGlobalChatVar("toggle_" + statement.pop());
              if (variable !== condition) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case ">": {
              const condition2 = statement.pop();
              if (parseFloat(condition2) > parseFloat(condition)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "<": {
              const condition2 = statement.pop();
              if (parseFloat(condition2) < parseFloat(condition)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case ">=": {
              const condition2 = statement.pop();
              if (parseFloat(condition2) >= parseFloat(condition)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            case "<=": {
              const condition2 = statement.pop();
              if (parseFloat(condition2) <= parseFloat(condition)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
            default: {
              if (isTruthy(condition)) {
                statement.push("1");
              } else {
                statement.push("0");
              }
              break;
            }
          }
        }

        const finalCondition = statement[0];
        if (isTruthy(finalCondition)) {
          switch (mode) {
            case "keep": {
              return { type: "newif", type2: "keep" };
            }
            case "legacy": {
              return { type: "parse" };
            }
            default: {
              return { type: "newif" };
            }
          }
        } else {
          switch (mode) {
            case "keep": {
              return { type: "newif-falsy", type2: "keep" };
            }
            case "legacy": {
              return { type: "ignore" };
            }
            default: {
              return { type: "newif-falsy" };
            }
          }
        }
      } else {
        return { type: "newif-falsy" };
      }
    }
    if (p1 === "#pure") {
      return { type: "pure" };
    }
    if (p1 === "#pure_display" || p1 === "#puredisplay") {
      return { type: "pure-display" };
    }
    if (p1 === "#code") {
      return { type: "normalize" };
    }
    if (p1.startsWith("#escape")) {
      const t2 = p1.substring(7).trim();
      const mode = t2 === "::keep" ? "keep" : undefined;
      return { type: "escape", mode };
    }
    if (p1.startsWith("#each")) {
      let t2 = p1.substring(5).trim();
      let mode: string | undefined;
      if (t2.startsWith("::keep ")) {
        mode = "keep";
        t2 = t2.substring(7).trim();
      }
      if (t2.startsWith("as ")) {
        t2 = t2.substring(3).trim();
      }
      return { type: "each", type2: t2, mode };
    }
    if (p1.startsWith("#func")) {
      const statement = p1.split(" ");
      if (statement.length > 1) {
        return { type: "function", funcArg: statement.slice(1) };
      }
    }

    return { type: "nothing" };
  }

  function trimLines(p1: string) {
    return p1
      .split("\n")
      .map((v) => {
        return v.trimStart();
      })
      .join("\n")
      .trim();
  }

  function blockEndMatcher(
    p1: string,
    type: { type: blockMatch; type2?: string; mode?: string },
    matcherArg: matcherArg,
  ): string {
    const p1Trimmed = p1.trim();
    switch (type.type) {
      case "pure":
      case "pure-display":
      case "function": {
        return p1Trimmed;
      }
      case "parse": {
        return trimLines(p1Trimmed);
      }
      case "each": {
        if (type.mode === "keep") {
          return p1;
        }
        return trimLines(p1Trimmed);
      }
      case "ifpure": {
        return p1;
      }
      case "newif":
      case "newif-falsy": {
        const lines = p1.split("\n");

        if (lines.length === 1) {
          const elseIndex = p1.indexOf("{{:else}}");
          if (elseIndex !== -1) {
            if (type.type === "newif") {
              return p1.substring(0, elseIndex);
            }
            if (type.type === "newif-falsy") {
              return p1.substring(elseIndex + 9);
            }
          } else {
            if (type.type === "newif") {
              return p1;
            }
            if (type.type === "newif-falsy") {
              return "";
            }
          }
        }

        const elseLine = lines.findIndex((v) => {
          return v.trim() === "{{:else}}";
        });

        if (elseLine !== -1 && type.type === "newif") {
          lines.splice(elseLine); //else line and everything after it is removed
        }
        if (elseLine !== -1 && type.type === "newif-falsy") {
          lines.splice(0, elseLine + 1); //everything before else line is removed
        }
        if (elseLine === -1 && type.type === "newif-falsy") {
          return "";
        }

        if (type.type2 !== "keep") {
          while (lines.length > 0 && lines[0].trim() === "") {
            lines.shift();
          }
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
          }
        }
        return lines.join("\n");
      }

      case "normalize": {
        return p1Trimmed
          .trim()
          .replaceAll("\n", "")
          .replaceAll("\t", "")
          .replaceAll(/\\u([0-9A-Fa-f]{4})/g, (match, p1) => {
            return String.fromCharCode(parseInt(p1, 16));
          })
          .replaceAll(/\\(.)/g, (match, p1) => {
            switch (p1) {
              case "n":
                return "\n";
              case "r":
                return "\r";
              case "t":
                return "\t";
              case "b":
                return "\b";
              case "f":
                return "\f";
              case "v":
                return "\v";
              case "a":
                return "\a";
              case "x":
                return "\x00";
              default:
                return p1;
            }
          });
      }
      case "escape": {
        return risuEscape(type.mode === "keep" ? p1 : p1Trimmed);
      }
      default: {
        return "";
      }
    }
  }

  function risuChatParser(
    da: string,
    arg: {
      chatID?: number;
      db?: Database;
      chara?: string | character | groupChat;
      rmVar?: boolean;
      var?: { [key: string]: string };
      tokenizeAccurate?: boolean;
      consistantChar?: boolean;
      visualize?: boolean;
      role?: string;
      runVar?: boolean;
      functions?: Map<string, { data: string; arg: string[] }>;
      callStack?: number;
      cbsConditions?: CbsConditions;
    } = {},
  ): string {
    const chatID = arg.chatID ?? -1;
    const db = arg.db ?? getDatabase();
    const aChara = arg.chara;
    let chara: character | string = null;

    if (aChara) {
      if (typeof aChara !== "string" && aChara.type === "group") {
        if (aChara.chats[aChara.chatPage].message.length > 0) {
          const gc = findCharacterbyId(
            aChara.chats[aChara.chatPage].message.at(-1).saying ?? "",
          );
          if (gc.name !== "Unknown Character") {
            chara = gc;
          }
        } else {
          chara = "bot";
        }
      } else {
        chara = aChara;
      }
    }
    if (arg.tokenizeAccurate) {
      const db = arg.db ?? getDatabase();
      const selchar = chara ?? db.characters[getSelectedCharID()];
      if (!selchar) {
        chara = "bot";
      }
    }

    let pointer = 0;
    let nested: string[] = [""];
    let stackType = new Uint8Array(512);
    let pureModeNest: Map<number, boolean> = new Map();
    let pureModeNestType: Map<number, string> = new Map();
    let blockNestType: Map<
      number,
      {
        type: blockMatch;
        type2?: string;
        funcArg?: string[];
        mode?: string;
      }
    > = new Map();
    let commentMode = false;
    let commentLatest: string[] = [""];
    let commentV = new Uint8Array(512);
    let thinkingMode = false;
    let tempVar: { [key: string]: string } = {};
    let functions: Map<
      string,
      {
        data: string;
        arg: string[];
      }
    > = arg.functions ?? new Map();

    arg.callStack = (arg.callStack ?? 0) + 1;

    if (arg.callStack > 20) {
      return "ERROR: Call stack limit reached";
    }

    const matcherObj = {
      chatID: chatID,
      chara: chara,
      rmVar: arg.rmVar ?? false,
      db: db,
      var: arg.var ?? null,
      tokenizeAccurate: arg.tokenizeAccurate ?? false,
      displaying: arg.visualize ?? false,
      role: arg.role,
      runVar: arg.runVar ?? false,
      consistantChar: arg.consistantChar ?? false,
      cbsConditions: arg.cbsConditions ?? {},
      callStack: arg.callStack,
      getNested: () => {
        return nested;
      },
      setNestedRoot: (val: string) => {
        nested[0] = val;
      },
    };

    da = da.replace(/\<(user|char|bot)\>/gi, "{{$1}}");

    const isPureMode = () => {
      return pureModeNest.size > 0;
    };

    while (pointer < da.length) {
      switch (da[pointer]) {
        case "{": {
          if (da[pointer + 1] !== "{" && da[pointer + 1] !== "#") {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          nested.unshift("");
          stackType[nested.length] = 1;
          break;
        }
        case "#": {
          //legacy if statement, deprecated
          if (
            da[pointer + 1] !== "}" ||
            nested.length === 1 ||
            stackType[nested.length] !== 1
          ) {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          const dat = nested.shift();
          const mc = legacyBlockMatcher(dat, matcherObj);
          nested[0] += mc ?? `{#${dat}#}`;
          break;
        }
        case "}": {
          if (
            da[pointer + 1] !== "}" ||
            nested.length === 1 ||
            stackType[nested.length] !== 1
          ) {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          const dat = nested.shift();
          if (dat.startsWith("#") || dat.startsWith(":")) {
            if (isPureMode()) {
              nested[0] += `{{${dat}}}`;
              if (dat !== ":else") {
                nested.unshift("");
                stackType[nested.length] = 6;
              }
              break;
            }
            const matchResult = blockStartMatcher(dat, matcherObj);
            if (matchResult.type === "nothing") {
              nested[0] += `{{${dat}}}`;
              break;
            } else {
              nested.unshift("");
              stackType[nested.length] = 5;
              blockNestType.set(nested.length, matchResult);
              if (
                matchResult.type === "ignore" ||
                matchResult.type === "pure" ||
                matchResult.type === "each" ||
                matchResult.type === "function" ||
                matchResult.type === "pure-display" ||
                matchResult.type === "escape"
              ) {
                pureModeNest.set(nested.length, true);
                pureModeNestType.set(nested.length, "block");
              }
              break;
            }
          }
          if (dat.startsWith("/") && !dat.startsWith("//")) {
            if (stackType[nested.length] === 5) {
              const blockType = blockNestType.get(nested.length);
              if (
                blockType.type === "ignore" ||
                blockType.type === "pure" ||
                blockType.type === "each" ||
                blockType.type === "function" ||
                blockType.type === "pure-display" ||
                blockType.type === "escape"
              ) {
                pureModeNest.delete(nested.length);
                pureModeNestType.delete(nested.length);
              }
              blockNestType.delete(nested.length);
              const dat2 = nested.shift();
              const matchResult = blockEndMatcher(dat2, blockType, matcherObj);
              if (blockType.type === "each") {
                const asIndex = blockType.type2.lastIndexOf(" as ");
                let sub = blockType.type2.substring(asIndex + 4).trim();
                let array = parseArray(blockType.type2.substring(0, asIndex));
                if (asIndex === -1) {
                  //compability mode
                  const subind = blockType.type2.lastIndexOf(" ");
                  if (subind === -1) {
                    break;
                  }
                  sub = blockType.type2.substring(subind + 1);
                  array = parseArray(blockType.type2.substring(0, subind));
                }
                let added = "";
                for (let i = 0; i < array.length; i++) {
                  added += matchResult.replaceAll(
                    `{{slot::${sub}}}`,
                    typeof array[i] === "string"
                      ? (array[i] as string)
                      : JSON.stringify(array[i]),
                  );
                }
                da =
                  da.substring(0, pointer + 1) +
                  (blockType.mode === "keep" ? added : added.trim()) +
                  da.substring(pointer + 1);
                break;
              }
              if (blockType.type === "function") {
                console.log(matchResult);
                functions.set(blockType.funcArg[0], {
                  data: matchResult,
                  arg: blockType.funcArg.slice(1),
                });
                break;
              }
              if (blockType.type === "pure-display") {
                nested[0] += matchResult
                  .replaceAll("{{", "\\{\\{")
                  .replaceAll("}}", "\\}\\}");
                break;
              }
              if (matchResult === "") {
                break;
              }
              nested[0] += matchResult;
              break;
            }
            if (stackType[nested.length] === 6) {
              const sft = nested.shift();
              nested[0] += sft + `{{${dat}}}`;
              break;
            }
          }
          if (dat.startsWith("call::")) {
            if (arg.callStack && arg.callStack > 20) {
              nested[0] += `ERROR: Call stack limit reached`;
              break;
            }
            const argData = dat.split("::").slice(1);
            const funcName = argData[0];
            const func = functions.get(funcName);
            console.log(func);
            if (func) {
              let data = func.data;
              for (let i = 0; i < argData.length; i++) {
                data = data.replaceAll(`{{arg::${i}}}`, argData[i]);
              }
              arg.functions = functions;
              nested[0] += risuChatParser(data, arg);
              break;
            }
          }
          const mc = isPureMode() ? null : matcher(dat, matcherObj, tempVar);
          if (!mc && mc !== "") {
            nested[0] += `{{${dat}}}`;
          } else if (typeof mc === "string") {
            nested[0] += mc;
          } else {
            nested[0] += mc.text;
            tempVar = mc.var;
            if (tempVar["__force_return__"]) {
              return tempVar["__return__"] ?? "null";
            }
          }
          break;
        }
        default: {
          nested[0] += da[pointer];
          break;
        }
      }
      pointer++;
    }
    if (commentMode) {
      nested = commentLatest;
      stackType = commentV;
      if (thinkingMode) {
        nested[0] += `<div>Thinking...</div>`;
      }
      commentMode = false;
    }
    if (nested.length === 1) {
      return nested[0];
    }
    let result = "";
    while (nested.length > 1) {
      let dat = stackType[nested.length] === 1 ? "{{" : "<";
      dat += nested.shift();
      result = dat + result;
    }
    return nested[0] + result;
  }

  return { parse: risuChatParser };
}
