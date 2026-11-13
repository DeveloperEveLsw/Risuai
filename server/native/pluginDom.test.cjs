"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { parse } = require("acorn");
const walk = require("acorn-walk");
const { createPluginDom } = require("./pluginDom.cjs");
const {
  readWygloreFixture,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");

const fixturePath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const original = {
  skip: fs.existsSync(fixturePath)
    ? false
    : "Fetch public fixture with: node server/native/wygloreContract.cjs fetch",
};

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function dialog(bridge) {
  const { document } = bridge;
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Synthetic confirmation");
  const title = document.createElement("p");
  title.textContent = "Synthetic memory operation";
  const skip = document.createElement("button");
  skip.textContent = "Skip";
  const proceed = document.createElement("button");
  proceed.textContent = "Proceed";
  overlay.appendChild(title);
  overlay.appendChild(skip);
  overlay.appendChild(proceed);
  return { overlay, skip, proceed };
}

test("durable selection invokes only the original selected button callback", async () => {
  const calls = [];
  let selected;
  const bridge = createPluginDom({
    alertSelect: async (options, prompt) => {
      selected = { options, prompt };
      return "1";
    },
  });
  const { overlay, skip, proceed } = dialog(bridge);
  skip.addEventListener("click", () => {
    calls.push("skip");
    overlay.remove();
  });
  proceed.addEventListener("click", () => {
    calls.push("proceed");
    overlay.remove();
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  assert.deepEqual(selected.options, ["Skip", "Proceed"]);
  assert.match(selected.prompt, /Synthetic memory operation/);
  assert.deepEqual(calls, ["proceed"]);
  bridge.check();
  bridge.stop();
});

test("the scratch DOM preserves text, HTML, classes and connected node selection", async () => {
  const bridge = createPluginDom();
  const { document } = bridge;
  const element = document.createElement("section");
  element.id = "synthetic-map";
  element.className = "garden initial";
  element.classList.remove("initial");
  element.classList.add("ready");
  element.classList.toggle("selected", true);
  element.innerHTML = '<p data-state="safe">one <strong>two</strong></p>';
  document.body.appendChild(element);
  assert.equal(document.getElementById("synthetic-map"), element);
  assert.equal(element.querySelector("strong").textContent, "two");
  assert.equal(element.querySelector("p").dataset.state, "safe");
  assert.equal(element.classList.contains("ready"), true);
  assert.equal(element.isConnected, true);
  assert.equal(document.querySelectorAll(".garden.selected").length, 1);
  const text = document.createElement("span");
  text.textContent = "<literal & text>";
  element.appendChild(text);
  assert.equal(text.textContent, "<literal & text>");
  assert.equal(text.querySelector("literal"), null);
  text.remove();
  assert.equal(text.isConnected, false);
  await tick();
  bridge.check();
  bridge.stop();
});

test("missing interaction support fails instead of approving or skipping a dialog", async () => {
  let failed;
  let clicked = false;
  const bridge = createPluginDom({
    onFailure: (error) => {
      failed = error;
    },
  });
  const { overlay, proceed } = dialog(bridge);
  proceed.addEventListener("click", () => {
    clicked = true;
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  assert.equal(failed.code, "PLUGIN_DOM_INTERACTION_REQUIRED");
  assert.equal(clicked, false);
  assert.throws(() => bridge.assertHealthy(), {
    code: "PLUGIN_DOM_INTERACTION_REQUIRED",
  });
  bridge.stop();
});

test("invalid selection indices never invoke an arbitrary action", async () => {
  for (const answer of [undefined, -1, "Proceed", "2", true]) {
    let clicked = false;
    const bridge = createPluginDom({ alertSelect: async () => answer });
    const { overlay, skip, proceed } = dialog(bridge);
    skip.addEventListener("click", () => {
      clicked = true;
    });
    proceed.addEventListener("click", () => {
      clicked = true;
    });
    bridge.document.body.appendChild(overlay);
    await tick();
    assert.equal(clicked, false);
    assert.throws(() => bridge.check(), { code: "PLUGIN_DOM_INVALID_ANSWER" });
    bridge.stop();
  }
});

test("original dialog timeout cannot be followed by a late durable proceed answer", async () => {
  let resolve;
  let clicked = false;
  const bridge = createPluginDom({
    alertSelect: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const { overlay, proceed } = dialog(bridge);
  proceed.addEventListener("click", () => {
    clicked = true;
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  overlay.remove();
  await tick();
  assert.throws(() => bridge.assertHealthy(), {
    code: "PLUGIN_DOM_INTERACTION_CLOSED",
  });
  resolve("0");
  await tick();
  assert.equal(clicked, false);
  bridge.stop();
});

test("progress action transport cannot bypass a recorded confirmation answer", async () => {
  let answer;
  let clicked = false;
  const events = [];
  const bridge = createPluginDom({
    alertSelect: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    onProgress: (event) => events.push(event),
  });
  const { overlay, proceed } = dialog(bridge);
  proceed.addEventListener("click", () => {
    clicked = true;
    overlay.remove();
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  await assert.rejects(bridge.dispatchAction(events[0].actions[0].id), {
    code: "PLUGIN_UI_DURABLE_ANSWER_REQUIRED",
  });
  assert.equal(clicked, false);
  answer("0");
  await tick();
  assert.equal(clicked, true);
  bridge.check();
  bridge.stop();
});

test("progress controls require an explicit dispatch and keep their original callbacks", async () => {
  const events = [];
  let cancelled = 0;
  let backgrounded = 0;
  const bridge = createPluginDom({
    onProgress: (event) => events.push(event),
    alertSelect: async () => {
      throw new Error("Progress must not block the provider with a selection");
    },
  });
  const { overlay, skip, proceed } = dialog(bridge);
  overlay.classList.add("at-coldstart-overlay");
  skip.textContent = "Background";
  proceed.textContent = "Cancel";
  skip.addEventListener("click", () => {
    backgrounded++;
  });
  proceed.addEventListener("click", () => {
    cancelled++;
    proceed.disabled = true;
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  const progress = events.find((event) => event.mode === "progress");
  assert.deepEqual(
    progress.actions.map((action) => action.label),
    ["Background", "Cancel"],
  );
  assert.equal(backgrounded, 0);
  assert.equal(cancelled, 0);
  await bridge.dispatchAction(progress.actions[1].id);
  assert.equal(cancelled, 1);
  assert.equal(backgrounded, 0);
  await assert.rejects(bridge.dispatchAction(progress.actions[1].id), {
    code: "STALE_PLUGIN_UI_ACTION",
  });
  bridge.check();
  overlay.remove();
  await tick();
  await assert.rejects(bridge.dispatchAction(progress.actions[0].id), {
    code: "STALE_PLUGIN_UI_ACTION",
  });
  bridge.stop();
});

test("caught unsupported DOM calls still poison the host and cannot fabricate a browser layout", () => {
  const failures = [];
  const bridge = createPluginDom({
    onFailure: (error) => failures.push(error),
  });
  const element = bridge.document.createElement("div");
  assert.throws(() => element.getBoundingClientRect(), {
    code: "PLUGIN_DOM_UNSUPPORTED",
  });
  assert.throws(() => bridge.assertHealthy(), {
    code: "PLUGIN_DOM_UNSUPPORTED",
  });
  assert.equal(failures.length, 1);
  bridge.stop();
});

test("aborted or stopped bridge cannot dispatch saved control IDs", async () => {
  const controller = new AbortController();
  const events = [];
  let clicked = false;
  const bridge = createPluginDom({
    signal: controller.signal,
    onProgress: (event) => events.push(event),
  });
  const { overlay, proceed } = dialog(bridge);
  overlay.className = "at-coldstart-overlay";
  proceed.addEventListener("click", () => {
    clicked = true;
  });
  bridge.document.body.appendChild(overlay);
  await tick();
  controller.abort(new Error("Synthetic job cancelled"));
  await assert.rejects(
    bridge.dispatchAction(events[0].actions[0].id),
    /Synthetic job cancelled/,
  );
  assert.equal(clicked, false);
  bridge.stop();
});

let originalFunctions;
async function originalDialogFunctions() {
  if (originalFunctions) return originalFunctions;
  const script = await readWygloreFixture(fixturePath);
  const wanted = new Set([
    "injectStyles",
    "acquireContainer",
    "releaseContainer",
    "createSpinner",
    "showColdStartConfirmModal",
    "showColdStartOverlay",
  ]);
  const definitions = [];
  walk.simple(parse(script, { ecmaVersion: "latest", sourceType: "script" }), {
    FunctionDeclaration(node) {
      if (wanted.has(node.id?.name)) {
        definitions.push(script.slice(node.start, node.end));
        wanted.delete(node.id.name);
      }
    },
  });
  assert.equal(
    wanted.size,
    0,
    "Pinned original dialog functions must be present",
  );
  originalFunctions = definitions.join("\n");
  return originalFunctions;
}

async function originalEnvironment(bridge) {
  // Function spans are taken unchanged from the hash-verified original bundle.
  // Constant CSS/icon fixtures affect appearance only; no memory algorithm runs
  // here. Full bundle execution is covered by the server-host integration gate.
  const context = vm.createContext({
    document: bridge.document,
    setTimeout,
    clearTimeout,
    STYLE_ID: "wl-style-root",
    CSS2: ".wl-overlay{display:block}",
    count: 0,
    _current2: null,
    getHost: () => bridge,
    icon: () => '<svg aria-hidden="true"></svg>',
  });
  vm.runInContext(await originalDialogFunctions(), context);
  return context;
}

test(
  "hash-verified original cold-start confirm selects original skip/proceed logic",
  original,
  async () => {
    for (const [answer, expected] of [
      ["0", "skip"],
      ["1", "proceed"],
    ]) {
      let request;
      const bridge = createPluginDom({
        alertSelect: async (options, prompt) => {
          request = { options, prompt };
          return answer;
        },
      });
      const context = await originalEnvironment(bridge);
      const choice = await vm.runInContext(
        "showColdStartConfirmModal({chunks:2,gap:16,totalMsgs:20,timeoutMs:2000})",
        context,
      );
      assert.equal(choice, expected);
      assert.deepEqual(request.options, ["이번 턴 건너뛰기", "처리 진행"]);
      assert.match(request.prompt, /2 묶음 · 16개 메시지/);
      await tick();
      bridge.check();
      assert.equal(bridge.document.querySelector('[role="dialog"]'), null);
      bridge.stop();
    }
  },
);

test(
  "hash-verified original cold-start overlay emits progress and executes selected cancel callback",
  original,
  async () => {
    const events = [];
    let cancelled = 0;
    let backgrounded = 0;
    const bridge = createPluginDom({
      onProgress: (event) => events.push(event),
    });
    const context = await originalEnvironment(bridge);
    context.cancel = () => {
      cancelled++;
    };
    context.background = () => {
      backgrounded++;
    };
    const overlay = vm.runInContext(
      "showColdStartOverlay({totalChunks:2,totalMsgs:16,onCancel:cancel,onBackground:background})",
      context,
    );
    assert.ok(overlay);
    overlay.update({ total: 2, done: 1, totalMsgs: 16, processedMsgs: 8 });
    await tick();
    const progress = events.filter((event) => event.mode === "progress").at(-1);
    assert.match(progress.text, /1\/2 묶음/);
    assert.deepEqual(
      progress.actions.map((action) => action.label),
      ["백그라운드로", "중단"],
    );
    await bridge.dispatchAction(progress.actions[1].id);
    assert.equal(cancelled, 1);
    assert.equal(backgrounded, 0);
    overlay.close();
    await tick();
    bridge.check();
    assert.equal(bridge.document.querySelector('[role="dialog"]'), null);
    bridge.stop();
  },
);
