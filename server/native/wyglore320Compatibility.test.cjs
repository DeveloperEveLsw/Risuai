"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { parse } = require("node-html-parser");
const { EntityStore } = require("../entity/store.cjs");
const { PluginUIOwners } = require("../runtime/pluginUI.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const acorn = require("acorn");
const walk = require("acorn-walk");
const {
  getWygloreRelease,
  LIFECYCLE_SEAM,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const {
  CONFIRMATION_PROFILE,
  CONFIRMATION_PROFILE_320,
  REVIEWED_CONFIRMATIONS_320,
  validateWygloreConfirmationSites,
  validateWygloreConfirmationProfile,
  instrumentWygloreUIConfirmations,
} = require("./wygloreUIConfirmation.cjs");
const fixture = join(
  __dirname,
  "../../.local-runtime/public-plugins/wyglore-leaf/3.2.0/WygLoreLeaf-latest.js",
);
const actual = {
  skip: fs.existsSync(fixture)
    ? false
    : "Fetch the pinned public WygLore 3.2.0 fixture",
};
const sha = "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9";
const original = () => fs.readFileSync(fixture, "utf8");
const count = (source, part) => source.split(part).length - 1;

async function integrationFixture(t) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(":memory:");
  const owners = [];
  const transport = { call: async (method, ...args) => store[method](...args) };
  let unexpectedRequests = 0;
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      pluginIds: ["wyglore"],
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-main",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: true,
      mainPrompt: "Help the gardener.",
      maxContext: 8000,
      maxResponse: 200,
      requestRetrys: 0,
    },
  });
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: "◆ WygLore Leaf",
      version: "3.0",
      versionOfPlugin: "3.2.0",
      enabled: true,
      script: original(),
      realArg: {},
    },
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "garden",
    definition: {
      type: "character",
      name: "Green",
      desc: "Green tends blue flowers.",
      firstMessage: "Welcome to the garden.",
      globalLore: [],
      triggerscript: [],
    },
    chat: {
      chatId: "chat",
      metadata: { name: "Synthetic garden", localLore: [] },
    },
  });
  const namespace = {
    pluginId: "wyglore",
    bundleSha: sha,
    pluginEpoch: store.getResource("plugin", "wyglore").entityEpoch,
  };
  const lease = store.claimPluginStorage({
    namespace,
    writerId: "synthetic-initial",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease,
    expectedRevision: 0,
    commitId: "synthetic-initial",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          speedMode: "fast",
          // Deliberately enabled in user settings: the server presentation flag,
          // rather than mutating this setting, must suppress the browser shortcut.
          cbsToggleFloatEnabled: true,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  store.releasePluginStorage(lease);
  t.after(async () => {
    for (const owner of owners) await owner.close();
    store.close();
  });
  return {
    native,
    store,
    namespace,
    transport,
    requests: () => unexpectedRequests,
    async open() {
      const owner = await createPluginUIRuntime({
        store: transport,
        pluginId: "wyglore",
        chatId: "chat",
        expectedChatEpoch: 0,
        providerFetch: async () => {
          unexpectedRequests++;
          throw new Error("Unexpected synthetic provider request");
        },
      });
      owners.push(owner);
      return owner;
    },
  };
}

async function dispatch(owner, find, type, values = {}) {
  const view = await owner.snapshot(),
    element = find(parse(view.html));
  assert.ok(element, "The original 3.2.0 control must exist");
  const request = {
    scope: view.scope,
    revision: view.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: element.getAttribute("data-risu-plugin-node"),
    type,
    ...values,
  };
  return { request, response: await owner.dispatch(request) };
}

function adaptedNodes(source) {
  const result = {
    ports: [],
    helpers: [],
    manualReturns: [],
    asyncStarts: new Set(),
  };
  walk.fullAncestor(
    acorn.parse(source, { ecmaVersion: "latest" }),
    (node, _state, parents) => {
      if (
        node.type === "ReturnStatement" &&
        node.argument?.type === "CallExpression" &&
        node.argument.callee.type === "MemberExpression" &&
        node.argument.callee.property.name === "catch" &&
        node.argument.callee.object.type === "CallExpression" &&
        node.argument.callee.object.callee.name === "runManualColdStart"
      )
        result.manualReturns.push(node);
      if (
        node.type === "FunctionDeclaration" &&
        ["openDraft", "confirmLargeRecapSelection"].includes(node.id?.name)
      ) {
        assert.equal(node.async, true);
        result.asyncStarts.add(node.start);
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
        result.ports.push({ node, owner });
      }
      if (callee.name === "confirmLargeRecapSelection")
        result.helpers.push(node);
    },
  );
  return result;
}

test(
  "3.2.0 pins its own complete confirmation profile while retaining the reviewed 3.1.6 profile",
  actual,
  () => {
    const source = original();
    assert.equal(Buffer.byteLength(source), 2781807);
    assert.equal(createHash("sha256").update(source).digest("hex"), sha);
    assert.equal(getWygloreRelease(source).version, "3.2.0");
    assert.equal(CONFIRMATION_PROFILE.calls.length, 26);
    assert.equal(CONFIRMATION_PROFILE.calls[0].start, 897652);
    assert.equal(
      Object.isFrozen(CONFIRMATION_PROFILE_320.calls[0].function),
      true,
    );
    assert.equal(
      validateWygloreConfirmationSites(source, REVIEWED_CONFIRMATIONS_320),
      true,
    );
    const profile = validateWygloreConfirmationProfile(
      source,
      CONFIRMATION_PROFILE_320,
    );
    assert.equal(profile.calls.length, 26);
    assert.equal(profile.helpers.length, 2);
    assert.equal(profile.consumers.length, 3);
    assert.equal(profile.manualConsumers.length, 2);
    assert.equal(
      profile.functions.find((fn) => fn.name === "createBtn").sha256,
      CONFIRMATION_PROFILE.functions.find((fn) => fn.name === "createBtn")
        .sha256,
    );
  },
);

test(
  "3.2.0 confirmation adaptation is byte-exact reversible and preserves every original target/selection guard",
  actual,
  () => {
    const source = original(),
      executable = instrumentWygloreUIConfirmations(source);
    new vm.Script(executable);
    assert.equal(count(executable, LIFECYCLE_SEAM), 1);
    const adapted = executable.replace(LIFECYCLE_SEAM, "");
    const nodes = adaptedNodes(adapted);
    assert.equal(nodes.ports.length, 26);
    assert.equal(nodes.helpers.length, 2);
    assert.equal(nodes.manualReturns.length, 2);
    assert.equal(count(adapted, "window.confirm("), 0);
    const edits = nodes.ports.map(({ node, owner }, index) => {
      const call = CONFIRMATION_PROFILE_320.calls[index];
      if (!call.function.async) nodes.asyncStarts.add(owner.start);
      assert.equal(adapted[node.start - 1], "(");
      assert.equal(adapted[node.end], ")");
      return {
        start: node.start - 1,
        end: node.end + 1,
        value: source.slice(call.start, call.end),
      };
    });
    nodes.helpers.forEach((node, index) => {
      const call = CONFIRMATION_PROFILE_320.helpers[index];
      edits.push({
        start: node.start - 1,
        end: node.end + 1,
        value: source.slice(call.start, call.end),
      });
    });
    assert.equal(nodes.asyncStarts.size, 3);
    for (const node of nodes.manualReturns) {
      assert.equal(adapted.slice(node.start, node.start + 7), "return ");
      edits.push({ start: node.start, end: node.start + 7, value: "" });
    }
    for (const start of nodes.asyncStarts) {
      assert.equal(adapted.slice(start, start + 6), "async ");
      edits.push({ start, end: start + 6, value: "" });
    }
    let reversed = adapted;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      reversed =
        reversed.slice(0, edit.start) + edit.value + reversed.slice(edit.end);
    assert.equal(reversed, source);
    for (const site of REVIEWED_CONFIRMATIONS_320) {
      assert.equal(count(source, site.before), 1);
      assert.equal(count(executable, site.after), 1);
    }
  },
);

test(
  "3.2.0 native generation retains original synchronous dialogs and the untouched author body",
  actual,
  () => {
    const source = original(),
      executable = instrumentWygloreLifecycle(source);
    assert.equal(executable.replace(LIFECYCLE_SEAM, ""), source);
    assert.equal(count(executable, "window.confirm("), 15);
    assert.equal(count(executable, "__RISU_PLUGIN_UI_CONFIRM"), 0);
  },
);

test(
  "3.2.0 rejects changed bytes, missing target guards, duplicated consent and discarded Promise consumers",
  actual,
  () => {
    const source = original();
    assert.throws(
      () => instrumentWygloreUIConfirmations(source + "\n"),
      /bundle hash differs/,
    );
    assert.throws(
      () =>
        validateWygloreConfirmationSites(
          source.replace(
            "if(await target.assertSelected(),!window.confirm(",
            "if(!window.confirm(",
          ),
          REVIEWED_CONFIRMATIONS_320,
        ),
      /memory-import/,
    );
    const site = REVIEWED_CONFIRMATIONS_320[0];
    assert.throws(
      () =>
        validateWygloreConfirmationSites(
          source + site.before,
          REVIEWED_CONFIRMATIONS_320,
        ),
      /memory-import/,
    );
    const consumer = CONFIRMATION_PROFILE_320.consumers.find(
      (call) => call.callee === "openDraft",
    );
    const discarded =
      "()=>{" + source.slice(consumer.start, consumer.end) + "}";
    assert.throws(
      () =>
        validateWygloreConfirmationProfile(
          source.slice(0, consumer.function.start) +
            discarded +
            source.slice(consumer.function.end),
          CONFIRMATION_PROFILE_320,
        ),
      /profile/,
    );
  },
);

test(
  "the original 3.2.0 import waits for target validation and explicit consent before its only mutation",
  actual,
  async () => {
    const executable = instrumentWygloreUIConfirmations(original());
    const index = CONFIRMATION_PROFILE_320.calls.findIndex(
      (call) => call.id === "memory-import",
    );
    const owner = adaptedNodes(executable).ports[index].owner;
    const body = executable.slice(owner.start, owner.end);
    for (const choice of [false, true, "stale"]) {
      const events = [];
      let answer;
      const consent = new Promise((resolve) => {
        answer = resolve;
      });
      const selected = { synthetic: true };
      const target = {
        async assertSelected() {
          events.push("target-check");
          if (choice === "stale") throw new Error("synthetic target changed");
        },
      };
      const sandbox = {
        captureSnapshotRestoreTarget: () => {
          events.push("target-capture");
          return target;
        },
        pickJSONFile: async () => {
          events.push("file-selected");
          return selected;
        },
        __RISU_PLUGIN_UI_CONFIRM: () => {
          events.push("consent");
          return consent;
        },
        importEngineSnapshot: async (value, options) => {
          assert.equal(value, selected);
          assert.equal(options.target, target);
          events.push("import");
          return { ok: true, unitCount: 0 };
        },
        recordMemoryImport: () => events.push("record"),
        logRow: { textContent: "" },
      };
      const task = vm.runInNewContext(`(${body})()`, sandbox);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        events,
        choice === "stale"
          ? ["target-capture", "file-selected", "target-check"]
          : ["target-capture", "file-selected", "target-check", "consent"],
      );
      answer(choice === true);
      await task;
      assert.equal(
        events.filter((event) => event === "import").length,
        choice === true ? 1 : 0,
      );
      assert.equal(
        events.filter((event) => event === "record").length,
        choice === true ? 1 : 0,
      );
    }
  },
);

