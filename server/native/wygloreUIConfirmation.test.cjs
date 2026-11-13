"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { createHash } = require("node:crypto");
const {
  WYGLORE_RELEASE,
  LIFECYCLE_SEAM,
  instrumentWygloreLifecycle,
  readWygloreFixture,
} = require("./wygloreContract.cjs");
const {
  REVIEWED_CONFIRMATIONS,
  CONFIRMATION_PROFILE,
  validateWygloreConfirmationProfile,
  validateWygloreConfirmationSites,
  instrumentWygloreUIConfirmations,
} = require("./wygloreUIConfirmation.cjs");

function count(source, snippet) {
  return source.split(snippet).length - 1;
}

test("all reviewed UI confirmations and their Promise consumers adapt without changing any other original byte", async () => {
  const original = await readWygloreFixture(),
    executable = instrumentWygloreUIConfirmations(original);
  new vm.Script(executable);
  assert.equal(CONFIRMATION_PROFILE.calls.length, 26);
  assert.equal(CONFIRMATION_PROFILE.helpers.length, 2);
  assert.equal(CONFIRMATION_PROFILE.consumers.length, 3);
  assert.equal(CONFIRMATION_PROFILE.manualConsumers.length, 2);
  assert.equal(count(executable, "await __RISU_PLUGIN_UI_CONFIRM("), 26);
  assert.equal(count(original, "window.confirm("), 15);
  assert.equal(count(executable, "window.confirm("), 0);
  assert.equal(count(executable, LIFECYCLE_SEAM), 1);
  for (const site of REVIEWED_CONFIRMATIONS) {
    assert.equal(count(original, site.before), 1);
    assert.equal(count(executable, site.after), 1);
  }
  // Independently reverse the parsed compatibility expressions and exactly
  // three async prefixes. All remaining bytes must equal the author artifact.
  const adapted = executable.replace(LIFECYCLE_SEAM, ""),
    ast = acorn.parse(adapted, { ecmaVersion: "latest" });
  const ports = [],
    helpers = [],
    manualReturns = [],
    asyncStarts = new Set();
  walk.fullAncestor(ast, (node, _state, parents) => {
    if (
      node.type === "ReturnStatement" &&
      node.argument?.type === "CallExpression" &&
      node.argument.callee.type === "MemberExpression" &&
      node.argument.callee.property.name === "catch" &&
      node.argument.callee.object.type === "CallExpression" &&
      node.argument.callee.object.callee.name === "runManualColdStart"
    )
      manualReturns.push(node);
    if (
      node.type === "FunctionDeclaration" &&
      ["openDraft", "confirmLargeRecapSelection"].includes(node.id?.name)
    ) {
      assert.equal(node.async, true);
      asyncStarts.add(node.start);
    }
    if (
      node.type !== "AwaitExpression" ||
      node.argument.type !== "CallExpression"
    )
      return;
    const callee = node.argument.callee;
    if (callee.type !== "Identifier") return;
    if (callee.name === "__RISU_PLUGIN_UI_CONFIRM") {
      const owner = parents
        .slice(0, -1)
        .reverse()
        .find((parent) =>
          [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
          ].includes(parent.type),
        );
      assert.equal(owner.async, true);
      ports.push({ node, owner });
    }
    if (callee.name === "confirmLargeRecapSelection") helpers.push(node);
  });
  assert.equal(ports.length, 26);
  assert.equal(helpers.length, 2);
  assert.equal(manualReturns.length, 2);
  const edits = ports.map(({ node, owner }, index) => {
    const originalCall = CONFIRMATION_PROFILE.calls[index];
    if (!originalCall.function.async) asyncStarts.add(owner.start);
    assert.equal(adapted[node.start - 1], "(");
    assert.equal(adapted[node.end], ")");
    return {
      start: node.start - 1,
      end: node.end + 1,
      value: original.slice(originalCall.start, originalCall.end),
    };
  });
  helpers.forEach((node, index) => {
    const call = CONFIRMATION_PROFILE.helpers[index];
    edits.push({
      start: node.start - 1,
      end: node.end + 1,
      value: original.slice(call.start, call.end),
    });
  });
  assert.equal(asyncStarts.size, 3);
  for (const node of manualReturns) {
    assert.equal(adapted.slice(node.start, node.start + 7), "return ");
    edits.push({ start: node.start, end: node.start + 7, value: "" });
  }
  for (const start of asyncStarts) {
    assert.equal(adapted.slice(start, start + 6), "async ");
    edits.push({ start, end: start + 6, value: "" });
  }
  let reversed = adapted;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    reversed =
      reversed.slice(0, edit.start) + edit.value + reversed.slice(edit.end);
  assert.equal(reversed, original);
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    WYGLORE_RELEASE.sha256,
  );
});

