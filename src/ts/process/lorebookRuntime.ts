import { get } from "svelte/store";
import type { Message } from "../storage/database.svelte";
/** Actual upstream execution, with job-local state and explicit capabilities. */
export interface LorebookRuntimeHost {
  selectedCharID: (typeof import("../stores.svelte"))["selectedCharID"];
  DBState: (typeof import("../stores.svelte"))["DBState"];
  getModuleLorebooks: (typeof import("./modules"))["getModuleLorebooks"];
  findCharacterbyId: (typeof import("../util"))["findCharacterbyId"];
  CCardLib: (typeof import("@risuai/ccardlib"))["CCardLib"];
  getChatVar: (typeof import("../parser/chatVar.svelte"))["getChatVar"];
  pickHashRand: (typeof import("../util"))["pickHashRand"];
  tokenize: (typeof import("../tokenizer"))["tokenize"];
  risuChatParser: (typeof import("../parser/parser.svelte"))["risuChatParser"];
  setChatVar: (typeof import("../parser/chatVar.svelte"))["setChatVar"];
  safeStructuredClone: <T>(value: T) => T;
}
export function createLorebookRuntime(host: LorebookRuntimeHost) {
  async function loadLoreBookV3Prompt() {
    const selectedID = get(host.selectedCharID);
    const char = host.DBState.db.characters[selectedID];
    const page = char.chatPage;
    const characterLore = char.globalLore ?? [];
    const chatLore = char.chats[page].localLore ?? [];
    const moduleLorebook = host.getModuleLorebooks();
    const fullLore = host.safeStructuredClone(
      characterLore.concat(chatLore).concat(moduleLorebook),
    );
    const currentChat = char.chats[page].message;
    const loreDepth =
      char.loreSettings?.scanDepth ?? host.DBState.db.loreBookDepth;
    const loreToken =
      char.loreSettings?.tokenBudget ?? host.DBState.db.loreBookToken;
    const fullWordMatchingSetting =
      char.loreSettings?.fullWordMatching ?? false;
    const chatLength = currentChat.length + 1; //includes first message
    const recursiveScanning = char.loreSettings?.recursiveScanning ?? true;
    let recursivePrompt: {
      prompt: string;
      source: string;
      data: string;
    }[] = [];
    let matchLog: {
      prompt: string;
      source: string;
      activated: string;
    }[] = [];
    const searchMatch = (
      messages: Message[],
      arg: {
        keys: string[];
        searchDepth: number;
        regex: boolean;
        fullWordMatching: boolean;
        all?: boolean;
        dontSearchWhenRecursive: boolean;
      },
    ) => {
      const sliced = messages.slice(
        messages.length - arg.searchDepth,
        messages.length,
      );
      const newKeys = [];
      for (const key of arg.keys) {
        const trimmed = key.trim();
        if (trimmed.length > 0) {
          newKeys.push(trimmed);
        }
      }
      arg.keys = newKeys;
      let mList: {
        source: string;
        prompt: string;
        data: string;
      }[] = sliced
        .map((msg, i) => {
          if (msg.role === "user") {
            return {
              source: `message ${i} by user`,
              prompt:
                `\x01{{${host.DBState.db.username}}}:` + msg.data + "\x01",
              data: msg.data,
            };
          } else {
            return {
              source: `message ${i} by char`,
              prompt:
                `\x01{{${msg.name ?? (msg.saying ? host.findCharacterbyId(msg.saying)?.name : null) ?? char.name}}}:` +
                msg.data +
                "\x01",
              data: msg.data,
            };
          }
        })
        .concat(
          arg.dontSearchWhenRecursive
            ? []
            : recursivePrompt.map((msg) => {
                return {
                  source: "lorebook " + msg.source,
                  prompt: msg.prompt,
                  data: msg.data,
                };
              }),
        );
      if (arg.regex) {
        for (const mText of mList) {
          for (const regexString of arg.keys) {
            if (!regexString.startsWith("/")) {
              return false;
            }
            const regexFlag = regexString.split("/").pop();
            if (regexFlag) {
              arg.keys[0] = regexString.replace("/" + regexFlag, "");
              try {
                const regex = new RegExp(arg.keys[0], regexFlag);
                const d = regex.test(mText.data);
                if (d) {
                  matchLog.push({
                    prompt: mText.prompt,
                    source: mText.source,
                    activated: regexString,
                  });
                  return true;
                }
              } catch (error) {
                return false;
              }
            }
          }
        }
        return false;
      }
      mList = mList.map((m) => {
        return {
          source: m.source,
          prompt: m.prompt
            .toLocaleLowerCase()
            .replace(/\{\{\/\/(.+?)\}\}/g, "")
            .replace(/\{\{comment:(.+?)\}\}/g, ""),
          data: m.data
            .toLocaleLowerCase()
            .replace(/\{\{\/\/(.+?)\}\}/g, "")
            .replace(/\{\{comment:(.+?)\}\}/g, ""),
        };
      });
      let allMode = arg.all ?? false;
      let allModeMatched = true;
      for (const m of mList) {
        let mText = m.data;
        if (arg.fullWordMatching) {
          const splited = mText.split(" ");
          for (const key of arg.keys) {
            if (splited.includes(key.toLocaleLowerCase())) {
              matchLog.push({
                prompt: m.prompt,
                source: m.source,
                activated: key,
              });
              if (!allMode) {
                return true;
              }
            } else if (allMode) {
              allModeMatched = false;
            }
          }
        } else {
          mText = mText.replace(/ /g, "");
          for (const key of arg.keys) {
            const realKey = key.toLocaleLowerCase().replace(/ /g, "");
            if (mText.includes(realKey)) {
              matchLog.push({
                prompt: m.prompt,
                source: m.source,
                activated: key,
              });
              if (!allMode) {
                return true;
              }
            } else if (allMode) {
              allModeMatched = false;
            }
          }
        }
      }
      if (allMode && allModeMatched) {
        return true;
      }
      return false;
    };
    let matching = true;
    let actives: {
      depth: number;
      pos: string;
      prompt: string;
      role: "system" | "user" | "assistant";
      order: number;
      tokens: number;
      priority: number;
      source: string;
      inject: {
        operation: "append" | "prepend" | "replace";
        location: string;
        param: string;
        lore: boolean;
      } | null;
    }[] = [];
    let activatedIndexes: number[] = [];
    let disabledUIPrompts: string[] = [];
    let matchTimes = 0;
    let keepActivateAfterMatch = false;
    let dontActivateAfterMatch = false;
    while (matching) {
      matching = false;
      for (let i = 0; i < fullLore.length; i++) {
        if (activatedIndexes.includes(i)) {
          continue;
        }
        if (!fullLore[i].alwaysActive && !fullLore[i].key) {
          continue;
        }
        let activated = true;
        let pos = "";
        let inject: {
          operation: "append" | "prepend" | "replace";
          location: string;
          param: string;
          lore: boolean;
        } = null;
        let depth = 0;
        let scanDepth = loreDepth;
        let order = fullLore[i].insertorder;
        let priority = fullLore[i].insertorder;
        let forceState: string = "none";
        let role: "system" | "user" | "assistant" = "system";
        let searchQueries: {
          keys: string[];
          negative: boolean;
          all?: boolean;
        }[] = [];
        let fullWordMatching = fullWordMatchingSetting;
        let dontSearchWhenRecursive = false;
        if (fullLore[i].mode === "child") {
          activated = false;
          for (let j = 0; j < i; j++) {
            if (fullLore[j].id === fullLore[i].id) {
              if (!activatedIndexes.includes(j)) {
                fullLore[i].comment = fullLore[j].comment;
                fullLore[i].content = fullLore[j].content;
                fullLore[i].alwaysActive = true;
                activated = true;
              }
              break;
            }
          }
        }
        let itemRecursive: "global" | true | false = "global";
        const content = host.CCardLib.decorator.parse(
          fullLore[i].content,
          (name, arg) => {
            switch (name) {
              case "end": {
                pos = "depth";
                depth = 0;
                return;
              }
              case "activate_only_after": {
                const int = parseInt(arg[0]);
                if (Number.isNaN(int)) {
                  return false;
                }
                if (chatLength < int) {
                  activated = false;
                }
                return;
              }
              case "activate_only_every": {
                const int = parseInt(arg[0]);
                if (Number.isNaN(int)) {
                  return false;
                }
                if (chatLength % int !== 0) {
                  activated = false;
                }
                return;
              }
              case "keep_activate_after_match": {
                const vara = host.getChatVar(
                  "__internal_ka_" +
                    (fullLore[i].id ??
                      host.pickHashRand(5555, fullLore[i].content).toString()),
                );
                if (vara === "true") {
                  forceState = "activate";
                } else {
                  keepActivateAfterMatch = true;
                }
                return false;
              }
              case "dont_activate_after_match": {
                const vara = host.getChatVar(
                  "__internal_da_" +
                    (fullLore[i].id ??
                      host.pickHashRand(5555, fullLore[i].content).toString()),
                );
                if (vara === "true") {
                  forceState = "deactivate";
                } else {
                  dontActivateAfterMatch = true;
                }
                return false;
              }
              case "depth":
              case "reverse_depth": {
                const int = parseInt(arg[0]);
                if (Number.isNaN(int)) {
                  return false;
                }
                depth = int;
                pos = name === "depth" ? "depth" : "reverse_depth";
                return;
              }
              case "instruct_depth":
              case "reverse_instruct_depth":
              case "instruct_scan_depth": {
                //the instruct mode does not exists in risu
                return false;
              }
              case "role": {
                if (
                  arg[0] === "user" ||
                  arg[0] === "assistant" ||
                  arg[0] === "system"
                ) {
                  role = arg[0];
                  return;
                }
                return false;
              }
              case "scan_depth": {
                scanDepth = parseInt(arg[0]);
                return;
              }
              case "is_greeting": {
                const int = parseInt(arg[0]);
                if (Number.isNaN(int)) {
                  return false;
                }
                if ((char.chats[page].fmIndex ?? -1) + 1 !== int) {
                  activated = false;
                }
                return;
              }
              case "position": {
                if (
                  arg[0].startsWith("pt_") ||
                  [
                    "after_desc",
                    "before_desc",
                    "personality",
                    "scenario",
                  ].includes(arg[0])
                ) {
                  pos = arg[0];
                  return;
                }
                return false;
              }
              case "inject_lore": {
                inject ??= {
                  operation: "append",
                  location: "",
                  param: "",
                  lore: true,
                };
                inject.location = arg.join(" ");
                inject.lore = true;
                return;
              }
              case "inject_at": {
                inject ??= {
                  operation: "append",
                  location: "",
                  param: "",
                  lore: false,
                };
                inject.location = arg.join(" ");
                inject.lore = false;
                return;
              }
              case "inject_replace": {
                inject ??= {
                  operation: "replace",
                  location: "",
                  param: "",
                  lore: false,
                };
                inject.operation = "replace";
                inject.param = arg.join(" ");
                return;
              }
              case "inject_prepend": {
                inject ??= {
                  operation: "prepend",
                  location: "",
                  param: "",
                  lore: false,
                };
                inject.operation = "prepend";
                inject.param = arg.join(" ");
                return;
              }
              case "ignore_on_max_context": {
                priority = -1000;
                return;
              }
              case "additional_keys": {
                searchQueries.push({
                  keys: arg,
                  negative: false,
                });
                return;
              }
              case "exclude_keys": {
                searchQueries.push({
                  keys: arg,
                  negative: true,
                });
                return;
              }
              case "exclude_keys_all": {
                searchQueries.push({
                  keys: arg,
                  negative: true,
                  all: true,
                });
                return;
              }
              case "match_full_word": {
                fullWordMatching = true;
                return;
              }
              case "match_partial_word": {
                fullWordMatching = false;
                return;
              }
              case "is_user_icon": {
                //TODO
                return false;
              }
              case "activate": {
                forceState = "activate";
                return;
              }
              case "dont_activate": {
                forceState = "deactivate";
                return;
              }
              case "disable_ui_prompt": {
                if (
                  ["post_history_instructions", "system_prompt"].includes(
                    arg[0],
                  )
                ) {
                  disabledUIPrompts.push(arg[0]);
                  return;
                }
                return false;
              }
              case "probability": {
                if (Math.random() * 100 > parseInt(arg[0])) {
                  activated = false;
                }
                return;
              }
              case "priority": {
                priority = parseInt(arg[0]);
                return;
              }
              //We can already do it with search depth, but its more readable and performant this way
              case "unrecursive": {
                itemRecursive = false;
                return;
              }
              case "recursive": {
                itemRecursive = true;
                return;
              }
              case "no_recursive_search": {
                dontSearchWhenRecursive = true;
                return;
              }
              default: {
                return false;
              }
            }
          },
        );
        if (!activated || forceState !== "none" || fullLore[i].alwaysActive) {
          //if the lore is not activated or force activated, skip the search
        } else {
          searchQueries.push({
            keys: fullLore[i].key.split(","),
            negative: false,
          });
          if (fullLore[i].secondkey && fullLore[i].selective) {
            searchQueries.push({
              keys: fullLore[i].secondkey.split(","),
              negative: false,
            });
          }
          for (const query of searchQueries) {
            const result = searchMatch(currentChat, {
              keys: query.keys,
              searchDepth: scanDepth,
              regex: fullLore[i].useRegex,
              fullWordMatching: fullWordMatching,
              all: query.all,
              dontSearchWhenRecursive: dontSearchWhenRecursive,
            });
            if (query.negative) {
              if (result) {
                activated = false;
                break;
              }
            } else {
              if (!result) {
                activated = false;
                break;
              }
            }
          }
        }
        if (forceState === "activate") {
          activated = true;
        } else if (forceState === "deactivate") {
          activated = false;
        }
        if (activated) {
          actives.push({
            depth: depth,
            pos: pos,
            prompt: content,
            role: role,
            order: order,
            // Count tokens against the CBS-evaluated text (e.g. {{#if}}, {{getglobalvar}})
            // so cutoff reflects what actually reaches the context, not the unevaluated source.
            // runVar is left false (matching the output path in index.svelte.ts), so this
            // evaluation has no side effects like setvar.
            tokens: await host.tokenize(
              host.risuChatParser(content, { chara: char }),
            ),
            priority: priority,
            source: fullLore[i].comment || `lorebook ${i}`,
            inject: inject ?? null,
          });
          activatedIndexes.push(i);
          if (keepActivateAfterMatch) {
            host.setChatVar(
              "__internal_ka_" +
                (fullLore[i].id ??
                  host.pickHashRand(5555, fullLore[i].content).toString()),
              "true",
            );
          }
          if (dontActivateAfterMatch) {
            host.setChatVar(
              "__internal_da_" +
                (fullLore[i].id ??
                  host.pickHashRand(5555, fullLore[i].content).toString()),
              "true",
            );
          }
          let recursive = recursiveScanning;
          if (itemRecursive !== "global") {
            recursive = itemRecursive;
          }
          if (recursive) {
            matching = true;
            recursivePrompt.push({
              prompt: content,
              data: content,
              source: fullLore[i].comment || `lorebook ${i}`,
            });
          }
        }
      }
    }
    const activesSorted = actives.sort((a, b) => {
      return b.priority - a.priority;
    });
    let usedTokens = 0;
    const activesFiltered = activesSorted.filter((act) => {
      if (usedTokens + act.tokens <= loreToken) {
        usedTokens += act.tokens;
        return true;
      }
      return false;
    });
    let activesResorted = activesFiltered.sort((a, b) => {
      return b.order - a.order;
    });
    const loreinjectionLores = activesResorted.filter((act) => {
      return act?.inject?.lore;
    });
    activesResorted = activesResorted.filter((act) => {
      return !act?.inject?.lore;
    });
    //I know this will make token count wrong, but performance is more important here
    console.log("loreinjectionLores", loreinjectionLores);
    for (const lore of loreinjectionLores) {
      const foundLoreIndex = activesResorted.findIndex((l) => {
        return l.source === lore.inject.location;
      });
      if (foundLoreIndex !== -1) {
        const foundLore = activesResorted[foundLoreIndex];
        switch (lore.inject.operation) {
          case "append": {
            foundLore.prompt += " " + lore.prompt;
            break;
          }
          case "prepend": {
            foundLore.prompt = lore.prompt + " " + foundLore.prompt;
            break;
          }
          case "replace": {
            foundLore.prompt = foundLore.prompt.replace(
              lore.inject.param,
              lore.prompt,
            );
            break;
          }
        }
      }
    }
    return {
      actives: activesResorted.reverse(),
      matchLog: matchLog,
    };
  }
  return { loadLoreBookV3Prompt };
}
