"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const acorn = require("acorn");
const {
  HOLOCALL_BUTTON_RELEASE,
  matchesHolocallButtonRelease,
} = require("./holocallButtonContract.cjs");
const { reviewButtonPlugins } = require("./buttonPluginPolicy.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");

const fixture = join(
  __dirname,
  "../../.local-runtime/public-plugins/creditail-holocall-bridge/1.3.0/creditail_holocall_bridge.js",
);
const actual = {
  skip: fs.existsSync(fixture)
    ? false
    : "Preserve the pinned original HoloCall 1.3.0 fixture",
};
const original = () => fs.readFileSync(fixture, "utf8");

function holocall(overrides = {}) {
  return {
    id: "holocall",
    name: "creditail_holocall_bridge",
    version: "3.0",
    versionOfPlugin: "1.3.0",
    enabled: true,
    script: original(),
    realArg: { synthetic: "configuration must remain unchanged" },
    ...overrides,
  };
}

function snapshot(plugins = []) {
  return {
    character: { id: "garden", revision: 4, entityEpoch: 1 },
    chat: { id: "chat", revision: 5, entityEpoch: 2 },
    resources: [
      {
        kind: "settings",
        id: "global",
        revision: 2,
        entityEpoch: 0,
        payload: { synthetic: "settings must remain unchanged" },
      },
      ...plugins.map((payload, index) => ({
        kind: "plugin",
        id: payload.id,
        revision: index + 3,
        entityEpoch: index + 1,
        payload,
      })),
    ],
  };
}

test(
  "HoloCall button exception pins the complete original artifact",
  actual,
  () => {
    const script = original();
    assert.ok(Object.isFrozen(HOLOCALL_BUTTON_RELEASE));
    assert.deepEqual(HOLOCALL_BUTTON_RELEASE, {
      name: "creditail_holocall_bridge",
      apiVersion: "3.0",
      version: "1.3.0",
      sha256:
        "d7ce51b5edbf46940b2c3526bba0ed933ca8f548733c3035a12466c0f474bcf3",
      bytes: 137666,
    });
    assert.equal(Buffer.byteLength(script), HOLOCALL_BUTTON_RELEASE.bytes);
    assert.equal(
      createHash("sha256").update(script).digest("hex"),
      HOLOCALL_BUTTON_RELEASE.sha256,
    );
  },
);

test(
  "HoloCall identity uses API version and original bytes rather than reported display version",
  actual,
  () => {
    assert.equal(matchesHolocallButtonRelease(holocall()), true);
    assert.equal(
      matchesHolocallButtonRelease(holocall({ versionOfPlugin: "untrusted" })),
      true,
    );
  },
);

test(
  "HoloCall contract rejects renamed, alternate-API and changed source artifacts",
  actual,
  () => {
    for (const plugin of [
      null,
      {},
      holocall({ name: "renamed" }),
      holocall({ version: "1.3.0" }),
      holocall({ version: "3.1" }),
      holocall({ script: original() + "\n" }),
      holocall({ script: "" }),
      holocall({ script: null }),
    ])
      assert.equal(matchesHolocallButtonRelease(plugin), false);
  },
);

test(
  "an exact active HoloCall alone permits native character buttons",
  actual,
  () => {
    const plugin = holocall();
    const admission = reviewButtonPlugins(snapshot([plugin]));
    assert.equal(admission.pluginId, plugin.id);
    assert.equal(admission.pluginRequiresServerHost(plugin, {}), false);
    assert.equal(
      admission.pluginRequiresServerHost({ ...plugin, id: "uncaptured" }, {}),
      true,
    );
  },
);

test(
  "button review leaves HoloCall enabled, original script, arguments and settings unchanged",
  actual,
  () => {
    const captured = snapshot([holocall()]);
    const before = structuredClone(captured);
    const admission = reviewButtonPlugins(captured);
    assert.equal(
      admission.pluginRequiresServerHost(captured.resources[1].payload, {}),
      false,
    );
    assert.deepEqual(captured, before);
  },
);

test(
  "disabled HoloCall does not create a native button exemption",
  actual,
  () => {
    assert.equal(
      reviewButtonPlugins(snapshot([holocall({ enabled: false })])),
      null,
    );
  },
);

test(
  "HoloCall does not allow an unrelated enabled plugin through button admission",
  actual,
  () => {
    assert.throws(
      () =>
        reviewButtonPlugins(
          snapshot([
            holocall(),
            { id: "other", name: "unknown", enabled: true, script: "unknown" },
          ]),
        ),
      { code: "PLUGIN_UNSUPPORTED" },
    );
  },
);

test(
  "same-name altered HoloCall source is rejected before native Lua execution",
  actual,
  () => {
    assert.throws(
      () =>
        reviewButtonPlugins(
          snapshot([holocall({ script: original() + "\n// changed" })]),
        ),
      { code: "PLUGIN_UNSUPPORTED" },
    );
  },
);

