import { writable } from "svelte/store";
import {
  createScriptingRuntime,
  type ScriptingRuntimeHost,
} from "../process/scriptingRuntime";
import { createChatVariableRuntime } from "../parser/chatVariableRuntime";
import { createUtilStateRuntime } from "../utilStateRuntime";
import { parseKeyValue } from "../utilText";
import {
  DisplayProposal,
  displayIdentity,
  type DisplayCapture,
} from "./displayEffects";
import type { RuntimeCommand } from "./clientProtocol";

export interface DisplayScope {
  capture: DisplayCapture;
  proposal: DisplayProposal;
  variables: ReturnType<typeof createChatVariableRuntime>;
  util: ReturnType<typeof createUtilStateRuntime>;
  parse: ScriptingRuntimeHost["risuChatParser"];
}
export type DisplayExecution = {
  capture: DisplayCapture;
  content: string;
  index: number;
  identity: Awaited<ReturnType<typeof displayIdentity>>;
  suppressed: boolean;
};
export type DisplayExecutionResult = {
  output: string;
  command?: RuntimeCommand;
  reads?: import("./displayReadDependencies").DisplayRead[];
};
export interface DisplayExecutor {
  execute(input: DisplayExecution): Promise<DisplayExecutionResult>;
  close(): void;
}
export type DisplayParser = (
  scope: Omit<DisplayScope, "parse">,
) => DisplayScope["parse"];

/** Original Lua engine bound only to one pinned display invocation. */
export class DisplayLuaContext implements DisplayExecutor {
  private scope?: DisplayScope;
  private runtime: ReturnType<typeof createScriptingRuntime>;
  constructor(
    private base: () => ScriptingRuntimeHost,
    private parser: DisplayParser,
  ) {
    const current = () => {
      if (!this.scope) throw new Error("Display Lua has no active invocation");
      return this.scope;
    };
    const host = new Proxy(this.base(), {
      get(target, property) {
        const ports: Partial<ScriptingRuntimeHost> = {
          getCurrentCharacter: () => current().capture.character,
          getCurrentChat: () => current().capture.chat,
          getDatabase: () => current().capture.database,
          getChatVar: (key) => current().variables.getChatVar(key),
          setChatVar: (key, value) =>
            current().variables.setChatVar(key, value),
          getGlobalChatVar: (key) => current().variables.getGlobalChatVar(key),
          risuChatParser: (value, arg) => current().parse(value, arg),
          getUserName: () => current().util.getUserName(),
          getUserIcon: () => current().util.getUserIcon(),
          getPersonaPrompt: () => current().util.getPersonaPrompt(),
          getModuleLorebooks: () => current().capture.cbsLorebooks ?? [],
          getModuleTriggers: () => {
            const c = current().capture;
            return c.triggers.slice(
              c.character.type === "group"
                ? 0
                : c.character.triggerscript.length,
            );
          },
          onScriptError: (error) => {
            current().proposal.failure ??=
              error instanceof Error ? error : new Error(String(error));
          },
        };
        if (property === "DBState")
          return {
            get db() {
              return current().capture.database;
            },
          };
        if (property === "selectedCharID") return writable(0);
        return property in ports
          ? ports[property]
          : Reflect.get(target, property);
      },
    });

    this.runtime = createScriptingRuntime(host);
  }
  async execute({
    capture,
    content,
    index,
    identity,
    suppressed,
  }: DisplayExecution) {
    const proposal = new DisplayProposal(capture, suppressed);
    const selectedCharID = writable(0),
      DBState = { db: capture.database };
    const variables = createChatVariableRuntime({
      selectedCharID,
      DBState,
      parseKeyValue,
      getCurrentChat: () => capture.chat,
    });
    const util = createUtilStateRuntime({
      readResourceValue: (value) => value,
      selectedCharID,
      DBState,
      getDatabase: () => capture.database,
      createBlankChar: () =>
        proposal.fail(
          "Display character lookup outside its pinned scope is unavailable",
        ),
    });
    const trackedVariables = {
      ...variables,
      getChatVar: (key: string) => {
        proposal.record({
          scope: "chat",
          chatId: capture.state.chatId,
          key: "$" + key,
        });
        return variables.getChatVar(key);
      },
      setChatVar: (key: string, value: string) =>
        proposal.write(key, value, () => variables.setChatVar(key, value)),
      getGlobalChatVar: (key: string) => {
        proposal.record({
          scope: "chat-global",
          chatId: capture.state.chatId,
          key,
        });
        const local = capture.chat.GLGlobalVariables?.[key];
        if (!local || local === "null")
          proposal.record({ scope: "global", key });
        return variables.getGlobalChatVar(key);
      },
    };
    const scope = { capture, proposal, variables: trackedVariables, util };
    this.scope = { ...scope, parse: this.parser(scope) };
    try {
      // Paged history must never masquerade as the complete original chat.
      if (capture.hasEarlier)
        Object.defineProperty(capture.chat, "message", {
          get: () =>
            new Proxy([], {
              get: (_target, key) => {
                const count = capture.history?.count;
                if (
                  key === "length" &&
                  count !== undefined &&
                  Number.isSafeInteger(count) &&
                  count >= 0
                )
                  return count;
                return proposal.fail(
                  "Display Lua requires unloaded history; persistent effects were not submitted",
                );
              },
            }),
        });

      const output = await this.runtime.runLuaEditTrigger(
        capture.character,
        "editdisplay",
        content,
        { index: capture.history?.ordinal ?? index },
      );
      if (proposal.failure) throw proposal.failure;
      return {
        output,
        reads: [...proposal.reads.values()],
        command:
          capture.persistent && !suppressed && proposal.edits.size
            ? proposal.command(identity)
            : undefined,
      };
    } finally {
      this.scope = undefined;
    }
  }
  close() {
    this.runtime.close();
  }
}
