"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");

const path =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(path)
    ? false
    : "Fetch the pinned WygLore fixture before compatibility validation",
};

async function fixture(t) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  store.initializeState(native.createInitialRuntimeState());
  let commandId = 0;
  const command = (input) =>
    store.applyCommand("synthetic-source:" + ++commandId, input);
  const previous = store.getResource("settings", "global");
  command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: previous.revision,
    payload: {
      ...previous.payload,
      aiModel: "reverse_proxy",
      pluginIds: ["wyglore"],
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      useStreaming: false,
      mainPrompt: "Help the synthetic gardener.",
      maxContext: 8000,
      maxResponse: 200,
      enabledModules: ["module"],
      selectedPersona: 0,
    },
  });
  for (const [kind, resourceId, payload] of [
    [
      "plugin",
      "wyglore",
      {
        id: "wyglore",
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        enabled: true,
        script: fs.readFileSync(path, "utf8"),
        realArg: {},
      },
    ],
    [
      "module",
      "module",
      { id: "module", name: "Synthetic flower module", lorebook: [] },
    ],
    [
      "persona",
      "persona",
      {
        id: "persona",
        name: "Synthetic visitor",
        personaPrompt: "A visitor likes blue flowers.",
        lorebook: [],
      },
    ],
  ])
    command({
      type: "put-resource",
      kind,
      resourceId,
      expectedRevision: 0,
      payload,
    });
  command({
    type: "change-variables",
    edits: [
      {
        scope: "global",
        key: "toggle_garden",
        expectedRevision: 0,
        value: true,
      },
    ],
  });
  command({
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
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: 0,
  };
  const initial = store.claimPluginStorage({
    namespace,
    writerId: "synthetic-config",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease: initial,
    expectedRevision: 0,
    commitId: "synthetic-initial",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          canonicalIngestEnabled: true,
          speedMode: "fast",
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  store.releasePluginStorage(initial);
  const requests = [];
  const providerFetch = async (url, init) => {
    assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(
      body.model,
      "synthetic-model",
      "This short-history fixture does not use a memory provider",
    );
    requests.push(body);
    return Response.json({
      choices: [{ message: { content: "The blue flowers bloom." } }],
    });
  };
  store.enqueueJob("synthetic-generation", {
    type: "send",
    chatId: "chat",
    input: "Tell me about the flowers.",
    messageId: "synthetic-input",
  });
  const claimed = store.claimJob("synthetic-worker");
  const coordinator = createNativePluginCoordinator({
    store: { call: async (method, ...args) => store[method](...args) },
    job: claimed.job,
    snapshot: claimed.snapshot,
    fetch: providerFetch,
    alertSelect: async () => {
      throw Error("Unexpected synthetic interaction");
    },
  });
  let result;
  try {
    result = await native.executeExtensionJob(claimed, {
      appVer: "2026.8.250",
      providerFetch,
      preparePluginSnapshot: coordinator.prepareSnapshot,
      openPluginRuntime: coordinator.open,
      fetch: async (path) =>
        new Response(
          fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
        ),
    });
  } catch (error) {
    await coordinator.release();
    throw error;
  }
  function edit(target, value) {
    const current = store.readFields([target]).fields[0];
    command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: current.revision,
          expectedEpoch: current.entityEpoch,
          value,
        },
      ],
    });
  }
  return {
    store,
    namespace,
    command,
    edit,
    coordinator,
    result,
    requests,
    finish: () =>
      store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
        state: "completed",
        ...result,
      }),
  };
}

for (const change of [
  "character description",
  "main prompt",
  "module",
  "persona",
  "plugin arguments",
  "global variable",
  "new module membership",
  "new absent global variable",
])
  test(
    `compiled original-plugin checkpoint rejects changed ${change} without graph/chat persistence or provider replay`,
    actual,
    async (t) => {
      const f = await fixture(t);
      try {
        assert.equal(f.requests.length, 1);
        assert.ok(
          f.result.pluginStorage.writes.length > 0,
          "Actual plugin derived a private graph checkpoint",
        );
        assert.equal(f.result.pluginStorage.reads.version, 1);
        assert.ok(
          f.result.pluginStorage.reads.collectionSets.some(
            (row) => row.kind === "module",
          ),
        );
        assert.ok(
          f.result.pluginStorage.reads.collectionSets.some(
            (row) => row.kind === "persona",
          ),
        );
        assert.deepEqual(f.result.pluginStorage.reads.globalVariables.ids, [
          "toggle_garden",
        ]);
        if (change === "character description")
          f.edit(
            { scope: "character", entityId: "garden", key: "desc" },
            "Green now tends red flowers.",
          );
        else if (change === "main prompt")
          f.edit(
            {
              scope: "resource",
              resourceKind: "settings",
              entityId: "global",
              key: "mainPrompt",
            },
            "Synthetic changed main prompt.",
          );
        else if (change === "module")
          f.edit(
            {
              scope: "resource",
              resourceKind: "module",
              entityId: "module",
              key: "name",
            },
            "Synthetic changed module.",
          );
        else if (change === "persona")
          f.edit(
            {
              scope: "resource",
              resourceKind: "persona",
              entityId: "persona",
              key: "personaPrompt",
            },
            "A visitor now likes red flowers.",
          );
        else if (change === "plugin arguments")
          f.edit(
            {
              scope: "resource",
              resourceKind: "plugin",
              entityId: "wyglore",
              key: "realArg",
            },
            { synthetic: "changed" },
          );
        else if (change === "global variable")
          f.command({
            type: "change-variables",
            edits: [
              {
                scope: "global",
                key: "toggle_garden",
                expectedRevision: 1,
                value: false,
              },
            ],
          });
        else if (change === "new absent global variable")
          f.command({
            type: "change-variables",
            edits: [
              {
                scope: "global",
                key: "toggle_new",
                expectedRevision: 0,
                value: true,
              },
            ],
          });
        else
          f.command({
            type: "put-resource",
            kind: "module",
            resourceId: "new-module",
            expectedRevision: 0,
            payload: {
              id: "new-module",
              name: "Synthetic new module",
              lorebook: [],
            },
          });
        const graph = f.store.readAllPluginStorage(f.namespace),
          chat = f.store.snapshot("chat"),
          cursor = f.store.cursor();
        for (let retry = 0; retry < 2; retry++) {
          assert.throws(() => f.finish(), { code: "REVISION_CONFLICT" });
          assert.equal(f.store.cursor(), cursor);
          assert.deepEqual(f.store.readAllPluginStorage(f.namespace), graph);
          assert.deepEqual(f.store.snapshot("chat"), chat);
          assert.equal(
            f.requests.length,
            1,
            "Commit refusal cannot repeat a paid provider request",
          );
        }
      } finally {
        await f.coordinator.release();
      }
    },
  );
