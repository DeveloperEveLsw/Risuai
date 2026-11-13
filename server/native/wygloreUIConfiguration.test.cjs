"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  acorn = require("acorn"),
  walk = require("acorn-walk");
const { createHash } = require("node:crypto");
const {
  PORT,
  PROFILE,
  DELAYED_INPUT_PROFILE,
  createWygloreUIConfiguration,
  validateWygloreUIConfiguration,
  instrumentWygloreUIConfiguration,
} = require("./wygloreUIConfiguration.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const {
  instrumentWygloreUIConfirmations,
} = require("./wygloreUIConfirmation.cjs");
const fixture =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(fixture)
    ? false
    : "Fetch the pinned public WygLore fixture",
};
function original() {
  return fs.readFileSync(fixture, "utf8");
}
function functions(source) {
  let fieldQueue;
  walk.simple(acorn.parse(source, { ecmaVersion: "latest" }), {
    FunctionDeclaration(node) {
      if (node.id?.name === "createProviderFieldSaves")
        fieldQueue = source.slice(node.start, node.end);
    },
  });
  assert.ok(fieldQueue);
  return fieldQueue;
}
function inputFragments(source, input) {
  let declaration, registration;
  walk.ancestor(acorn.parse(source, { ecmaVersion: "latest" }), {
    VariableDeclaration(node, ancestors) {
      if (
        node.declarations[0]?.id?.name === input.timer &&
        ancestors.some(
          (parent) =>
            parent.type === "FunctionDeclaration" &&
            parent.id?.name === input.owner,
        )
      )
        declaration = source.slice(
          node.declarations[0].start,
          node.declarations.at(-1).end,
        );
    },
    CallExpression(node, ancestors) {
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.name === input.target &&
        node.callee.property.name === "addEventListener" &&
        node.arguments[0]?.value === "input" &&
        ancestors.some(
          (parent) =>
            parent.type === "FunctionDeclaration" &&
            parent.id?.name === input.owner,
        )
      )
        registration = source.slice(node.start, node.end);
    },
  });
  assert.ok(declaration);
  assert.ok(registration);
  return { declaration, registration };
}
function delayedInputFixture(input, port, options = {}) {
  const executable = instrumentWygloreUIConfiguration(original());
  const { declaration, registration } = inputFragments(executable, input);
  const timers = new Map(),
    listeners = new Map(),
    written = [];
  let next = 0,
    persistenceCalls = 0;
  const engine = {
    params: {},
    setParams(patch) {
      Object.assign(this.params, patch);
      written.push(patch);
    },
  };
  const target = {
    value: "",
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const sandbox = {
    [input.target]: target,
    getEngine: () => engine,
    persistEngine: async () => persistenceCalls++,
    _resolveCurrentContext:
      options.resolveContext ??
      (async () => ({
        charId: "synthetic-character",
        chatKey: "synthetic-chat",
      })),
    updateActiveToggle: (_params, charId, chatKey, varName, value) => ({
      syntheticToggle: { charId, chatKey, varName, value },
    }),
    t: { varName: "synthetic-toggle" },
    setTimeout: (callback) => {
      const id = ++next;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    [PORT]: port,
  };
  vm.runInNewContext(`let ${declaration};${registration};`, sandbox);
  return {
    timers,
    written,
    parameters: () => engine.params,
    persistenceCalls: () => persistenceCalls,
    input(value) {
      target.value = value;
      listeners.get("input")();
    },
    fire() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
  };
}
function modelFixture(port, client = { setConfig: async () => {} }) {
  const timers = new Map();
  let next = 0;
  const sandbox = {
    client,
    providerSel: { value: "synthetic-provider" },
    modelInput: { value: "old-model" },
    providerKey2: "provider",
    modelKey: "model",
    setTimeout: (callback) => {
      const id = ++next;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    [PORT]: port,
  };
  const schedule = PROFILE.scheduleSave
    .replace(
      "await saveNow()",
      `await globalThis.${PORT}.run(flushSave,saveNow)`,
    )
    .replace("},250)}", `},250),globalThis.${PORT}.schedule(flushSave)}`);
  const flush = PROFILE.flushSave.replace(
    "await saveNow()",
    `await globalThis.${PORT}.run(flushSave,saveNow)`,
  );
  vm.runInNewContext(
    `let saveTimer=null,${PROFILE.saveNow},${schedule},${flush};globalThis.schedule=scheduleSave;`,
    sandbox,
  );
  return {
    sandbox,
    timers,
    schedule: (value) => {
      sandbox.modelInput.value = value;
      sandbox.schedule();
    },
    fire() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
  };
}
test(
  "configuration instrumentation verifies exact author SHA/profile and composes after all original UI confirmations",
  actual,
  () => {
    const source = original(),
      confirmed = instrumentWygloreUIConfirmations(source),
      executable = instrumentWygloreUIConfiguration(source, confirmed);
    new vm.Script(executable);
    assert.equal(validateWygloreUIConfiguration(source), true);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      WYGLORE_RELEASE.sha256,
    );
    assert.ok(executable.includes(`globalThis.${PORT}.schedule(flushSave)`));
    assert.ok(
      executable.includes("flushFields:()=>providerFieldSaves?.flush()"),
    );
    const footer = `\n;Object.defineProperty(globalThis,"${PORT}",{value:(${createWygloreUIConfiguration.toString()})({flushFields:()=>providerFieldSaves?.flush()}),configurable:false,writable:false});\n`;
    let restored = executable
      .replace(footer, "")
      .replace(
        PROFILE.scheduleSave
          .replace(
            "await saveNow()",
            `await globalThis.${PORT}.run(flushSave,saveNow)`,
          )
          .replace("},250)}", `},250),globalThis.${PORT}.schedule(flushSave)}`),
        PROFILE.scheduleSave,
      )
      .replace(
        PROFILE.flushSave.replace(
          "await saveNow()",
          `await globalThis.${PORT}.run(flushSave,saveNow)`,
        ),
        PROFILE.flushSave,
      );
    for (const input of Object.values(DELAYED_INPUT_PROFILE)) {
      const fragments = inputFragments(restored, input);
      restored = restored
        .replace(fragments.declaration, input.declaration)
        .replace(fragments.registration, input.registration);
    }
    assert.equal(restored, confirmed);
    assert.throws(
      () => instrumentWygloreUIConfiguration(source + "\n", confirmed),
      /hash differs/,
    );
    assert.throws(
      () => instrumentWygloreUIConfiguration(source, executable),
      /profile differs|missing|already installed|identifier collision/,
    );
  },
);
test(
  "both additional original input profiles reject changed delays, callbacks, scope and duplicate registrations",
  actual,
  () => {
    const source = original();
    for (const input of Object.values(DELAYED_INPUT_PROFILE)) {
      for (const changed of [
        source.replace(
          input.registration,
          input.registration.replace(",400)", ",450)"),
        ),
        source.replace(
          input.registration,
          input.registration.replace("persistEngine()", "otherPersistence()"),
        ),
        source.replace(
          input.registration,
          input.registration + ";" + input.registration,
        ),
        source.replace(
          input.declaration,
          input.declaration + "," + input.operation + "=null",
        ),
        source.replace(
          "function " + input.owner + "(",
          "function " + input.owner + "Changed(",
        ),
      ])
        assert.throws(
          () => validateWygloreUIConfiguration(changed),
          /profile differs|identifier collision|timer scope differs/,
        );
    }
  },
);
for (const [name, input] of Object.entries(DELAYED_INPUT_PROFILE)) {
  test(
    `original ${name} 400ms debounce flushes its latest value and cancels the timer before acknowledgement`,
    actual,
    async () => {
      const port = createWygloreUIConfiguration();
      const f = delayedInputFixture(input, port);
      f.input("Intermediate synthetic value");
      f.input("Final synthetic value");
      assert.equal(port.pending(), 1);
      assert.equal(f.timers.size, 1);
      assert.equal(f.written.length, 0);
      await port.flush();
      assert.equal(f.written.length, 1);
      const value =
        name === "excludedModules"
          ? f.parameters().moduleLoreIngestExclude
          : f.parameters().syntheticToggle.value;
      assert.equal(value, "Final synthetic value");
      assert.equal(f.persistenceCalls(), 1);
      assert.equal(f.timers.size, 0);
      assert.equal(port.pending(), 0);
    },
  );
  test(
    `closed configuration cannot execute a late original ${name} input timer`,
    actual,
    async () => {
      const port = createWygloreUIConfiguration();
      const f = delayedInputFixture(input, port);
      f.input("Discarded synthetic value");
      port.close();
      assert.throws(() => f.fire(), { code: "PLUGIN_UI_CONFIGURATION_CLOSED" });
      assert.equal(f.written.length, 0);
      assert.equal(f.persistenceCalls(), 0);
    },
  );
}
test(
  "a timer-started original text toggle context lookup is awaited once before checkpoint",
  actual,
  async () => {
    let release,
      lookups = 0;
    const port = createWygloreUIConfiguration();
    const f = delayedInputFixture(DELAYED_INPUT_PROFILE.toggleText, port, {
      resolveContext: () => {
        lookups++;
        return new Promise((resolve) => (release = resolve));
      },
    });
    f.input("Synthetic context value");
    const started = f.fire();
    await Promise.resolve();
    assert.equal(lookups, 1);
    const settled = port.flush();
    assert.equal(f.written.length, 0);
    release({ charId: "synthetic-character", chatKey: "synthetic-chat" });
    await Promise.all([started, settled]);
    assert.equal(lookups, 1);
    assert.equal(f.written.length, 1);
    assert.equal(f.persistenceCalls(), 1);
  },
);
test(
  "a changed or duplicated executable save closure fails its independent reviewed profile",
  actual,
  () => {
    const source = original();
    assert.throws(
      () =>
        validateWygloreUIConfiguration(
          source.replace(
            PROFILE.scheduleSave,
            PROFILE.scheduleSave.replace("250", "300"),
          ),
        ),
      /profile differs/,
    );
    assert.throws(
      () =>
        instrumentWygloreUIConfiguration(
          source,
          source.replace(
            PROFILE.flushSave,
            PROFILE.flushSave.replace("saveNow()", "otherSave()"),
          ),
        ),
      /profile differs/,
    );
  },
);
test("original 250ms model input closures flush their latest value before acknowledgement without sleeping or external calls", async () => {
  const values = new Map();
  let calls = 0,
    fieldFlushes = 0;
  const port = createWygloreUIConfiguration({
    flushFields: async () => fieldFlushes++,
  });
  const f = modelFixture(port, {
    setConfig: async (patch) => {
      calls++;
      for (const [key, value] of Object.entries(patch)) values.set(key, value);
    },
  });
  f.schedule("intermediate-model");
  f.schedule("updated-model");
  assert.equal(f.timers.size, 1);
  assert.equal(port.pending(), 1);
  assert.equal(calls, 0);
  await port.flush();
  assert.equal(values.get("model"), "updated-model");
  assert.equal(values.get("provider"), "synthetic-provider");
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(port.pending(), 0);
  assert.equal(fieldFlushes, 1);
});
test("a timer-started original model save is awaited once while an immediate checkpoint is settling", async () => {
  let calls = 0,
    release;
  const port = createWygloreUIConfiguration();
  const f = modelFixture(port, {
    setConfig: async () => {
      calls++;
      await new Promise((resolve) => (release = resolve));
    },
  });
  f.schedule("timer-model");
  const timer = f.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  const flush = port.flush();
  assert.equal(calls, 1);
  release();
  await Promise.all([timer, flush]);
  assert.equal(calls, 1);
  assert.equal(port.pending(), 0);
});
test("a newer model edit during an active save is flushed in a following round without losing its pending registration", async () => {
  const written = [];
  let release;
  const port = createWygloreUIConfiguration();
  const f = modelFixture(port, {
    setConfig: async (patch) => {
      written.push(patch.model);
      if (written.length === 1)
        await new Promise((resolve) => (release = resolve));
    },
  });
  f.schedule("first-model");
  const timer = f.fire();
  await Promise.resolve();
  await Promise.resolve();
  f.schedule("last-model");
  const flush = port.flush();
  release();
  await Promise.all([timer, flush]);
  assert.deepEqual(written, ["first-model", "last-model"]);
  assert.equal(f.timers.size, 0);
  assert.equal(port.pending(), 0);
});
test(
  "original providerFieldSaves.flush settles its 400ms operations before any checkpoint",
  actual,
  async () => {
    const timers = new Map(),
      box = {
        setTimeout: (callback) => {
          const key = Symbol();
          timers.set(key, callback);
          return key;
        },
        clearTimeout: (key) => timers.delete(key),
      };
    vm.runInNewContext(
      `${functions(original())};globalThis.fields=createProviderFieldSaves();`,
      box,
    );
    const saved = [];
    box.fields.enqueue("synthetic-provider.setting", async () =>
      saved.push("synthetic-value"),
    );
    assert.equal(timers.size, 1);
    const port = createWygloreUIConfiguration({
      flushFields: () => box.fields.flush(),
    });
    await port.flush();
    assert.deepEqual(saved, ["synthetic-value"]);
    assert.equal(timers.size, 0);
  },
);
test(
  "a failed original provider queue operation poisons settlement even if its timer catches the error",
  actual,
  async () => {
    const box = { setTimeout: () => 1, clearTimeout: () => {} };
    vm.runInNewContext(
      `${functions(original())};globalThis.fields=createProviderFieldSaves();`,
      box,
    );
    box.fields.enqueue("synthetic-provider.setting", async () => {
      throw Error("Synthetic save failure");
    });
    const port = createWygloreUIConfiguration({
      flushFields: () => box.fields.flush(),
    });
    await assert.rejects(port.flush());
    assert.throws(() => port.assertHealthy());
  },
);
test("closing discards pending registrations and prevents a late original timer from staging writes", async () => {
  let calls = 0;
  const port = createWygloreUIConfiguration(),
    f = modelFixture(port, { setConfig: async () => calls++ });
  f.schedule("discard-model");
  port.close();
  assert.equal(port.pending(), 0);
  await assert.rejects(f.fire(), { code: "PLUGIN_UI_CONFIGURATION_CLOSED" });
  assert.equal(calls, 0);
  assert.throws(() => port.flush(), { code: "PLUGIN_UI_CONFIGURATION_CLOSED" });
  assert.throws(() => port.schedule(() => {}), {
    code: "PLUGIN_UI_CONFIGURATION_CLOSED",
  });
  assert.throws(
    () =>
      port.run(
        () => {},
        () => calls++,
      ),
    {
      code: "PLUGIN_UI_CONFIGURATION_CLOSED",
    },
  );
  assert.equal(calls, 0);
});
test("pending callbacks are bounded and a source fence failure prevents their invocation", async () => {
  const bounded = createWygloreUIConfiguration({ maxPending: 1 });
  bounded.schedule(() => {});
  assert.throws(() => bounded.schedule(() => {}), {
    code: "PLUGIN_UI_CONFIGURATION_LIMIT",
  });
  let stale = false,
    calls = 0;
  const port = createWygloreUIConfiguration({
    check: () => {
      if (stale)
        throw Object.assign(Error("Synthetic source changed"), {
          code: "REVISION_CONFLICT",
        });
    },
  });
  port.schedule(() => calls++);
  stale = true;
  assert.throws(() => port.flush(), { code: "REVISION_CONFLICT" });
  assert.equal(calls, 0);
});
test(
  "original exclusion and character text settings are durable at their event ACK and survive immediate owner close/reopen",
  { ...actual, timeout: 30000 },
  async (t) => {
    const { pathToFileURL } = require("node:url"),
      { join } = require("node:path"),
      { randomUUID } = require("node:crypto"),
      { parse } = require("node-html-parser"),
      { EntityStore } = require("../entity/store.cjs"),
      { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
    const native = await import(
      pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
    );
    const store = new EntityStore(":memory:"),
      owners = [];
    let requests = 0;
    t.after(async () => {
      for (const owner of owners) await owner.close();
      store.close();
    });
    store.initializeState(native.createInitialRuntimeState());
    const settings = store.getResource("settings", "global");
    store.applyCommand("settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: { ...settings.payload, pluginIds: ["wyglore"] },
    });
    store.applyCommand("plugin", {
      type: "put-resource",
      kind: "plugin",
      resourceId: "wyglore",
      expectedRevision: 0,
      payload: {
        id: "wyglore",
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        script: original(),
        enabled: true,
        realArg: {},
      },
    });
    store.applyCommand("character", {
      type: "create-character",
      characterId: "garden",
      definition: {
        type: "character",
        name: "Synthetic garden",
        desc: "Synthetic settings audit only.",
        firstMessage: "Welcome.",
        globalLore: [],
        triggerscript: [],
        customModuleToggle:
          "flavor=Synthetic text=text\nchoice=Synthetic choice=select=First,Second\nflag=Synthetic flag=boolean",
      },
      chat: {
        chatId: "chat",
        metadata: { name: "Synthetic audit", localLore: [] },
      },
    });
    const namespace = {
      pluginId: "wyglore",
      bundleSha: WYGLORE_RELEASE.sha256,
      pluginEpoch: store.getResource("plugin", "wyglore").entityEpoch,
    };
    const lease = store.claimPluginStorage({
      namespace,
      writerId: "initial",
      authority: { kind: "browser" },
    });
    store.commitPluginStorage({
      lease,
      expectedRevision: 0,
      commitId: "initial",
      writes: [
        {
          key: "wl.globalSettings.v1",
          value: JSON.stringify({
            coldStartAuto: false,
            cbsToggleFloatEnabled: false,
            updateCheckEnabled: false,
            wlCbsTogglesScope: "global",
          }),
        },
      ],
    });
    store.releasePluginStorage(lease);
    const open = async () => {
      const owner = await createPluginUIRuntime({
        store: { call: async (method, ...args) => store[method](...args) },
        pluginId: "wyglore",
        chatId: "chat",
        expectedChatEpoch: 0,
        providerFetch: async () => {
          requests++;
          throw Error("Unexpected synthetic provider request");
        },
      });
      owners.push(owner);
      return owner;
    };
    const dispatch = async (owner, find, type, value) => {
      const view = await owner.snapshot(),
        element = find(parse(view.html));
      assert.ok(element);
      const request = {
        scope: view.scope,
        revision: view.revision,
        eventId: "plugin-ui:" + randomUUID(),
        nodeId: element.getAttribute("data-risu-plugin-node"),
        type,
        ...value,
      };
      const response = await owner.dispatch(request);
      assert.equal(
        store.readPluginUIEvent({
          eventId: request.eventId,
          sessionId: owner.scope.sessionId,
        }).state,
        "completed",
      );
      assert.equal(response.eventId, request.eventId);
      return response;
    };
    const clickText = (owner, text) =>
      dispatch(
        owner,
        (doc) =>
          doc
            .querySelectorAll("button")
            .find((button) => button.textContent.trim() === text),
        "click",
      );
    const absorption = async (owner) => {
      await dispatch(
        owner,
        (doc) => doc.querySelector('button[data-tab="semantic"]'),
        "click",
      );
      await clickText(owner, "흡수 설정");
    };
    const stored = () =>
      JSON.parse(
        store.readPluginStorage(namespace, "wl.globalSettings.v1").value,
      );
    const owner = await open();
    await absorption(owner);
    await dispatch(
      owner,
      (doc) =>
        doc
          .querySelectorAll("input")
          .find((input) =>
            input.getAttribute("placeholder")?.startsWith("예: 번역, 지시"),
          ),
      "input",
      { value: "Synthetic excluded module" },
    );
    assert.equal(
      owner.parameters().moduleLoreIngestExclude,
      "Synthetic excluded module",
    );
    assert.equal(stored().moduleLoreIngestExclude, "Synthetic excluded module");
    await owner.close();
    const reopened = await open();
    assert.equal(
      reopened.parameters().moduleLoreIngestExclude,
      "Synthetic excluded module",
    );
    await absorption(reopened);
    await clickText(reopened, "토글 관리");
    const toggleRow = (doc, text) =>
      doc
        .querySelectorAll("div")
        .filter((element) => element.textContent.includes(text))
        .sort(
          (left, right) => left.textContent.length - right.textContent.length,
        )
        .find((element) => element.querySelector("input,select"));
    await dispatch(
      reopened,
      (doc) => toggleRow(doc, "Synthetic text")?.querySelector("input"),
      "input",
      { value: "Synthetic toggle value" },
    );
    assert.equal(
      reopened.parameters().wlCbsToggles.toggle_flavor,
      "Synthetic toggle value",
    );
    assert.equal(stored().wlCbsToggles.toggle_flavor, "Synthetic toggle value");
    await dispatch(
      reopened,
      (doc) => toggleRow(doc, "Synthetic choice")?.querySelector("select"),
      "change",
      { value: "1" },
    );
    assert.equal(stored().wlCbsToggles.toggle_choice, "1");
    await dispatch(
      reopened,
      (doc) => doc.querySelector('[data-wl-var="toggle_flag"]'),
      "click",
    );
    assert.equal(stored().wlCbsToggles.toggle_flag, "1");
    await reopened.close();
    const final = await open();
    assert.equal(
      final.parameters().wlCbsToggles.toggle_flavor,
      "Synthetic toggle value",
    );
    assert.equal(final.parameters().wlCbsToggles.toggle_choice, "1");
    assert.equal(final.parameters().wlCbsToggles.toggle_flag, "1");
    assert.equal(
      final.parameters().moduleLoreIngestExclude,
      "Synthetic excluded module",
    );
    assert.equal(requests, 0);
    assert.equal(
      createHash("sha256")
        .update(store.getResource("plugin", "wyglore").payload.script)
        .digest("hex"),
      WYGLORE_RELEASE.sha256,
    );
  },
);