test(
  "3.2.0 is admitted and its real server settings/model input save with ACK, survive reopen and retain the original plugin bytes",
  actual,
  async (t) => {
    const f = await integrationFixture(t);
    const service = new PluginUIOwners({
      store: f.transport,
      enabled: true,
      serverId: "synthetic-server",
    });
    t.after(() => service.close());
    const capability = await service.capability("wyglore");
    assert.equal(capability.supported, true);
    assert.equal(capability.enabled, true);
    const owner = await f.open();
    assert.equal(owner.scope.bundleSha, sha);
    const view = await owner.snapshot();
    assert.equal(
      parse(view.html).querySelectorAll("button[data-tab]").length,
      7,
    );
    assert.equal(owner.parameters().cbsToggleFloatEnabled, true);
    await dispatch(
      owner,
      (doc) => doc.querySelector('button[data-tab="settings"]'),
      "click",
    );
    const { request } = await dispatch(
      owner,
      (doc) =>
        doc
          .querySelectorAll("label")
          .find((label) =>
            label.textContent.includes("백그라운드 진행 우선 켜기"),
          )
          ?.querySelector('input[type="checkbox"]'),
      "change",
      { checked: false },
    );
    assert.equal(owner.parameters().backgroundFirstEnabled, false);
    assert.equal(
      f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: request.eventId,
      }).state,
      "completed",
    );
    await dispatch(
      owner,
      (doc) => doc.querySelector('button[data-tab="providers"]'),
      "click",
    );
    await dispatch(
      owner,
      (doc) => doc.querySelector(".wl-active-slot-grid select"),
      "change",
      { value: "custom-openai" },
    );
    const model = await dispatch(
      owner,
      (doc) => doc.querySelector('.wl-active-slot-grid input[type="text"]'),
      "input",
      { value: "synthetic-memory-model" },
    );
    assert.equal(
      f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: model.request.eventId,
      }).state,
      "completed",
    );
    const config = JSON.parse(
      f.store.readPluginStorage(f.namespace, "wl.llm.config").value,
    );
    assert.equal(config.completeProviderId, "custom-openai");
    assert.equal(config.completeModel, "synthetic-memory-model");
    await owner.close();
    const reopened = await f.open();
    assert.equal(reopened.parameters().backgroundFirstEnabled, false);
    assert.equal(reopened.parameters().cbsToggleFloatEnabled, true);
    await dispatch(
      reopened,
      (doc) => doc.querySelector('button[data-tab="providers"]'),
      "click",
    );
    const reopenedHtml = parse((await reopened.snapshot()).html);
    assert.equal(
      reopenedHtml
        .querySelector('.wl-active-slot-grid input[type="text"]')
        .getAttribute("value"),
      "synthetic-memory-model",
    );
    assert.equal(
      createHash("sha256")
        .update(f.store.getResource("plugin", "wyglore").payload.script)
        .digest("hex"),
      sha,
    );
    assert.equal(f.requests(), 0);
  },
);

