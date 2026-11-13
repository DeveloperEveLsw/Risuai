export type ThoughtToolLabels = { cot: string; toolCalled: string };

/** Same primitive-string result as the original formatter. Pair literal tokens
 * once, then emit only the outer matched regions; unmatched outer openings
 * remain literal and can still contain matched inner regions. No HTML parsing,
 * output cache, script omission or locale capture is performed here.
 */
export function formatThoughtTools(
  data: string,
  labels: () => ThoughtToolLabels,
): string {
  let result = data;
  if (data.includes("<Thoughts>")) {
    const tokens = /<\/?Thoughts>/g;
    const stack: number[] = [];
    const openings: number[] = [];
    const pairs = new Map<number, number>();
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(data))) {
      if (token[0] === "<Thoughts>") {
        stack.push(token.index);
        openings.push(token.index);
      } else if (stack.length) {
        pairs.set(stack.pop()!, token.index);
      }
    }
    let start = 0;
    const parts: string[] = [];
    for (const open of openings) {
      const close = pairs.get(open);
      if (open < start || close === undefined) continue;
      parts.push(
        data.slice(start, open),
        `<details><summary>${labels().cot}</summary>${data.substring(open + 10, close)}</details>`,
      );
      start = close + 11;
    }
    if (parts.length) {
      parts.push(data.slice(start));
      result = parts.join("");
    }
  }
  if (!result.includes("<tool_call>")) return result;
  return result.replace(
    /<tool_call>(.+?)<\/tool_call>/gms,
    (full, txt: string) => {
      return `<div class="x-risu-tool-call">🛠️ ${labels().toolCalled.replace("{{tool}}", txt.split("\uf100")?.[1] ?? "unknown")}</div>\n\n`;
    },
  );
}
