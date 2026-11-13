let browserRuntime: ReturnType<typeof createChatTemplateRuntime>;
import { Template } from "@huggingface/jinja";

import type { OpenAIChat } from "../index.svelte";

import {
  getCurrentCharacter,
  getDatabase,
} from "src/ts/storage/database.svelte";

import { getUserName } from "src/ts/util";

export const chatTemplates = getBrowserRuntime().chatTemplates;

type TemplateEffect = "no_system_messages" | "alter_user_assistant_roles";

export const templateEffect = getBrowserRuntime().templateEffect;

export const applyChatTemplate = (
  messages: OpenAIChat[],
  arg: {
    type?: string;
    custom?: string;
  } = {},
) => getBrowserRuntime().applyChatTemplate(messages, arg);
import { createChatTemplateRuntime } from "./chatTemplateRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createChatTemplateRuntime({
    get getDatabase() {
      return getDatabase;
    },
    get getCurrentCharacter() {
      return getCurrentCharacter;
    },
    get Template() {
      return Template;
    },
    get getUserName() {
      return getUserName;
    },
    get safeStructuredClone() {
      return safeStructuredClone;
    },
  }));
}
