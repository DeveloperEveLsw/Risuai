import type { risuChatParser } from "src/ts/parser/parser.svelte";
import type { getDatabase } from "src/ts/storage/database.svelte";
import type { jsonOutputTrimmer } from "src/ts/util";

export function getRequestedJsonSchema(
  settings: { jsonSchemaEnabled?: boolean; jsonSchema?: string },
  override?: string,
): string | undefined {
  if (typeof override === "string" && override.trim()) return override;
  const { jsonSchemaEnabled, jsonSchema } = settings;
  if (jsonSchemaEnabled && typeof jsonSchema === "string" && jsonSchema.trim()) {
    return jsonSchema;
  }
  return undefined;
}

/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface JsonSchemaRuntimeHost {
  risuChatParser: (typeof import("src/ts/parser/parser.svelte"))["risuChatParser"];
  getDatabase: (typeof import("src/ts/storage/database.svelte"))["getDatabase"];
  jsonOutputTrimmer: (typeof import("src/ts/util"))["jsonOutputTrimmer"];
}
export function createJsonSchemaRuntime(host: JsonSchemaRuntimeHost) {
  function convertInterfaceToSchema(int: string) {
    if (!int.startsWith("interface ") && !int.startsWith("export interface ")) {
      return JSON.parse(int);
    }
    int = host.risuChatParser(int);
    type SchemaProp = {
      type: "array" | "string" | "number" | "boolean";
      items?: SchemaProp;
      enum?: string[];
      const?: string;
    };
    const lines = int.split("\n");
    let schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {} as {
        [key: string]: SchemaProp;
      },
      required: [] as string[],
    };
    for (let i = 1; i < lines.length; i++) {
      let content = lines[i].trim();
      if (content === "{") {
        continue;
      }
      if (content === "}") {
        continue;
      }
      if (content === "") {
        continue;
      }
      let placeHolders: string[] = [];
      content = content
        .replace(/\\"/gu, "\uE9b4a")
        .replace(/\\'/gu, "\uE9b4b")
        .replace(/"(.+?)"/gu, function (match, p1) {
          placeHolders.push(match);
          return `\uE9b4d${placeHolders.length - 1}`;
        })
        .replace(/'(.+?)'/gu, function (match, p1) {
          placeHolders.push(`"${p1}"`);
          return `\uE9b4d${placeHolders.length - 1}`;
        })
        .split("//")[0]
        .trim() //remove comments
        .replace(/((number)|(string)|(boolean))\[\]/gu, "Array<$1>");
      if (content.endsWith(",") || content.endsWith(";")) {
        content = content.slice(0, -1);
      }
      let spData = content.replace(/ /g, "").split(":");
      if (spData.length !== 2) {
        throw "SyntaxError Found";
      }
      let [property, typeData] = spData;
      switch (typeData) {
        case "string":
        case "number":
        case "boolean": {
          schema.properties[property] = {
            type: typeData,
          };
          break;
        }
        case "Array<string>":
        case "Array<number>":
        case "Array<boolean>": {
          const ogType = typeData.slice(6, -1);
          schema.properties[property] = {
            type: "array",
            items: {
              type: ogType as "string" | "number" | "boolean",
            },
          };
          break;
        }
        default: {
          const types = typeData.split("|");
          const strings: string[] = [];
          for (const t of types) {
            if (!t.startsWith("\uE9b4d")) {
              throw "Unsupported Type Detected";
            }
            const textIndex = t.replace("\uE9b4d", "");
            const text = placeHolders[parseInt(textIndex)];
            const textParsed = JSON.parse(
              text.replace(/\uE9b4a/gu, '\\"').replace(/\uE9b4b/gu, "\\'"),
            );
            strings.push(textParsed);
          }
          if (strings.length === 1) {
            schema.properties[property] = {
              type: "string",
              const: strings[0],
            };
          } else {
            schema.properties[property] = {
              type: "string",
              enum: strings,
            };
          }
        }
      }
      schema.required.push(property);
    }
    return schema;
  }

  function getOpenAIJSONSchema(schema?: string) {
    const db = host.getDatabase();
    return {
      name: "format",
      strict: db.strictJsonSchema,
      schema: convertInterfaceToSchema(schema ?? db.jsonSchema),
    };
  }

  function getGeneralJSONSchema(schema?: string, excludes: string[] = []) {
    const db = host.getDatabase();
    function process(data: any) {
      const keys = Object.keys(data);
      for (const key of keys) {
        if (excludes.includes(key)) {
          delete data[key];
        }
        if (typeof data[key] === "object") {
          data[key] = process(data[key]);
        }
      }
      return data;
    }
    const d = convertInterfaceToSchema(schema ?? db.jsonSchema);
    return process(d);
  }

  function extractJSON(data: string, format: string) {
    const extract = (data: any, format: string) => {
      try {
        if (data === undefined || data === null) {
          return "";
        }
        const fp = format.split(".");
        const current = data[fp[0]];
        if (current === undefined) {
          return "";
        } else if (fp.length === 1) {
          return `${current ?? ""}`;
        } else if (typeof current === "object") {
          return extractJSON(current, fp.slice(1).join("."));
        } else if (Array.isArray(current)) {
          const index = parseInt(fp[1]);
          return extractJSON(current[index], fp.slice(1).join("."));
        } else {
          return `${current ?? ""}`;
        }
      } catch (error) {
        return "";
      }
    };
    try {
      format = host.risuChatParser(format);
      data = data.trim();
      if (data.startsWith("{")) {
        return extract(JSON.parse(host.jsonOutputTrimmer(data)), format);
      }
    } catch (error) {}
    return data;
  }
  return {
    convertInterfaceToSchema,
    getOpenAIJSONSchema,
    getGeneralJSONSchema,
    extractJSON,
  };
}
