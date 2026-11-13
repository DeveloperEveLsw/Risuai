import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = "f9728b14c733d073168d8d0c6a8f34f8febf0304";
const specs = [
  {
    source: "src/ts/process/index.svelte.ts",
    core: "src/ts/process/generationRuntime.ts",
    factory: "createGenerationRuntime",
    manifest: "docs/generation-ports.json",
  },
  {
    source: "src/ts/process/modules.ts",
    core: "src/ts/process/moduleRuntime.ts",
    factory: "createModuleRuntime",
    manifest: "docs/moduleRuntime-ports.json",
  },
  {
    source: "src/ts/process/scripts.ts",
    core: "src/ts/process/scriptRuntime.ts",
    factory: "createScriptRuntime",
    manifest: "docs/scriptRuntime-ports.json",
  },
  {
    source: "src/ts/process/scriptings.ts",
    core: "src/ts/process/scriptingRuntime.ts",
    factory: "createScriptingRuntime",
    manifest: "docs/scriptingRuntime-ports.json",
  },
  {
    source: "src/ts/util.ts",
    core: "src/ts/utilStateRuntime.ts",
    factory: "createUtilStateRuntime",
    manifest: "docs/utilStateRuntime-ports.json",
  },
  {
    source: "src/ts/parser/chatVar.svelte.ts",
    core: "src/ts/parser/chatVariableRuntime.ts",
    factory: "createChatVariableRuntime",
    manifest: "docs/chatVariableRuntime-ports.json",
  },
  {
    source: "src/ts/characters.ts",
    core: "src/ts/characterFactory.ts",
    factory: "createCharacterFactory",
    manifest: "docs/characterFactory-ports.json",
  },
  {
    source: "src/ts/process/triggers.ts",
    core: "src/ts/process/triggerRuntime.ts",
    factory: "createTriggerRuntime",
    manifest: "docs/triggerRuntime-ports.json",
  },
  {
    source: "src/ts/process/lorebook.svelte.ts",
    core: "src/ts/process/lorebookRuntime.ts",
    factory: "createLorebookRuntime",
    manifest: "docs/lorebookRuntime-ports.json",
  },
  {
    source: "src/ts/model/modellist.ts",
    core: "src/ts/model/modelRuntime.ts",
    factory: "createModelRuntime",
    manifest: "docs/modelRuntime-ports.json",
  },
  {
    source: "src/ts/parser/chatML.ts",
    core: "src/ts/parser/chatMLRuntime.ts",
    factory: "createChatMLRuntime",
    manifest: "docs/chatMLRuntime-ports.json",
  },
];

for (const name of [
  "tokenizerRuntime",
  "parameterRuntime",
  "networkRuntime",
  "responsesRuntime",
  "completionRuntime",
  "googleRuntime",
  "utilBinaryRuntime",
  "requestRuntime",
  "exampleMessageRuntime",
  "modelStringRuntime",
  "chatTemplateRuntime",
  "inlayScreenRuntime",
  "addinfoRuntime",
  "embeddingRuntime",
  "jsonSchemaRuntime",
  "settingsRuntime",
  "promptTemplateRuntime",
  "presetRuntime",
  "hypaPresetRuntime",
  "hypaSummaryRuntime",
  "hypaV3Runtime",
  "embeddingV2Runtime",
  "contextualEmbeddingRuntime",
  "supaMemoryRuntime",
  "stringlizeRuntime",
  "presetStateRuntime",
  "groupOrderRuntime",
]) {
  const manifest = "docs/" + name + "-ports.json";
  const data = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
  specs.push({
    source: data.source,
    core: data.core,
    factory: data.factory,
    manifest,
  });
}
function findDeclaration(statements, name) {
  for (const node of statements) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    )
      return node;
    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations.find(
        (d) => d.name.text === name,
      );
      if (declaration) return declaration;
    }
  }
}

function reversePorts(names, importLoaders = [], expressionPorts = []) {
  return (context) => {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "host"
      ) {
        const expressionPort = expressionPorts.find(
          (item) => item.name === node.expression.name.text,
        );
        if (
          expressionPort &&
          node.arguments.length === expressionPort.parameters.length
        ) {
          const source = ts.createSourceFile(
            "port-expression.ts",
            "(" + expressionPort.expression + ");",
            ts.ScriptTarget.Latest,
            true,
          );
          const expression = source.statements[0].expression;
          const args = new Map(
            expressionPort.parameters.map((name, i) => [
              name,
              node.arguments[i],
            ]),
          );
          const substitute = (part) =>
            ts.isIdentifier(part) && args.has(part.text)
              ? ts.visitNode(args.get(part.text), visit)
              : ts.visitEachChild(part, substitute, context);
          return ts.visitNode(expression, substitute);
        }
        const loader = importLoaders.find(
          (item) => item.name === node.expression.name.text,
        );
        if (loader && node.arguments.length === 0)
          return ts.factory.createCallExpression(
            ts.factory.createToken(ts.SyntaxKind.ImportKeyword),
            undefined,
            [ts.factory.createStringLiteral(loader.specifier)],
          );
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "host"
      ) {
        if (node.name.text === "snapshot")
          return ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier("$state"),
            "snapshot",
          );
        if (names.has(node.name.text))
          return ts.factory.createIdentifier(node.name.text);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  };
}

