"use strict";
const acorn = require("acorn");
const walk = require("acorn-walk");
const { createHash } = require("node:crypto");
const CONFIRMATION_PROFILE = require("./wygloreUIConfirmationProfile.cjs");
const CONFIRMATION_PROFILE_320 = require("./wygloreUIConfirmationProfile320.cjs");
const {
  verifyWygloreScript,
  getWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");

// The import anchors remain separately checked because their file-picker /
// overwrite ordering is part of the reviewed browser interaction contract.
const REVIEWED_CONFIRMATIONS = Object.freeze(
  [
    {
      id: "memory-import",
      source: "src/ui/tabs/settings.js",
      line: 1744,
      before:
        'btnImport.addEventListener("click",async()=>{try{let parsed=await pickJSONFile();if(!window.confirm("\\uC120\\uD0DD\\uD55C \\uD30C\\uC77C\\uC758 \\uAE30\\uC5B5\\uB730\\uB85C \\uD604\\uC7AC \\uAE30\\uC5B5\\uB730\\uC744 \\uC644\\uC804\\uD788 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?")){',
      after:
        'btnImport.addEventListener("click",async()=>{try{let parsed=await pickJSONFile();if(!(await __RISU_PLUGIN_UI_CONFIRM("\\uC120\\uD0DD\\uD55C \\uD30C\\uC77C\\uC758 \\uAE30\\uC5B5\\uB730\\uB85C \\uD604\\uC7AC \\uAE30\\uC5B5\\uB730\\uC744 \\uC644\\uC804\\uD788 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?"))){',
    },
    {
      id: "settings-import",
      source: "src/ui/tabs/settings.js",
      line: 3726,
      before:
        'btnImportSettings.addEventListener("click",async()=>{try{let parsed=await pickJSONFile(),keyCount=parsed?.params?Object.keys(parsed.params).length:0;if(!window.confirm(`\\uC774 \\uD30C\\uC77C\\uC758 \\uC124\\uC815 ${keyCount}\\uAC1C \\uD56D\\uBAA9\\uC73C\\uB85C \\uD604\\uC7AC \\uC124\\uC815\\uC744 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uB730\\uC758 \\uAE30\\uC5B5\\uACFC \\uC5F0\\uACB0\\uC740 \\uBCF4\\uC874\\uB429\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?`)){',
      after:
        'btnImportSettings.addEventListener("click",async()=>{try{let parsed=await pickJSONFile(),keyCount=parsed?.params?Object.keys(parsed.params).length:0;if(!(await __RISU_PLUGIN_UI_CONFIRM(`\\uC774 \\uD30C\\uC77C\\uC758 \\uC124\\uC815 ${keyCount}\\uAC1C \\uD56D\\uBAA9\\uC73C\\uB85C \\uD604\\uC7AC \\uC124\\uC815\\uC744 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uB730\\uC758 \\uAE30\\uC5B5\\uACFC \\uC5F0\\uACB0\\uC740 \\uBCF4\\uC874\\uB429\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?`))){',
    },
    {
      id: "full-import",
      source: "src/ui/tabs/settings.js",
      line: 3755,
      before:
        'btnImportAll.addEventListener("click",async()=>{try{let parsed=await pickJSONFile(),uc=parsed?.snapshot?.units?.length??parsed?.unitCount??"?";if(!window.confirm(`\\uC774 \\uD30C\\uC77C\\uC758 \\uC804\\uCCB4 \\uB730 (\\uAE30\\uC5B5 ${uc}\\uAC1C) \\uACFC \\uC124\\uC815\\uC73C\\uB85C \\uD604\\uC7AC \\uC0C1\\uD0DC\\uB97C \\uC644\\uC804\\uD788 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?`)){',
      after:
        'btnImportAll.addEventListener("click",async()=>{try{let parsed=await pickJSONFile(),uc=parsed?.snapshot?.units?.length??parsed?.unitCount??"?";if(!(await __RISU_PLUGIN_UI_CONFIRM(`\\uC774 \\uD30C\\uC77C\\uC758 \\uC804\\uCCB4 \\uB730 (\\uAE30\\uC5B5 ${uc}\\uAC1C) \\uACFC \\uC124\\uC815\\uC73C\\uB85C \\uD604\\uC7AC \\uC0C1\\uD0DC\\uB97C \\uC644\\uC804\\uD788 \\uB36E\\uC5B4\\uC501\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD560\\uAE4C\\uC694?`))){',
    },
  ].map((site) => Object.freeze(site)),
);

// 3.2.0 captures and rechecks the import target before consent. Preserve these
// original guards and the ordering of the original file selection verbatim.
const REVIEWED_CONFIRMATIONS_320 = Object.freeze(
  REVIEWED_CONFIRMATIONS.map((site) => {
    const oldPrefix =
      site.id === "memory-import"
        ? "let parsed=await pickJSONFile();if("
        : 'let parsed=await pickJSONFile(),uc=parsed?.snapshot?.units?.length??parsed?.unitCount??"?";if(';
    const newPrefix =
      site.id === "memory-import"
        ? "let target=captureSnapshotRestoreTarget(),parsed=await pickJSONFile();if(await target.assertSelected(),"
        : 'let target=captureSnapshotRestoreTarget(),parsed=await pickJSONFile();await target.assertSelected();let uc=parsed?.snapshot?.units?.length??parsed?.unitCount??"?";if(';
    return Object.freeze({
      ...site,
      source: "WygLoreLeaf-latest.js",
      line: CONFIRMATION_PROFILE_320.calls.find((call) => call.id === site.id)
        .line,
      before: site.before.replace(oldPrefix, newPrefix),
      after: site.after.replace(oldPrefix, newPrefix),
    });
  }),
);

function occurrences(script, snippet) {
  let count = 0,
    offset = 0;
  while ((offset = script.indexOf(snippet, offset)) !== -1) {
    count++;
    offset += snippet.length;
  }
  return count;
}
/** Pure guard for exact reviewed snippets, also testable independently of SHA. */
function validateWygloreConfirmationSites(
  script,
  sites = REVIEWED_CONFIRMATIONS,
) {
  if (typeof script !== "string")
    throw Error("WygLore execution source is required");
  for (const site of sites) {
    if (
      occurrences(script, site.before) !== 1 ||
      occurrences(script, site.after) !== 0
    )
      throw Error(
        "WygLore reviewed confirmation site count differs: " + site.id,
      );
  }
  return true;
}

function isFunction(node) {
  return [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(node.type);
}
function collectProfile(script) {
  const ast = acorn.parse(script, { ecmaVersion: "latest" });
  const digest = (node) =>
    createHash("sha256")
      .update(script.slice(node.start, node.end))
      .digest("hex");
  const metadata = (node) => ({
    start: node.start,
    end: node.end,
    sha256: digest(node),
  });
  const functionMetadata = (node) => ({
    ...metadata(node),
    type: node.type,
    name: node.id?.name ?? null,
    async: node.async,
  });
  const calls = [],
    helpers = [],
    consumers = [],
    functions = [],
    manualConsumers = [];
  walk.fullAncestor(ast, (node, _state, parents) => {
    if (
      node.type === "FunctionDeclaration" &&
      ["createBtn", "openDraft", "confirmLargeRecapSelection"].includes(
        node.id?.name,
      )
    )
      functions.push(functionMetadata(node));
    if (node.type !== "CallExpression") return;
    const callee = node.callee,
      fn = parents.slice(0, -1).reverse().find(isFunction);
    if (
      (callee.type === "Identifier" && callee.name === "confirm") ||
      (callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.name === "confirm")
    ) {
      if (
        !fn ||
        node.optional ||
        node.arguments.length !== 1 ||
        node.arguments[0].type === "SpreadElement"
      )
        throw Error("WygLore confirmation execution shape differs");
      calls.push({
        ...metadata(node),
        callee: script.slice(callee.start, callee.end),
        calleeEnd: callee.end,
        arity: node.arguments.length,
        function: functionMetadata(fn),
      });
    }
    if (
      callee.type === "Identifier" &&
      callee.name === "confirmLargeRecapSelection"
    )
      helpers.push({ ...metadata(node), function: functionMetadata(fn) });
    if (callee.type === "Identifier" && callee.name === "runManualColdStart") {
      const statement = parents
        .slice(0, -1)
        .reverse()
        .find((parent) => parent.type === "ExpressionStatement");
      if (
        !statement ||
        fn.type !== "ArrowFunctionExpression" ||
        fn.body.type !== "BlockStatement"
      )
        throw Error("WygLore manual recovery Promise consumer differs");
      manualConsumers.push({
        ...metadata(node),
        function: functionMetadata(fn),
        statement: metadata(statement),
      });
    }
    if (
      callee.type === "Identifier" &&
      ["openDraft", "openProseDraft"].includes(callee.name)
    ) {
      const property = parents.findLast(
        (parent) => parent.type === "Property" && parent.value === fn,
      );
      consumers.push({
        ...metadata(node),
        callee: callee.name,
        function: functionMetadata(fn),
        returnsPromise: fn.body === node,
        property: property?.key?.name ?? null,
      });
    }
  });
  return { calls, helpers, consumers, functions, manualConsumers };
}

/** SHA is checked before execution; the separate exact AST/source profile also
 * rejects call-count, synchronous-function, or Promise-consumer drift. */
function validateWygloreConfirmationProfile(
  script,
  expected = CONFIRMATION_PROFILE,
) {
  const actual = collectProfile(script);
  if (
    actual.calls.length !== 26 ||
    actual.helpers.length !== 2 ||
    actual.consumers.length !== 3 ||
    actual.functions.length !== 3 ||
    actual.manualConsumers.length !== 2
  )
    throw Error("WygLore reviewed confirmation profile counts differ");
  actual.calls = actual.calls.map((site, index) => ({
    ...site,
    id: expected.calls[index].id,
    source: expected.calls[index].source,
    line: expected.calls[index].line,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error("WygLore reviewed confirmation AST/source profile differs");
  return actual;
}

function confirmationEdits(script, profile) {
  const edits = [];
  for (const call of profile.calls)
    edits.push({
      start: call.start,
      end: call.end,
      replacement: `(await __RISU_PLUGIN_UI_CONFIRM(${script.slice(call.calleeEnd + 1, call.end - 1)}))`,
    });
  for (const call of profile.helpers)
    edits.push({
      start: call.start,
      end: call.end,
      replacement: `(await ${script.slice(call.start, call.end)})`,
    });
  // The two synchronous confirmation owners and openDraft need async. Its
  // three source-profiled createBtn consumers already return its Promise.
  const asynchronous = new Set(
    profile.calls
      .filter((call) => !call.function.async)
      .map((call) => call.function.start),
  );
  asynchronous.add(
    profile.functions.find((fn) => fn.name === "openDraft").start,
  );
  if (
    asynchronous.size !== 3 ||
    profile.consumers.some(
      (call) => !call.returnsPromise || call.property !== "onClick",
    )
  )
    throw Error("WygLore confirmation Promise propagation differs");
  for (const start of asynchronous)
    edits.push({ start, end: start, replacement: "async " });
  for (const consumer of profile.manualConsumers)
    edits.push({
      start: consumer.statement.start,
      end: consumer.statement.start,
      replacement: "return ",
    });
  return edits.sort((a, b) => b.start - a.start);
}
function instrumentWygloreUIConfirmations(script) {
  verifyWygloreScript(script);
  const release = getWygloreRelease(script);
  const sites =
    release.version === "3.2.0"
      ? REVIEWED_CONFIRMATIONS_320
      : REVIEWED_CONFIRMATIONS;
  const expected =
    release.version === "3.2.0"
      ? CONFIRMATION_PROFILE_320
      : CONFIRMATION_PROFILE;
  validateWygloreConfirmationSites(script, sites);
  const profile = validateWygloreConfirmationProfile(script, expected);
  let executable = instrumentWygloreLifecycle(script);
  for (const edit of confirmationEdits(script, profile))
    executable =
      executable.slice(0, edit.start) +
      edit.replacement +
      executable.slice(edit.end);
  for (const site of sites) {
    if (
      occurrences(executable, site.before) !== 0 ||
      occurrences(executable, site.after) !== 1
    )
      throw Error(
        "WygLore reviewed confirmation transformation differs: " + site.id,
      );
  }
  const adapted = acorn.parse(executable, { ecmaVersion: "latest" });
  let ports = 0,
    unreviewed = 0,
    awaitedHelpers = 0,
    returnedManual = 0;
  walk.ancestor(adapted, {
    CallExpression(node, parents) {
      const callee = node.callee,
        parent = parents.at(-2);
      if (
        callee.type === "Identifier" &&
        callee.name === "__RISU_PLUGIN_UI_CONFIRM"
      ) {
        if (parent.type !== "AwaitExpression")
          throw Error("WygLore UI confirmation was not awaited");
        ports++;
      }
      if (
        (callee.type === "Identifier" && callee.name === "confirm") ||
        (callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.name === "confirm")
      )
        unreviewed++;
      if (
        callee.type === "Identifier" &&
        callee.name === "confirmLargeRecapSelection" &&
        parent.type === "AwaitExpression"
      )
        awaitedHelpers++;
      if (
        callee.type === "Identifier" &&
        callee.name === "runManualColdStart" &&
        parents.some((parent) => parent.type === "ReturnStatement")
      )
        returnedManual++;
    },
  });
  if (
    ports !== 26 ||
    unreviewed !== 0 ||
    awaitedHelpers !== 2 ||
    returnedManual !== 2
  )
    throw Error("WygLore transformed confirmation profile differs");
  return executable;
}
module.exports = {
  REVIEWED_CONFIRMATIONS,
  REVIEWED_CONFIRMATIONS_320,
  CONFIRMATION_PROFILE,
  CONFIRMATION_PROFILE_320,
  validateWygloreConfirmationSites,
  validateWygloreConfirmationProfile,
  instrumentWygloreUIConfirmations,
};