test(
  "HoloCall-only admission captures settings, all plugin rows and collection, character and chat revisions",
  actual,
  () => {
    const plugin = holocall();
    const inactive = { id: "inactive", enabled: false, script: "unreviewed" };
    const admission = reviewButtonPlugins(snapshot([plugin, inactive]));
    assert.deepEqual(admission.reads, {
      version: 1,
      characters: [{ id: "garden", revision: 4, epoch: 1 }],
      chats: [{ id: "chat", revision: 5, epoch: 2 }],
      resources: [
        { kind: "settings", id: "global", revision: 2, epoch: 0 },
        { kind: "plugin", id: "holocall", revision: 3, epoch: 1 },
        { kind: "plugin", id: "inactive", revision: 4, epoch: 2 },
      ],
      collectionSets: [{ kind: "plugin", ids: ["holocall", "inactive"] }],
    });
    assert.equal(admission.pluginRequiresServerHost(inactive, {}), false);
    assert.equal(
      admission.pluginRequiresServerHost({ ...inactive, enabled: true }, {}),
      true,
    );
  },
);

test(
  "HoloCall exemption never changes general generation/plugin host admission",
  actual,
  () => {
    const plugin = holocall();
    assert.equal(pluginRequiresServerHost(plugin, {}), true);
    const admission = reviewButtonPlugins(snapshot([plugin]));
    assert.equal(admission.pluginRequiresServerHost(plugin, {}), false);
    assert.equal(pluginRequiresServerHost(plugin, {}), true);
  },
);

for (const version of ["3.1.6", "3.2.0"]) {
  const wygPath = join(
    __dirname,
    `../../.local-runtime/public-plugins/wyglore-leaf/${version}/WygLoreLeaf-latest.js`,
  );
  const combined = {
    skip:
      actual.skip ||
      (fs.existsSync(wygPath)
        ? false
        : `Fetch the pinned public WygLore ${version} fixture`),
  };
  const wyg = () => ({
    id: "wyglore",
    name: "◆ WygLore Leaf",
    version: "3.0",
    enabled: true,
    script: fs.readFileSync(wygPath, "utf8"),
  });

  test(
    `HoloCall coexists with WygLore ${version} while Wyg keeps admission ownership`,
    combined,
    () => {
      const bridge = holocall();
      const memory = wyg();
      const admission = reviewButtonPlugins(snapshot([bridge, memory]));
      assert.equal(admission.pluginId, memory.id);
      assert.equal(admission.pluginRequiresServerHost(bridge, {}), false);
      assert.equal(admission.pluginRequiresServerHost(memory, {}), false);
      assert.deepEqual(admission.reads.resources, [
        { kind: "settings", id: "global", revision: 2, epoch: 0 },
        { kind: "plugin", id: "holocall", revision: 3, epoch: 1 },
        { kind: "plugin", id: "wyglore", revision: 4, epoch: 2 },
      ]);
      assert.deepEqual(admission.reads.collectionSets, [
        { kind: "plugin", ids: ["holocall", "wyglore"] },
      ]);
    },
  );

  test(
    `HoloCall/WygLore ${version} captured identities cannot be substituted later`,
    combined,
    () => {
      const bridge = holocall();
      const memory = wyg();
      const admission = reviewButtonPlugins(snapshot([bridge, memory]));
      for (const plugin of [bridge, memory]) {
        assert.equal(
          admission.pluginRequiresServerHost(
            { ...plugin, id: "different" },
            {},
          ),
          true,
        );
        assert.equal(
          admission.pluginRequiresServerHost(
            { ...plugin, script: plugin.script + "\n" },
            {},
          ),
          true,
        );
      }
    },
  );

  test(
    `HoloCall does not weaken the single WygLore ${version} owner restriction`,
    combined,
    () => {
      const memory = wyg();
      assert.throws(
        () =>
          reviewButtonPlugins(
            snapshot([holocall(), memory, { ...memory, id: "second-wyglore" }]),
          ),
        { code: "PLUGIN_UNSUPPORTED" },
      );
    },
  );
}

