// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";
import {
  formatThoughtTools,
  type ThoughtToolLabels,
} from "../thoughtToolFormatting";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const baseline = "f9728b14c733d073168d8d0c6a8f34f8febf0304";
const originalSource = execFileSync(
  "git",
  ["show", baseline + ":src/ts/parser/parser.svelte.ts"],
  { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
);
const currentSource = readFileSync(
  new URL("../parser.svelte.ts", import.meta.url),
  "utf8",
);
function declaration(source: string) {
  const tree = ts.createSourceFile(
    "parser.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const node = tree.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "parseThoughtsAndTools",
  );
  if (!node?.body) throw Error("Missing original thought/tool formatter");
  return { tree, node };
}
const original = declaration(originalSource);
const compiled = ts.transpileModule(original.node.getText(original.tree), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.None,
  },
}).outputText;
const oracle = new Function(
  "language",
  compiled + "\nreturn parseThoughtsAndTools;",
) as (language: ThoughtToolLabels) => (data: string) => string;

function observe(
  format: (text: string, labels: () => ThoughtToolLabels) => string,
  text: string,
) {
  const reads: string[] = [];
  const language = {
    get cot() {
      reads.push("cot");
      return "Thoughts " + reads.length;
    },
    get toolCalled() {
      reads.push("tool");
      return "Tool {{tool}} " + reads.length;
    },
  };
  return { output: format(text, () => language), reads };
}
const reference = (text: string, labels: () => ThoughtToolLabels) =>
  oracle(labels())(text);
const same = (text: string) => {
  expect(observe(formatThoughtTools, text)).toEqual(observe(reference, text));
};

test("the ordinary/plugin fallback retains the exact pinned original body", () => {
  const current = declaration(currentSource);
  const printer = ts.createPrinter({ removeComments: true });
  expect(
    printer.printNode(
      ts.EmitHint.Unspecified,
      current.node.body!,
      current.tree,
    ),
  ).toBe(
    printer.printNode(
      ts.EmitHint.Unspecified,
      original.node.body!,
      original.tree,
    ),
  );
});

function actualSelection() {
  const tree = ts.createSourceFile(
    "parser.ts",
    currentSource,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression: ts.ConditionalExpression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isConditionalExpression(node) &&
      ts.isCallExpression(node.whenTrue) &&
      node.whenTrue.expression.getText(tree) === "formatThoughtTools"
    )
      expression = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!expression) throw Error("Missing actual parser formatter selection");
  return new Function(
    "data",
    "context",
    "language",
    "formatThoughtTools",
    "parseThoughtsAndTools",
    "return (" + expression.getText(tree) + ");",
  ) as (
    data: unknown,
    context: unknown,
    language: ThoughtToolLabels,
    fast: typeof formatThoughtTools,
    legacy: (text: string) => string,
  ) => string;
}
const select = actualSelection();
for (const scenario of [
  "ordinary",
  "plugins",
  "boxed-input",
  "entity",
] as const)
  test(
    "the actual ParseMarkdown selection preserves ordinary/plugin/nonprimitive fallback: " +
      scenario,
    () => {
      const calls: string[] = [];
      const language = {
        cot: "Synthetic thoughts",
        toolCalled: "Synthetic {{tool}}",
      };
      const text = "<Thoughts>x</Thoughts><tool_call>x\uf100name</tool_call>";
      const data = scenario === "boxed-input" ? new String(text) : text;
      const context =
        scenario === "ordinary"
          ? undefined
          : {
              settings: {
                plugins:
                  scenario === "plugins"
                    ? [{ name: "Synthetic metadata" }]
                    : [],
              },
            };
      const result = select(
        data,
        context,
        language,
        (text, labels) => {
          calls.push("fast");
          return formatThoughtTools(text, labels);
        },
        (text) => {
          calls.push("legacy");
          return oracle(language)(text);
        },
      );
      expect(result).toBe(oracle(language)(text));
      expect(calls).toEqual([scenario === "entity" ? "fast" : "legacy"]);
    },
  );

