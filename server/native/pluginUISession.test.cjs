"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const {
  createPluginUISession,
  sanitizeCss,
  pluginUiPreviewDocument,
} = require("./pluginUISession.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");

const fixturePath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const original = {
  skip: fs.existsSync(fixturePath)
    ? false
    : "Fetch author fixture: node server/native/wygloreContract.cjs fetch",
};

async function makeWindow() {
  const { Window } = await import(
    pathToFileURL(require.resolve("happy-dom")).href
  );
  return new Window({
    url: "https://synthetic.invalid",
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  });
}
function scope() {
  return {
    sessionId: randomUUID(),
    pluginId: "synthetic-plugin",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: 0,
    characterId: "synthetic-character",
    chatId: "synthetic-chat",
    chatEpoch: 0,
    writerId: "synthetic-ui-owner",
    writerFence: 1,
  };
}
function memoryReceipts() {
  const values = new Map();
  return {
    values,
    read: async (_scope, id) => structuredClone(values.get(id) ?? null),
    admit: async (_scope, row) => {
      assert.equal(values.has(row.eventId), false);
      const result = { ...row, state: "admitted" };
      values.set(row.eventId, result);
      return structuredClone(result);
    },
    complete: async (_scope, row) => {
      const result = values.get(row.eventId);
      assert.equal(
        result.state,
        "completed",
        "Checkpoint must commit completion atomically before read acknowledgement",
      );
      return structuredClone(result);
    },
    fail: async (_scope, row) => {
      const previous = values.get(row.eventId);
      if (previous?.state !== "completed")
        values.set(row.eventId, {
          ...previous,
          state: "failed",
          code: row.code,
        });
    },
  };
}
async function setup(t, options = {}) {
  const window = await makeWindow();
  const receipts = memoryReceipts();
  const checkpoints = [];
  let authority = true;
  const session = createPluginUISession(window, {
    scope: scope(),
    guard: async () => {
      if (!authority)
        throw Object.assign(new Error("Synthetic lease ownership changed"), {
          code: "STALE_PLUGIN_WORKER",
        });
    },
    settle: options.settle ?? (async () => {}),
    checkpoint: async (event) => {
      checkpoints.push(event);
      if (event)
        receipts.values.set(event.eventId, {
          ...receipts.values.get(event.eventId),
          state: "completed",
          appliedRevision: event.appliedRevision,
        });
    },
    receipts,
    ...options,
  });
  t.after(async () => {
    session.close();
    await window.happyDOM.cancelAsync();
    window.close();
  });
  const packet = async (element, type, payload = {}) => ({
    scope: session.scope,
    revision: (await session.snapshot()).revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: session.nodeId(element),
    type,
    ...payload,
  });
  return {
    window,
    session,
    receipts,
    checkpoints,
    packet,
    revoke: () => {
      authority = false;
    },
  };
}
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("sanitized snapshots preserve original form properties and strip scripts, handlers, navigation and CSS network access", async (t) => {
  const h = await setup(t);
  const doc = h.window.document;
  doc.body.innerHTML =
    '<script>globalThis.unsafe=true</script><iframe src="https://bad.invalid"></iframe><img src="https://bad.invalid" onerror="unsafe()"><a href="javascript:unsafe()">link</a><div data-risu-plugin-node="forged" onclick="unsafe()" style="color:red;background:url(https://bad.invalid)">safe</div><input type="checkbox"><textarea>stale</textarea><select><option value="a">A</option><option value="b">B</option></select>';
  const style = doc.createElement("style");
  style.textContent =
    '@import "https://bad.invalid/a.css"; .ok{color:red;background:u\\72l(https://bad.invalid)} @media(max-width:600px){.ok{padding:2px}}';
  doc.head.appendChild(style);
  doc.querySelector("input").checked = true;
  doc.querySelector("input").indeterminate = true;
  doc.querySelector("textarea").value = "fresh\ntext <literal>";
  doc.querySelector("select").value = "b";
  const view = await h.session.snapshot();
  assert.doesNotMatch(
    view.html,
    /<script|<iframe|onclick|onerror|javascript:|https:\/\/bad|forged|url\(/i,
  );
  assert.match(view.html, /color:red/);
  assert.match(view.html, /checked/);
  assert.match(view.html, /fresh\ntext &lt;literal&gt;/);
  assert.match(view.html, /value="b" selected/);
  assert.equal(
    view.controlStates.find((control) => control.tag === "INPUT").indeterminate,
    true,
  );
  assert.equal(
    view.controlStates.find((control) => control.tag === "SELECT").value,
    "b",
  );
  assert.doesNotMatch(view.styles.join(""), /@import|url\(/i);
  assert.match(view.styles.join(""), /color:red/);
  assert.match(pluginUiPreviewDocument(view), /script-src 'none'/);
  assert.doesNotMatch(pluginUiPreviewDocument(view), /<script/i);
  assert.equal(h.window.unsafe, undefined);
  assert.equal((await h.session.snapshot()).revision, view.revision);
});

test("exact duplicate receipt returns fresh view without repeating original effects", async (t) => {
  const h = await setup(t);
  const button = h.window.document.createElement("button");
  let clicks = 0;
  button.textContent = "original";
  button.addEventListener("click", async () => {
    await tick();
    clicks++;
    button.textContent = "changed";
  });
  h.window.document.body.appendChild(button);
  const request = await h.packet(button, "click");
  const result = await h.session.dispatch(request);
  assert.equal(clicks, 1);
  assert.equal(result.replayed, false);
  assert.equal(h.checkpoints.length, 1);
  assert.equal(h.receipts.values.get(request.eventId).state, "completed");
  assert.equal(h.receipts.values.get(request.eventId).value, undefined);
  button.textContent = "later view";
  const replay = await h.session.dispatch(request);
  assert.equal(replay.replayed, true);
  assert.equal(clicks, 1);
  assert.match(replay.snapshot.html, /later view/);
  await assert.rejects(h.session.dispatch({ ...request, type: "input" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(clicks, 1);
});

test("an admitted uncertain event never restarts its original button callback", async (t) => {
  const h = await setup(t);
  const button = h.window.document.createElement("button");
  let clicks = 0;
  button.addEventListener("click", () => {
    clicks++;
  });
  h.window.document.body.appendChild(button);
  const request = await h.packet(button, "click");
  const crypto = require("node:crypto");
  function sorted(value) {
    return Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
  }
  h.receipts.values.set(request.eventId, {
    state: "admitted",
    requestHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(sorted(request)))
      .digest("hex"),
  });
  await assert.rejects(h.session.dispatch(request), {
    code: "PLUGIN_UI_EVENT_UNCERTAIN",
  });
  assert.equal(clicks, 0);
  assert.equal(h.checkpoints.length, 0);
});

test("stale scope, changed DOM and forged nodes are rejected before event admission", async (t) => {
  const h = await setup(t);
  const button = h.window.document.createElement("button");
  let clicks = 0;
  button.addEventListener("click", () => {
    clicks++;
  });
  h.window.document.body.appendChild(button);
  const request = await h.packet(button, "click");
  await assert.rejects(
    h.session.dispatch({
      ...request,
      scope: { ...request.scope, writerFence: 2 },
    }),
    { code: "PLUGIN_UI_SCOPE_CHANGED" },
  );
  await assert.rejects(
    h.session.dispatch({
      ...request,
      scope: { ...request.scope, chatEpoch: 1 },
    }),
    { code: "PLUGIN_UI_SCOPE_CHANGED" },
  );
  await assert.rejects(h.session.dispatch({ ...request, extra: "forged" }), {
    code: "INVALID_PLUGIN_UI_EVENT",
  });
  await assert.rejects(
    h.session.dispatch({ ...request, nodeId: randomUUID() }),
    { code: "PLUGIN_UI_NODE_CHANGED" },
  );
  button.textContent = "changed independently";
  await assert.rejects(h.session.dispatch(request), {
    code: "PLUGIN_UI_REVISION_CHANGED",
  });
  const removed = await h.packet(button, "click");
  button.remove();
  await assert.rejects(h.session.dispatch(removed), {
    code: "PLUGIN_UI_REVISION_CHANGED",
  });
  assert.equal(clicks, 0);
  assert.equal(h.receipts.values.size, 0);
  h.revoke();
  await assert.rejects(h.session.snapshot(), { code: "STALE_PLUGIN_WORKER" });
});

test("checkbox, radio, textarea, number and select events carry exact original values", async (t) => {
  const h = await setup(t);
  const doc = h.window.document;
  const observed = [];
  doc.body.innerHTML =
    '<input id="check" type="checkbox"><input id="r1" type="radio" name="r" checked><input id="r2" type="radio" name="r"><textarea id="text"></textarea><input id="number" type="number" min="1" max="10"><select id="single"><option value="a">A</option><option value="b">B</option><option value="disabled" disabled>X</option></select><select id="multiple" multiple><option value="one">one</option><option value="two">two</option><option value="three">three</option></select>';
  for (const element of doc.querySelectorAll("input,textarea,select"))
    element.addEventListener("change", () =>
      observed.push({
        id: element.id,
        value: element.value,
        checked: element.checked,
        selected: element.selectedOptions
          ? Array.from(element.selectedOptions, (option) => option.value)
          : [],
      }),
    );
  const change = async (id, payload) =>
    h.session.dispatch(
      await h.packet(doc.getElementById(id), "change", payload),
    );
  await change("check", { checked: true });
  await change("r2", { checked: true });
  assert.equal(doc.getElementById("r1").checked, false);
  await change("text", { value: "line one\nline two" });
  await change("number", { value: "7" });
  await change("single", { value: "b" });
  await change("multiple", { selectedValues: ["one", "three"] });
  assert.equal(observed.find((item) => item.id === "check").checked, true);
  assert.equal(
    observed.find((item) => item.id === "text").value,
    "line one\nline two",
  );
  assert.equal(observed.find((item) => item.id === "number").value, "7");
  assert.equal(observed.find((item) => item.id === "single").value, "b");
  assert.deepEqual(observed.find((item) => item.id === "multiple").selected, [
    "one",
    "three",
  ]);
  const count = h.receipts.values.size;
  await assert.rejects(change("check", { value: "forged-checkbox-value" }), {
    code: "INVALID_PLUGIN_UI_VALUE",
  });
  await assert.rejects(change("number", { value: "11" }), {
    code: "INVALID_PLUGIN_UI_VALUE",
  });
  await assert.rejects(change("single", { value: "unknown" }), {
    code: "INVALID_PLUGIN_UI_VALUE",
  });
  await assert.rejects(change("single", { value: "disabled" }), {
    code: "INVALID_PLUGIN_UI_VALUE",
  });
  await assert.rejects(change("multiple", { value: "one" }), {
    code: "INVALID_PLUGIN_UI_VALUE",
  });
  assert.equal(h.receipts.values.size, count);
});

test("listener-free original modal controls synchronize native values before their original save callback", async (t) => {
  const h = await setup(t);
  const doc = h.window.document;
  doc.body.innerHTML =
    '<input id="name" maxlength="40"><textarea id="content"></textarea><select id="type"><option value="person">Person</option><option value="relation">Relation</option></select><select id="members" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select><input id="enabled" type="checkbox"><button id="save">Save</button>';
  let saved;
  const save = doc.getElementById("save");
  save.addEventListener("click", () => {
    saved = {
      name: doc.getElementById("name").value,
      content: doc.getElementById("content").value,
      type: doc.getElementById("type").value,
      members: Array.from(
        doc.getElementById("members").selectedOptions,
        (e) => e.value,
      ),
      enabled: doc.getElementById("enabled").checked,
    };
  });
  const view = await h.session.snapshot();
  assert.equal(view.capabilities.nativeFormValueSync, true);
  assert.equal(
    (view.html.match(/data-risu-plugin-value-sync="true"/g) ?? []).length,
    5,
  );
  assert.equal(
    (view.html.match(/data-risu-plugin-events="input change blur"/g) ?? [])
      .length,
    5,
  );
  const set = async (id, type, payload) =>
    h.session.dispatch(await h.packet(doc.getElementById(id), type, payload));
  await set("name", "input", { value: "Blue garden" });
  await set("content", "blur", { value: "Line one\nLine two" });
  await set("type", "change", { value: "relation" });
  await set("members", "input", { selectedValues: ["a", "c"] });
  await set("enabled", "change", { checked: true });
  assert.equal(
    saved,
    undefined,
    "Synchronizing a native value must not invoke save",
  );
  await h.session.dispatch(await h.packet(save, "click"));
  assert.deepEqual(saved, {
    name: "Blue garden",
    content: "Line one\nLine two",
    type: "relation",
    members: ["a", "c"],
    enabled: true,
  });
  assert.equal(h.receipts.values.size, 6);
  assert.ok(
    [...h.receipts.values.values()].every(
      (receipt) => receipt.state === "completed",
    ),
  );
});

test("options selected before insertion retain their actual type and selected index across DOM owners", async (t) => {
  const first = await setup(t),
    second = await setup(t);
  const types = [
    "utterance",
    "persona",
    "event",
    "environment",
    "sensation",
    "note",
    "relation",
  ];
  async function build(owner, wanted) {
    const select = owner.window.document.createElement("select");
    for (const type of types) {
      const option = owner.window.document.createElement("option");
      option.value = type;
      option.textContent = type;
      if (type === wanted) option.selected = true;
      select.appendChild(option);
    }
    owner.window.document.body.appendChild(select);
    const view = await owner.session.snapshot();
    const state = view.controlStates.find(
      (item) => item.nodeId === owner.session.nodeId(select),
    );
    assert.equal(select.value, wanted);
    assert.equal(select.selectedIndex, types.indexOf(wanted));
    assert.deepEqual(
      Array.from(select.selectedOptions, (option) => option.value),
      [wanted],
    );
    assert.equal(state.value, wanted);
    assert.equal(state.selectedIndex, types.indexOf(wanted));
    return select;
  }
  await build(first, "relation");
  await build(second, "sensation");
  first.session.close();
  const select = await build(second, "relation");
  const tail = second.window.document.createElement("option");
  tail.value = "selected-tail";
  tail.selected = true;
  select.appendChild(tail);
  assert.equal(select.value, "selected-tail");
  assert.equal(select.selectedIndex, types.length);
  assert.deepEqual(
    Array.from(select.selectedOptions, (option) => option.value),
    ["selected-tail"],
  );
});

test("native value synchronization does not open unregistered clicks, keyboard, button, file or read-only mutations", async (t) => {
  const h = await setup(t);
  const doc = h.window.document;
  doc.body.innerHTML =
    '<input id="plain" maxlength="4"><input id="readonly" readonly value="retained"><input id="file" type="file"><input id="button" type="button" value="Action"><input id="disabled" disabled><select id="options"><option value="a">A</option><option value="disabled" disabled>Disabled</option></select><div id="other">Other</div>';
  const view = await h.session.snapshot();
  for (const id of ["readonly", "file", "button", "disabled", "other"])
    await assert.rejects(
      h.session.dispatch(
        await h.packet(doc.getElementById(id), "input", { value: "bad" }),
      ),
      (cause) =>
        ["INVALID_PLUGIN_UI_EVENT", "PLUGIN_UI_DISABLED"].includes(cause.code),
    );
  for (const [type, payload] of [
    ["click", {}],
    ["keydown", { key: "Enter" }],
    ["blur", {}],
    ["input", { value: "too-long" }],
  ])
    await assert.rejects(
      h.session.dispatch(
        await h.packet(doc.getElementById("plain"), type, payload),
      ),
      (cause) =>
        ["INVALID_PLUGIN_UI_EVENT", "INVALID_PLUGIN_UI_VALUE"].includes(
          cause.code,
        ),
    );
  for (const value of ["unknown", "disabled"])
    await assert.rejects(
      h.session.dispatch(
        await h.packet(doc.getElementById("options"), "change", { value }),
      ),
      { code: "INVALID_PLUGIN_UI_VALUE" },
    );
  assert.equal(h.receipts.values.size, 0);
  assert.equal(doc.getElementById("plain").value, "");
  assert.equal(doc.getElementById("readonly").value, "retained");
  assert.equal((await h.session.snapshot()).revision, view.revision);
});

test("disabled, read-only and non-form nodes cannot receive forged mutable input", async (t) => {
  const h = await setup(t);
  const doc = h.window.document;
  doc.body.innerHTML =
    '<button disabled>disabled</button><input readonly value="retained"><input type="file"><div>other</div>';
  for (const element of doc.body.children)
    element.addEventListener("change", () => {
      throw new Error("Must not execute");
    });
  const view = await h.session.snapshot();
  assert.match(view.html, /data-risu-plugin-unavailable="file-transfer"/);
  for (const element of doc.body.children) {
    const request = await h.packet(element, "change", { value: "forged" });
    await assert.rejects(h.session.dispatch(request), (cause) =>
      [
        "PLUGIN_UI_DISABLED",
        "INVALID_PLUGIN_UI_VALUE",
        "PLUGIN_UI_CAPABILITY_REQUIRED",
      ].includes(cause.code),
    );
  }
  assert.equal(h.receipts.values.size, 0);
});

test("busy original asynchronous work still offers guarded progress snapshots", async (t) => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t);
  const button = h.window.document.createElement("button");
  button.textContent = "starting";
  button.addEventListener("click", async () => {
    button.textContent = "progress";
    await barrier;
    button.textContent = "completed";
  });
  h.window.document.body.appendChild(button);
  const run = h.session.dispatch(await h.packet(button, "click"));
  await tick();
  const progress = await h.session.snapshot({ whileBusy: true });
  assert.equal(progress.busy, true);
  assert.match(progress.html, /progress/);
  release();
  const completed = await run;
  assert.equal(completed.snapshot.busy, false);
  assert.match(completed.snapshot.html, /completed/);
});

test("original summary click retains native details toggle and its original toggle handler", async (t) => {
  const h = await setup(t);
  const details = h.window.document.createElement("details");
  const summary = h.window.document.createElement("summary");
  summary.textContent = "Original section";
  details.appendChild(summary);
  h.window.document.body.appendChild(details);
  let clicks = 0,
    toggles = 0;
  details.addEventListener("click", () => clicks++);
  details.addEventListener("toggle", () => {
    toggles++;
    details.setAttribute("aria-expanded", String(details.open));
  });
  const first = await h.session.dispatch(await h.packet(summary, "click"));
  assert.equal(details.open, true);
  assert.equal(toggles, 1);
  assert.match(first.snapshot.html, /aria-expanded="true"/);
  await h.session.dispatch(await h.packet(summary, "click"));
  assert.equal(details.open, false);
  assert.equal(toggles, 2);
  assert.equal(clicks, 2);
  summary.addEventListener("click", (event) => event.preventDefault());
  await h.session.dispatch(await h.packet(summary, "click"));
  assert.equal(details.open, false);
  assert.equal(toggles, 2);
});

test("two server DOM owners keep listener tracking and cleanup isolated", async (t) => {
  const a = await setup(t),
    b = await setup(t);
  const elements = [];
  for (const owner of [a, b]) {
    const button = owner.window.document.createElement("button");
    button.addEventListener("click", () => {
      button.textContent = "own";
    });
    owner.window.document.body.appendChild(button);
    elements.push(button);
  }
  await a.session.dispatch(await a.packet(elements[0], "click"));
  a.session.close();
  await b.session.dispatch(await b.packet(elements[1], "click"));
  assert.equal(elements[1].textContent, "own");
  assert.equal(b.checkpoints.length, 1);
});

test("CSS sanitization preserves responsive keyframes while rejecting escape-obfuscated network declarations", () => {
  const output = sanitizeCss(
    '@import "https://bad.invalid"; @keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}} .a{--color:#abc;color:var(--color);background:u\\72l(https://bad.invalid);behavior:url(x);padding:2px} @media(max-width:800px){.a{display:block}}',
  );
  assert.match(output, /@keyframes spin/);
  assert.match(output, /@media/);
  assert.match(output, /var\(--color\)/);
  assert.doesNotMatch(output, /bad.invalid|url|@import|behavior/);
});

test(
  "an original setting UI remote toggle updates the same engine and atomically acknowledges its checkpoint",
  original,
  async (t) => {
    const fixture = makeWygloreContractFixture();
    const settle = async () => {
      await fixture.lifecycle().settlePanel();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fixture.settle();
      await fixture.lifecycle().settlePanel();
    };
    const h = await setup(t, {
      settle,
      prepareEvent: async () => fixture.lifecycle().settlePanel(),
    });
    fixture.attachDOM(h.window);
    t.after(() => fixture.close());
    const lifecycle = await fixture.boot(fs.readFileSync(fixturePath, "utf8"));
    await fixture.registrations
      .find((entry) => entry.type === "setting")
      .args[1]();
    await settle();
    const settingsTab = h.window.document.querySelector(
      'button[data-tab="settings"]',
    );
    await h.session.dispatch(await h.packet(settingsTab, "click"));
    const label = [...h.window.document.querySelectorAll("label")].find(
      (element) => element.textContent.includes("백그라운드 진행 우선 켜기"),
    );
    assert.ok(label);
    const checkbox = label.querySelector('input[type="checkbox"]');
    assert.equal(lifecycle.parameters().backgroundFirstEnabled, true);
    const result = await h.session.dispatch(
      await h.packet(checkbox, "change", { checked: false }),
    );
    assert.equal(lifecycle.parameters().backgroundFirstEnabled, false);
    assert.equal(
      JSON.parse(fixture.storage.get("wl.globalSettings.v1"))
        .backgroundFirstEnabled,
      false,
    );
    assert.equal(result.replayed, false);
    assert.equal(
      result.snapshot.controlStates.find(
        (entry) => entry.nodeId === h.session.nodeId(checkbox),
      ).checked,
      false,
    );
    assert.equal(
      fixture.calls.some((entry) => entry.method === "provider"),
      false,
    );
    assert.doesNotMatch(result.snapshot.html, /<script|\son\w+=/i);
  },
);
