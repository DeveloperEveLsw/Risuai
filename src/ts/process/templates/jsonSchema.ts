let browserRuntime: ReturnType<typeof createJsonSchemaRuntime>;
import { risuChatParser } from "src/ts/parser/parser.svelte";

import { getDatabase } from "src/ts/storage/database.svelte";

import { jsonOutputTrimmer } from "src/ts/util";

export function convertInterfaceToSchema(int: string) {
  return getBrowserRuntime().convertInterfaceToSchema(int);
}

export function getOpenAIJSONSchema(schema?: string) {
  return getBrowserRuntime().getOpenAIJSONSchema(schema);
}

export function getGeneralJSONSchema(schema?: string, excludes: string[] = []) {
  return getBrowserRuntime().getGeneralJSONSchema(schema, excludes);
}

export function extractJSON(data: string, format: string) {
  return getBrowserRuntime().extractJSON(data, format);
}
import { createJsonSchemaRuntime } from "./jsonSchemaRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createJsonSchemaRuntime({
    get risuChatParser(): typeof risuChatParser {
      return risuChatParser;
    },
    get getDatabase(): typeof getDatabase {
      return getDatabase;
    },
    get jsonOutputTrimmer(): typeof jsonOutputTrimmer {
      return jsonOutputTrimmer;
    },
  }));
}