function fingerprint(node, propertyName = false) {
  if (ts.isRegularExpressionLiteral(node)) {
    const end = node.text.lastIndexOf("/");
    return {
      kind: "RegularExpressionLiteral",
      text:
        node.text.slice(0, end + 1) +
        node.text
          .slice(end + 1)
          .split("")
          .sort()
          .join(""),
      children: [],
    };
  }
  if (propertyName && (ts.isIdentifier(node) || ts.isStringLiteral(node)))
    return { kind: "PropertyKey", text: node.text, children: [] };
  if (
    ts.isShorthandPropertyAssignment(node) &&
    !node.objectAssignmentInitializer
  )
    return {
      kind: "PropertyAssignment",
      children: [fingerprint(node.name, true), fingerprint(node.name)],
    };
  if (node.kind === ts.SyntaxKind.ExportKeyword) return undefined;
  if (ts.isParenthesizedExpression(node)) return fingerprint(node.expression);
  if (ts.isParenthesizedTypeNode(node)) return fingerprint(node.type);
  // Notification delivery is intentionally the host's capability.
  if (
    ts.isIfStatement(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "notification" &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "db" &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === "DBState"
  )
    return undefined;
  const children = [];
  ts.forEachChild(node, (child) => {
    const isPropertyName =
      (ts.isPropertyAssignment(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node)) &&
      child === node.name;
    const result = fingerprint(child, isPropertyName);
    if (result !== undefined) children.push(result);
  });
  return { kind: ts.SyntaxKind[node.kind], text: node.text, children };
}

function firstDifference(a, b, path = "root") {
  if (a?.kind !== b?.kind || a?.text !== b?.text)
    return {
      path,
      expected: { kind: a?.kind, text: a?.text },
      actual: { kind: b?.kind, text: b?.text },
    };
  if (a.children.length !== b.children.length)
    return {
      path,
      expectedChildren: a.children.length,
      actualChildren: b.children.length,
    };
  for (let i = 0; i < a.children.length; i++) {
    const difference = firstDifference(
      a.children[i],
      b.children[i],
      path + "." + i,
    );
    if (difference) return difference;
  }
}
const results = [];
for (const spec of specs) {
  const originalText = execFileSync(
    "git",
    ["show", baseline + ":" + spec.source],
    { cwd: root, encoding: "utf8" },
  );
  const original = ts.createSourceFile(
    spec.source,
    originalText,
    ts.ScriptTarget.Latest,
    true,
  );
  const core = ts.createSourceFile(
    spec.core,
    readFileSync(resolve(root, spec.core), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const manifest = JSON.parse(
    readFileSync(resolve(root, spec.manifest), "utf8"),
  );
  const factory = core.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name.text === spec.factory,
  );
  const names = new Set([
    ...manifest.ports.map((p) => p.name),
    ...(manifest.globals ?? []),
    "doingChat",
    "chatProcessStage",
    "abortChat",
    "requestTokenParts",
    "previewFormated",
    "previewBody",
    "safeStructuredClone",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]);
  const selected =
    manifest.functions ??
    original.statements
      .filter(ts.isFunctionDeclaration)
      .map((n) => n.name.text);
  for (const name of [...selected, ...(manifest.classes ?? [])]) {
    const originalFunction = findDeclaration(original.statements, name);
    const migrated = findDeclaration(factory.body.statements, name);
    if (!originalFunction || !migrated)
      throw new Error("Missing function: " + name);
    const transformed = ts.transform(migrated, [
      reversePorts(names, manifest.importLoaders, manifest.expressionPorts),
    ]);
    const expected = JSON.stringify(fingerprint(originalFunction));
    const actual = JSON.stringify(fingerprint(transformed.transformed[0]));
    const equal = expected === actual;
    const originalHash = createHash("sha256").update(expected).digest("hex");
    const extractedHash = createHash("sha256").update(actual).digest("hex");
    const policy = manifest.invocationPolicies?.find(
      (item) => item.function === name,
    );
    const policyVerified =
      !equal &&
      policy?.originalHash === originalHash &&
      policy?.extractedHash === extractedHash;
    if (!equal && !policyVerified)
      console.log(
        JSON.stringify({
          source: spec.source,
          function: name,
          difference: firstDifference(JSON.parse(expected), JSON.parse(actual)),
        }),
      );
    results.push({
      source: spec.source,
      function: name,
      originalAlgorithmPreserved: equal,
      originalHash,
      extractedHash,
      ...(policyVerified
        ? {
            verifiedInvocationPolicy: policy.description,
            behavioralTests: policy.tests,
          }
        : {}),
    });
    transformed.dispose();
  }
}
const report = {
  verifiedAt: new Date().toISOString(),
  baseline,
  results,
  scope:
    "Structural comparison of selected upstream function, class and callable declarations, including generation, provider requests, tokenizers, settings, modules, regex, Lua, triggers, lorebook and data helpers, reversing injected ports to their source-local names and declared expression ports to their original mutations. Ignores export modifiers, parentheses, equivalent object-key/shorthand notation, regex flag order and the explicitly migrated DBState notification branch and declared module-loader ports. The statistics/activity ports deliberately change native persistence and require separate behavioral tests; Lua invocation cleanup/error policies and Google streaming UTF-8/SSE and pipe-error policies are explicit, hash-pinned exceptions reported separately from originalAlgorithmPreserved, with behavioral tests. All selected declarations remain compared; this comparison does not prove their bindings, complete native-host integration, providers or browser compatibility.",
};
writeFileSync(
  resolve(root, "docs/engine-extraction-audit.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (
  results.some(
    (r) => !r.originalAlgorithmPreserved && !r.verifiedInvocationPolicy,
  )
)
  process.exitCode = 1;
