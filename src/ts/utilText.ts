export function sfc32(a: number, b: number, c: number, d: number) {
  return function () {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    let t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function uuidtoNumber(uuid: string) {
  let result = 0;
  for (let i = 0; i < uuid.length; i++) {
    result += uuid.charCodeAt(i);
  }
  return result;
}

export function isLastCharPunctuation(s: string) {
  const lastChar = s.trim().at(-1);
  const punctuation = [
    ".",
    "!",
    "?",
    "。",
    "！",
    "？",
    "…",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "-",
    "_",
    "+",
    "=",
    "{",
    "}",
    "[",
    "]",
    "|",
    "\\",
    ":",
    ";",
    "<",
    ">",
    ",",
    ".",
    "/",
    "~",
    "`",
    " ",
    "¡",
    "¿",
    "‽",
    "⁉",
    "'",
    '"',
  ];
  if (
    lastChar &&
    !(
      punctuation.indexOf(lastChar) !== -1 ||
      //spacing modifier letters
      (lastChar.charCodeAt(0) >= 0x02b0 && lastChar.charCodeAt(0) <= 0x02ff) ||
      //combining diacritical marks
      (lastChar.charCodeAt(0) >= 0x0300 && lastChar.charCodeAt(0) <= 0x036f) ||
      //hebrew punctuation
      (lastChar.charCodeAt(0) >= 0x0590 && lastChar.charCodeAt(0) <= 0x05cf) ||
      //CJK symbols and punctuation
      (lastChar.charCodeAt(0) >= 0x3000 && lastChar.charCodeAt(0) <= 0x303f)
    )
  ) {
    return false;
  }
  return true;
}

export function trimUntilPunctuation(s: string) {
  let result = s;
  while (result.length > 0 && !isLastCharPunctuation(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

export function parseKeyValue(template: string) {
  try {
    if (!template) {
      return [];
    }

    const keyValue: [string, string][] = [];

    for (const line of template.split("\n")) {
      const [key, value] = line.split("=");
      if (key && value) {
        keyValue.push([key, value]);
      }
    }

    return keyValue;
  } catch (error) {
    return [];
  }
}

export type sidebarToggleGroup = {
  key?: string;
  value?: string;
  type: "group";
  children: sidebarToggle[];
};

export type sidebarToggleGroupEnd = {
  key?: string;
  value?: string;
  type: "groupEnd";
};

export type sidebarToggle =
  | sidebarToggleGroup
  | sidebarToggleGroupEnd
  | {
      key?: string;
      value?: string;
      type: "caption";
    }
  | {
      key?: string;
      value?: string;
      type: "divider";
    }
  | {
      key: string;
      value: string;
      type: "select";
      options: string[];
    }
  | {
      key: string;
      value: string;
      type: "text" | "textarea" | undefined;
      options?: string[];
    };

export function parseToggleSyntax(template: string) {
  try {
    if (!template) {
      return [];
    }

    const keyValue: sidebarToggle[] = [];

    const splited = template.split("\n");

    for (const line of splited) {
      const [key, value, type, option] = line.split("=");
      if (type === "group" || type === "groupEnd" || type === "divider") {
        keyValue.push({
          key,
          value,
          type,
          children: [],
        });
      } else if (type === "caption" && value) {
        keyValue.push({
          key,
          value,
          type,
        });
      } else if (key && value) {
        keyValue.push({
          key,
          value,
          type:
            type === "select" || type === "text" || type === "textarea"
              ? type
              : undefined,
          options: option?.split(",") ?? [],
        });
      }
    }

    return keyValue;
  } catch (error) {
    console.error(error);
    return [];
  }
}

export function pickHashRand(cid: number, word: string) {
  let hashAddress = 5515;
  const rand = (word: string) => {
    for (let counter = 0; counter < word.length; counter++) {
      hashAddress = (hashAddress << 5) + hashAddress + word.charCodeAt(counter);
    }
    return hashAddress;
  };
  const randF = sfc32(rand(word), rand(word), rand(word), rand(word));
  const v = cid % 1000;
  for (let i = 0; i < v; i++) {
    randF();
  }
  return randF();
}

export const prebuiltAssetCommand = `
<Image Tag Instruction>Insert HTML image tags between paragraphs based on context.
Set src as keywords from the list below that matches current character, outfit, situation sentiment and etc.
print as many different images as possible. Use only available keywords.
if there are no matching keywords, try to put clostest matching image src.
try to put at least 1 image per output.
<keywords>{{join::{{chardisplayasset}}::,}}</keywords>
Example: <img src="{{ele::{{chardisplayasset}}::0}}">
<Image Tag Instruction>
`;

export function checkNullish(data: any) {
  return data === undefined || data === null;
}

export function appendLastPath(url, lastPath) {
  // Remove trailing slash from url if exists
  url = url.replace(/\/$/, "");

  // Remove leading slash from lastPath if exists
  lastPath = lastPath.replace(/^\//, "");

  // Concat the url and lastPath
  return url + "/" + lastPath;
}

export function simplifySchema(
  schema: any,
  args: {
    upperType?: boolean;
  } = {},
) {
  if (!schema || typeof schema !== "object") {
    console.error("Schema is not an object", schema);
    return schema;
  }

  if (Array.isArray(schema.type)) {
    if (schema.type.includes("null")) {
      schema.nullable = true;
    }
    schema.type = (schema.type as string[]).filter((v) => v !== "null")[0];
  }

  console.log("schema", schema);
  const result: any = {};

  if (schema.type) {
    result.type = (schema.type as string)?.toLowerCase();
  }
  if (schema.type === "object") {
    result.properties = {};
    for (const key in schema.properties) {
      result.properties[key] = simplifySchema(schema.properties[key], args);
    }
    if (schema.required && schema.required.length > 0) {
      result.required = schema.required;
    }
  }
  if (schema.type === "array") {
    result.items = simplifySchema(schema.items, args);
  }

  if (schema.type === "string" && schema.enum && schema.enum.length > 0) {
    result.enum = schema.enum;
  }

  if (schema.type === "string" && schema.format) {
    result.format = schema.format;
  }

  if (schema.nullable) {
    result.nullable = true;
  }

  if (schema.maxLength !== undefined && schema.maxLength !== null) {
    result.maxLength = schema.maxLength;
  }

  if (schema.minLength !== undefined && schema.minLength !== null) {
    result.minLength = schema.minLength;
  }

  if (schema.minProperties !== undefined && schema.minProperties !== null) {
    result.minProperties = schema.minProperties;
  }

  if (schema.maxProperties !== undefined && schema.maxProperties !== null) {
    result.maxProperties = schema.maxProperties;
  }

  if (schema.description) {
    result.description = schema.description;
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    console.log("anyOf", schema.anyOf);
    result.anyOf = schema.anyOf.map((v: any) => simplifySchema(v, args));
  }

  return result;
}

export const jsonOutputTrimmer = (data: string) => {
  data = data.replace(/<Thoughts>(.+?)<\/Thoughts>/gms, "").trim();
  if (data.startsWith("```json") && data.endsWith("```")) {
    data = data.slice(7, -3).trim();
  }
  return data.trim();
};