test("native execution retains all three original synchronous UI sites and its unchanged lifecycle seam", async () => {
  const original = await readWygloreFixture();
  const native = instrumentWygloreLifecycle(original);
  assert.equal(count(native, "window.confirm("), 15);
  assert.equal(count(native, "__RISU_PLUGIN_UI_CONFIRM"), 0);
  for (const site of REVIEWED_CONFIRMATIONS)
    assert.equal(count(native, site.before), 1);
  assert.equal(native.replace(LIFECYCLE_SEAM, ""), original);
});

test("confirmation seam refuses a changed distributed source before it can run", async () => {
  const original = await readWygloreFixture();
  assert.throws(
    () => instrumentWygloreUIConfirmations(original + "\n"),
    /bundle hash differs/,
  );
  assert.throws(
    () =>
      instrumentWygloreUIConfirmations(
        original.replace(
          REVIEWED_CONFIRMATIONS[0].before,
          REVIEWED_CONFIRMATIONS[0].after,
        ),
      ),
    /bundle hash differs/,
  );
});

test("exact reviewed snippet guards reject missing, duplicated, or already adapted sites independently", async () => {
  const original = await readWygloreFixture();
  assert.equal(validateWygloreConfirmationSites(original), true);
  for (const site of REVIEWED_CONFIRMATIONS) {
    assert.throws(
      () => validateWygloreConfirmationSites(original.replace(site.before, "")),
      new RegExp(site.id),
    );
    assert.throws(
      () => validateWygloreConfirmationSites(original + site.before),
      new RegExp(site.id),
    );
    assert.throws(
      () =>
        validateWygloreConfirmationSites(
          original.replace(site.before, site.after),
        ),
      new RegExp(site.id),
    );
    assert.throws(
      () => validateWygloreConfirmationSites(original + site.after),
      new RegExp(site.id),
    );
  }
});

test("the reviewed AST profile refuses altered call counts, warning bodies, and discarded Promise consumers", async () => {
  const original = await readWygloreFixture();
  assert.equal(validateWygloreConfirmationProfile(original).calls.length, 26);
  assert.throws(
    () =>
      validateWygloreConfirmationProfile(original + ";confirm('unexpected')"),
    /execution shape|profile/,
  );
  const helper = CONFIRMATION_PROFILE.helpers[0];
  assert.throws(
    () =>
      validateWygloreConfirmationProfile(
        original.slice(0, helper.start) + "true" + original.slice(helper.end),
      ),
    /profile/,
  );
  const consumer = CONFIRMATION_PROFILE.consumers.find(
    (call) => call.callee === "openDraft",
  );
  const fn = consumer.function;
  const discarded =
    "()=>{" + original.slice(consumer.start, consumer.end) + "}";
  assert.throws(
    () =>
      validateWygloreConfirmationProfile(
        original.slice(0, fn.start) + discarded + original.slice(fn.end),
      ),
    /profile/,
  );
  const call = CONFIRMATION_PROFILE.calls.find(
    (call) => call.id === "loss-recovery",
  );
  const changed =
    original.slice(0, call.start) +
    original.slice(call.start, call.end).replace("uC190", "uC191") +
    original.slice(call.end);
  assert.notEqual(changed, original);
  assert.throws(() => validateWygloreConfirmationProfile(changed), /profile/);
});