test(
  "3.2.0 executes real streaming generation and author marker writes through the staged job facade, then commits and restarts",
  actual,
  async (t) => {
    const f = await integrationFixture(t);
    let requests = 0;
    for (const id of ["first", "second"]) {
      f.store.enqueueJob(id, {
        type: "send",
        chatId: "chat",
        input: "Tell me about blue flowers.",
        messageId: id + ":input",
      });
      const claimed = f.store.claimJob("worker:" + id);
      const providerFetch = async (url, init) => {
        requests++;
        assert.equal(
          String(url),
          "https://synthetic.invalid/v1/chat/completions",
        );
        const body = JSON.parse(init.body);
        assert.equal(body.stream, true);
        assert.match(
          body.messages.map((message) => message.content).join("\n"),
          /WygLore Leaf — canonical layer/,
        );
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "The blue flowers bloom." } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const coordinator = createNativePluginCoordinator({
        store: f.transport,
        job: claimed.job,
        snapshot: claimed.snapshot,
        fetch: async () => {
          throw new Error("Unexpected memory request");
        },
        alertSelect: async () => {
          throw new Error("Unexpected synthetic interaction");
        },
      });
      try {
        const outcome = await f.native.executeExtensionJob(claimed, {
          appVer: "2026.8.250",
          providerFetch,
          fetch: async (path) =>
            new Response(
              fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
            ),
          preparePluginSnapshot: coordinator.prepareSnapshot,
          openPluginRuntime: coordinator.open,
        });
        assert.equal(outcome.pluginStorage.lease.namespace.bundleSha, sha);
        assert.ok(outcome.pluginStorage.writes.length > 0);
        assert.equal(
          f.store.snapshot("chat").messages.length,
          id === "first" ? 0 : 2,
        );
        f.store.finishJob(
          claimed.job.id,
          claimed.job.owner,
          claimed.job.fence,
          { state: "completed", ...outcome },
        );
        const saved = f.store.snapshot("chat");
        assert.equal(
          saved.messages.at(-1).message.data,
          "The blue flowers bloom.",
        );
        assert.ok(
          saved.chat.metadata.localLore.some(
            (entry) =>
              entry.key === "__wl_marker__" ||
              /^wl\.marker\.v\d+$/i.test(entry.comment ?? ""),
          ),
        );
      } finally {
        await coordinator.release();
      }
    }
    assert.equal(requests, 2);
    assert.equal(f.store.snapshot("chat").messages.length, 4);
    assert.equal(f.requests(), 0);
  },
);