test(
  "original HoloCall AST exposes only reviewed direct APIs and registers no edit/request/trigger hooks",
  actual,
  () => {
    const ast = acorn.parse(original(), { ecmaVersion: "latest" });
    const members = new Set();
    const unsafe = [];
    function visit(node, parent) {
      if (!node || typeof node !== "object") return;
      if (node.type === "Identifier" && node.name === "Risuai") {
        // Reject aliases, enumeration and computed APIs: those would invalidate
        // the direct-call inventory instead of hiding new hook registration.
        assert.equal(parent?.type, "MemberExpression");
        assert.equal(parent.object, node);
        assert.equal(parent.computed, false);
        members.add(parent.property.name);
      }
      if (node.type === "ImportExpression") unsafe.push("dynamic import");
      if (
        ["CallExpression", "NewExpression"].includes(node.type) &&
        node.callee?.type === "Identifier" &&
        ["eval", "Function", "require"].includes(node.callee.name)
      )
        unsafe.push(node.callee.name);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => visit(child, node));
        else if (value && typeof value === "object") visit(value, node);
      }
    }
    visit(ast);
    assert.deepEqual(unsafe, []);
    assert.deepEqual([...members].sort(), [
      "alert",
      "createMutationObserver",
      "getArgument",
      "getCharacterFromIndex",
      "getChatFromIndex",
      "getCurrentCharacterIndex",
      "getCurrentChatIndex",
      "getDatabase",
      "getRootDocument",
      "hideContainer",
      "nativeFetch",
      "onUnload",
      "pluginStorage",
      "requestPluginPermission",
      "runLLMModel",
      "setCharacterToIndex",
      "setChatToIndex",
      "showContainer",
      "unwarpSafeArray",
    ]);
  },
);

function syntheticElement() {
  return {
    value: "",
    hidden: true,
    dataset: {},
    style: {},
    classList: { toggle() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    focus() {},
    setSelectionRange() {},
  };
}

async function bootOriginal(mode) {
  const calls = [];
  const nodes = new Map();
  const errors = [];
  const logs = [];
  let unload;
  let mutation;
  const root = {
    async querySelectorAll(selector) {
      calls.push(["dom.querySelectorAll", selector]);
      return [];
    },
    async querySelector(selector) {
      calls.push(["dom.querySelector", selector]);
      return selector === "body" ? {} : null;
    },
  };
  const permitted = {
    pluginStorage: {
      async getItem(key) {
        calls.push(["pluginStorage.getItem", key]);
        return null;
      },
      async setItem() {
        throw new Error("Unexpected synthetic plugin storage write");
      },
    },
    async requestPluginPermission(permission) {
      calls.push(["requestPluginPermission", permission]);
      return mode !== "permission-denied";
    },
    async getRootDocument() {
      calls.push(["getRootDocument"]);
      return mode === "root-unavailable" ? null : root;
    },
    unwarpSafeArray: (value) => value,
    async createMutationObserver(callback) {
      calls.push(["createMutationObserver"]);
      mutation = callback;
      return {
        observe: async () => calls.push(["observer.observe"]),
        disconnect: async () => calls.push(["observer.disconnect"]),
      };
    },
    async onUnload(callback) {
      calls.push(["onUnload"]);
      unload = callback;
    },
  };
  const context = vm.createContext({
    Risuai: new Proxy(permitted, {
      get(target, property) {
        if (property in target) return target[property];
        throw new Error(`Unexpected synthetic Risu API ${String(property)}`);
      },
    }),
    document: {
      body: { innerHTML: "" },
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, syntheticElement());
        return nodes.get(id);
      },
    },
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    atob,
    btoa,
    setTimeout() {
      throw new Error("Unexpected synthetic startup timer");
    },
    clearTimeout() {},
    setInterval() {
      throw new Error("Unexpected synthetic startup interval");
    },
    clearInterval() {},
    fetch() {
      throw new Error("Synthetic network is blocked");
    },
    console: {
      log: (...values) => logs.push(values.map(String).join(" ")),
      warn: (...values) => errors.push(values.map(String).join(" ")),
      error: (...values) => errors.push(values.map(String).join(" ")),
    },
  });
  await vm.runInContext(original(), context, { timeout: 1000 });
  if (mode === "empty-safedom") {
    assert.equal(typeof unload, "function");
    assert.equal(typeof mutation, "function");
    assert.ok(logs.some((message) => message.endsWith(" installed")));
    await unload();
  }
  assert.deepEqual(errors, []);
  return calls;
}

for (const mode of ["permission-denied", "root-unavailable", "empty-safedom"])
  test(
    `original HoloCall ${mode} boot uses no model, canonical data or native hook APIs`,
    actual,
    async () => {
      const calls = await bootOriginal(mode);
      const expected = [
        ["pluginStorage.getItem", "holo-bridge-streaming-enabled"],
        ["requestPluginPermission", "mainDom"],
        ...(mode !== "permission-denied" ? [["getRootDocument"]] : []),
        ...(mode === "empty-safedom"
          ? [
              ["dom.querySelectorAll", 'div[id^="holo-input-"]'],
              ["dom.querySelectorAll", 'input[id^="holo-input-"]'],
              ["dom.querySelectorAll", 'button[class*="ct-holo-send-btn"]'],
              ["dom.querySelector", "body"],
              ["createMutationObserver"],
              ["observer.observe"],
              ["onUnload"],
              ["observer.disconnect"],
            ]
          : []),
      ];
      assert.deepEqual(calls, expected);
    },
  );