for (const [name, text] of [
  ["plain HTML and Unicode", "<table><tr><td>한글😀\ud800</td></tr></table>"],
  ["balanced", "before<Thoughts>inside</Thoughts>after"],
  ["nested", "<Thoughts>outer<Thoughts>inner</Thoughts>end</Thoughts>"],
  [
    "unmatched outer with matched inner",
    "<Thoughts>outer<Thoughts>inner</Thoughts>end",
  ],
  ["unmatched closing", "</Thoughts>text<Thoughts>x</Thoughts></Thoughts>"],
  ["empty", "<Thoughts></Thoughts><tool_call></tool_call>"],
  [
    "case and attributes",
    '<thoughts>x</thoughts><Thoughts x="y">z</Thoughts><tool_call x="y">x</tool_call>',
  ],
  [
    "tool calls in thought output",
    "<Thoughts><tool_call>a\uf100tool\uf100extra</tool_call></Thoughts><tool_call>x</tool_call>",
  ],
  [
    "malformed overlapping tools",
    "<tool_call>one<tool_call>two\uf100name</tool_call>three</tool_call>",
  ],
  [
    "tokens in quoted HTML",
    '<div title="<Thoughts>x</Thoughts>"><tool_call>line\n\uf100name</tool_call></div>',
  ],
] as const)
  test("literal thought/tool compatibility: " + name, () => same(text));

test("one thousand independently generated token/Unicode inputs match original output and lazy locale reads", () => {
  let seed = 0x51e7463;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = [
    "text",
    " ",
    "\n",
    "한글",
    "😀",
    "\ud800",
    "\u0000",
    "\uf100",
    "<Thoughts>",
    "</Thoughts>",
    "<Thoughts",
    "Thoughts>",
    "<tool_call>",
    "</tool_call>",
    "<tool_call",
    "<thoughts>",
    "</thoughts>",
    '<div title="',
    '">',
    "</div>",
    "<",
    ">",
    "&lt;Thoughts&gt;",
  ];
  for (let sample = 0; sample < 1000; sample++) {
    const count = next() % 80;
    const text = Array.from(
      { length: count },
      () => alphabet[next() % alphabet.length],
    ).join("");
    same(text);
  }
});

test("many unmatched outer openings still transform balanced inner regions with no locale reads for unmatched regions", () => {
  same("<Thoughts>".repeat(200) + "tail<Thoughts>matched</Thoughts>end");
});

test("locale getters may change the live language binding between thought and tool replacements", () => {
  function run(format: typeof formatThoughtTools) {
    const reads: string[] = [];
    let language: ThoughtToolLabels;
    const later: ThoughtToolLabels = {
      get cot() {
        reads.push("later-cot");
        return "Later";
      },
      get toolCalled() {
        reads.push("later-tool");
        return "Later {{tool}}";
      },
    };
    language = {
      get cot() {
        reads.push("first-cot");
        language = later;
        return "First";
      },
      get toolCalled() {
        reads.push("first-tool");
        return "First {{tool}}";
      },
    };
    const text =
      "<Thoughts>a</Thoughts><Thoughts>b</Thoughts><tool_call>x</tool_call>";
    return { output: format(text, () => language), reads };
  }
  // Evaluate the untouched original with a live binding, not an early captured label object.
  const liveOracle: typeof formatThoughtTools = (text, labels) => {
    const proxy = new Proxy({} as ThoughtToolLabels, {
      get: (_, key) => labels()[key as keyof ThoughtToolLabels],
    });
    return oracle(proxy)(text);
  };
  expect(run(formatThoughtTools)).toEqual(run(liveOracle));
});

test("tag-free large text has no locale reads and returns its exact primitive value", () => {
  const text = "<div>Neutral 한글😀</div>".repeat(10000);
  expect(
    formatThoughtTools(text, () => {
      throw Error("Unexpected locale read");
    }),
  ).toBe(text);
});
