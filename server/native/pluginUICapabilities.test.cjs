"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { createPluginUICapabilities } = require("./pluginUICapabilities.cjs");
const { createPluginUIEffects } = require("./pluginUIEffects.cjs");
const { randomUUID } = require("node:crypto");

async function windows(t, count = 1) {
  const { Window } = await import(
    pathToFileURL(require.resolve("happy-dom")).href
  );
  const values = Array.from({ length: count }, () => new Window());
  const guards = [];
  t.after(async () => {
    for (const guard of guards) guard.close();
    for (const window of values) {
      await window.happyDOM.cancelAsync();
      window.close();
    }
  });
  return {
    values,
    guard(window, options) {
      const guard = createPluginUICapabilities(window, options);
      guards.push(guard);
      return guard;
    },
  };
}
function blocked(action, guard, capability) {
  let first;
  try {
    action();
  } catch (error) {
    first = error;
  }
  assert.equal(first?.code, "PLUGIN_UI_CAPABILITY_REQUIRED");
  assert.equal(first.details.capability, capability);
  assert.throws(
    () => guard.assertHealthy(),
    (error) => error === first,
  );
  return first;
}
test("file picker requests fail immediately while ordinary inputs remain usable", async (t) => {
  const f = await windows(t),
    window = f.values[0],
    guard = f.guard(window);
  const normal = window.document.createElement("input");
  normal.type = "checkbox";
  let clicks = 0;
  normal.addEventListener("click", () => clicks++);
  normal.click();
  assert.equal(clicks, 1);
  guard.assertHealthy();
  const picker = window.document.createElement("input");
  picker.setAttribute("type", "FILE");
  picker.addEventListener("click", () =>
    assert.fail("picker must not dispatch"),
  );
  blocked(() => picker.click(), guard, "file selection");
});
test("download anchors fail before dispatch including an empty download attribute", async (t) => {
  const f = await windows(t),
    window = f.values[0],
    guard = f.guard(window);
  const link = window.document.createElement("a");
  link.setAttribute("download", "");
  link.href = "data:application/json,%7B%7D";
  link.addEventListener("click", () =>
    assert.fail("download must not dispatch"),
  );
  blocked(() => link.click(), guard, "file download");
});
test("object URL guards are confined to their UI window and restore native URL", async (t) => {
  const f = await windows(t, 2),
    [window, peer] = f.values;
  const original = window.URL,
    peerURL = peer.URL,
    nativeCreate = URL.createObjectURL;
  const guard = f.guard(window);
  assert.equal(
    new guard.globals.URL("/hello", "https://example.invalid").href,
    "https://example.invalid/hello",
  );
  blocked(
    () => guard.globals.URL.createObjectURL(new Blob(["private"])),
    guard,
    "object URLs and file export",
  );
  assert.equal(peer.URL, peerURL);
  assert.equal(URL.createObjectURL, nativeCreate);
  const url = URL.createObjectURL(new Blob(["native"]));
  URL.revokeObjectURL(url);
  guard.close();
  assert.equal(window.URL, original);
  assert.equal(URL.createObjectURL, nativeCreate);
});
test("shared prototypes route to the actual owner and survive another owner closing", async (t) => {
  const f = await windows(t, 3),
    [left, right, unguarded] = f.values;
  const original = left.HTMLInputElement.prototype.click;
  const a = f.guard(left),
    b = f.guard(right);
  const peer = unguarded.document.createElement("input");
  peer.type = "button";
  let clicks = 0;
  peer.addEventListener("click", () => clicks++);
  peer.click();
  assert.equal(clicks, 1);
  a.close();
  const input = right.document.createElement("input");
  input.type = "file";
  blocked(() => input.click(), b, "file selection");
  b.close();
  assert.equal(right.HTMLInputElement.prototype.click, original);
});
test("caught original export errors remain sticky and cannot be treated as success", async (t) => {
  const f = await windows(t),
    window = f.values[0],
    guard = f.guard(window);
  function originalExport() {
    try {
      guard.globals.URL.createObjectURL(
        new Blob([JSON.stringify({ safe: true })]),
      );
      return true;
    } catch {
      return false;
    }
  }
  assert.equal(originalExport(), false);
  assert.throws(() => guard.assertHealthy(), {
    code: "PLUGIN_UI_CAPABILITY_REQUIRED",
  });
  const same = blocked(
    () => window.document.execCommand("copy"),
    guard,
    "object URLs and file export",
  );
  assert.equal(same.details.capability, "object URLs and file export");
});
test("clipboard Promise and legacy fallback errors remain sticky when caught", async (t) => {
  const f = await windows(t),
    window = f.values[0],
    guard = f.guard(window);
  let fallback = false;
  async function originalCopy() {
    try {
      await guard.globals.navigator.clipboard.writeText("synthetic command");
    } catch {
      fallback = true;
      try {
        window.document.execCommand("COPY");
      } catch {}
    }
  }
  await originalCopy();
  assert.equal(fallback, true);
  assert.throws(() => guard.assertHealthy(), {
    code: "PLUGIN_UI_CAPABILITY_REQUIRED",
  });
});
test("FileReader and direct clipboard reads fail explicitly without a partial file read", async (t) => {
  const f = await windows(t, 2),
    [readerWindow, clipboardWindow] = f.values;
  const reader = f.guard(readerWindow),
    clipboard = f.guard(clipboardWindow);
  blocked(() => new reader.globals.FileReader(), reader, "file reading");
  blocked(
    () => clipboard.globals.navigator.clipboard.readText(),
    clipboard,
    "clipboard access",
  );
});
test("an original export catching a bridge staging limit still poisons its checkpoint", async (t) => {
  const f = await windows(t),
    window = f.values[0],
    effects = createPluginUIEffects(),
    guard = f.guard(window, { effects });
  effects.beginEvent("plugin-ui:" + randomUUID());
  for (let i = 0; i < 4; i++)
    effects.stageDownload(`${i}.json`, "application/json", new Blob(["{}"]));
  function originalExport() {
    try {
      const a = window.document.createElement("a");
      a.href = guard.globals.URL.createObjectURL(
        new Blob(["{}"], { type: "application/json" }),
      );
      a.download = "overflow.json";
      a.click();
      return true;
    } catch {
      return false;
    }
  }
  assert.equal(originalExport(), false);
  assert.throws(() => guard.assertHealthy(), {
    code: "PLUGIN_UI_EFFECT_LIMIT",
  });
});