test(
  "3.2.0 restores a flushed original 3.1.6 memory archive and recalls its canonical facts without any provider request",
  actual,
  async () => {
    const legacy = makeWygloreContractFixture({
      settings: { shortTermWindow: 7 },
    });
    let restored;
    try {
      const previous = await legacy.boot(
        fs.readFileSync(
          join(
            __dirname,
            "../../.local-runtime/public-plugins/wyglore-leaf/3.1.6/WygLoreLeaf-latest.js",
          ),
          "utf8",
        ),
      );
      await legacy.hooks.beforeRequest[0](
        [
          { role: "system", content: "Help the gardener." },
          { role: "user", content: "Remember Green and the garden." },
        ],
        "model",
      );
      await legacy.settle();
      const countBefore = previous.unitsCount();
      assert.equal(countBefore, 2);
      const marker = legacy.chat.localLore.find(
        (entry) => entry.key === "__wl_marker__",
      );
      assert.equal(JSON.parse(marker.content).unitCount, countBefore);
      const canonicalIds = [...legacy.storage]
        .filter(([key]) => key.includes(":units:"))
        .flatMap(([, value]) => JSON.parse(value))
        .filter((unit) => unit.flags?.canonical)
        .map((unit) => unit.id)
        .sort();
      assert.equal(canonicalIds.length, countBefore);
      await legacy.close();
      const archive = structuredClone(legacy.storage);
      archive.set("synthetic.unknown-preserved", { retained: [false, 0, ""] });
      const chat = structuredClone(legacy.chat);
      restored = makeWygloreContractFixture({
        storage: archive,
        chat,
        settings: { shortTermWindow: 7, coldStartAuto: false },
      });
      const current = await restored.boot(original());
      assert.equal(
        current.unitsCount(),
        countBefore,
        "Memory is loaded before a new request can regenerate canonical units",
      );
      const recalled = await restored.hooks.beforeRequest[0](
        [
          { role: "system", content: "Help the gardener." },
          { role: "user", content: "Remember Green and the garden." },
        ],
        "model",
      );
      const prompt = recalled.map((message) => message.content).join("\n");
      assert.match(prompt, /WygLore Leaf — canonical layer/);
      assert.match(prompt, /A gardener named Green welcomes visitors/);
      await restored.settle();
      assert.equal(current.unitsCount(), countBefore);
      const restoredCanonicalIds = [...restored.storage]
        .filter(([key]) => key.includes(":units:"))
        .flatMap(([, value]) => JSON.parse(value))
        .filter((unit) => unit.flags?.canonical)
        .map((unit) => unit.id)
        .sort();
      assert.deepEqual(restoredCanonicalIds, canonicalIds);
      assert.equal(current.parameters().shortTermWindow, 7);
      assert.deepEqual(restored.storage.get("synthetic.unknown-preserved"), {
        retained: [false, 0, ""],
      });
      assert.equal(
        legacy.calls.filter((call) => call.method === "provider").length,
        0,
      );
      assert.equal(
        restored.calls.filter((call) => call.method === "provider").length,
        0,
      );
    } finally {
      await legacy.close();
      await restored?.close();
    }
  },
);
