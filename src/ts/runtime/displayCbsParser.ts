import type { createCbsRuntime } from "../parser/cbsRuntime";

type Parser = ReturnType<typeof createCbsRuntime>["parse"];

/** With no CBS opening brace or legacy character tag, the upstream scan only
 * appends the input unchanged. Still invoke its empty-input path: context
 * getters, group lookup, argument mutation and the call-stack limit must run.
 * CBS/malformed braces and legacy aliases always use the complete parser.
 */
export function createDisplayCbsParser(parse: Parser): Parser {
  return (data, arg) => {
    if (
      typeof data !== "string" ||
      data.includes("{") ||
      /<(user|char|bot)>/i.test(data)
    )
      return parse(data, arg);
    const initialized = parse("", arg);
    return initialized || data;
  };
}
